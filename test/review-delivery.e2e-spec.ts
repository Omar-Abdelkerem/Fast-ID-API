import './helpers/test-env';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as argon2 from 'argon2';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SESSION_COOKIE_NAME } from '../src/common/guards/auth.guard';
import { UserRateLimitGuard } from '../src/common/guards/user-rate-limit.guard';
import { PrismaService } from '../src/database/prisma.service';
import { AuthService } from '../src/modules/auth/auth.service';
import { SeedService } from '../src/modules/seed/seed.service';
import { resetTestDatabase, resetThrottlerStorage } from './helpers/db-reset';
import { getTestAllowedOrigin } from './helpers/test-env';

function extractCookie(setCookie: string[] | string | undefined): string {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const found = list.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (!found) {
    throw new Error('Expected fid_session cookie');
  }
  return found.split(';')[0];
}

describe('Admin Review, Credentials, and Delivery Lifecycle (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const allowedOrigin = getTestAllowedOrigin();
  let adminCookie: string;
  let citizenOneCookie: string;
  let citizenTwoCookie: string;
  let agentCairoACookie: string;
  let agentCairoBCookie: string;
  let agentCairoAId: string;
  let agentCairoBId: string;

  async function createSubmittedApplication(
    citizenCookie: string,
    serviceId: string,
    gov: 'CAIRO' | 'ALEXANDRIA' = 'CAIRO',
  ): Promise<string> {
    const draft = await request(app.getHttpServer())
      .post('/api/v1/applications')
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenCookie)
      .send({ serviceId })
      .expect(201);
    const appId = draft.body.data.id as string;

    await request(app.getHttpServer())
      .patch(`/api/v1/applications/${appId}`)
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenCookie)
      .send({
        deliveryAddress: {
          governorate: gov,
          city: gov === 'CAIRO' ? 'Nasr City' : 'Smouha',
          addressLine: '15 Main Boulevard Street',
          phone: '01012345678',
          notes: null,
        },
      })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/v1/applications/${appId}/submit`)
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenCookie)
      .expect(200);

    return appId;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);
    await resetTestDatabase(prisma);
    await app.get(SeedService).ensureBootstrapData();
    resetThrottlerStorage(app);

    // Admin login + initial password change
    const adminLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Origin', allowedOrigin)
      .send({
        identifier: process.env.SEED_ADMIN_EMAIL!,
        password: process.env.SEED_ADMIN_PASSWORD!,
      })
      .expect(200);
    const initAdminCookie = extractCookie(adminLogin.headers['set-cookie']);
    const changed = await request(app.getHttpServer())
      .post('/api/v1/auth/change-password')
      .set('Origin', allowedOrigin)
      .set('Cookie', initAdminCookie)
      .send({
        currentPassword: process.env.SEED_ADMIN_PASSWORD!,
        newPassword: 'SecureRootPass2026!',
      })
      .expect(200);
    adminCookie = extractCookie(changed.headers['set-cookie']);

    // Register two citizens
    const c1 = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .set('Origin', allowedOrigin)
      .send({
        fullName: 'Ahmed Mohamed Kamal',
        nationalId: '29901150112314',
        email: 'citizen.review1@example.com',
        phone: '01012345678',
        password: 'CitizenOnePassword2026!',
        acceptTerms: true,
      })
      .expect(201);
    citizenOneCookie = extractCookie(c1.headers['set-cookie']);

    const c2 = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .set('Origin', allowedOrigin)
      .send({
        fullName: 'Nadia Samir Ali',
        nationalId: '30006200112324',
        email: 'citizen.review2@example.com',
        phone: '01112345678',
        password: 'CitizenTwoPassword2026!',
        acceptTerms: true,
      })
      .expect(201);
    citizenTwoCookie = extractCookie(c2.headers['set-cookie']);

    // Seed two active AGENT accounts in CAIRO directly (admin staff endpoints arrive in M6)
    const agentPassHash = await argon2.hash('AgentSecurePass2026!', { type: argon2.argon2id });
    const agentA = await prisma.users.create({
      data: {
        role: 'AGENT',
        full_name: 'Karim Agent A',
        email: 'agent.cairo.a@example.com',
        phone: '01211111111',
        password_hash: agentPassHash,
        governorate: 'CAIRO',
        is_active: true,
        must_change_password: false,
      },
    });
    const agentB = await prisma.users.create({
      data: {
        role: 'AGENT',
        full_name: 'Tarek Agent B',
        email: 'agent.cairo.b@example.com',
        phone: '01222222222',
        password_hash: agentPassHash,
        governorate: 'CAIRO',
        is_active: true,
        must_change_password: false,
      },
    });
    agentCairoAId = agentA.id;
    agentCairoBId = agentB.id;

    agentCairoACookie = extractCookie(
      (
        await request(app.getHttpServer())
          .post('/api/v1/auth/login')
          .set('Origin', allowedOrigin)
          .send({ identifier: 'agent.cairo.a@example.com', password: 'AgentSecurePass2026!' })
          .expect(200)
      ).headers['set-cookie'],
    );

    agentCairoBCookie = extractCookie(
      (
        await request(app.getHttpServer())
          .post('/api/v1/auth/login')
          .set('Origin', allowedOrigin)
          .send({ identifier: 'agent.cairo.b@example.com', password: 'AgentSecurePass2026!' })
          .expect(200)
      ).headers['set-cookie'],
    );

    // Create & publish two free services for smooth end-to-end review/delivery tests
    for (const svc of [
      { id: 'national-id', en: 'National ID Card', validityYears: 7 },
      { id: 'birth-cert', en: 'Birth Certificate', validityYears: null },
    ]) {
      await request(app.getHttpServer())
        .post('/api/v1/admin/services')
        .set('Origin', allowedOrigin)
        .set('Cookie', adminCookie)
        .send({
          id: svc.id,
          name: { ar: `خدمة ${svc.en}`, en: svc.en },
          description: { ar: 'وصف الخدمة', en: 'Service description' },
          category: 'IDENTITY',
          fee: { amount: 0, currency: 'EGP' },
          slaDays: 3,
          validityYears: svc.validityYears,
          requiredDocuments: [],
          formSchema: { fields: [] },
        })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/admin/services/${svc.id}/publish`)
        .set('Origin', allowedOrigin)
        .set('Cookie', adminCookie)
        .expect(200);
    }
  });

  beforeEach(() => {
    app.get(AuthService).resetRateLimiters();
    app.get(UserRateLimitGuard).resetAll();
    resetThrottlerStorage(app);
  });

  afterAll(async () => {
    try {
      await resetTestDatabase(prisma);
      await app.get(SeedService).ensureBootstrapData();
    } finally {
      await app.close();
    }
  });

  it('clamps leap-day credential expiry via PostgreSQL make_interval (Feb 29 + 1y -> Feb 28)', async () => {
    const [row] = await prisma.$queryRaw<Array<{ expires_at: Date }>>`
      SELECT (TIMESTAMPTZ '2024-02-29 10:00:00Z' + make_interval(years => ${1}::int)) AS expires_at
    `;
    expect(row.expires_at.toISOString()).toBe('2025-02-28T10:00:00.000Z');
  });

  it('handles concurrent double approval race, omits delivery/deliveryCode on AdminApplication (C-9), auto-assigns least-loaded agent, and runs full delivery code + fail + reassign + deliver flow', async () => {
    const appId = await createSubmittedApplication(citizenOneCookie, 'national-id', 'CAIRO');

    // Admin list excludes DRAFT, masks national ID with 10 asterisks
    const listRes = await request(app.getHttpServer())
      .get('/api/v1/admin/applications?q=29901150112314')
      .set('Cookie', adminCookie)
      .expect(200);
    expect(listRes.body.data).toHaveLength(1);
    expect(listRes.body.data[0].citizen.nationalIdMasked).toBe('29**********14');

    // Reject status=DRAFT in admin filter
    await request(app.getHttpServer())
      .get('/api/v1/admin/applications?status=DRAFT')
      .set('Cookie', adminCookie)
      .expect(400);

    // Start review
    const reviewRes = await request(app.getHttpServer())
      .post(`/api/v1/admin/applications/${appId}/start-review`)
      .set('Origin', allowedOrigin)
      .set('Cookie', adminCookie)
      .expect(200);
    expect(reviewRes.body.data.status).toBe('UNDER_REVIEW');

    // Concurrent double approval race: exactly 1 succeeds (200) and 1 fails (409 INVALID_STATUS_TRANSITION)
    const [a1, a2] = await Promise.all([
      request(app.getHttpServer())
        .post(`/api/v1/admin/applications/${appId}/approve`)
        .set('Origin', allowedOrigin)
        .set('Cookie', adminCookie)
        .send({ note: 'Internal reviewer check passed' }),
      request(app.getHttpServer())
        .post(`/api/v1/admin/applications/${appId}/approve`)
        .set('Origin', allowedOrigin)
        .set('Cookie', adminCookie)
        .send({ note: 'Second concurrent click' }),
    ]);

    const statuses = [a1.status, a2.status].sort((x, y) => x - y);
    expect(statuses).toEqual([200, 409]);

    const approvedRes = a1.status === 200 ? a1 : a2;
    const conflictRes = a1.status === 409 ? a1 : a2;
    expect(conflictRes.body.error.code).toBe('INVALID_STATUS_TRANSITION');

    // C-9: AdminApplication strictly omits `delivery` and never contains `deliveryCode`
    expect('delivery' in approvedRes.body.data).toBe(false);
    expect(JSON.stringify(approvedRes.body.data)).not.toContain('deliveryCode');
    expect(approvedRes.body.data.deliveryRecord).not.toBeNull();
    expect(approvedRes.body.data.deliveryRecord.status).toBe('ASSIGNED');
    expect(approvedRes.body.data.credential.number).toMatch(/^CRD-[0-9A-Z]{10}$/);
    expect(approvedRes.body.data.credential.qrToken.length).toBeGreaterThanOrEqual(43);

    const firstDeliveryId = approvedRes.body.data.deliveryRecord.id as string;
    const firstAssignedAgentId = approvedRes.body.data.deliveryRecord.agent.id as string;
    const otherAgentId = firstAssignedAgentId === agentCairoAId ? agentCairoBId : agentCairoAId;
    const assignedAgentCookie =
      firstAssignedAgentId === agentCairoAId ? agentCairoACookie : agentCairoBCookie;
    const otherAgentCookie =
      firstAssignedAgentId === agentCairoAId ? agentCairoBCookie : agentCairoACookie;

    // Verify staff_note is visible to admin but hidden from citizen
    const approvedHistory = approvedRes.body.data.statusHistory;
    expect(approvedHistory[approvedHistory.length - 1].note).toBeTruthy();

    const citizenAfterApprove = await request(app.getHttpServer())
      .get(`/api/v1/applications/${appId}`)
      .set('Cookie', citizenOneCookie)
      .expect(200);
    expect(
      citizenAfterApprove.body.data.statusHistory[
        citizenAfterApprove.body.data.statusHistory.length - 1
      ].note,
    ).toBeNull();

    // Auto-assignment load balancing: a 2nd CAIRO approval must pick the OTHER (least-loaded) agent!
    const app2Id = await createSubmittedApplication(citizenTwoCookie, 'national-id', 'CAIRO');
    await request(app.getHttpServer())
      .post(`/api/v1/admin/applications/${app2Id}/start-review`)
      .set('Origin', allowedOrigin)
      .set('Cookie', adminCookie)
      .expect(200);
    const app2Approved = await request(app.getHttpServer())
      .post(`/api/v1/admin/applications/${app2Id}/approve`)
      .set('Origin', allowedOrigin)
      .set('Cookie', adminCookie)
      .send({})
      .expect(200);
    expect(app2Approved.body.data.deliveryRecord.agent.id).toBe(otherAgentId);

    // Other agent cannot see or start firstDeliveryId (404 DELIVERY_NOT_FOUND)
    await request(app.getHttpServer())
      .get(`/api/v1/agent/deliveries/${firstDeliveryId}`)
      .set('Cookie', otherAgentCookie)
      .expect(404)
      .expect(({ body }) => expect(body.error.code).toBe('DELIVERY_NOT_FOUND'));

    // Assigned agent starts delivery (§9.6)
    const started = await request(app.getHttpServer())
      .post(`/api/v1/agent/deliveries/${firstDeliveryId}/start`)
      .set('Origin', allowedOrigin)
      .set('Cookie', assignedAgentCookie)
      .expect(200);
    expect(started.body.data.status).toBe('OUT_FOR_DELIVERY');
    expect(started.body.data.outForDeliveryAt).not.toBeNull();
    expect(JSON.stringify(started.body.data)).not.toContain('deliveryCode');

    // Citizen sees 6-digit deliveryCode & agent phone while OUT_FOR_DELIVERY
    const citizenOut = await request(app.getHttpServer())
      .get(`/api/v1/applications/${appId}`)
      .set('Cookie', citizenOneCookie)
      .expect(200);
    const firstCode = citizenOut.body.data.delivery.deliveryCode as string;
    expect(firstCode).toMatch(/^[0-9]{6}$/);
    expect(citizenOut.body.data.delivery.agent.phone).toMatch(/^01[0125][0-9]{8}$/);

    // Admin detail STILL omits delivery / deliveryCode while OUT_FOR_DELIVERY
    const adminOut = await request(app.getHttpServer())
      .get(`/api/v1/admin/applications/${appId}`)
      .set('Cookie', adminCookie)
      .expect(200);
    expect('delivery' in adminOut.body.data).toBe(false);
    expect(JSON.stringify(adminOut.body.data)).not.toContain(firstCode);

    // 4 wrong codes return 400 INVALID_DELIVERY_CODE and persist tries; 5th locks (409 DELIVERY_CODE_LOCKED)
    const wrongCode = firstCode === '000000' ? '111111' : '000000';
    for (let i = 1; i <= 4; i += 1) {
      await request(app.getHttpServer())
        .post(`/api/v1/agent/deliveries/${firstDeliveryId}/deliver`)
        .set('Origin', allowedOrigin)
        .set('Cookie', assignedAgentCookie)
        .send({ code: wrongCode })
        .expect(400)
        .expect(({ body }) => expect(body.error.code).toBe('INVALID_DELIVERY_CODE'));
    }

    await request(app.getHttpServer())
      .post(`/api/v1/agent/deliveries/${firstDeliveryId}/deliver`)
      .set('Origin', allowedOrigin)
      .set('Cookie', assignedAgentCookie)
      .send({ code: wrongCode })
      .expect(409)
      .expect(({ body }) => expect(body.error.code).toBe('DELIVERY_CODE_LOCKED'));

    // Even the correct code is rejected once locked
    await request(app.getHttpServer())
      .post(`/api/v1/agent/deliveries/${firstDeliveryId}/deliver`)
      .set('Origin', allowedOrigin)
      .set('Cookie', assignedAgentCookie)
      .send({ code: firstCode })
      .expect(409)
      .expect(({ body }) => expect(body.error.code).toBe('DELIVERY_CODE_LOCKED'));

    // Agent fails delivery (§9.8) -> OTHER requires reason >= 5 chars
    await request(app.getHttpServer())
      .post(`/api/v1/agent/deliveries/${firstDeliveryId}/fail`)
      .set('Origin', allowedOrigin)
      .set('Cookie', assignedAgentCookie)
      .send({ reasonCode: 'OTHER', reason: 'hi' })
      .expect(400);

    const failed = await request(app.getHttpServer())
      .post(`/api/v1/agent/deliveries/${firstDeliveryId}/fail`)
      .set('Origin', allowedOrigin)
      .set('Cookie', assignedAgentCookie)
      .send({ reasonCode: 'CITIZEN_UNAVAILABLE', reason: 'No answer at door' })
      .expect(200);
    expect(failed.body.data.status).toBe('FAILED_ATTEMPT');
    expect(failed.body.data.attempts).toBe(1);

    // Application returned to APPROVED
    const citizenAfterFail = await request(app.getHttpServer())
      .get(`/api/v1/applications/${appId}`)
      .set('Cookie', citizenOneCookie)
      .expect(200);
    expect(citizenAfterFail.body.data.status).toBe('APPROVED');
    expect(citizenAfterFail.body.data.delivery.deliveryCode).toBeNull();

    // Admin reassigns delivery (§9.3) -> status ASSIGNED and outForDeliveryAt cleared to null
    const reassigned = await request(app.getHttpServer())
      .post(`/api/v1/admin/deliveries/${firstDeliveryId}/assign`)
      .set('Origin', allowedOrigin)
      .set('Cookie', adminCookie)
      .send({ agentId: firstAssignedAgentId })
      .expect(200);
    expect(reassigned.body.data.status).toBe('ASSIGNED');
    expect(reassigned.body.data.outForDeliveryAt).toBeNull();

    // Agent starts again, citizen reads new code, agent completes delivery (§9.7)
    await request(app.getHttpServer())
      .post(`/api/v1/agent/deliveries/${firstDeliveryId}/start`)
      .set('Origin', allowedOrigin)
      .set('Cookie', assignedAgentCookie)
      .expect(200);

    const citizenOut2 = await request(app.getHttpServer())
      .get(`/api/v1/applications/${appId}`)
      .set('Cookie', citizenOneCookie)
      .expect(200);
    const secondCode = citizenOut2.body.data.delivery.deliveryCode as string;

    const delivered = await request(app.getHttpServer())
      .post(`/api/v1/agent/deliveries/${firstDeliveryId}/deliver`)
      .set('Origin', allowedOrigin)
      .set('Cookie', assignedAgentCookie)
      .send({ code: secondCode })
      .expect(200);
    expect(delivered.body.data.status).toBe('DELIVERED');
    expect(delivered.body.data.deliveredAt).not.toBeNull();

    const finalCitizenApp = await request(app.getHttpServer())
      .get(`/api/v1/applications/${appId}`)
      .set('Cookie', citizenOneCookie)
      .expect(200);
    expect(finalCitizenApp.body.data.status).toBe('DELIVERED');
    expect(finalCitizenApp.body.data.delivery.deliveryCode).toBeNull();
  });

  it('handles reject (§7.6), unassigned delivery in ALEXANDRIA (§9.1), credentials list/verify/revoke + expired rejection (§5, §7.7)', async () => {
    // 1. Reject flow
    const rejectAppId = await createSubmittedApplication(citizenOneCookie, 'birth-cert', 'CAIRO');
    await request(app.getHttpServer())
      .post(`/api/v1/admin/applications/${rejectAppId}/start-review`)
      .set('Origin', allowedOrigin)
      .set('Cookie', adminCookie)
      .expect(200);

    const rejected = await request(app.getHttpServer())
      .post(`/api/v1/admin/applications/${rejectAppId}/reject`)
      .set('Origin', allowedOrigin)
      .set('Cookie', adminCookie)
      .send({
        reasonCode: 'INVALID_DATA',
        reason: 'Submitted details did not match official civil records.',
      })
      .expect(200);
    expect(rejected.body.data.status).toBe('REJECTED');
    expect(rejected.body.data.decision.reasonCode).toBe('INVALID_DATA');

    // 2. Unassigned delivery (no ALEXANDRIA agent) + credentials verify & revoke
    const alexAppId = await createSubmittedApplication(
      citizenTwoCookie,
      'birth-cert',
      'ALEXANDRIA',
    );
    await request(app.getHttpServer())
      .post(`/api/v1/admin/applications/${alexAppId}/start-review`)
      .set('Origin', allowedOrigin)
      .set('Cookie', adminCookie)
      .expect(200);

    const alexApproved = await request(app.getHttpServer())
      .post(`/api/v1/admin/applications/${alexAppId}/approve`)
      .set('Origin', allowedOrigin)
      .set('Cookie', adminCookie)
      .send({})
      .expect(200);

    expect(alexApproved.body.data.deliveryRecord.status).toBe('PENDING_ASSIGNMENT');
    expect(alexApproved.body.data.deliveryRecord.agent).toBeNull();

    const unassignedList = await request(app.getHttpServer())
      .get('/api/v1/admin/deliveries?unassigned=true')
      .set('Cookie', adminCookie)
      .expect(200);
    expect(
      unassignedList.body.data.some(
        (d: { id: string }) => d.id === alexApproved.body.data.deliveryRecord.id,
      ),
    ).toBe(true);

    // Citizen credentials list & detail
    const credsList = await request(app.getHttpServer())
      .get('/api/v1/credentials')
      .set('Cookie', citizenTwoCookie)
      .expect(200);
    const cred = credsList.body.data.find(
      (c: { applicationId: string }) => c.applicationId === alexAppId,
    );
    expect(cred).toBeDefined();

    // Another citizen cannot read citizenTwo's credential (404 CREDENTIAL_NOT_FOUND)
    await request(app.getHttpServer())
      .get(`/api/v1/credentials/${cred.id}`)
      .set('Cookie', citizenOneCookie)
      .expect(404)
      .expect(({ body }) => expect(body.error.code).toBe('CREDENTIAL_NOT_FOUND'));

    // Public verify: ACTIVE -> valid: true, masked holderName, no-store
    const verifyActive = await request(app.getHttpServer())
      .get(`/api/v1/verify/${cred.qrToken}`)
      .expect(200);
    expect(verifyActive.headers['cache-control']).toBe('no-store');
    expect(verifyActive.body.data).toMatchObject({
      valid: true,
      status: 'ACTIVE',
      credential: {
        number: cred.number,
        holderName: 'Nadia S. A.',
      },
    });

    // Unknown QR token -> 404 CREDENTIAL_NOT_FOUND
    await request(app.getHttpServer())
      .get('/api/v1/verify/unknown-token-value')
      .expect(404)
      .expect(({ body }) => expect(body.error.code).toBe('CREDENTIAL_NOT_FOUND'));

    // Admin revokes credential (§7.7)
    const revoked = await request(app.getHttpServer())
      .post(`/api/v1/admin/credentials/${cred.id}/revoke`)
      .set('Origin', allowedOrigin)
      .set('Cookie', adminCookie)
      .send({ reason: 'Revoked due to issuance error verified by audit team.' })
      .expect(200);
    expect(revoked.body.data.status).toBe('REVOKED');

    // Public verify now returns valid: false, status: REVOKED
    const verifyRevoked = await request(app.getHttpServer())
      .get(`/api/v1/verify/${cred.qrToken}`)
      .expect(200);
    expect(verifyRevoked.body.data.valid).toBe(false);
    expect(verifyRevoked.body.data.status).toBe('REVOKED');

    // Revoking again -> 409 CREDENTIAL_NOT_ACTIVE
    await request(app.getHttpServer())
      .post(`/api/v1/admin/credentials/${cred.id}/revoke`)
      .set('Origin', allowedOrigin)
      .set('Cookie', adminCookie)
      .send({ reason: 'Second revoke attempt should be rejected cleanly.' })
      .expect(409)
      .expect(({ body }) => expect(body.error.code).toBe('CREDENTIAL_NOT_ACTIVE'));

    // Revoking an already-expired credential -> 409 CREDENTIAL_NOT_ACTIVE & verify returns EXPIRED
    const c1Creds = await request(app.getHttpServer())
      .get('/api/v1/credentials')
      .set('Cookie', citizenOneCookie)
      .expect(200);
    const expiredCred = c1Creds.body.data[0];

    await prisma.$executeRaw`
      UPDATE credentials
      SET issued_at = now() - interval '2 years',
          expires_at = now() - interval '1 day'
      WHERE id = ${expiredCred.id}::uuid
    `;

    const verifyExpired = await request(app.getHttpServer())
      .get(`/api/v1/verify/${expiredCred.qrToken}`)
      .expect(200);
    expect(verifyExpired.body.data.valid).toBe(false);
    expect(verifyExpired.body.data.status).toBe('EXPIRED');

    await request(app.getHttpServer())
      .post(`/api/v1/admin/credentials/${expiredCred.id}/revoke`)
      .set('Origin', allowedOrigin)
      .set('Cookie', adminCookie)
      .send({ reason: 'Cannot revoke a credential that has already expired.' })
      .expect(409)
      .expect(({ body }) => expect(body.error.code).toBe('CREDENTIAL_NOT_ACTIVE'));
  });
});
