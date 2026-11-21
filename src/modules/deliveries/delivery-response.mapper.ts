import { deliveries, delivery_failure_code, delivery_status, users } from '@prisma/client';
import { DeliveryAddressValue } from '../services/application-data.validator';
import { LocalizedText } from '../services/service-definition.types';

export interface AdminDeliveryResponse {
  id: string;
  applicationId: string;
  applicationNumber: string;
  service: { id: string; name: LocalizedText };
  status: delivery_status;
  attempts: number;
  recipientName: string;
  address: DeliveryAddressValue;
  agent: { id: string; fullName: string } | null;
  assignedAt: string | null;
  outForDeliveryAt: string | null;
  deliveredAt: string | null;
  lastFailure: {
    reasonCode: delivery_failure_code;
    reason: string | null;
    at: string;
  } | null;
  createdAt: string;
  updatedAt: string;
}

export interface MapAdminDeliveryInput {
  delivery: deliveries;
  applicationNumber: string;
  serviceId: string;
  serviceName: LocalizedText;
  recipientName: string;
  deliveryAddress: DeliveryAddressValue;
  agent?: Pick<users, 'id' | 'full_name'> | null;
}

/**
 * Maps a delivery row to AdminDelivery (used for both admin and agent views, Contract §0.20).
 * Strictly omits deliveryCode, nationalId, attachments, and email.
 */
export function mapAdminDelivery(input: MapAdminDeliveryInput): AdminDeliveryResponse {
  const { delivery, deliveryAddress } = input;

  return {
    id: delivery.id,
    applicationId: delivery.application_id,
    applicationNumber: input.applicationNumber,
    service: {
      id: input.serviceId,
      name: input.serviceName,
    },
    status: delivery.status,
    attempts: delivery.attempts,
    recipientName: input.recipientName,
    address: {
      ...deliveryAddress,
      notes: deliveryAddress.notes ?? null,
    },
    agent: input.agent
      ? {
          id: input.agent.id,
          fullName: input.agent.full_name,
        }
      : null,
    assignedAt: delivery.assigned_at ? delivery.assigned_at.toISOString() : null,
    outForDeliveryAt: delivery.out_for_delivery_at
      ? delivery.out_for_delivery_at.toISOString()
      : null,
    deliveredAt: delivery.delivered_at ? delivery.delivered_at.toISOString() : null,
    lastFailure:
      delivery.last_failure_code && delivery.last_failure_at
        ? {
            reasonCode: delivery.last_failure_code,
            reason: delivery.last_failure_reason ?? null,
            at: delivery.last_failure_at.toISOString(),
          }
        : null,
    createdAt: delivery.created_at.toISOString(),
    updatedAt: delivery.updated_at.toISOString(),
  };
}
