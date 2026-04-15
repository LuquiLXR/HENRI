import express from "express";
import { nanoid } from "nanoid";
import { createDbPool, ensureSchema, kvGet, kvSet, auditLog } from "./db.js";
import { connectMqtt, topicsForDevice } from "./mqtt.js";
import { interpret } from "./nlu.js";

function getEnv(name, fallback = null) {
  const value = process.env[name];
  if (value === undefined || value === null || value === "") return fallback;
  return value;
}

function defaultAcState() {
  return {
    mode: "dry",
    temp: 24,
    fan: "low",
    swing: "off",
    eco: "off",
    turbo: "off",
    display: "on"
  };
}

function nowIso() {
  return new Date().toISOString();
}

function mergeAcState(base, patch) {
  const next = { ...base };
  for (const key of ["mode", "temp", "fan", "swing", "eco", "turbo", "display"]) {
    if (patch[key] !== null && patch[key] !== undefined) next[key] = patch[key];
  }
  return next;
}

function toggleFrom(state) {
  if (state === "toggle") return "toggle";
  if (state === "on") return "on";
  if (state === "off") return "off";
  return null;
}

async function getWeatherSummary({ lat, lon }) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", lat);
  url.searchParams.set("longitude", lon);
  url.searchParams.set("current", "temperature_2m,weather_code");
  url.searchParams.set("timezone", "auto");

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Weather request failed: ${response.status}`);
  }
  const data = await response.json();
  const temp = data?.current?.temperature_2m;
  const code = data?.current?.weather_code;
  if (temp === undefined || code === undefined) return null;
  return { temp, code };
}

function describeWeatherCode(code) {
  const map = new Map([
    [0, "despejado"],
    [1, "mayormente despejado"],
    [2, "parcialmente nublado"],
    [3, "nublado"],
    [45, "niebla"],
    [48, "niebla con escarcha"],
    [51, "llovizna leve"],
    [53, "llovizna"],
    [55, "llovizna intensa"],
    [61, "lluvia leve"],
    [63, "lluvia"],
    [65, "lluvia intensa"],
    [71, "nieve leve"],
    [73, "nieve"],
    [75, "nieve intensa"],
    [80, "chaparrones leves"],
    [81, "chaparrones"],
    [82, "chaparrones intensos"],
    [95, "tormenta"],
    [96, "tormenta con granizo"],
    [99, "tormenta con granizo"]
  ]);
  return map.get(code) ?? `código ${code}`;
}

function responseVariant(variants, seed) {
  if (!variants.length) return "";
  const index = Math.abs(seed.split("").reduce((acc, ch) => acc + ch.charCodeAt(0), 0)) % variants.length;
  return variants[index];
}

function buildReplyForPlan(plan, ackHint = null) {
  const seed = plan.cmd_id ?? nowIso();

  if (plan.kind === "scene_activate") {
    const map = {
      noche: ["Listo. Luces encendidas y cortina cerrada.", "Hecho: modo noche activo.", "Entendido. Noche lista: luces y cortina."],
      dia: ["Hecho. Cortina abierta y luces prendidas.", "Listo: modo día activo.", "Entendido. Día listo: abrí cortina y prendí luces."],
      trabajo: ["Entendido. Modo trabajo activo.", "Listo: escritorio iluminado y herramientas encendidas.", "Hecho. Trabajo listo."],
      dormir: ["Todo apagado. Cortina cerrada.", "Entendido. Modo dormir activo.", "Listo. Apagué todo y cerré la cortina."]
    };
    return responseVariant(map[plan.scene] ?? ["Hecho."], seed);
  }

  if (plan.kind === "goodbye_all_off") {
    return responseVariant(
      ["Listo. Todo apagado y cortina abierta.", "Hecho. Dejé todo apagado y la cortina abierta.", "Hasta luego. Apagué todo y abrí la cortina."],
      seed
    );
  }

  if (plan.kind === "ac_control") {
    if (ackHint?.applied_last_state) {
      return responseVariant(
        ["Hecho. Aire encendido con la última configuración.", "Listo, vuelvo al último ajuste del aire.", "Entendido. Aire encendido como la última vez."],
        seed
      );
    }
    const parts = [];
    if (plan.payload?.mode) parts.push(`modo ${plan.payload.mode}`);
    if (plan.payload?.temp) parts.push(`${plan.payload.temp}°C`);
    if (plan.payload?.fan) parts.push(`ventilador ${plan.payload.fan}`);
    if (plan.payload?.power === "off") parts.push("apagado");
    if (plan.payload?.power === "on") parts.push("encendido");
    return parts.length ? `Aire: ${parts.join(", ")}.` : "Hecho.";
  }

  if (plan.kind === "light_control") {
    const target =
      plan.payload?.target === "deskLight"
        ? "escritorio"
        : plan.payload?.target === "bedLight"
          ? "cama"
          : plan.payload?.target === "lights"
            ? "luces"
            : "luces";
    const state = plan.payload?.state;
    if (state === "on") return `Listo. Luz ${target} encendida.`;
    if (state === "off") return `Hecho. Luz ${target} apagada.`;
    return `Entendido. Cambio el estado de la luz ${target}.`;
  }

  if (plan.kind === "curtain_set") {
    return `Listo. Cortina al ${plan.payload?.perCort}% y trabada.`;
  }

  if (plan.kind === "tool_power") {
    const tool = plan.payload?.tool;
    const state = plan.payload?.state;
    if (state === "on") return `Hecho. ${tool} encendido.`;
    if (state === "off") return `Listo. ${tool} apagado.`;
    return `Entendido. Cambio el estado de ${tool}.`;
  }

  if (plan.kind === "trash_control") {
    const state = plan.payload?.state;
    if (state === "open") return "Abriendo el tacho.";
    if (state === "close") return "Cerrando el tacho.";
    return "Hecho.";
  }

  return responseVariant(["Entendido.", "Hecho.", "Listo."], seed);
}

function expandScene(scene) {
  if (scene === "noche") {
    return [
      { kind: "light_control", payload: { target: "deskLight", state: "on" } },
      { kind: "light_control", payload: { target: "bedLight", state: "on" } },
      { kind: "curtain_set", payload: { perCort: 0 } }
    ];
  }

  if (scene === "dia") {
    return [
      { kind: "light_control", payload: { target: "deskLight", state: "on" } },
      { kind: "light_control", payload: { target: "bedLight", state: "on" } },
      { kind: "curtain_set", payload: { perCort: 100 } }
    ];
  }

  if (scene === "trabajo") {
    return [
      { kind: "light_control", payload: { target: "deskLight", state: "on" } },
      { kind: "tool_power", payload: { tool: "silicona", state: "on" } },
      { kind: "tool_power", payload: { tool: "soldador", state: "on" } }
    ];
  }

  if (scene === "dormir") {
    return [
      { kind: "light_control", payload: { target: "deskLight", state: "off" } },
      { kind: "light_control", payload: { target: "bedLight", state: "off" } },
      { kind: "tool_power", payload: { tool: "silicona", state: "off" } },
      { kind: "tool_power", payload: { tool: "soldador", state: "off" } },
      { kind: "curtain_set", payload: { perCort: 0 } },
      { kind: "ac_control", payload: { fan: "low" }, onlyIfAcOn: true }
    ];
  }

  return [];
}

function planToDeviceCommand({ cmdId, kind, payload, requestedBy }) {
  return {
    cmd_id: cmdId,
    ts: nowIso(),
    requested_by: requestedBy,
    kind,
    payload
  };
}

async function main() {
  const port = Number(getEnv("PORT", "8080"));
  const mqttUrl = getEnv("MQTT_URL", "mqtt://localhost:1883");
  const deviceId = getEnv("MQTT_DEVICE_ID", "c3-debug");
  const workspaceToolUrl = getEnv("WORKSPACE_TOOL_URL", null);
  const weatherLat = getEnv("WEATHER_LAT", null);
  const weatherLon = getEnv("WEATHER_LON", null);

  const pool = createDbPool();
  await ensureSchema(pool);

  const mqttClient = connectMqtt({ url: mqttUrl, clientId: `henri-core-${nanoid(6)}` });
  const topics = topicsForDevice(deviceId);

  const sseClients = new Set();
  function broadcastEvent(evt) {
    const payload = `data: ${JSON.stringify(evt)}\n\n`;
    for (const res of sseClients) {
      res.write(payload);
    }
  }

  mqttClient.on("connect", () => {
    mqttClient.subscribe(topics.ack, { qos: 1 });
  });

  mqttClient.on("message", async (topic, message) => {
    if (topic !== topics.ack) return;
    let parsed = null;
    try {
      parsed = JSON.parse(message.toString("utf8"));
    } catch {
      parsed = { raw: message.toString("utf8") };
    }
    await auditLog(pool, { source: "mqtt", kind: "ack", payload: parsed });
    broadcastEvent({ type: "ack", payload: parsed });
  });

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(new URL("../public", import.meta.url).pathname));

  app.get("/api/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    res.write(`data: ${JSON.stringify({ type: "hello", ts: nowIso() })}\n\n`);
    sseClients.add(res);
    req.on("close", () => {
      sseClients.delete(res);
    });
  });

  app.post("/api/chat", async (req, res) => {
    const text = String(req.body?.text ?? "").trim();
    if (!text) return res.status(400).json({ error: "text is required" });

    const interpreted = interpret(text);
    await auditLog(pool, { source: "panel", kind: "user_text", payload: { text, interpreted } });
    broadcastEvent({ type: "log", payload: { ts: nowIso(), source: "panel", kind: "user_text", text, interpreted } });

    if (interpreted.kind === "info_time") {
      const now = new Date();
      return res.json({ reply: `Son las ${now.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}.`, interpreted });
    }

    if (interpreted.kind === "info_weather") {
      if (!weatherLat || !weatherLon) {
        return res.json({
          reply: "Todavía no tengo tu ubicación configurada para el clima.",
          interpreted
        });
      }
      try {
        const summary = await getWeatherSummary({ lat: weatherLat, lon: weatherLon });
        if (!summary) return res.json({ reply: "No pude leer el clima ahora mismo.", interpreted });
        const description = describeWeatherCode(summary.code);
        return res.json({ reply: `Ahora hay ${summary.temp}°C y está ${description}.`, interpreted });
      } catch (e) {
        return res.json({ reply: "No pude consultar el clima ahora mismo.", interpreted });
      }
    }

    if (interpreted.kind === "workspace_calendar_next") {
      if (!workspaceToolUrl) return res.json({ reply: "Workspace no está configurado.", interpreted });
      try {
        const response = await fetch(`${workspaceToolUrl}/calendar/next`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ maxResults: 5 })
        });
        const data = await response.json();
        if (!data.ok) return res.json({ reply: "No pude consultar tu calendario todavía.", interpreted, data });
        const items = data?.data?.items ?? [];
        if (!items.length) return res.json({ reply: "No tenés eventos próximos en el calendario.", interpreted });
        const next = items[0];
        const summary = next.summary ?? "Evento";
        const start = next.start?.dateTime ?? next.start?.date ?? null;
        const when = start ? new Date(start).toLocaleString("es-AR", { hour: "2-digit", minute: "2-digit", weekday: "short", month: "short", day: "2-digit" }) : "";
        return res.json({ reply: `Lo próximo es: ${summary}${when ? ` (${when})` : ""}.`, interpreted, items });
      } catch (e) {
        return res.json({ reply: "No pude consultar tu calendario todavía.", interpreted });
      }
    }

    if (interpreted.kind === "workspace_drive_listRecent") {
      if (!workspaceToolUrl) return res.json({ reply: "Workspace no está configurado.", interpreted });
      try {
        const response = await fetch(`${workspaceToolUrl}/drive/listRecent`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pageSize: 5 })
        });
        const data = await response.json();
        if (!data.ok) return res.json({ reply: "No pude consultar Drive todavía.", interpreted, data });
        const files = data?.data?.files ?? [];
        if (!files.length) return res.json({ reply: "No encontré archivos recientes.", interpreted });
        const names = files.map((f) => f.name).filter(Boolean).slice(0, 5);
        return res.json({ reply: `Tus últimos archivos: ${names.join(", ")}.`, interpreted, files });
      } catch (e) {
        return res.json({ reply: "No pude consultar Drive todavía.", interpreted });
      }
    }

    if (interpreted.kind === "unknown") {
      return res.json({
        reply: "No lo entendí todavía. Probá con: modo noche/día/trabajo/dormir, aire, luces, cortina, tacho.",
        interpreted
      });
    }

    if (interpreted.kind === "scene_activate") {
      const actions = expandScene(interpreted.scene);
      const cmdIds = [];
      for (const action of actions) {
        if (action.onlyIfAcOn) {
          const acState = (await kvGet(pool, "ac_state")) ?? { power: "off", ...defaultAcState() };
          if (acState.power !== "on") continue;
        }
        const cmdId = nanoid();
        cmdIds.push(cmdId);
        const deviceCmd = planToDeviceCommand({
          cmdId,
          kind: action.kind,
          payload: action.payload,
          requestedBy: { type: "panel", text }
        });
        mqttClient.publish(topics.cmd, JSON.stringify(deviceCmd), { qos: 1 });
        await auditLog(pool, { source: "henri-core", kind: "cmd_publish", payload: deviceCmd });
        broadcastEvent({ type: "log", payload: { ts: nowIso(), source: "henri-core", kind: "cmd_publish", cmd: deviceCmd } });
      }
      return res.json({ reply: buildReplyForPlan({ kind: "scene_activate", scene: interpreted.scene, cmd_id: cmdIds[0] ?? nanoid() }), interpreted, cmd_ids: cmdIds });
    }

    if (interpreted.kind === "goodbye_all_off") {
      const goodbyeActions = [
        { kind: "light_control", payload: { target: "deskLight", state: "off" } },
        { kind: "light_control", payload: { target: "bedLight", state: "off" } },
        { kind: "tool_power", payload: { tool: "silicona", state: "off" } },
        { kind: "tool_power", payload: { tool: "soldador", state: "off" } },
        { kind: "trash_control", payload: { state: "close" } },
        { kind: "ac_control", payload: { power: "off" } },
        { kind: "curtain_set", payload: { perCort: 100 } }
      ];
      const cmdIds = [];
      for (const action of goodbyeActions) {
        const cmdId = nanoid();
        cmdIds.push(cmdId);
        const deviceCmd = planToDeviceCommand({
          cmdId,
          kind: action.kind,
          payload: action.payload,
          requestedBy: { type: "panel", text }
        });
        mqttClient.publish(topics.cmd, JSON.stringify(deviceCmd), { qos: 1 });
        await auditLog(pool, { source: "henri-core", kind: "cmd_publish", payload: deviceCmd });
        broadcastEvent({ type: "log", payload: { ts: nowIso(), source: "henri-core", kind: "cmd_publish", cmd: deviceCmd } });
      }
      return res.json({ reply: buildReplyForPlan({ kind: "goodbye_all_off", cmd_id: cmdIds[0] }), interpreted, cmd_ids: cmdIds });
    }

    if (interpreted.kind === "ac_control") {
      const lastOnState = (await kvGet(pool, "ac_last_on_state")) ?? defaultAcState();
      const current = (await kvGet(pool, "ac_state")) ?? { power: "off", ...lastOnState };

      const requestedPower = interpreted.power;

      const wantsPowerOnWithoutSpecifics = requestedPower === "on" && !interpreted.mode && interpreted.temp === null && !interpreted.fan && !interpreted.swing && !interpreted.eco && !interpreted.turbo && !interpreted.display;

      let appliedLastState = false;
      let nextState = { ...current };

      if (requestedPower === "off") {
        nextState.power = "off";
      } else if (wantsPowerOnWithoutSpecifics) {
        nextState.power = "on";
        nextState = { ...nextState, ...lastOnState };
        appliedLastState = true;
      } else {
        if (requestedPower === "on") nextState.power = "on";
        nextState = mergeAcState(nextState, {
          mode: interpreted.mode,
          temp: interpreted.temp,
          fan: interpreted.fan,
          swing: toggleFrom(interpreted.swing),
          eco: toggleFrom(interpreted.eco),
          turbo: toggleFrom(interpreted.turbo),
          display: toggleFrom(interpreted.display)
        });
        if (nextState.power === "on") {
          const snapshot = {
            mode: nextState.mode,
            temp: nextState.temp,
            fan: nextState.fan,
            swing: nextState.swing,
            eco: nextState.eco,
            turbo: nextState.turbo,
            display: nextState.display
          };
          await kvSet(pool, "ac_last_on_state", snapshot);
        }
      }

      await kvSet(pool, "ac_state", nextState);

      const cmdId = nanoid();
      const payload = {
        power: nextState.power,
        mode: nextState.mode,
        temp: nextState.temp,
        fan: nextState.fan,
        swing: nextState.swing,
        eco: nextState.eco,
        turbo: nextState.turbo,
        display: nextState.display,
        applied_last_state: appliedLastState
      };

      const deviceCmd = planToDeviceCommand({ cmdId, kind: "ac_control", payload, requestedBy: { type: "panel", text } });
      mqttClient.publish(topics.cmd, JSON.stringify(deviceCmd), { qos: 1 });
      await auditLog(pool, { source: "henri-core", kind: "cmd_publish", payload: deviceCmd });
      broadcastEvent({ type: "log", payload: { ts: nowIso(), source: "henri-core", kind: "cmd_publish", cmd: deviceCmd } });

      return res.json({
        reply: buildReplyForPlan({ kind: "ac_control", cmd_id: cmdId, payload }, { applied_last_state: appliedLastState }),
        interpreted,
        cmd_id: cmdId,
        payload
      });
    }

    if (interpreted.kind === "light_control") {
      const cmdId = nanoid();
      const payload = { target: interpreted.target, state: interpreted.state };
      const deviceCmd = planToDeviceCommand({ cmdId, kind: "light_control", payload, requestedBy: { type: "panel", text } });
      mqttClient.publish(topics.cmd, JSON.stringify(deviceCmd), { qos: 1 });
      await auditLog(pool, { source: "henri-core", kind: "cmd_publish", payload: deviceCmd });
      broadcastEvent({ type: "log", payload: { ts: nowIso(), source: "henri-core", kind: "cmd_publish", cmd: deviceCmd } });
      return res.json({ reply: buildReplyForPlan({ kind: "light_control", cmd_id: cmdId, payload }), interpreted, cmd_id: cmdId, payload });
    }

    if (interpreted.kind === "curtain_set") {
      const cmdId = nanoid();
      const payload = { perCort: interpreted.perCort };
      const deviceCmd = planToDeviceCommand({ cmdId, kind: "curtain_set", payload, requestedBy: { type: "panel", text } });
      mqttClient.publish(topics.cmd, JSON.stringify(deviceCmd), { qos: 1 });
      await auditLog(pool, { source: "henri-core", kind: "cmd_publish", payload: deviceCmd });
      broadcastEvent({ type: "log", payload: { ts: nowIso(), source: "henri-core", kind: "cmd_publish", cmd: deviceCmd } });
      return res.json({ reply: buildReplyForPlan({ kind: "curtain_set", cmd_id: cmdId, payload }), interpreted, cmd_id: cmdId, payload });
    }

    if (interpreted.kind === "tool_power") {
      const cmdId = nanoid();
      const payload = { tool: interpreted.tool, state: interpreted.state };
      const deviceCmd = planToDeviceCommand({ cmdId, kind: "tool_power", payload, requestedBy: { type: "panel", text } });
      mqttClient.publish(topics.cmd, JSON.stringify(deviceCmd), { qos: 1 });
      await auditLog(pool, { source: "henri-core", kind: "cmd_publish", payload: deviceCmd });
      broadcastEvent({ type: "log", payload: { ts: nowIso(), source: "henri-core", kind: "cmd_publish", cmd: deviceCmd } });
      return res.json({ reply: buildReplyForPlan({ kind: "tool_power", cmd_id: cmdId, payload }), interpreted, cmd_id: cmdId, payload });
    }

    if (interpreted.kind === "trash_control") {
      const cmdId = nanoid();
      const payload = { state: interpreted.state };
      const deviceCmd = planToDeviceCommand({ cmdId, kind: "trash_control", payload, requestedBy: { type: "panel", text } });
      mqttClient.publish(topics.cmd, JSON.stringify(deviceCmd), { qos: 1 });
      await auditLog(pool, { source: "henri-core", kind: "cmd_publish", payload: deviceCmd });
      broadcastEvent({ type: "log", payload: { ts: nowIso(), source: "henri-core", kind: "cmd_publish", cmd: deviceCmd } });
      return res.json({ reply: buildReplyForPlan({ kind: "trash_control", cmd_id: cmdId, payload }), interpreted, cmd_id: cmdId, payload });
    }

    if (workspaceToolUrl && /\b(calendar|drive|gmail)\b/i.test(text)) {
      return res.json({ reply: "Workspace: todavía no está cableado en este slice, pero el contenedor está listo.", interpreted });
    }

    return res.json({ reply: "Entendido.", interpreted });
  });

  app.listen(port, () => {
    console.log(`henri-core listening on :${port}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
