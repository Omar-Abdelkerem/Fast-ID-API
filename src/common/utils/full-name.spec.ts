import { isValidFullName, normalizeFullName } from './full-name';

describe('fullName utils', () => {
  it('normalizes whitespace and validates Arabic and Latin names', () => {
    expect(normalizeFullName('  Ahmed   Mohamed  Ali ')).toBe('Ahmed Mohamed Ali');
    expect(isValidFullName('Ahmed Mohamed')).toBe(true);
    expect(isValidFullName("O'Connor Al-Mansour")).toBe(true);
    expect(isValidFullName('أحمد محمد علي')).toBe(true);
  });

  it('rejects single-word names, digits, symbols, and out-of-range lengths', () => {
    expect(isValidFullName('Ahmed')).toBe(false);
    expect(isValidFullName('Ahmed 123')).toBe(false);
    expect(isValidFullName('Ahmed @Ali')).toBe(false);
    expect(isValidFullName('A B'.repeat(40))).toBe(false);
  });
});
