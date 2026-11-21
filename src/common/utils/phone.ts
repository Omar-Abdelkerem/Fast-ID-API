const EGYPTIAN_MOBILE_REGEX = /^01[0125][0-9]{8}$/;

/**
 * Normalizes Egyptian mobile numbers (Contract §0.12):
 * Accepts 01012345678, +201012345678, 201012345678 -> returns 01XXXXXXXXX or null if invalid.
 */
export function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim();
  let normalized = trimmed;

  if (normalized.startsWith('+20')) {
    normalized = `0${normalized.slice(3)}`;
  } else if (normalized.startsWith('20') && normalized.length === 12) {
    normalized = `0${normalized.slice(2)}`;
  }

  if (!EGYPTIAN_MOBILE_REGEX.test(normalized)) {
    return null;
  }

  return normalized;
}
