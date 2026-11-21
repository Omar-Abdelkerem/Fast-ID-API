import {
  application_status,
  application_status_history,
  applications,
  attachments,
  credentials,
  decision_outcome,
  deliveries,
  delivery_status,
  gender,
  governorate,
  payment_status,
  reject_reason_code,
  user_role,
  users,
} from '@prisma/client';
import { formatDateOnlyUtc } from '../../common/utils/dates';
import { maskNationalId } from '../../common/utils/mask';
import {
  CredentialResponse,
  mapCredentialResponse,
} from '../credentials/credential-response.mapper';
import { AdminDeliveryResponse, mapAdminDelivery } from '../deliveries/delivery-response.mapper';
import { DeliveryAddressValue } from '../services/application-data.validator';
import { LocalizedText, MoneyValue } from '../services/service-definition.types';
import {
  AttachmentResponse,
  deriveIsOverdue,
  mapAttachmentResponse,
} from './application-response.mapper';

export interface AdminApplicationListItemResponse {
  id: string;
  applicationNumber: string;
  service: { id: string; name: LocalizedText };
  status: application_status;
  citizen: {
    id: string;
    fullName: string;
    nationalIdMasked: string;
  };
  governorate: governorate | null;
  submittedAt: string | null;
  dueAt: string | null;
  isOverdue: boolean;
  paymentStatus: payment_status;
  deliveryStatus: delivery_status | null;
}

export interface AdminStatusHistoryItem {
  status: application_status;
  at: string;
  note: string | null;
  by: { id: string; fullName: string; role: user_role } | null;
}

/**
 * Contract §0.20 & Clarification C-9:
 * AdminApplication omits citizen `delivery` completely and exposes `deliveryRecord` only,
 * so `deliveryCode` never appears in any admin response.
 */
export interface AdminApplicationResponse {
  id: string;
  applicationNumber: string;
  service: { id: string; name: LocalizedText };
  serviceVersion: number;
  status: application_status;
  data: Record<string, unknown>;
  deliveryAddress: DeliveryAddressValue | null;
  payment: {
    status: payment_status;
    amount: MoneyValue;
    paidAt: string | null;
    reference: string | null;
  };
  attachments: AttachmentResponse[];
  submittedAt: string | null;
  dueAt: string | null;
  isOverdue: boolean;
  decision: {
    decidedAt: string;
    outcome: decision_outcome;
    reasonCode: reject_reason_code | null;
    reason: string | null;
    decidedBy: { id: string; fullName: string } | null;
  } | null;
  credential: CredentialResponse | null;
  deliveryRecord: AdminDeliveryResponse | null;
  citizen: {
    id: string;
    fullName: string;
    nationalId: string;
    birthDate: string;
    gender: gender;
    email: string;
    phone: string;
  };
  statusHistory: AdminStatusHistoryItem[];
  createdAt: string;
  updatedAt: string;
}

export function mapAdminApplicationListItem(params: {
  application: applications;
  serviceName: LocalizedText;
  citizen: Pick<users, 'id' | 'full_name' | 'national_id'>;
  deliveryStatus: delivery_status | null;
  now?: Date;
}): AdminApplicationListItemResponse {
  const { application, serviceName, citizen, deliveryStatus } = params;
  const now = params.now ?? new Date();
  const address = application.delivery_address as DeliveryAddressValue | null;

  return {
    id: application.id,
    applicationNumber: application.application_number,
    service: { id: application.service_id, name: serviceName },
    status: application.status,
    citizen: {
      id: citizen.id,
      fullName: citizen.full_name,
      nationalIdMasked: maskNationalId(citizen.national_id ?? ''),
    },
    governorate: address?.governorate ?? null,
    submittedAt: application.submitted_at ? application.submitted_at.toISOString() : null,
    dueAt: application.due_at ? application.due_at.toISOString() : null,
    isOverdue: deriveIsOverdue(application.status, application.due_at, now),
    paymentStatus: application.payment_status,
    deliveryStatus,
  };
}

export function mapAdminApplicationDetail(params: {
  application: applications;
  serviceName: LocalizedText;
  resolvedServiceVersion: number;
  citizen: Pick<
    users,
    'id' | 'full_name' | 'national_id' | 'birth_date' | 'gender' | 'email' | 'phone'
  >;
  decidedBy: Pick<users, 'id' | 'full_name'> | null;
  attachments: attachments[];
  statusHistory: Array<
    application_status_history & {
      users: Pick<users, 'id' | 'full_name' | 'role'> | null;
    }
  >;
  credential: credentials | null;
  delivery: (deliveries & { users: Pick<users, 'id' | 'full_name'> | null }) | null;
  now?: Date;
}): AdminApplicationResponse {
  const { application, serviceName, resolvedServiceVersion, citizen } = params;
  const now = params.now ?? new Date();
  const rawAddress = application.delivery_address as DeliveryAddressValue | null;
  const deliveryAddress: DeliveryAddressValue | null = rawAddress
    ? {
        ...rawAddress,
        notes: rawAddress.notes ?? null,
      }
    : null;

  return {
    id: application.id,
    applicationNumber: application.application_number,
    service: {
      id: application.service_id,
      name: serviceName,
    },
    serviceVersion: resolvedServiceVersion,
    status: application.status,
    data: (application.data as Record<string, unknown>) ?? {},
    deliveryAddress,
    payment: {
      status: application.payment_status,
      amount: { amount: application.payment_amount, currency: 'EGP' },
      paidAt: application.paid_at ? application.paid_at.toISOString() : null,
      reference: application.payment_reference ?? null,
    },
    attachments: params.attachments.map(mapAttachmentResponse),
    submittedAt: application.submitted_at ? application.submitted_at.toISOString() : null,
    dueAt: application.due_at ? application.due_at.toISOString() : null,
    isOverdue: deriveIsOverdue(application.status, application.due_at, now),
    decision:
      application.decision_outcome && application.decided_at
        ? {
            decidedAt: application.decided_at.toISOString(),
            outcome: application.decision_outcome,
            reasonCode: application.decision_reason_code ?? null,
            reason: application.decision_reason ?? null,
            decidedBy: params.decidedBy
              ? { id: params.decidedBy.id, fullName: params.decidedBy.full_name }
              : null,
          }
        : null,
    credential: params.credential
      ? mapCredentialResponse(params.credential, serviceName, now)
      : null,
    deliveryRecord:
      params.delivery && deliveryAddress
        ? mapAdminDelivery({
            delivery: params.delivery,
            applicationNumber: application.application_number,
            serviceId: application.service_id,
            serviceName,
            recipientName: citizen.full_name,
            deliveryAddress,
            agent: params.delivery.users,
          })
        : null,
    citizen: {
      id: citizen.id,
      fullName: citizen.full_name,
      nationalId: citizen.national_id ?? '',
      birthDate: citizen.birth_date ? formatDateOnlyUtc(citizen.birth_date) : '',
      gender: citizen.gender ?? 'MALE',
      email: citizen.email,
      phone: citizen.phone,
    },
    statusHistory: params.statusHistory.map((entry) => ({
      status: entry.status,
      at: entry.created_at.toISOString(),
      // Clarification C-6: staff_note when present, otherwise citizen_note
      note: entry.staff_note ?? entry.citizen_note ?? null,
      by: entry.users
        ? { id: entry.users.id, fullName: entry.users.full_name, role: entry.users.role }
        : null,
    })),
    createdAt: application.created_at.toISOString(),
    updatedAt: application.updated_at.toISOString(),
  };
}
