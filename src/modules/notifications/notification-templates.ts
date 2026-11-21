import { notification_type } from '@prisma/client';

export interface NotificationContent {
  title: { ar: string; en: string };
  body: { ar: string; en: string };
}

export interface NotificationTemplateParams {
  applicationNumber?: string;
  credentialNumber?: string;
}

export function buildNotificationContent(
  type: notification_type,
  params: NotificationTemplateParams = {},
): NotificationContent {
  const appNo = params.applicationNumber ?? '';
  const credNo = params.credentialNumber ?? '';

  switch (type) {
    case 'APPLICATION_SUBMITTED':
      return {
        title: { ar: 'تم استلام طلبك', en: 'Application received' },
        body: {
          ar: `تم تقديم طلبك رقم ${appNo} بنجاح وجارٍ إدراجه للمراجعة.`,
          en: `Your application ${appNo} has been submitted and queued for review.`,
        },
      };
    case 'APPLICATION_CANCELLED':
      return {
        title: { ar: 'تم إلغاء الطلب', en: 'Application cancelled' },
        body: {
          ar: `تم إلغاء طلبك رقم ${appNo}.`,
          en: `Your application ${appNo} has been cancelled.`,
        },
      };
    case 'APPLICATION_UNDER_REVIEW':
      return {
        title: { ar: 'طلبك قيد المراجعة', en: 'Application under review' },
        body: {
          ar: `بدأ الموظف المختص في مراجعة طلبك رقم ${appNo}.`,
          en: `Staff have started reviewing your application ${appNo}.`,
        },
      };
    case 'APPLICATION_APPROVED':
      return {
        title: { ar: 'تمت الموافقة على طلبك', en: 'Application approved' },
        body: {
          ar: `تمت الموافقة على طلبك رقم ${appNo} وإصدار الوثيقة رقم ${credNo}.`,
          en: `Your application ${appNo} was approved and credential ${credNo} has been issued.`,
        },
      };
    case 'APPLICATION_REJECTED':
      return {
        title: { ar: 'تم رفض الطلب', en: 'Application rejected' },
        body: {
          ar: `تم رفض طلبك رقم ${appNo}. يرجى مراجعة سبب الرفض داخل تفاصيل الطلب.`,
          en: `Your application ${appNo} was rejected. Please review the reason in your application details.`,
        },
      };
    case 'CREDENTIAL_REVOKED':
      return {
        title: { ar: 'تم إلغاء الوثيقة', en: 'Credential revoked' },
        body: {
          ar: `تم إلغاء الوثيقة رقم ${credNo} المرتبطة بطلبك ${appNo}.`,
          en: `Credential ${credNo} linked to application ${appNo} has been revoked.`,
        },
      };
    case 'DELIVERY_ASSIGNED':
      return {
        title: { ar: 'تم تعيين مهمة توصيل جديدة', en: 'New delivery assigned' },
        body: {
          ar: `تم تعيين مهمة توصيل للطلب رقم ${appNo} لك.`,
          en: `A delivery for application ${appNo} has been assigned to you.`,
        },
      };
    case 'DELIVERY_OUT_FOR_DELIVERY':
      return {
        title: { ar: 'طلبك في الطريق للتوصيل', en: 'Out for delivery' },
        body: {
          ar: `طلبك رقم ${appNo} خرج للتوصيل. يمكنك الاطلاع على كود الاستلام وبيانات المندوب في تفاصيل الطلب.`,
          en: `Your application ${appNo} is out for delivery. View your delivery code and agent details in the app.`,
        },
      };
    case 'DELIVERY_FAILED_ATTEMPT':
      return {
        title: { ar: 'تعذّر تسليم الطلب', en: 'Delivery attempt failed' },
        body: {
          ar: `تعذّر تسليم طلبك رقم ${appNo}. سيتم إعادة جدولة التوصيل قريباً.`,
          en: `Delivery attempt failed for application ${appNo}. It will be rescheduled shortly.`,
        },
      };
    case 'DELIVERY_COMPLETED':
      return {
        title: { ar: 'تم تسليم الطلب بنجاح', en: 'Delivery completed' },
        body: {
          ar: `تم تسليم طلبك رقم ${appNo} بنجاح.`,
          en: `Your application ${appNo} has been delivered.`,
        },
      };
  }
}
