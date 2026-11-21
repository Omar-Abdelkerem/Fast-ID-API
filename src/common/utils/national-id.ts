import { getCairoDateString, parseDateOnlyUtc } from './dates';

const VALID_BIRTH_GOVERNORATE_CODES = new Set([
  '01',
  '02',
  '03',
  '04',
  '11',
  '12',
  '13',
  '14',
  '15',
  '16',
  '17',
  '18',
  '19',
  '21',
  '22',
  '23',
  '24',
  '25',
  '26',
  '27',
  '28',
  '29',
  '31',
  '32',
  '33',
  '34',
  '35',
  '88',
]);

export type ParsedNationalId =
  | {
      valid: true;
      birthDate: string;
      birthDateObj: Date;
      gender: 'MALE' | 'FEMALE';
    }
  | {
      valid: false;
    };

/**
 * Validates Egyptian 14-digit national ID structure and derives birthDate & gender (Contract §1.1, Design §7.3).
 * Uses Africa/Cairo today's calendar date for the "not in the future" check.
 */
export function parseNationalId(raw: string, now: Date = new Date()): ParsedNationalId {
  if (!/^[0-9]{14}$/.test(raw)) {
    return { valid: false };
  }

  const centuryDigit = raw[0];
  let centuryBase: number;
  if (centuryDigit === '2') {
    centuryBase = 1900;
  } else if (centuryDigit === '3') {
    centuryBase = 2000;
  } else {
    return { valid: false };
  }

  const yy = Number.parseInt(raw.slice(1, 3), 10);
  const mm = raw.slice(3, 5);
  const dd = raw.slice(5, 7);
  const year = centuryBase + yy;
  const birthDate = `${year}-${mm}-${dd}`;

  const birthDateObj = parseDateOnlyUtc(birthDate);
  if (!birthDateObj) {
    return { valid: false };
  }

  const cairoToday = getCairoDateString(now);
  if (birthDate > cairoToday) {
    return { valid: false };
  }

  const birthGovCode = raw.slice(7, 9);
  if (!VALID_BIRTH_GOVERNORATE_CODES.has(birthGovCode)) {
    return { valid: false };
  }

  const genderDigit = Number.parseInt(raw[12], 10);
  const gender: 'MALE' | 'FEMALE' = genderDigit % 2 === 1 ? 'MALE' : 'FEMALE';

  return {
    valid: true,
    birthDate,
    birthDateObj,
    gender,
  };
}
