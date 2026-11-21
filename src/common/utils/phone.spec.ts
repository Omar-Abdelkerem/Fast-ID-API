import { normalizePhone } from './phone';

describe('normalizePhone', () => {
  it('normalizes valid Egyptian mobile numbers across all accepted formats', () => {
    expect(normalizePhone('01012345678')).toBe('01012345678');
    expect(normalizePhone('+201112345678')).toBe('01112345678');
    expect(normalizePhone('201212345678')).toBe('01212345678');
    expect(normalizePhone('  +201512345678  ')).toBe('01512345678');
  });

  it('rejects invalid prefixes, lengths, or non-digits', () => {
    expect(normalizePhone('01312345678')).toBeNull();
    expect(normalizePhone('0101234567')).toBeNull();
    expect(normalizePhone('+2010123456789')).toBeNull();
    expect(normalizePhone('0201012345678')).toBeNull();
    expect(normalizePhone('not-a-phone')).toBeNull();
  });
});
