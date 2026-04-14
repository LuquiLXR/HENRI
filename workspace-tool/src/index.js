import express from "express";
import { spawn } from "node:child_process";

function getEnv(name, fallback = null) {
  const value = process.env[name];
  if (value === undefined || value === null || value === "") return fallback;
  return value;
}

function runGws(args, { json = true } = {}) {
  const finalArgs = [...args];
  if (json && !finalArgs.includes("--format") && !finalArgs.includes("--json")) {
    finalArgs.push("--format", "json");
  }

  return new Promise((resolve, reject) => {
    const child = spawn("gws", finalArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(stderr || `gws exited ${code}`));
      resolve({ stdout, stderr });
    });
  });
}

async function main() {
  const port = Number(getEnv("PORT", "8787"));
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (req, res) => res.json({ ok: true }));

  app.post("/drive/listRecent", async (req, res) => {
    const pageSize = Number(req.body?.pageSize ?? 10);
    try {
      const { stdout } = await runGws(["drive", "files", "list", "--params", JSON.stringify({ pageSize })], { json: false });
      const parsed = JSON.parse(stdout);
      res.json({ ok: true, data: parsed });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message ?? e) });
    }
  });

  app.post("/calendar/next", async (req, res) => {
    const maxResults = Number(req.body?.maxResults ?? 5);
    const timeMin = new Date().toISOString();
    try {
      const { stdout } = await runGws(
        ["calendar", "events", "list", "--params", JSON.stringify({ calendarId: "primary", timeMin, maxResults, singleEvents: true, orderBy: "startTime" })],
        { json: false }
      );
      const parsed = JSON.parse(stdout);
      res.json({ ok: true, data: parsed });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message ?? e) });
    }
  });

  app.listen(port, () => {
    console.log(`workspace-tool listening on :${port}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

