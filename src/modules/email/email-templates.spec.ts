import { renderEmailTemplate } from './email-templates';

describe('renderEmailTemplate', () => {
  it('renders PASSWORD_RESET in Arabic and English with the reset URL', () => {
    const ar = renderEmailTemplate({
      to: 'citizen@example.com',
      template: 'PASSWORD_RESET',
      language: 'ar',
      payload: { resetUrl: 'https://app.example.test/reset-password?token=abc' },
    });
    expect(ar.subject).toContain('Fast ID');
    expect(ar.text).toContain('https://app.example.test/reset-password?token=abc');

    const en = renderEmailTemplate({
      to: 'citizen@example.com',
      template: 'PASSWORD_RESET',
      language: 'en',
      payload: { resetUrl: 'https://app.example.test/reset-password?token=abc' },
    });
    expect(en.subject).toContain('Reset your password');
    expect(en.text).toContain('https://app.example.test/reset-password?token=abc');
  });

  it('renders PASSWORD_CHANGED in Arabic and English', () => {
    const ar = renderEmailTemplate({
      to: 'citizen@example.com',
      template: 'PASSWORD_CHANGED',
      language: 'ar',
      payload: {},
    });
    expect(ar.text).toContain('تغيير كلمة المرور');

    const en = renderEmailTemplate({
      to: 'citizen@example.com',
      template: 'PASSWORD_CHANGED',
      language: 'en',
      payload: {},
    });
    expect(en.text).toContain('password has been changed');
  });
});
