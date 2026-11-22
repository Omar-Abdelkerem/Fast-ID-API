import { email_template, language_code } from '@prisma/client';
import { renderEmailTemplate } from './email-templates';

const ALL_TEMPLATES: readonly email_template[] = [
  'APPLICATION_SUBMITTED',
  'APPLICATION_APPROVED',
  'APPLICATION_REJECTED',
  'CREDENTIAL_REVOKED',
  'DELIVERY_OUT_FOR_DELIVERY',
  'DELIVERY_FAILED_ATTEMPT',
  'DELIVERY_COMPLETED',
  'PASSWORD_RESET',
  'PASSWORD_CHANGED',
];

const LANGUAGES: readonly language_code[] = ['ar', 'en'];

describe('renderEmailTemplate (all 9 templates x ar/en)', () => {
  it.each(ALL_TEMPLATES)('renders %s cleanly in both ar and en', (template) => {
    for (const language of LANGUAGES) {
      const rendered = renderEmailTemplate({
        to: 'citizen@example.com',
        template,
        language,
        payload: {
          applicationNumber: 'APP-2026-000042',
          credentialNumber: 'CRD-12345ABCDE',
          reason: 'Document scan was blurry.',
          agentFirstName: 'Karim',
          resetUrl: 'https://app.example.test/reset-password?token=tok123',
        },
      });

      expect(rendered.to).toBe('citizen@example.com');
      expect(rendered.template).toBe(template);
      expect(rendered.language).toBe(language);
      expect(rendered.subject.trim().length).toBeGreaterThan(5);
      expect(rendered.text.trim().length).toBeGreaterThan(10);
    }
  });

  it('includes agent first name and instructs citizen to check the app (never a delivery code) on DELIVERY_OUT_FOR_DELIVERY', () => {
    const en = renderEmailTemplate({
      to: 'citizen@example.com',
      template: 'DELIVERY_OUT_FOR_DELIVERY',
      language: 'en',
      payload: {
        applicationNumber: 'APP-2026-000042',
        agentFirstName: 'Karim',
        deliveryCode: '999999', // even if accidentally passed, must NEVER appear!
      },
    });
    expect(en.text).toContain('Karim');
    expect(en.text).toContain('delivery code');
    expect(en.text).not.toContain('999999');
  });
});
