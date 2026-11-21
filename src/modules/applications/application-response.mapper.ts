import {
  application_status,
  application_status_history,
  applications,
  attachments,
  credential_status,
  credentials,
  decision_outcome,
  deliveries,
  delivery_failure_code,
  delivery_status,
  payment_status,
  reject_reason_code,
  users,
} from '@prisma/client';
import { DeliveryAddressValue } from '../services/application-data.validator';
import { LocalizedText, MoneyValue } from '../services/service-definition.types';

export interface AttachmentResponse {
  id: string;
  requirementKey: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedAt: string;
}

export interface CredentialSummaryResponse {
  id: string;
  number: string;
  status: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
  issuedAt: string;
  expiresAt: string | null;
}

export interface DeliveryTrackingResponse {
  status: delivery_status;
  attempts: number;
  agent: { fullName: string; phone: string } | null;
  deliveryCode: string | null;
  lastFailure: {
    reasonCode: delivery_failure_code;
    reason: string | null;
    at: string;
  } | null;
}

export interface ApplicationStatusHistoryItem {
  status: application_status;
  at: string;
  note: string | null;
}

export interface CitizenApplicationResponse {
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
  } | null;
  credential: CredentialSummaryResponse | null;
  delivery: DeliveryTrackingResponse | null;
  statusHistory: ApplicationStatusHistoryItem[];
  createdAt: string;
  updatedAt: string;
}

export function deriveCredentialStatus(
  status: credential_status,
  expiresAt: Date | null,
  now: Date = new Date(),
): 'ACTIVE' | 'REVOKED' | 'EXPIRED' {
  if (status === 'REVOKED') {
    return 'REVOKED';
  }
  if (expiresAt !== null && expiresAt.getTime() < now.getTime()) {
    return 'EXPIRED';
  }
  return 'ACTIVE';
}

export function deriveIsOverdue(
  status: application_status,
  dueAt: Date | null,
  now: Date = new Date(),
): boolean {
  if (!dueAt) {
    return false;
  }
  if (status !== 'SUBMITTED' && status !== 'UNDER_REVIEW') {
    return false;
  }
  return dueAt.getTime() < now.getTime();
}

export function mapAttachmentResponse(row: attachments): AttachmentResponse {
  return {
    id: row.id,
    requirementKey: row.requirement_key,
    originalName: row.original_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    uploadedAt: row.uploaded_at.toISOString(),
  };
}

export function mapCredentialSummary(
  row: credentials,
  now: Date = new Date(),
): CredentialSummaryResponse {
  return {
    id: row.id,
    number: row.number,
    status: deriveCredentialStatus(row.status, row.expires_at, now),
    issuedAt: row.issued_at.toISOString(),
    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
  };
}

export function mapDeliveryTracking(
  row: deliveries & { users?: Pick<users, 'full_name' | 'phone'> | null },
): DeliveryTrackingResponse {
  const isOut = row.status === 'OUT_FOR_DELIVERY';

  return {
    status: row.status,
    attempts: row.attempts,
    agent:
      isOut && row.users
        ? {
            fullName: row.users.full_name,
            phone: row.users.phone,
          }
        : null,
    deliveryCode: isOut ? (row.delivery_code ?? null) : null,
    lastFailure:
      row.last_failure_code && row.last_failure_at
        ? {
            reasonCode: row.last_failure_code,
            reason: row.last_failure_reason ?? null,
            at: row.last_failure_at.toISOString(),
          }
        : null,
  };
}

export interface CitizenApplicationMapperInput {
  application: applications;
  serviceName: LocalizedText;
  resolvedServiceVersion: number;
  attachments?: attachments[];
  statusHistory?: application_status_history[];
  credential?: credentials | null;
  delivery?: (deliveries & { users?: Pick<users, 'full_name' | 'phone'> | null }) | null;
  paymentOverride?: { status: payment_status; amount: number };
  listMode?: boolean;
  now?: Date;
}

export function mapCitizenApplication(
  input: CitizenApplicationMapperInput,
): CitizenApplicationResponse {
  const { application, serviceName, resolvedServiceVersion, listMode = false } = input;
  const now = input.now ?? new Date();
  const paymentStatus = input.paymentOverride?.status ?? application.payment_status;
  const paymentAmount = input.paymentOverride?.amount ?? application.payment_amount;

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
      status: paymentStatus,
      amount: { amount: paymentAmount, currency: 'EGP' },
      paidAt: application.paid_at ? application.paid_at.toISOString() : null,
      reference: application.payment_reference ?? null,
    },
    attachments: listMode ? [] : (input.attachments ?? []).map(mapAttachmentResponse),
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
          }
        : null,
    credential: input.credential ? mapCredentialSummary(input.credential, now) : null,
    delivery: input.delivery ? mapDeliveryTracking(input.delivery) : null,
    statusHistory: listMode
      ? []
      : (input.statusHistory ?? []).map((entry) => ({
          status: entry.status,
          at: entry.created_at.toISOString(),
          note: entry.citizen_note ?? null,
        })),
    createdAt: application.created_at.toISOString(),
    updatedAt: application.updated_at.toISOString(),
  };
}
