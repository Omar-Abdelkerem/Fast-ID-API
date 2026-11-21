import { email_template, language_code } from '@prisma/client';
import { RenderedEmail } from './email-provider.interface';

type TemplatePayload = Record<string, unknown>;

function readString(payload: TemplatePayload, key: string): string {
  const value = payload[key];
  return typeof value === 'string' ? value : '';
}

/**
 * Renders bilingual (Arabic / English) email templates (Design §9, Contract §11).
 * Never includes passwords or delivery codes.
 */
export function renderEmailTemplate(params: {
  to: string;
  template: email_template;
  language: language_code;
  payload: TemplatePayload;
}): RenderedEmail {
  const { to, template, language, payload } = params;
  const isArabic = language === 'ar';

  switch (template) {
    case 'PASSWORD_RESET': {
      const resetUrl = readString(payload, 'resetUrl');
      return {
        to,
        template,
        language,
        subject: isArabic
          ? 'إعادة تعيين كلمة المرور — نظام Fast ID'
          : 'Reset your password — Fast ID System',
        text: isArabic
          ? `لقد طلبت إعادة تعيين كلمة المرور الخاصة بحسابك. استخدم الرابط التالي خلال 30 دقيقة:\n${resetUrl}\nإذا لم تطلب ذلك، يمكنك تجاهل هذه الرسالة.`
          : `You requested a password reset for your Fast ID account. Use the following link within 30 minutes:\n${resetUrl}\nIf you did not request this, you can safely ignore this message.`,
      };
    }

    case 'PASSWORD_CHANGED':
      return {
        to,
        template,
        language,
        subject: isArabic
          ? 'تم تغيير كلمة المرور — نظام Fast ID'
          : 'Your password was changed — Fast ID System',
        text: isArabic
          ? 'نؤكد لك أنه تم تغيير كلمة المرور الخاصة بحسابك في نظام Fast ID بنجاح. تم إنهاء جميع الجلسات الأخرى.'
          : 'This confirms that your Fast ID account password has been changed. All other active sessions have been signed out.',
      };

    default: {
      const appNumber = readString(payload, 'applicationNumber');
      return {
        to,
        template,
        language,
        subject: isArabic
          ? `تحديث من نظام Fast ID (${template})`
          : `Fast ID System update (${template})`,
        text: isArabic
          ? `يوجد تحديث جديد على طلبك ${appNumber}. يرجى تسجيل الدخول للاطلاع على التفاصيل.`
          : `There is a new update on your application ${appNumber}. Please sign in to view details.`,
      };
    }
  }
}
