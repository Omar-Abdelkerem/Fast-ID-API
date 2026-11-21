/**
 * Masks an Egyptian 14-digit national ID showing first 2 and last 2 digits with 10 asterisks:
 * e.g. 29901011234545 -> 29**********45 (Contract §0.20, §7.2).
 */
export function maskNationalId(nationalId: string): string {
  return `${nationalId.slice(0, 2)}**********${nationalId.slice(-2)}`;
}

/**
 * Masks a credential holder name: first word in full, every other word reduced to
 * its first character followed by a period (e.g. "Ahmed Mohamed Kamal" -> "Ahmed M. K.", Contract §5.3).
 */
export function maskHolderName(fullName: string): string {
  const words = fullName.trim().split(/\s+/).filter(Boolean);
  if (words.length <= 1) {
    return words[0] ?? '';
  }

  const [first, ...rest] = words;
  const maskedRest = rest.map((word) => `${Array.from(word)[0] ?? ''}.`);
  return [first, ...maskedRest].join(' ');
}
