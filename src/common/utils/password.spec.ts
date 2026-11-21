import { validatePasswordStrength } from './password';

describe('validatePasswordStrength', () => {
  it('accepts valid passwords meeting all Contract §0.12 rules', () => {
    expect(
      validatePasswordStrength('SecurePass2026!', {
        email: 'ahmed.ali@example.com',
        nationalId: '29901150112314',
      }),
    ).toEqual({ valid: true });
  });

  it('rejects too short or too long passwords', () => {
    expect(validatePasswordStrength('Abc1234').valid).toBe(false);
    expect(validatePasswordStrength(`A1${'x'.repeat(127)}`).valid).toBe(false);
  });

  it('requires at least one letter and one digit', () => {
    expect(validatePasswordStrength('12345678').valid).toBe(false);
    expect(validatePasswordStrength('OnlyLettersHere').valid).toBe(false);
  });

  it('rejects passwords containing email local part when >= 3 chars (case-insensitive)', () => {
    expect(validatePasswordStrength('MyAHMED123!', { email: 'ahmed@example.com' }).valid).toBe(
      false,
    );
    // 2-char local part is NOT banned per Contract §0.12
    expect(validatePasswordStrength('Myab12345!', { email: 'ab@example.com' }).valid).toBe(true);
  });

  it('rejects passwords containing the national ID', () => {
    expect(
      validatePasswordStrength('Pass29901150112314!', { nationalId: '29901150112314' }).valid,
    ).toBe(false);
  });
});
