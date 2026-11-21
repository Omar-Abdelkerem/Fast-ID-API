import { credentials } from '@prisma/client';
import { maskHolderName } from '../../common/utils/mask';
import { deriveCredentialStatus } from '../applications/application-response.mapper';
import { LocalizedText } from '../services/service-definition.types';

export interface CredentialResponse {
  id: string;
  number: string;
  status: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
  issuedAt: string;
  expiresAt: string | null;
  service: { id: string; name: LocalizedText };
  holderName: string;
  qrToken: string;
  applicationId: string;
}

export interface VerifyCredentialResponse {
  valid: boolean;
  status: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
  credential: {
    number: string;
    service: { id: string; name: LocalizedText };
    holderName: string;
    issuedAt: string;
    expiresAt: string | null;
  };
}

export function mapCredentialResponse(
  row: credentials,
  serviceName: LocalizedText,
  now: Date = new Date(),
): CredentialResponse {
  return {
    id: row.id,
    number: row.number,
    status: deriveCredentialStatus(row.status, row.expires_at, now),
    issuedAt: row.issued_at.toISOString(),
    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
    service: {
      id: row.service_id,
      name: serviceName,
    },
    holderName: row.holder_name,
    qrToken: row.qr_token,
    applicationId: row.application_id,
  };
}

export function mapVerifyCredentialResponse(
  row: credentials,
  serviceName: LocalizedText,
  now: Date = new Date(),
): VerifyCredentialResponse {
  const status = deriveCredentialStatus(row.status, row.expires_at, now);

  return {
    valid: status === 'ACTIVE',
    status,
    credential: {
      number: row.number,
      service: {
        id: row.service_id,
        name: serviceName,
      },
      holderName: maskHolderName(row.holder_name),
      issuedAt: row.issued_at.toISOString(),
      expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
    },
  };
}
