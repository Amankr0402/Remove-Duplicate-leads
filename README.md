# TeleCRM Lead Deduplicator (Node.js)

An automated, production-ready lead deduplication service for TeleCRM using the official **TeleCRM Sync API**.

---

## 📌 Features

- **Standard Phone Normalization**: Normalizes Indian & international numbers to E.164-compatible standard (`91XXXXXXXXXX`), gracefully skipping and logging malformed numbers.
- **Multi-Format Variant Matching**: Automatically scans phone variants (`91...`, `+91...`, `0...`, `10-digit`) to catch historical duplicates regardless of how they were entered.
- **Intelligent Lead Scoring**:
  - Calculates completeness score (number of populated fields + interaction/actions history).
  - Selects the permanent lead based on score with deterministic oldest-lead tie-breaking.
- **Safe Field Merging**:
  - Non-destructively copies missing fields from duplicates to the permanent lead.
  - Detects and preserves permanent lead values on conflicts, recording any differences in an audit trail.
  - Excludes immutable identifiers (`phone`, `_id`) to comply with TeleCRM API specifications.
- **Audit Trails & System Notes**:
  - Creates a `SYSTEM_NOTE` on the permanent lead listing merged IDs, copied fields, and conflict details.
  - Updates duplicate leads with status `"Duplicate"` and logs merge reference notes.
- **Safety First (`DRY_RUN=true`)**:
  - `DRY_RUN=true` by default prevents any unintended write operations.
  - Automatic JSON backups generated in `/backups/` before any mutations.
- **Rate-Limiting & Resilience**:
  - 250ms spacing between calls, exponential backoff (up to 3 retries), and HTTP 429 rate-limit handling.
  - Mutex lock preventing concurrent overlapping executions.
- **Dual Interface**:
  - CLI commands for quick manual scans, dry-run previews, or live execution.
  - Express REST API with scheduled background cron jobs.

---

## 🛠️ TeleCRM Sync API Endpoints Used

All requests use `Authorization: Bearer <TELECRM_SYNC_TOKEN>`:

| Purpose | Method | Endpoint | Note |
|---|---|---|---|
| **Search Leads** | `POST` | `/enterprise/{enterpriseId}/lead/search?skip=0&limit=100` | Searches by phone variants or fetches recent leads |
| **Get Lead Details** | `GET` | `/enterprise/{enterpriseId}/lead/{leadId}?includeActions=true` | Fetches full fields & action history for scoring |
| **Update Lead** | `POST` | `/enterprise/{enterpriseId}/lead/{leadId}` | Merges fields into permanent lead, marks status `"Duplicate"` |
| **Add Audit Action** | `POST` | `/enterprise/{enterpriseId}/lead/{leadId}/action` | Adds `SYSTEM_NOTE` action detailing merge history |

> **Note on Deletions**: The TeleCRM Sync API does not provide a hard `DELETE /lead` endpoint. The documented best practice is updating `fields.status` to `"Duplicate"` and recording the merge link via `SYSTEM_NOTE`.

---

## 📁 Project Structure

```text
telecrm_sync.py/
├── backups/               # Automated timestamped JSON backup snapshots
├── logs/                  # Application logs, audit logs, and per-run summaries
│   ├── app.log
│   ├── audit.log
│   └── run_YYYY-MM-DD_HH-mm.json
├── src/
│   ├── config.js          # Environment configuration & validation
│   ├── dedupe.js          # Scoring, tie-breaking, and merge logic
│   ├── index.js           # Express API server & hourly cron schedule
│   ├── job.js             # Deduplication engine & CLI runner
│   ├── logger.js          # Multi-destination logging utility
│   ├── phone.js           # Phone normalization & variant generator
│   └── telecrmClient.js   # TeleCRM API client with retries & rate limits
├── .env                   # Environment credentials (git-ignored)
├── .env.example           # Example environment template
├── package.json
└── README.md
```

---

## 🚀 Setup & Installation (Windows)

### 1. Prerequisites
- **Node.js 18+** installed ([Download Node.js](https://nodejs.org/)). Check version:
  ```powershell
  node -v
  ```

### 2. Install Dependencies
In PowerShell or Command Prompt:
```powershell
npm install
```

### 3. Configure `.env`
Ensure your `.env` file exists with your credentials:
```env
TELECRM_ENTERPRISE_ID=your_enterprise_id_here
TELECRM_SYNC_TOKEN=your_sync_token_here
TELECRM_BASE_URL=https://next.telecrm.in/autoupdate/v2

# Safety controls
DRY_RUN=true
LOOKBACK_MINUTES=60
DEFAULT_COUNTRY_CODE=91

# Express Server & Cron
PORT=3000
CRON_SCHEDULE="0 * * * *"
```

---

## 💻 Running the Application

### Option A: Run via CLI

#### 1. Dry-Run Preview (Safe - No changes made)
```powershell
# Scans leads within the lookback window (default 60 min)
node src/job.js

# Scan all historical leads without making changes
node src/job.js --all

# Custom lookback window (e.g. last 120 minutes)
node src/job.js --lookback=120
```

#### 2. Live Apply (Executes merges and status updates)
```powershell
# Applies merges for recent leads
node src/job.js --apply

# Applies merges across all historical leads
node src/job.js --apply --all
```

---

### Option B: Run as a Service (Express + Cron)

Start the server:
```powershell
npm start
```
Or for development with automatic reload:
```powershell
npm run dev
```

#### API Endpoints:

1. **Health Check**:
   ```http
   GET http://localhost:3000/api/health
   ```

2. **Preview Duplicates (Dry Run)**:
   ```http
   GET http://localhost:3000/api/dedupe/preview
   GET http://localhost:3000/api/dedupe/preview?lookbackMinutes=120
   ```

3. **Trigger Dedupe Run**:
   ```http
   POST http://localhost:3000/api/dedupe/run
   Content-Type: application/json

   {
     "dryRun": true,
     "lookbackMinutes": 60
   }
   ```
   *(Set `"dryRun": false` to execute live updates).*

---

## 🔒 Safety and Backup Guarantees

1. **Immutable Snapshots**: Every run generates a timestamped snapshot in `backups/` containing all identified duplicates, permanent selections, and merge plans before any update occurs.
2. **Exclusion of Protected Identifiers**: `phone` and `_id` are never mutated or sent in update payloads, preventing `403 INVALID_LEAD` errors.
3. **Audit Trail**: Every merge operation is preserved as a permanent `SYSTEM_NOTE` in both the permanent lead and the duplicate leads.
