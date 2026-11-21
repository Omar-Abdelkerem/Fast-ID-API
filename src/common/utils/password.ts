export interface PasswordPolicyContext {
  email?: string;
  nationalId?: string | null;
}

export interface PasswordValidationResult {
  valid: boolean;
  code?: 'TOO_SHORT' | 'TOO_LONG' | 'INVALID_FORMAT' | 'INVALID_VALUE';
  message?: string;
}

/**
 * Validates password strength rules per Contract §0.12:
 * - 8-128 characters
 * - At least one letter and one digit
 * - Must not contain the account's email local part (when >= 3 chars, case-insensitive)
 * - Must not contain the account's national ID
 */
export function validatePasswordStrength(
  password: string,
  context: PasswordPolicyContext = {},
): PasswordValidationResult {
  if (password.length < 8) {
    return {
      valid: false,
      code: 'TOO_SHORT',
      message: 'Password must be at least 8 characters long.',
    };
  }

  if (password.length > 128) {
    return {
      valid: false,
      code: 'TOO_LONG',
      message: 'Password must be at most 128 characters long.',
    };
  }

  if (!/\p{L}/u.test(password) || !/[0-9]/.test(password)) {
    return {
      valid: false,
      code: 'INVALID_FORMAT',
      message: 'Password must contain at least one letter and one digit.',
    };
  }

  if (context.email) {
    const atIndex = context.email.indexOf('@');
    const localPart = atIndex > 0 ? context.email.slice(0, atIndex) : '';
    if (localPart.length >= 3 && password.toLowerCase().includes(localPart.toLowerCase())) {
      return {
        valid: false,
        code: 'INVALID_VALUE',
        message: 'Password must not contain your email username.',
      };
    }
  }

  if (context.nationalId && password.includes(context.nationalId)) {
    return {
      valid: false,
      code: 'INVALID_VALUE',
      message: 'Password must not contain your national ID.',
    };
  }

  return { valid: true };
}
