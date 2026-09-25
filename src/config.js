const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const config = {
  syncToken: process.env.TELECRM_SYNC_TOKEN || "",
  enterpriseId: process.env.TELECRM_ENTERPRISE_ID || "",
  baseUrl: (process.env.TELECRM_BASE_URL || "https://next.telecrm.in/autoupdate/v2").replace(/\/+$/, ""),
  dryRun: (process.env.DRY_RUN || "true").toLowerCase() === "true",
  lookbackMinutes: parseInt(process.env.LOOKBACK_MINUTES || "60", 10),
  defaultCountryCode: process.env.DEFAULT_COUNTRY_CODE || "91",
  port: parseInt(process.env.PORT || "3000", 10),
};

// Simple validation
if (!config.syncToken || !config.enterpriseId) {
  console.warn("[WARN] TELECRM_SYNC_TOKEN or TELECRM_ENTERPRISE_ID is missing in .env");
}

module.exports = config;
