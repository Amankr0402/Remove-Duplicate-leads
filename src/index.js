const express = require("express");
const cron = require("node-cron");
const config = require("./config");
const logger = require("./logger");
const { runDeduplication, getJobStatus } = require("./job");

const app = express();
app.use(express.json());

const startTime = Date.now();

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
