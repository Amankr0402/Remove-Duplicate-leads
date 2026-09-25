const config = require("./config");

/**
 * Normalizes an Indian/international phone number.
 * For default country code 91:
 * - Strips all non-digit characters.
 * - Extracts standard 10-digit mobile number if length >= 10.
 * - Formats as 91XXXXXXXXXX.
 * Returns null if invalid / cannot be parsed.
 */
function normalizePhone(rawPhone, countryCode = config.defaultCountryCode) {
  if (!rawPhone) return null;
  const str = String(rawPhone).trim();
  // Strip all non-digit characters
  const digits = str.replace(/\D/g, "");

  if (countryCode === "91") {
    // Expected Indian mobile is 10 digits starting with 5,6,7,8,9
    if (digits.length === 10) {
      return `91${digits}`;
    }
    if (digits.length === 11 && digits.startsWith("0")) {
      return `91${digits.slice(1)}`;
    }
    if (digits.length === 12 && digits.startsWith("91")) {
      return digits;
    }
    if (digits.length > 10) {
      // If ends with 10 digits
      const last10 = digits.slice(-10);
      return `91${last10}`;
    }
    return null; // Less than 10 digits
  }

  // Fallback for general country codes
  if (digits.length >= 7) {
    if (digits.startsWith(countryCode)) {
      return digits;
    }
    return `${countryCode}${digits}`;
  }

  return null;
}

/**
 * Generates variants of a phone number to search across TeleCRM.
 * E.g. for "919409428717":
 * ["919409428717", "+919409428717", "9409428717", "09409428717"]
 */
function getPhoneSearchVariants(rawPhone, countryCode = config.defaultCountryCode) {
  const normalized = normalizePhone(rawPhone, countryCode);
  if (!normalized) {
    if (!rawPhone) return [];
    const clean = String(rawPhone).trim();
    return clean ? [clean] : [];
  }

  const variants = new Set();
  variants.add(normalized); // e.g. 919409428717
  variants.add(`+${normalized}`); // e.g. +919409428717

  if (countryCode === "91" && normalized.startsWith("91") && normalized.length === 12) {
    const raw10 = normalized.slice(2);
    variants.add(raw10); // e.g. 9409428717
    variants.add(`0${raw10}`); // e.g. 09409428717
    variants.add(`+91 ${raw10}`);
    variants.add(`+91-${raw10}`);
  }

  return Array.from(variants);
}

module.exports = {
  normalizePhone,
  getPhoneSearchVariants,
};
