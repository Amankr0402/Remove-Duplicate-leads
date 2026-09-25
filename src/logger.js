const fs = require("fs");
const path = require("path");

const logsDir = process.env.VERCEL ? path.join("/tmp", "logs") : path.resolve(__dirname, "../logs");
try {
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
} catch (e) {
  // Ignore filesystem errors in restricted environments
}

function getTimestamp() {
  return new Date().toISOString().replace("T", " ").substring(0, 19);
}

function writeToFile(filename, message) {
  try {
    const filePath = path.join(logsDir, filename);
    fs.appendFileSync(filePath, `[${getTimestamp()}] ${message}\n`, "utf-8");
  } catch (err) {
    console.error("Failed to write to log file:", err.message);
  }
}

const logger = {
  info: (msg, ...args) => {
    console.log(`[INFO] ${msg}`, ...args);
    writeToFile("app.log", `[INFO] ${msg} ${args.length ? JSON.stringify(args) : ""}`);
  },
  success: (msg, ...args) => {
    console.log(`\x1b[32m[SUCCESS]\x1b[0m ${msg}`, ...args);
    writeToFile("app.log", `[SUCCESS] ${msg} ${args.length ? JSON.stringify(args) : ""}`);
  },
  warn: (msg, ...args) => {
    console.warn(`\x1b[33m[WARN]\x1b[0m ${msg}`, ...args);
    writeToFile("app.log", `[WARN] ${msg} ${args.length ? JSON.stringify(args) : ""}`);
  },
  error: (msg, ...args) => {
    console.error(`\x1b[31m[ERROR]\x1b[0m ${msg}`, ...args);
    writeToFile("app.log", `[ERROR] ${msg} ${args.length ? JSON.stringify(args) : ""}`);
  },
  logRunSummary: (summary) => {
    const dateStr = new Date().toISOString().replace(/[:.]/g, "-").substring(0, 16);
    const runLogFile = `run_${dateStr}.json`;
    try {
      fs.writeFileSync(path.join(logsDir, runLogFile), JSON.stringify(summary, null, 2), "utf-8");
      writeToFile("audit.log", `Job finished: Fetched ${summary.leadsFetched}, Duplicates Found: ${summary.duplicateGroupsFound}, Merged: ${summary.mergedCount}, Marked/Deleted: ${summary.deletedCount}, Errors: ${summary.errors.length}`);
    } catch (e) {
      console.error("Failed to save run summary JSON:", e.message);
    }
  }
};

module.exports = logger;
