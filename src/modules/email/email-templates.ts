import { email_template, language_code } from '@prisma/client';
import { RenderedEmail } from './email-provider.interface';

type TemplatePayload = Record<string, unknown>;

function readString(payload: TemplatePayload, key: string): string {
  const value = payload[key];
  return typeof value === 'string' ? value : '';
}

/**
 * Renders bilingual (Arabic / English) templates for all 9 email_template values
 * (Contract §11, Design §9). Never includes passwords or delivery codes.
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
    case 'APPLICATION_SUBMITTED': {
      const appNo = readString(payload, 'applicationNumber');
      return {
        to,
        template,
        language,
        subject: isArabic
          ? `تم استلام طلبك ${appNo} — نظام Fast ID`
          : `We received your application ${appNo} — Fast ID System`,
        text: isArabic
          ? `تم استلام طلبك رقم ${appNo} بنجاح. سنقوم بمراجعته وإخطارك فور وجود أي تحديث.`
          : `We have received your application ${appNo}. We will review it and notify you as soon as there is an update.`,
      };
    }

    case 'APPLICATION_APPROVED': {
      const appNo = readString(payload, 'applicationNumber');
      const credNo = readString(payload, 'credentialNumber');
      return {
        to,
        template,
        language,
        subject: isArabic
          ? `تمت الموافقة على طلبك ${appNo} — نظام Fast ID`
          : `Your application ${appNo} was approved — Fast ID System`,
        text: isArabic
          ? `يسعدنا إبلاغك بالموافقة على طلبك رقم ${appNo}. تم إصدار وثيقتك برقم ${credNo} وجارٍ تجهيزها للتوصيل.`
          : `Your application ${appNo} has been approved. Your credential number is ${credNo} and delivery is being arranged.`,
      };
    }

    case 'APPLICATION_REJECTED': {
      const appNo = readString(payload, 'applicationNumber');
      const reason = readString(payload, 'reason');
      return {
        to,
        template,
        language,
        subject: isArabic
          ? `تحديث بخصوص طلبك ${appNo} — نظام Fast ID`
          : `Update on your application ${appNo} — Fast ID System`,
        text: isArabic
          ? `نأسف لإبلاغك بأنه تم رفض طلبك رقم ${appNo}.\nالسبب: ${reason}\nيمكنك تقديم طلب جديد بعد استيفاء المطلوب.`
          : `Your application ${appNo} was not approved.\nReason: ${reason}\nYou may submit a new application once the issue is resolved.`,
      };
    }

    case 'CREDENTIAL_REVOKED': {
      const appNo = readString(payload, 'applicationNumber');
      const credNo = readString(payload, 'credentialNumber');
      return {
        to,
        template,
        language,
        subject: isArabic
          ? `إلغاء الوثيقة ${credNo} — نظام Fast ID`
          : `Credential ${credNo} revoked — Fast ID System`,
        text: isArabic
          ? `نحيطك علماً بأنه تم إلغاء الوثيقة رقم ${credNo} المرتبطة بالطلب رقم ${appNo}. يرجى التواصل مع الدعم لمزيد من المعلومات.`
          : `Please be informed that credential ${credNo} linked to application ${appNo} has been revoked. Contact support if you have questions.`,
      };
    }

    case 'DELIVERY_OUT_FOR_DELIVERY': {
      const appNo = readString(payload, 'applicationNumber');
      const agentFirstName = readString(payload, 'agentFirstName');
      return {
        to,
        template,
        language,
        subject: isArabic
          ? `طلبك ${appNo} في الطريق للتوصيل — نظام Fast ID`
          : `Your application ${appNo} is out for delivery — Fast ID System`,
        text: isArabic
          ? `طلبك رقم ${appNo} خرج للتوصيل مع المندوب ${agentFirstName}. يمكنك العثور على كود الاستلام وبيانات المندوب داخل التطبيق.`
          : `Your application ${appNo} is out for delivery with agent ${agentFirstName}. Open the Fast ID app to view your delivery code and contact details.`,
      };
    }

    case 'DELIVERY_FAILED_ATTEMPT': {
      const appNo = readString(payload, 'applicationNumber');
      return {
        to,
        template,
        language,
        subject: isArabic
          ? `تعذّر تسليم طلبك ${appNo} — نظام Fast ID`
          : `Delivery attempt failed for ${appNo} — Fast ID System`,
        text: isArabic
          ? `تعذّر تسليم طلبك رقم ${appNo} في المحاولة الأخيرة. سيتم إعادة تعيين التوصيل وإبلاغك قريباً.`
          : `The recent delivery attempt for your application ${appNo} was unsuccessful. A new delivery attempt will be scheduled shortly.`,
      };
    }

    case 'DELIVERY_COMPLETED': {
      const appNo = readString(payload, 'applicationNumber');
      return {
        to,
        template,
        language,
        subject: isArabic
          ? `تم تسليم طلبك ${appNo} بنجاح — نظام Fast ID`
          : `Your application ${appNo} has been delivered — Fast ID System`,
        text: isArabic
          ? `تم تسليم طلبك رقم ${appNo} بنجاح. شكراً لاستخدامك نظام Fast ID.`
          : `Your application ${appNo} has been delivered successfully. Thank you for using Fast ID System.`,
      };
    }

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
  }
}
