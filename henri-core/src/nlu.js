const TEMP_WORDS = new Map([
  ["veinte", 20],
  ["veintiuno", 21],
  ["veintiun", 21],
  ["veintidos", 22],
  ["veintidós", 22],
  ["veintitres", 23],
  ["veintitrés", 23],
  ["veinticuatro", 24],
  ["veinticinco", 25],
  ["veintiseis", 26],
  ["veintiséis", 26],
  ["veintisiete", 27],
  ["veintiocho", 28]
]);

function normalizeText(input) {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim();
}

function pickFirst(regex, text) {
  const match = text.match(regex);
  return match ? match[1] : null;
}

function parseTemp(text) {
  const num = pickFirst(/\b(2[0-8])\b/, text);
  if (num) return Number(num);

  for (const [word, value] of TEMP_WORDS.entries()) {
    if (text.includes(word)) return value;
  }
  return null;
}

function parsePercent(text) {
  const num = pickFirst(/\b(\d{1,3})\s*%?\b/, text);
  if (num) {
    const value = Math.max(0, Math.min(100, Number(num)));
    return Number.isFinite(value) ? value : null;
  }

  if (text.includes("mitad") || text.includes("media")) return 50;
  if (text.includes("toda") || text.includes("entera") || text.includes("completa")) return 100;
  return null;
}

function parseOnOffToggle(text) {
  const on = /\b(prende|prendi|prender|prendelo|prendeme|encende|encendi|encender|enciende|activa|activar|pone|poneme|ponele|poner|pon|subi|suba|subir|abr(i|i)|abrime|abrir|abre)\b/.test(
    text
  );
  const off = /\b(apaga|apagar|apagame|apagalo|apagale|desactiva|desactivar|saca|sacar|quita|quitar|corta|cortar|cerra|cerrame|cerrar|cierra)\b/.test(
    text
  );
  const toggle = /\b(estado|cambia|cambiar|toggle|alterna|alternar)\b/.test(text);

  if (on && !off) return "on";
  if (off && !on) return "off";
  if (toggle && !on && !off) return "toggle";
  return null;
}

function parseAcMode(text) {
  if (text.includes("hace calor") || text.includes("tengo calor") || text.includes("modo frio") || text.includes("frio")) return "cool";
  if (text.includes("hace frio") || text.includes("tengo frio") || text.includes("modo calor") || text.includes("calor")) return "heat";
  if (text.includes("humedad") || text.includes("seco") || text.includes("dry")) return "dry";
  if (text.includes("solo ventilador") || /\bfan\b/.test(text) || text.includes("ventilador")) return "fan";
  if (text.includes("auto") || text.includes("automatico")) return "auto";
  return null;
}

function parseAcFan(text) {
  if (text.includes("silencio") || text.includes("quiet") || text.includes("bajo") || text.includes("low")) return "low";
  if (text.includes("medio") || text.includes("media") || text.includes("medium")) return "medium";
  if (text.includes("alto") || text.includes("high")) return "high";
  if (text.includes("fan auto") || text.includes("ventilador auto") || (text.includes("auto") && text.includes("ventilador")))
    return "auto";
  return null;
}

function parseToggleKeyword(text, keyword) {
  if (!text.includes(keyword)) return null;
  const state = parseOnOffToggle(text);
  if (state === "toggle" || state === null) return "toggle";
  return state;
}

export function interpret(textRaw) {
  const text = normalizeText(textRaw);

  const timeAsked = /\b(que hora es|hora tenes|decime la hora|hora actual)\b/.test(text);
  if (timeAsked) {
    return { kind: "info_time" };
  }

  const weatherAsked = /\b(clima|tiempo|pronostico|temperatura afuera|como esta afuera)\b/.test(text);
  if (weatherAsked) {
    return { kind: "info_weather" };
  }

  const calendarAsked = /\b(agenda|calendario|que tengo hoy|que tengo manana|proximos eventos|proxima reunion|proxima reunion|eventos)\b/.test(
    text
  );
  if (calendarAsked) {
    return { kind: "workspace_calendar_next" };
  }

  const driveAsked = /\b(drive|archivos|ultimo archivo|ultimos archivos|mis archivos)\b/.test(text);
  if (driveAsked) {
    return { kind: "workspace_drive_listRecent" };
  }

  const goodbye = /\b(chau|me voy|ya me voy|nos vemos|hasta luego|hasta pronto|apag(a|a) todo|goodbye)\b/.test(text);
  if (goodbye) {
    return { kind: "goodbye_all_off" };
  }

  if (/\b(buen dia|buenos dias|good morning|guten tag)\b/.test(text)) return { kind: "scene_activate", scene: "dia" };
  if (/\b(buenas noches|good night|gute nacht)\b/.test(text)) return { kind: "scene_activate", scene: "dormir" };
  if (/\b(a trabajar|work mode)\b/.test(text)) return { kind: "scene_activate", scene: "trabajo" };

  const scene = pickFirst(/\b(modo\s+)?(noche|dia|trabajo|dormir|sleep)\b/, text);
  if (scene) {
    const normalizedScene =
      scene === "sleep" ? "dormir" : scene === "dia" ? "dia" : scene === "noche" ? "noche" : scene === "trabajo" ? "trabajo" : null;
    if (normalizedScene) return { kind: "scene_activate", scene: normalizedScene };
  }

  const talksAboutCurtain = /\b(cortina|cortinas|persiana)\b/.test(text);
  if (talksAboutCurtain) {
    const state = parseOnOffToggle(text);
    if (state === "on") return { kind: "curtain_set", perCort: 100 };
    if (state === "off") return { kind: "curtain_set", perCort: 0 };
    const perCort = parsePercent(text);
    if (perCort !== null) return { kind: "curtain_set", perCort };
  }

  if (/\b(tacho|basura|basurero|cesto)\b/.test(text)) {
    if (/\b(necesito)\b/.test(text)) return { kind: "trash_control", state: "open" };
    const state = parseOnOffToggle(text);
    if (state === "on") return { kind: "trash_control", state: "open" };
    if (state === "off") return { kind: "trash_control", state: "close" };
    return { kind: "trash_control", state: "toggle" };
  }

  const hasLuz = /\b(luz|luces|escritorio|cama|lampara|lampara|velador)\b/.test(text);
  if (hasLuz) {
    if (/\b(necesito)\b/.test(text) && /\b(luz|luces)\b/.test(text)) return { kind: "light_control", target: "lights", state: "on" };
    const state = parseOnOffToggle(text);
    if (state) {
      const target = text.includes("escritorio") ? "deskLight" : text.includes("cama") || text.includes("velador") ? "bedLight" : "lights";
      return { kind: "light_control", target, state };
    }
  }

  const tool = text.includes("soldador") || text.includes("cautin") ? "soldador" : text.includes("silicona") || text.includes("pistola") ? "silicona" : null;
  if (tool) {
    const state = parseOnOffToggle(text);
    if (state) return { kind: "tool_power", tool, state };
  }

  const talksAboutAc = /\b(aire acondicionado|aire|ac|climatizacion)\b/.test(text)
    || text.includes("ventilador")
    || text.includes("swing")
    || text.includes("eco")
    || text.includes("turbo")
    || text.includes("display")
    || text.includes("hace calor")
    || text.includes("tengo calor")
    || text.includes("hace frio")
    || text.includes("tengo frio")
    || text.includes("humedad");
  if (talksAboutAc) {
    const powerWord = parseOnOffToggle(text);

    const mode = parseAcMode(text);
    const temp = parseTemp(text);
    const fan = parseAcFan(text);

    const swing = parseToggleKeyword(text, "swing");
    const eco = parseToggleKeyword(text, "eco");
    const turbo = parseToggleKeyword(text, "turbo");
    const display = parseToggleKeyword(text, "display");

    const hasAnySlot = Boolean(mode || temp !== null || fan || swing || eco || turbo || display || powerWord);
    if (hasAnySlot) {
      return {
        kind: "ac_control",
        power: powerWord === "on" ? "on" : powerWord === "off" ? "off" : null,
        mode,
        temp,
        fan,
        swing,
        eco,
        turbo,
        display
      };
    }
  }

  return { kind: "unknown", text: textRaw };
}
