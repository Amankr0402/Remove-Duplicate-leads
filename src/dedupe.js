/**
 * Deduplication logic: scoring, permanent lead selection, and merge calculation.
 */

// Fields that should never be sent in an update payload to TeleCRM
const EXCLUDED_UPDATE_FIELDS = new Set([
  "_id",
  "id",
  "phone", // Phone cannot be modified via update endpoint (causes 403 INVALID_LEAD)
  "status", // Permanent lead should keep its active status, never absorb duplicate/cold status
  "lostReasonid", // Never mark permanent lead with a lost reason
  "employeeid", // Permanent lead should keep its existing sales rep assignee
  "created_at",
  "created_on",
  "createdAt",
  "updated_at",
  "updated_on",
  "updatedAt",
  "actions",
  "enterprise_id",
  "enterpriseId",
  "events",
  "history",
]);

/**
 * Extracts creation timestamp in milliseconds.
 * Checks created_at/created_on, or falls back to MongoDB ObjectId timestamp.
 */
function getLeadCreationTimestamp(lead) {
  if (lead.created_at) {
    const t = new Date(lead.created_at).getTime();
    if (!isNaN(t)) return t;
  }
  if (lead.created_on) {
    const t = new Date(lead.created_on).getTime();
    if (!isNaN(t)) return t;
  }
  if (lead.createdAt) {
    const t = new Date(lead.createdAt).getTime();
    if (!isNaN(t)) return t;
  }
  // MongoDB ObjectId timestamp (first 8 hex characters = unix seconds)
  const id = lead._id || lead.id;
  if (typeof id === "string" && id.length === 24 && /^[0-9a-fA-F]{24}$/.test(id)) {
    return parseInt(id.substring(0, 8), 16) * 1000;
  }
  return Date.now();
}

/**
 * Checks whether a field value is considered non-empty.
 */
function isNonEmpty(val) {
  if (val === null || val === undefined) return false;
  if (typeof val === "string") return val.trim().length > 0;
  if (Array.isArray(val)) return val.length > 0;
  if (typeof val === "object") return Object.keys(val).length > 0;
  return true; // numbers, booleans
}

/**
 * Calculates a completeness & activity score for a lead.
 * Higher score = more complete data & more interactions.
 */
function scoreLead(lead) {
  const fields = lead.fields || {};
  let fieldScore = 0;

  for (const [key, value] of Object.entries(fields)) {
    if (isNonEmpty(value)) {
      fieldScore += 1;
    }
  }

  // Count actions/notes/calls
  const actionCount = Array.isArray(lead.actions) ? lead.actions.length : 0;

  // Total score = non-empty fields + total action history
  return {
    total: fieldScore + actionCount,
    fieldScore,
    actionCount,
  };
}

/**
 * Given an array of duplicate leads for the same phone number,
 * picks the permanent lead and duplicate leads.
 * Criteria:
 * 1. Highest score (fields + actions)
 * 2. Tie-breaker: oldest lead (earliest timestamp)
 * 3. Tie-breaker: deterministic sort by ID
 */
function pickPermanentLead(leadGroup) {
  if (!leadGroup || leadGroup.length === 0) return null;
  if (leadGroup.length === 1) {
    return {
      permanentLead: leadGroup[0],
      duplicateLeads: [],
    };
  }

  const scored = leadGroup.map((lead) => ({
    lead,
    score: scoreLead(lead),
    createdAt: getLeadCreationTimestamp(lead),
    id: lead._id || lead.id || "",
  }));

  scored.sort((a, b) => {
    // 1. Highest score first
    if (b.score.total !== a.score.total) {
      return b.score.total - a.score.total;
    }
    // 2. Oldest lead first (smallest timestamp)
    if (a.createdAt !== b.createdAt) {
      return a.createdAt - b.createdAt;
    }
    // 3. Alphabetical tie-breaker on ID
    return a.id.localeCompare(b.id);
  });

  const permanentLead = scored[0].lead;
  const duplicateLeads = scored.slice(1).map((s) => s.lead);

  return {
    permanentLead,
    duplicateLeads,
    permanentScore: scored[0].score,
    allScores: scored.map((s) => ({ id: s.id, score: s.score, createdAt: s.createdAt })),
  };
}

/**
 * Merges fields from duplicates into permanent lead.
 * - If permanent lead field is empty and duplicate has value, fills it.
 * - If both have non-empty but differing values, retains permanent lead's value
 *   and notes the conflict.
 * Returns { fieldsToUpdate, conflicts, mergedFieldsCount, noteText }
 */
function calculateMerge(permanentLead, duplicateLeads) {
  const permFields = { ...(permanentLead.fields || {}) };
  const fieldsToUpdate = {};
  const conflicts = [];
  const addedFields = {};

  for (const dup of duplicateLeads) {
    const dupFields = dup.fields || {};
    const dupId = dup._id || dup.id;

    for (const [key, val] of Object.entries(dupFields)) {
      if (EXCLUDED_UPDATE_FIELDS.has(key)) continue;
      if (!isNonEmpty(val)) continue;
      if (key === "name" && typeof val === "string" && val.startsWith("[DUPLICATE]")) continue;

      const currentPermVal = permFields[key];

      if (!isNonEmpty(currentPermVal)) {
        // Field was empty in permanent lead, merge it!
        permFields[key] = val;
        fieldsToUpdate[key] = val;
        addedFields[key] = { fromId: dupId, value: val };
      } else {
        // Field exists in both. Check if differing.
        const strPerm = typeof currentPermVal === "object" ? JSON.stringify(currentPermVal) : String(currentPermVal).trim();
        const strDup = typeof val === "object" ? JSON.stringify(val) : String(val).trim();

        if (strPerm !== strDup) {
          conflicts.push({
            field: key,
            keptValue: currentPermVal,
            discardedValue: val,
            fromLeadId: dupId,
          });
        }
      }
    }
  }

  // Generate system note text documenting merge
  const duplicateIds = duplicateLeads.map((d) => d._id || d.id);
  const nowStr = new Date().toISOString();
  let noteText = `[AUTOMATED MERGE - ${nowStr}]\n`;
  noteText += `Merged ${duplicateLeads.length} duplicate lead(s) into this permanent lead.\n`;
  noteText += `Duplicate Lead ID(s): ${duplicateIds.join(", ")}\n`;

  const addedKeys = Object.keys(addedFields);
  if (addedKeys.length > 0) {
    noteText += `Fields copied from duplicates:\n`;
    for (const k of addedKeys) {
      noteText += ` - ${k}: ${JSON.stringify(addedFields[k].value)} (from ${addedFields[k].fromId})\n`;
    }
  } else {
    noteText += `No new empty fields required copying.\n`;
  }

  if (conflicts.length > 0) {
    noteText += `Conflicting field values noted (kept permanent lead's value):\n`;
    for (const c of conflicts) {
      noteText += ` - ${c.field}: Kept [${c.keptValue}], Duplicate had [${c.discardedValue}] (from ${c.fromLeadId})\n`;
    }
  }

  return {
    fieldsToUpdate,
    addedFields,
    conflicts,
    duplicateIds,
    noteText,
    mergedFieldsCount: Object.keys(fieldsToUpdate).length,
  };
}

module.exports = {
  scoreLead,
  getLeadCreationTimestamp,
  pickPermanentLead,
  calculateMerge,
  EXCLUDED_UPDATE_FIELDS,
};
