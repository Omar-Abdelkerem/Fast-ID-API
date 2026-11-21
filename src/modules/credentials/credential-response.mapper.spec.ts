import { credentials } from '@prisma/client';
import { mapCredentialResponse, mapVerifyCredentialResponse } from './credential-response.mapper';
import { generateCredentialNumber } from './credentials.service';

function makeCredentialRow(overrides: Partial<credentials> = {}): credentials {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    application_id: '22222222-2222-4222-8222-222222222222',
    holder_id: '33333333-3333-4333-8333-333333333333',
    service_id: 'national-id',
    holder_name: 'Ahmed Mohamed Kamal',
    number: 'CRD-12345ABCDE',
    qr_token: 'a'.repeat(43),
    status: 'ACTIVE',
    issued_at: new Date('2026-01-01T00:00:00.000Z'),
    expires_at: new Date('2033-01-01T00:00:00.000Z'),
    revoked_at: null,
    revoked_by: null,
    revoked_reason: null,
    ...overrides,
  };
}

describe('Credentials mapper & generator', () => {
  it('generates credential numbers matching ^CRD-[0-9A-Z]{10}$', () => {
    for (let i = 0; i < 20; i += 1) {
      expect(generateCredentialNumber()).toMatch(/^CRD-[0-9A-Z]{10}$/);
    }
  });

  it('derives ACTIVE, EXPIRED, and REVOKED statuses and masks holderName for public verification', () => {
    const serviceName = { ar: 'بطاقة', en: 'National ID' };
    const now = new Date('2026-11-22T00:00:00.000Z');

    const active = mapVerifyCredentialResponse(makeCredentialRow(), serviceName, now);
    expect(active).toEqual({
      valid: true,
      status: 'ACTIVE',
      credential: {
        number: 'CRD-12345ABCDE',
        service: { id: 'national-id', name: serviceName },
        holderName: 'Ahmed M. K.',
        issuedAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2033-01-01T00:00:00.000Z',
      },
    });

    const expired = mapVerifyCredentialResponse(
      makeCredentialRow({ expires_at: new Date('2026-06-01T00:00:00.000Z') }),
      serviceName,
      now,
    );
    expect(expired.valid).toBe(false);
    expect(expired.status).toBe('EXPIRED');

    const revoked = mapCredentialResponse(
      makeCredentialRow({ status: 'REVOKED' }),
      serviceName,
      now,
    );
    expect(revoked.status).toBe('REVOKED');
    expect(revoked.qrToken).toBe('a'.repeat(43));
  });
});
