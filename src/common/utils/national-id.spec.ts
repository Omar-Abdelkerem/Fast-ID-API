import { parseNationalId } from './national-id';

describe('parseNationalId', () => {
  it('parses valid 1900s male and 2000s female national IDs', () => {
    const male = parseNationalId('29901150112314', new Date('2026-11-21T12:00:00Z'));
    expect(male).toEqual({
      valid: true,
      birthDate: '1999-01-15',
      birthDateObj: new Date('1999-01-15T00:00:00.000Z'),
      gender: 'MALE',
    });

    const female = parseNationalId('30402298812324', new Date('2026-11-21T12:00:00Z'));
    expect(female).toEqual({
      valid: true,
      birthDate: '2004-02-29',
      birthDateObj: new Date('2004-02-29T00:00:00.000Z'),
      gender: 'FEMALE',
    });
  });

  it('rejects wrong length or non-digits', () => {
    expect(parseNationalId('2990115011231')).toEqual({ valid: false });
    expect(parseNationalId('299011501123140')).toEqual({ valid: false });
    expect(parseNationalId('2990115011231a')).toEqual({ valid: false });
  });

  it('rejects invalid century digit', () => {
    expect(parseNationalId('19901150112314')).toEqual({ valid: false });
    expect(parseNationalId('49901150112314')).toEqual({ valid: false });
  });

  it('rejects invalid calendar dates (non-leap Feb 29, month 13, day 32)', () => {
    expect(parseNationalId('30102290112314')).toEqual({ valid: false });
    expect(parseNationalId('29913010112314')).toEqual({ valid: false });
    expect(parseNationalId('29901320112314')).toEqual({ valid: false });
  });

  it('rejects future dates using Africa/Cairo calendar day', () => {
    // 2026-11-21 22:30 UTC is already 2026-11-22 00:30 in Africa/Cairo (UTC+2)
    const cairoNextDay = new Date('2026-11-21T22:30:00Z');
    expect(parseNationalId('32611220112314', cairoNextDay).valid).toBe(true);
    expect(parseNationalId('32611230112314', cairoNextDay).valid).toBe(false);

    // 2026-11-21 21:30 UTC is still 2026-11-21 23:30 in Africa/Cairo
    const cairoSameDay = new Date('2026-11-21T21:30:00Z');
    expect(parseNationalId('32611220112314', cairoSameDay).valid).toBe(false);
  });

  it('rejects invalid birth governorate codes', () => {
    expect(parseNationalId('29901150512314')).toEqual({ valid: false });
    expect(parseNationalId('29901151012314')).toEqual({ valid: false });
    expect(parseNationalId('29901159912314')).toEqual({ valid: false });
  });
});
