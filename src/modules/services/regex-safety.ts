import safeRegex from 'safe-regex2';

export interface RegexSafetyResult {
  safe: boolean;
  reason?: string;
}

/**
 * Checks for backreferences (\1-\9, \k<...>) and lookarounds ((?=, (?!, (?<=, (?<!)
 * outside character classes, respecting escaped backslashes (Design D-22).
 */
function hasDisallowedRegexConstruct(pattern: string): string | null {
  let inCharClass = false;

  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];

    if (ch === '\\') {
      const next = pattern[i + 1];
      if (!inCharClass && next !== undefined) {
        if (next >= '1' && next <= '9') {
          return 'Numeric backreferences are not allowed in regex patterns.';
        }
        if (next === 'k' && pattern[i + 2] === '<') {
          return 'Named backreferences are not allowed in regex patterns.';
        }
      }
      // Skip escaped character
      i += 1;
      continue;
    }

    if (ch === '[' && !inCharClass) {
      inCharClass = true;
      continue;
    }

    if (ch === ']' && inCharClass) {
      inCharClass = false;
      continue;
    }

    if (!inCharClass && ch === '(' && pattern[i + 1] === '?') {
      const third = pattern[i + 2];
      const fourth = pattern[i + 3];
      if (third === '=' || third === '!') {
        return 'Lookahead assertions are not allowed in regex patterns.';
      }
      if (third === '<' && (fourth === '=' || fourth === '!')) {
        return 'Lookbehind assertions are not allowed in regex patterns.';
      }
    }
  }

  return null;
}

/**
 * Validates admin-defined form field regex patterns per Design D-22 and Contract §0.20:
 * - 1..200 chars
 * - No backreferences or lookarounds
 * - Must compile with RegExp
 * - Must pass safe-regex2
 */
export function checkRegexSafety(pattern: string): RegexSafetyResult {
  if (pattern.length === 0) {
    return { safe: false, reason: 'pattern must not be empty.' };
  }
  if (pattern.length > 200) {
    return { safe: false, reason: 'pattern must be at most 200 characters.' };
  }

  const disallowed = hasDisallowedRegexConstruct(pattern);
  if (disallowed) {
    return { safe: false, reason: disallowed };
  }

  try {
    new RegExp(pattern);
  } catch {
    return { safe: false, reason: 'pattern is not a valid regular expression.' };
  }

  if (!safeRegex(pattern)) {
    return { safe: false, reason: 'pattern failed ReDoS safety check.' };
  }

  return { safe: true };
}
