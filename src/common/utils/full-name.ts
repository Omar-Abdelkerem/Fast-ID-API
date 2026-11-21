const ALLOWED_NAME_CHARS_REGEX = /^[\p{Script=Arabic}\p{Script=Latin} '.-]+$/u;
const HAS_LETTER_REGEX = /[\p{Script=Arabic}\p{Script=Latin}]/u;

/**
 * Collapses internal whitespace and trims a fullName (Contract §0.12).
 */
export function normalizeFullName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

/**
 * Validates fullName per Contract §0.12:
 * - 3-100 characters after trimming and collapsing internal whitespace
 * - At least 2 words
 * - Unicode letters (Arabic or Latin), spaces, ', -, . only
 */
export function isValidFullName(raw: string): boolean {
  const normalized = normalizeFullName(raw);
  if (normalized.length < 3 || normalized.length > 100) {
    return false;
  }
  if (!ALLOWED_NAME_CHARS_REGEX.test(normalized)) {
    return false;
  }
  const words = normalized.split(' ').filter((word) => HAS_LETTER_REGEX.test(word));
  return words.length >= 2;
}
