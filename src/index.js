const express = require("express");
const cron = require("node-cron");
const config = require("./config");
const logger = require("./logger");
const { runDeduplication, getJobStatus } = require("./job");

const app = express();
app.use(express.json());

// Normalize URL in case Vercel rewrote request to entrypoint path
app.use((req, res, next) => {
  if (req.url === "/src/index.js" || req.url.startsWith("/src/index.js?")) {
    const original = req.headers["x-matched-path"] || req.headers["x-forwarded-url"] || "/";
    req.url = original.startsWith("/src/index.js") ? "/" : original;
  }
  next();
});

const startTime = Date.now();

// Root route - Overview Dashboard & API Directory
app.get("/", (req, res) => {
  const status = getJobStatus();
  if (req.headers.accept && req.headers.accept.includes("application/json") && !req.headers.accept.includes("text/html")) {
    return res.json({
      service: "TeleCRM Lead Deduplicator",
      status: "online",
      uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
      mode: config.dryRun ? "DRY-RUN (Safe preview)" : "LIVE",
      endpoints: {
        health: "/api/health",
        preview: "/api/dedupe/preview",
        run: "POST /api/dedupe/run"
      }
    });
  }

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TeleCRM Lead Deduplicator</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background: #0f172a; color: #f8fafc; min-height: 100vh; display: flex; justify-content: center; align-items: center; padding: 20px; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 16px; max-width: 650px; width: 100%; padding: 32px; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5); }
    .badge { display: inline-block; padding: 4px 12px; border-radius: 9999px; font-size: 12px; font-weight: 600; text-transform: uppercase; }
    .badge-green { background: #065f46; color: #34d399; }
    .badge-amber { background: #78350f; color: #fbbf24; }
    h1 { font-size: 24px; font-weight: 700; margin: 16px 0 8px; color: #fff; }
    p { color: #94a3b8; font-size: 14px; line-height: 1.5; margin-bottom: 24px; }
    .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-bottom: 24px; }
    .stat { background: #0f172a; border: 1px solid #334155; padding: 14px; border-radius: 10px; }
    .stat-label { font-size: 11px; text-transform: uppercase; color: #64748b; font-weight: 600; }
    .stat-value { font-size: 15px; font-weight: 600; color: #e2e8f0; margin-top: 4px; word-break: break-all; }
    .section-title { font-size: 14px; font-weight: 600; color: #cbd5e1; margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
    .btn-group { display: flex; flex-direction: column; gap: 10px; }
    .btn { display: flex; align-items: center; justify-content: space-between; padding: 12px 18px; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 500; transition: all 0.2s; border: 1px solid #3b82f6; background: rgba(59, 130, 246, 0.1); color: #60a5fa; }
    .btn:hover { background: #3b82f6; color: #fff; transform: translateY(-1px); }
    .btn-secondary { border-color: #334155; background: #0f172a; color: #94a3b8; }
    .btn-secondary:hover { background: #1e293b; color: #f8fafc; border-color: #475569; }
    .footer { margin-top: 24px; padding-top: 16px; border-top: 1px solid #334155; font-size: 12px; color: #64748b; display: flex; justify-content: space-between; }
  </style>
</head>
<body>
  <div class="card">
    <span class="badge badge-green">● Service Online</span>
    <span class="badge badge-amber" style="margin-left: 6px;">Mode: ${config.dryRun ? "DRY-RUN (Safe)" : "LIVE"}</span>
    <h1>TeleCRM Lead Deduplicator</h1>
    <p>Automated service that identifies, scores, non-destructively merges, and flags duplicate leads via the official TeleCRM Sync API.</p>
    
    <div class="grid">
      <div class="stat">
        <div class="stat-label">Enterprise ID</div>
        <div class="stat-value">${config.enterpriseId ? config.enterpriseId.slice(0, 10) + '...' : 'Not set'}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Lookback Window</div>
        <div class="stat-value">${config.lookbackMinutes} minutes</div>
      </div>
    </div>

    <div class="section-title">Available Endpoints</div>
    <div class="btn-group">
      <a href="/api/dedupe/preview" target="_blank" class="btn">
        <span>🔍 <strong>Preview Duplicates</strong> (Dry-Run Analysis)</span>
        <span>GET &rarr;</span>
      </a>
      <a href="/api/health" target="_blank" class="btn btn-secondary">
        <span>🩺 <strong>Health Check</strong> (Uptime & Node Info)</span>
        <span>GET &rarr;</span>
      </a>
    </div>

    <div class="footer">
      <span>TeleCRM Sync API Service</span>
      <span>Uptime: ${Math.floor((Date.now() - startTime) / 1000)}s</span>
    </div>
  </div>
</body>
</html>`);
});

// 1. Health check endpoint
app.get("/api/health", (req, res) => {
  const status = getJobStatus();
  res.json({
    status: "ok",
    uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
    jobStatus: status,
  });
});

// 2. Preview endpoint (always runs in dryRun mode)
app.get("/api/dedupe/preview", async (req, res) => {
  try {
    let lookbackMinutes = config.lookbackMinutes;
    if (req.query.all === "true") {
      lookbackMinutes = 0;
    } else if (req.query.lookbackMinutes !== undefined) {
      lookbackMinutes = parseInt(req.query.lookbackMinutes, 10);
    }
    logger.info(`Received GET /api/dedupe/preview (lookback=${lookbackMinutes})`);

    const result = await runDeduplication({
      dryRun: true,
      lookbackMinutes,
    });

    if (result.status === "busy") {
      return res.status(409).json(result);
    }

    res.json({
      success: true,
      message: "Preview generated successfully (dry-run)",
      data: result,
    });
  } catch (err) {
    logger.error("Preview endpoint error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Trigger dedupe run endpoint
app.post("/api/dedupe/run", async (req, res) => {
  try {
    const dryRun = req.body?.dryRun !== undefined ? Boolean(req.body.dryRun) : req.query.dryRun !== undefined ? req.query.dryRun === "true" : config.dryRun;
    const lookbackMinutes = req.body?.lookbackMinutes !== undefined ? parseInt(req.body.lookbackMinutes, 10) : req.query.lookbackMinutes !== undefined ? parseInt(req.query.lookbackMinutes, 10) : config.lookbackMinutes;

    logger.info(`Received POST /api/dedupe/run (dryRun=${dryRun}, lookback=${lookbackMinutes})`);

    // Run job asynchronously or synchronously based on caller preference
    const isAsync = req.query.async === "true" || req.body?.async === true;

    if (isAsync) {
      // Fire and forget
      runDeduplication({ dryRun, lookbackMinutes });
      return res.status(202).json({
        success: true,
        message: "Deduplication job dispatched in background",
        mode: dryRun ? "DRY-RUN" : "LIVE",
        lookbackMinutes,
      });
    }

    const result = await runDeduplication({ dryRun, lookbackMinutes });
    if (result.status === "busy") {
      return res.status(409).json(result);
    }

    res.json({
      success: true,
      message: `Deduplication job finished (${dryRun ? "DRY-RUN" : "LIVE"})`,
      data: result,
    });
  } catch (err) {
    logger.error("Run endpoint error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Only start local cron and server when running standalone (not inside Vercel serverless)
let server = null;
if (process.env.VERCEL !== "1") {
  // Start scheduled cron job (runs every hour at minute 0)
  const cronExpression = process.env.CRON_SCHEDULE || "0 * * * *";
  logger.info(`Initializing cron schedule: "${cronExpression}"`);
  cron.schedule(cronExpression, async () => {
    logger.info(`[CRON] Triggering scheduled deduplication run...`);
    try {
      await runDeduplication();
    } catch (err) {
      logger.error("[CRON] Scheduled deduplication failed:", err.message);
    }
  });

  const port = config.port;
  server = app.listen(port, () => {
    logger.success(`TeleCRM Dedupe server listening on port ${port}`);
    logger.info(`Health check: http://localhost:${port}/api/health`);
    logger.info(`Preview API:  http://localhost:${port}/api/dedupe/preview`);
    logger.info(`Run API:      http://localhost:${port}/api/dedupe/run`);
  });
}

app.app = app;
app.server = server;
module.exports = app;
