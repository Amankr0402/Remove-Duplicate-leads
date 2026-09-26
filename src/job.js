const fs = require("fs");
const path = require("path");
const config = require("./config");
const logger = require("./logger");
const telecrm = require("./telecrmClient");
const { normalizePhone, getPhoneSearchVariants } = require("./phone");
const { pickPermanentLead, calculateMerge, getLeadCreationTimestamp } = require("./dedupe");

// Concurrency mutex flag
let isJobRunning = false;

const backupsDir = process.env.VERCEL ? path.join("/tmp", "backups") : path.resolve(__dirname, "../backups");
try {
  if (!fs.existsSync(backupsDir)) {
    fs.mkdirSync(backupsDir, { recursive: true });
  }
} catch (e) {
  // Ignore filesystem errors in restricted environments
}

/**
 * Executes a deduplication run.
 * @param {Object} options
 * @param {boolean} [options.dryRun] - Overrides config.dryRun
 * @param {number} [options.lookbackMinutes] - Overrides config.lookbackMinutes (0 means all)
 * @returns {Promise<Object>} Run summary
 */
async function runDeduplication(options = {}) {
  if (isJobRunning) {
    const msg = "A deduplication job is already running. Concurrency lock prevented execution.";
    logger.warn(msg);
    return { status: "busy", message: msg };
  }

  isJobRunning = true;
  const startTime = Date.now();
  const dryRun = options.dryRun !== undefined ? Boolean(options.dryRun) : config.dryRun;
  const lookbackMinutes = options.lookbackMinutes !== undefined ? parseInt(options.lookbackMinutes, 10) : config.lookbackMinutes;

  logger.info(`Starting deduplication job (dryRun=${dryRun}, lookbackMinutes=${lookbackMinutes})...`);

  const summary = {
    startedAt: new Date(startTime).toISOString(),
    finishedAt: null,
    durationMs: 0,
    dryRun,
    lookbackMinutes,
    leadsFetched: 0,
    uniquePhonesScanned: 0,
    duplicateGroupsFound: 0,
    totalDuplicatesIdentified: 0,
    mergedCount: 0,
    deletedCount: 0,
    conflictsCount: 0,
    groups: [],
    errors: [],
  };

  try {
    const cutoffTime = lookbackMinutes > 0 ? startTime - lookbackMinutes * 60 * 1000 : 0;
    const leadsByNormalizedPhone = new Map(); // normalizedPhone -> Array of lead stubs
    let skip = 0;
    const pageSize = 100;
    let keepPaginating = true;

    // Step 1: Scan recent leads
    logger.info(`Fetching leads from TeleCRM...`);
    while (keepPaginating) {
      const page = await telecrm.searchLeads({}, skip, pageSize);
      if (!page || page.length === 0) {
        break;
      }

      summary.leadsFetched += page.length;

      let leadsInWindowThisPage = 0;
      for (const lead of page) {
        const leadTime = getLeadCreationTimestamp(lead);
        if (cutoffTime > 0 && leadTime < cutoffTime) {
          continue;
        }
        leadsInWindowThisPage++;

        const rawPhone = lead.fields?.phone;
        const phoneList = Array.isArray(rawPhone) ? rawPhone : [rawPhone];

        for (const phoneItem of phoneList) {
          const norm = normalizePhone(phoneItem);
          if (!norm) {
            if (phoneItem) {
              logger.warn(`Malformed or invalid phone number skipped: "${phoneItem}" (Lead ID: ${lead._id || lead.id})`);
            }
            continue;
          }

          if (!leadsByNormalizedPhone.has(norm)) {
            leadsByNormalizedPhone.set(norm, []);
          }
          leadsByNormalizedPhone.get(norm).push(lead);
        }
      }

      // If a lookback window is set and no leads on this page were within the window, stop
      if (cutoffTime > 0 && leadsInWindowThisPage === 0) {
        keepPaginating = false;
        break;
      }

      skip += pageSize;
      if (page.length < pageSize) {
        break;
      }
    }

    summary.uniquePhonesScanned = leadsByNormalizedPhone.size;
    logger.info(`Scanned ${summary.leadsFetched} leads across ${summary.uniquePhonesScanned} unique phone numbers.`);

    // Step 2: For each unique phone, search all variants to catch historical duplicates
    // with different phone formats (e.g. 91... vs 0... vs +91...)
    const processedGroupPhones = new Set();
    const duplicateGroups = [];

    for (const [normPhone] of leadsByNormalizedPhone.entries()) {
      if (processedGroupPhones.has(normPhone)) continue;

      const variants = getPhoneSearchVariants(normPhone);
      const searchResult = await telecrm.searchLeads({ fields: { phone: variants } }, 0, 100);

      // De-duplicate leads by _id
      const uniqueLeadsMap = new Map();
      for (const item of searchResult) {
        const id = item._id || item.id;
        if (id && !uniqueLeadsMap.has(id)) {
          uniqueLeadsMap.set(id, item);
        }
      }

      const allMatchingLeads = Array.from(uniqueLeadsMap.values());

      if (allMatchingLeads.length >= 2) {
        processedGroupPhones.add(normPhone);
        duplicateGroups.push({
          normalizedPhone: normPhone,
          leads: allMatchingLeads,
        });
      }
    }

    summary.duplicateGroupsFound = duplicateGroups.length;
    logger.info(`Found ${duplicateGroups.length} duplicate phone group(s).`);

    // Step 3: Fetch full details (including actions) for scoring & plan merge
    const detailedGroups = [];

    for (const group of duplicateGroups) {
      const fullLeads = [];
      for (const leadStub of group.leads) {
        const leadId = leadStub._id || leadStub.id;
        try {
          const fullLead = await telecrm.getLead(leadId, true);
          fullLeads.push(fullLead);
        } catch (e) {
          logger.error(`Failed to fetch full lead details for ${leadId}:`, e.message);
          summary.errors.push({ leadId, error: e.message });
          // Fall back to stub
          fullLeads.push(leadStub);
        }
      }

      const selection = pickPermanentLead(fullLeads);
      const mergePlan = calculateMerge(selection.permanentLead, selection.duplicateLeads);

      detailedGroups.push({
        phone: group.normalizedPhone,
        permanentLead: selection.permanentLead,
        duplicateLeads: selection.duplicateLeads,
        selection,
        mergePlan,
      });

      summary.totalDuplicatesIdentified += selection.duplicateLeads.length;
      summary.conflictsCount += mergePlan.conflicts.length;
    }

    // Step 4: Save Backup Snapshot
    const dateStr = new Date().toISOString().replace(/[:.]/g, "-").substring(0, 16);
    const backupFileName = `${dateStr}.json`;
    const backupFilePath = path.join(backupsDir, backupFileName);
    fs.writeFileSync(
      backupFilePath,
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          dryRun,
          duplicateGroups: detailedGroups,
        },
        null,
        2
      ),
      "utf-8"
    );
    logger.info(`Backup snapshot created at ${backupFilePath}`);

    // Step 5: Execute deduplication if NOT dry-run
    for (const group of detailedGroups) {
      const { permanentLead, duplicateLeads, mergePlan, phone, selection } = group;
      const permId = permanentLead._id || permanentLead.id;

      const groupSummary = {
        phone,
        permanentId: permId,
        permanentLead: {
          id: permId,
          name: permanentLead.fields?.name || permanentLead.fields?.first_name || "N/A",
          status: permanentLead.fields?.status || "N/A",
          createdOn: permanentLead.fields?.created_on || permanentLead.created_at,
          score: selection?.permanentScore?.total || 0,
        },
        duplicateLeads: duplicateLeads.map((d) => ({
          id: d._id || d.id,
          name: d.fields?.name || d.fields?.first_name || "N/A",
          status: d.fields?.status || "N/A",
          createdOn: d.fields?.created_on || d.created_at,
        })),
        duplicateIds: duplicateLeads.map((d) => d._id || d.id),
        mergedFields: mergePlan.fieldsToUpdate,
        conflicts: mergePlan.conflicts,
        dryRun,
        success: false,
      };

      if (dryRun) {
        logger.info(`[DRY-RUN] Would keep permanent lead ${permId} and merge ${duplicateLeads.length} duplicates for phone ${phone}.`);
        if (mergePlan.mergedFieldsCount > 0) {
          logger.info(`[DRY-RUN] Fields to merge into ${permId}:`, mergePlan.fieldsToUpdate);
        }
        if (mergePlan.conflicts.length > 0) {
          logger.warn(`[DRY-RUN] Detected ${mergePlan.conflicts.length} field conflict(s) for ${phone}:`, mergePlan.conflicts);
        }
        groupSummary.success = true;
        summary.groups.push(groupSummary);
        continue;
      }

      // Live Execution
      try {
        logger.info(`Merging duplicate group for phone ${phone} (Permanent Lead: ${permId})...`);

        // 1. Update permanent lead with merged fields and attach audit note
        const permActions = [
          {
            type: "SYSTEM_NOTE",
            text: mergePlan.noteText,
          },
        ];
        await telecrm.updateLead(permId, mergePlan.fieldsToUpdate, permActions);
        logger.success(`Updated permanent lead ${permId} with merged fields and audit note.`);
        summary.mergedCount++;

        // 2. Mark duplicate leads as inactive/duplicate in TeleCRM
        for (const dup of duplicateLeads) {
          const dupId = dup._id || dup.id;
          const existingName = (dup.fields?.name || dup.fields?.first_name || "").replace(/^\[DUPLICATE\]\s*/, "");
          const dupFields = {
            name: `[DUPLICATE] ${existingName}`.trim(),
            assignee: config.duplicateAssignee,
            status: config.duplicateStatus,
          };
          const dupActions = [
            {
              type: "SYSTEM_NOTE",
              text: `[AUTOMATED CLEANUP] Marked as Duplicate. Merged into permanent lead ${permId}.`,
            },
          ];
          await telecrm.updateLead(dupId, dupFields, dupActions);
          logger.success(`Marked duplicate lead ${dupId} as '[DUPLICATE]' (Status: COLD/Lost).`);
          summary.deletedCount++;
        }

        groupSummary.success = true;
      } catch (err) {
        logger.error(`Error processing duplicate group for phone ${phone}:`, err.message);
        summary.errors.push({ phone, permId, error: err.message });
        groupSummary.error = err.message;
      }

      summary.groups.push(groupSummary);
    }
  } catch (err) {
    logger.error("Deduplication run encountered a fatal error:", err);
    summary.errors.push({ fatal: err.message, stack: err.stack });
  } finally {
    summary.finishedAt = new Date().toISOString();
    summary.durationMs = Date.now() - startTime;
    isJobRunning = false;
    logger.logRunSummary(summary);
    logger.info(`Job completed in ${summary.durationMs}ms.`);
  }

  return summary;
}

function getJobStatus() {
  return {
    isRunning: isJobRunning,
    config: {
      dryRun: config.dryRun,
      lookbackMinutes: config.lookbackMinutes,
      enterpriseId: config.enterpriseId ? `${config.enterpriseId.slice(0, 6)}...` : "not set",
    },
  };
}

// Support running directly from CLI: node src/job.js [--apply] [--all] [--lookback=N]
if (require.main === module) {
  const args = process.argv.slice(2);
  const isApply = args.includes("--apply");
  const isAll = args.includes("--all");
  const lookbackArg = args.find((a) => a.startsWith("--lookback="));
  let lookback = config.lookbackMinutes;

  if (isAll) {
    lookback = 0;
  } else if (lookbackArg) {
    lookback = parseInt(lookbackArg.split("=")[1], 10);
  }

  const dryRun = !isApply;

  console.log(`\n================ TELECRM DEDUPLICATION CLI ================`);
  console.log(`Mode: ${dryRun ? "DRY-RUN (Safe preview)" : "LIVE APPLY (Changes will be written!)"}`);
  console.log(`Lookback: ${lookback === 0 ? "All historical leads" : `${lookback} minutes`}`);
  console.log(`===========================================================\n`);

  runDeduplication({ dryRun, lookbackMinutes: lookback })
    .then((result) => {
      console.log(`\nCLI Run Finished.`);
      console.log(`Leads Scanned: ${result.leadsFetched}`);
      console.log(`Duplicate Groups: ${result.duplicateGroupsFound}`);
      console.log(`Duplicates Identified: ${result.totalDuplicatesIdentified}`);
      console.log(`Conflicts Noted: ${result.conflictsCount}`);
      if (!result.dryRun) {
        console.log(`Merged Leads: ${result.mergedCount}`);
        console.log(`Cleaned/Marked Duplicates: ${result.deletedCount}`);
      }
      if (result.errors.length > 0) {
        console.log(`Errors: ${result.errors.length}`);
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error("CLI Run Failed:", err);
      process.exit(1);
    });
}

/**
 * Merges duplicates for a specific phone number on-demand.
 * @param {string} rawPhone
 * @param {Object} options
 * @param {boolean} [options.dryRun]
 */
async function mergePhoneGroup(rawPhone, options = {}) {
  const norm = normalizePhone(rawPhone);
  if (!norm) {
    throw new Error(`Invalid phone number: "${rawPhone}"`);
  }
  const dryRun = options.dryRun !== undefined ? Boolean(options.dryRun) : false;
  logger.info(`Running targeted phone merge for ${norm} (dryRun=${dryRun})...`);

  const variants = getPhoneSearchVariants(norm);
  const searchResult = await telecrm.searchLeads({ fields: { phone: variants } }, 0, 100);

  // De-duplicate leads by _id
  const uniqueLeadsMap = new Map();
  for (const item of searchResult) {
    const id = item._id || item.id;
    if (id && !uniqueLeadsMap.has(id)) {
      uniqueLeadsMap.set(id, item);
    }
  }

  const allMatchingLeads = Array.from(uniqueLeadsMap.values());
  if (allMatchingLeads.length < 2) {
    return {
      success: true,
      phone: norm,
      duplicateCount: allMatchingLeads.length,
      message: `Only ${allMatchingLeads.length} lead(s) found for phone ${norm}. No duplicates to merge.`,
      leads: allMatchingLeads.map((l) => ({ id: l._id || l.id, name: l.fields?.name, status: l.fields?.status })),
    };
  }

  // Fetch full details
  const fullLeads = [];
  for (const stub of allMatchingLeads) {
    const leadId = stub._id || stub.id;
    try {
      const full = await telecrm.getLead(leadId, true);
      fullLeads.push(full);
    } catch (e) {
      fullLeads.push(stub);
    }
  }

  const selection = pickPermanentLead(fullLeads);
  const mergePlan = calculateMerge(selection.permanentLead, selection.duplicateLeads);
  const permId = selection.permanentLead._id || selection.permanentLead.id;
  const duplicateIds = selection.duplicateLeads.map((d) => d._id || d.id);

  // Backup snapshot
  const dateStr = new Date().toISOString().replace(/[:.]/g, "-").substring(0, 16);
  const backupFileName = `targeted_${norm}_${dateStr}.json`;
  const backupFilePath = path.join(backupsDir, backupFileName);
  try {
    fs.writeFileSync(
      backupFilePath,
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          phone: norm,
          dryRun,
          permanentLead: selection.permanentLead,
          duplicateLeads: selection.duplicateLeads,
          mergePlan,
        },
        null,
        2
      ),
      "utf-8"
    );
  } catch (e) {
    logger.warn(`Failed to save backup snapshot: ${e.message}`);
  }

  if (dryRun) {
    return {
      success: true,
      dryRun: true,
      phone: norm,
      message: `[DRY-RUN] Found ${duplicateIds.length} duplicate(s) for phone ${norm}`,
      permanentLead: {
        id: permId,
        name: selection.permanentLead.fields?.name || "N/A",
        status: selection.permanentLead.fields?.status || "N/A",
        score: selection.permanentScore?.total,
      },
      duplicateLeads: selection.duplicateLeads.map((d) => ({
        id: d._id || d.id,
        name: d.fields?.name || "N/A",
        status: d.fields?.status || "N/A",
      })),
      fieldsToMerge: mergePlan.fieldsToUpdate,
      conflicts: mergePlan.conflicts,
    };
  }

  // Execute Live Merge
  // 1. Update permanent lead with merged fields & audit note
  const permActions = [
    {
      type: "SYSTEM_NOTE",
      text: mergePlan.noteText,
    },
  ];
  await telecrm.updateLead(permId, mergePlan.fieldsToUpdate, permActions);
  logger.success(`Updated permanent lead ${permId} with merged fields & audit note.`);

  // 2. Mark duplicate leads as COLD/Lost with [DUPLICATE] prefix
  for (const dup of selection.duplicateLeads) {
    const dupId = dup._id || dup.id;
    const existingName = (dup.fields?.name || dup.fields?.first_name || "").replace(/^\[DUPLICATE\]\s*/, "");
    const dupFields = {
      name: `[DUPLICATE] ${existingName}`.trim(),
      assignee: config.duplicateAssignee,
      status: config.duplicateStatus,
    };
    const dupActions = [
      {
        type: "SYSTEM_NOTE",
        text: `[AUTOMATED CLEANUP] Marked as Duplicate. Merged into permanent lead ${permId}.`,
      },
    ];
    await telecrm.updateLead(dupId, dupFields, dupActions);
    logger.success(`Marked duplicate lead ${dupId} as '[DUPLICATE]' (Status: COLD/Lost).`);
  }

  return {
    success: true,
    dryRun: false,
    phone: norm,
    message: `Successfully merged ${duplicateIds.length} duplicate lead(s) into permanent lead ${permId}`,
    permanentLeadId: permId,
    duplicateLeadIds: duplicateIds,
    mergedFields: mergePlan.fieldsToUpdate,
    conflictsRecorded: mergePlan.conflicts.length,
  };
}

module.exports = {
  runDeduplication,
  mergePhoneGroup,
  getJobStatus,
};
