import './helpers/test-env';
import * as http from 'http';
import { AddressInfo } from 'net';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { UserRateLimitGuard } from '../src/common/guards/user-rate-limit.guard';
import { PrismaService } from '../src/database/prisma.service';
import { AuthService } from '../src/modules/auth/auth.service';
import { SeedService } from '../src/modules/seed/seed.service';
import { resetTestDatabase, resetThrottlerStorage } from './helpers/db-reset';
import { getTestAllowedOrigin } from './helpers/test-env';

function extractCookie(setCookieHeader: string[] | string | undefined): string {
  const list = Array.isArray(setCookieHeader)
    ? setCookieHeader
    : setCookieHeader
      ? [setCookieHeader]
      : [];
  const session = list.find((c) => c.startsWith('fid_session='));
  if (!session) {
    throw new Error('Expected fid_session Set-Cookie header');
  }
  return session.split(';')[0];
}

interface SseClientHandle {
  statusCode: number;
  closedPromise: Promise<void>;
  close: () => void;
}

function openSseStream(baseUrl: string, cookie: string): Promise<SseClientHandle> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      `${baseUrl}/api/v1/notifications/stream`,
      { headers: { Cookie: cookie } },
      (res) => {
        const closedPromise = new Promise<void>((resolveClosed) => {
          res.on('end', resolveClosed);
          res.on('close', resolveClosed);
        });
        res.on('data', () => {
          // drain incoming SSE frames
        });
        resolve({
          statusCode: res.statusCode ?? 0,
          closedPromise,
          close: () => {
            req.destroy();
            res.destroy();
          },
        });
      },
    );
    req.on('error', reject);
  });
}

describe('Admin Extras — M6 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let baseUrl = '';
  const allowedOrigin = getTestAllowedOrigin();

  let primaryAdminId = '';
  let primaryAdminCookie = '';

  const loginUser = async (identifier: string, password: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Origin', allowedOrigin)
      .send({ identifier, password })
      .expect(200);
    return extractCookie(res.headers['set-cookie']);
  };

  const changePasswordAndGetCookie = async (
    cookie: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/change-password')
      .set('Origin', allowedOrigin)
      .set('Cookie', cookie)
      .send({ currentPassword, newPassword })
      .expect(200);
    return extractCookie(res.headers['set-cookie']);
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    await app.listen(0);
    const addr = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;

    prisma = app.get(PrismaService);
    await resetTestDatabase(prisma);
    await app.get(SeedService).ensureBootstrapData();

    const seedEmail = process.env.SEED_ADMIN_EMAIL!;
    const seedPassword = process.env.SEED_ADMIN_PASSWORD!;
    const adminRow = await prisma.users.findUniqueOrThrow({ where: { email: seedEmail } });
    primaryAdminId = adminRow.id;

    const initialCookie = await loginUser(seedEmail, seedPassword);
    primaryAdminCookie = await changePasswordAndGetCookie(
      initialCookie,
      seedPassword,
      'RootExtrasPass1!',
    );
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

  it('manages staff (§10.1-§10.3), enforces LAST_ADMIN & CANNOT_MODIFY_SELF, and handles concurrent mutual admin deactivation', async () => {
    // Reject governorate on ADMIN creation
    await request(app.getHttpServer())
      .post('/api/v1/admin/staff')
      .set('Origin', allowedOrigin)
      .set('Cookie', primaryAdminCookie)
      .send({
        fullName: 'Bad Admin',
        email: 'bad.admin@example.com',
        phone: '01012345670',
        role: 'ADMIN',
        governorate: 'CAIRO',
        temporaryPassword: 'TempPassword1!',
      })
      .expect(400)
      .expect(({ body }) => expect(body.error.code).toBe('GOVERNORATE_NOT_ALLOWED'));

    // Cannot deactivate self
    await request(app.getHttpServer())
      .patch(`/api/v1/admin/staff/${primaryAdminId}`)
      .set('Origin', allowedOrigin)
      .set('Cookie', primaryAdminCookie)
      .send({ isActive: false })
      .expect(409)
      .expect(({ body }) => expect(body.error.code).toBe('CANNOT_MODIFY_SELF'));

    // Create a second admin
    const secondAdminRes = await request(app.getHttpServer())
      .post('/api/v1/admin/staff')
      .set('Origin', allowedOrigin)
      .set('Cookie', primaryAdminCookie)
      .send({
        fullName: 'Second Admin',
        email: 'second.admin@example.com',
        phone: '+201012345671',
        role: 'ADMIN',
        temporaryPassword: 'TempPassword2!',
      })
      .expect(201);
    expect(secondAdminRes.body.data.mustChangePassword).toBe(true);
    expect(secondAdminRes.body.data.phone).toBe('01012345671');
    expect(secondAdminRes.body.data.governorate).toBeNull();
    const secondAdminId = secondAdminRes.body.data.id as string;

    // Duplicate email -> 409 EMAIL_ALREADY_REGISTERED
    await request(app.getHttpServer())
      .post('/api/v1/admin/staff')
      .set('Origin', allowedOrigin)
      .set('Cookie', primaryAdminCookie)
      .send({
        fullName: 'Dup Admin',
        email: 'second.admin@example.com',
        phone: '01012345672',
        role: 'ADMIN',
        temporaryPassword: 'TempPassword3!',
      })
      .expect(409)
      .expect(({ body }) => expect(body.error.code).toBe('EMAIL_ALREADY_REGISTERED'));

    // Role is immutable -> 400 UNKNOWN_FIELD
    await request(app.getHttpServer())
      .patch(`/api/v1/admin/staff/${secondAdminId}`)
      .set('Origin', allowedOrigin)
      .set('Cookie', primaryAdminCookie)
      .send({ role: 'AGENT' })
      .expect(400)
      .expect(({ body }) => expect(body.error.code).toBe('UNKNOWN_FIELD'));

    // Setting governorate on ADMIN -> 400 GOVERNORATE_NOT_ALLOWED
    await request(app.getHttpServer())
      .patch(`/api/v1/admin/staff/${secondAdminId}`)
      .set('Origin', allowedOrigin)
      .set('Cookie', primaryAdminCookie)
      .send({ governorate: 'GIZA' })
      .expect(400)
      .expect(({ body }) => expect(body.error.code).toBe('GOVERNORATE_NOT_ALLOWED'));

    // Activate second admin session and open SSE stream
    const tempCookie = await loginUser('second.admin@example.com', 'TempPassword2!');
    const secondAdminCookie = await changePasswordAndGetCookie(
      tempCookie,
      'TempPassword2!',
      'SecondStaffPass2!',
    );
    const secondAdminStream = await openSseStream(baseUrl, secondAdminCookie);
    expect(secondAdminStream.statusCode).toBe(200);

    // List staff
    const staffList = await request(app.getHttpServer())
      .get('/api/v1/admin/staff?role=ADMIN&q=Second&sort=fullName')
      .set('Cookie', primaryAdminCookie)
      .expect(200);
    expect(staffList.body.meta.total).toBe(1);
    expect(staffList.body.data[0].id).toBe(secondAdminId);

    // Concurrency Race #1: Both active admins try to deactivate each other simultaneously!
    const [resA, resB] = await Promise.all([
      request(app.getHttpServer())
        .patch(`/api/v1/admin/staff/${secondAdminId}`)
        .set('Origin', allowedOrigin)
        .set('Cookie', primaryAdminCookie)
        .send({ isActive: false }),
      request(app.getHttpServer())
        .patch(`/api/v1/admin/staff/${primaryAdminId}`)
        .set('Origin', allowedOrigin)
        .set('Cookie', secondAdminCookie)
        .send({ isActive: false }),
    ]);

    const statuses = [resA.status, resB.status].sort((x, y) => x - y);
    expect(statuses).toEqual([200, 409]);
    const conflict = resA.status === 409 ? resA : resB;
    expect(conflict.body.error.code).toBe('LAST_ADMIN');

    const activeAdmins = await prisma.users.findMany({
      where: { role: 'ADMIN', is_active: true },
    });
    expect(activeAdmins).toHaveLength(1);

    // Ensure primaryAdmin is active again for subsequent tests and verify SSE/session invalidation
    if (resA.status === 200) {
      await secondAdminStream.closedPromise;
      await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Cookie', secondAdminCookie)
        .expect(403)
        .expect(({ body }) => expect(body.error.code).toBe('ACCOUNT_DISABLED'));
    } else {
      secondAdminStream.close();
      // Reactivate primaryAdmin using secondAdminCookie and deactivate secondAdmin
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/staff/${primaryAdminId}`)
        .set('Origin', allowedOrigin)
        .set('Cookie', secondAdminCookie)
        .send({ isActive: true })
        .expect(200);
      primaryAdminCookie = await loginUser(process.env.SEED_ADMIN_EMAIL!, 'RootExtrasPass1!');
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/staff/${secondAdminId}`)
        .set('Origin', allowedOrigin)
        .set('Cookie', primaryAdminCookie)
        .send({ isActive: false })
        .expect(200);
    }
  });

  it('serializes concurrent agent deactivation vs approve auto-assign (D-25) and rejects deactivating busy agents', async () => {
    // Publish a free service
    await request(app.getHttpServer())
      .post('/api/v1/admin/services')
      .set('Origin', allowedOrigin)
      .set('Cookie', primaryAdminCookie)
      .send({
        id: 'extras-service',
        name: { ar: 'خدمة اختبار', en: 'Extras Service' },
        description: { ar: 'وصف الخدمة الاختبارية الكامل', en: 'Full extras service description' },
        category: 'IDENTITY',
        fee: { amount: 5000, currency: 'EGP' },
        slaDays: 3,
        validityYears: 5,
        requiredDocuments: [],
        formSchema: { fields: [] },
      })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/admin/services/extras-service/publish')
      .set('Origin', allowedOrigin)
      .set('Cookie', primaryAdminCookie)
      .expect(200);

    // Create one AGENT in ALEXANDRIA
    const agentRes = await request(app.getHttpServer())
      .post('/api/v1/admin/staff')
      .set('Origin', allowedOrigin)
      .set('Cookie', primaryAdminCookie)
      .send({
        fullName: 'Alexandria Agent',
        email: 'alex.agent@example.com',
        phone: '01212345678',
        role: 'AGENT',
        governorate: 'ALEXANDRIA',
        temporaryPassword: 'AgentTempPassword1!',
      })
      .expect(201);
    const agentId = agentRes.body.data.id as string;

    // Register citizen and bring application to UNDER_REVIEW in ALEXANDRIA
    const citizenRes = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .set('Origin', allowedOrigin)
      .send({
        fullName: 'Nadia Hassan',
        nationalId: '29504120212321',
        email: 'nadia.extras@example.com',
        phone: '01099887766',
        password: 'CitizenExtrasPass1!',
        acceptTerms: true,
      })
      .expect(201);
    const citizenCookie = extractCookie(citizenRes.headers['set-cookie']);

    const draft = await request(app.getHttpServer())
      .post('/api/v1/applications')
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenCookie)
      .send({ serviceId: 'extras-service' })
      .expect(201);
    const appId = draft.body.data.id as string;

    await request(app.getHttpServer())
      .patch(`/api/v1/applications/${appId}`)
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenCookie)
      .send({
        deliveryAddress: {
          governorate: 'ALEXANDRIA',
          city: 'Smouha',
          addressLine: '25 Fawzy Moaz Street',
          phone: '01099887766',
          notes: null,
        },
      })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/v1/applications/${appId}/payment/mock`)
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenCookie)
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/v1/applications/${appId}/submit`)
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenCookie)
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/v1/admin/applications/${appId}/start-review`)
      .set('Origin', allowedOrigin)
      .set('Cookie', primaryAdminCookie)
      .expect(200);

    // Concurrency Race #2: agent deactivation vs approve auto-assign!
    const [deactivateRes, approveRes] = await Promise.all([
      request(app.getHttpServer())
        .patch(`/api/v1/admin/staff/${agentId}`)
        .set('Origin', allowedOrigin)
        .set('Cookie', primaryAdminCookie)
        .send({ isActive: false }),
      request(app.getHttpServer())
        .post(`/api/v1/admin/applications/${appId}/approve`)
        .set('Origin', allowedOrigin)
        .set('Cookie', primaryAdminCookie)
        .send({}),
    ]);

    expect(approveRes.status).toBe(200);
    const delivery = await prisma.deliveries.findUniqueOrThrow({
      where: { application_id: appId },
    });
    const agentAfter = await prisma.users.findUniqueOrThrow({ where: { id: agentId } });

    if (deactivateRes.status === 200) {
      // Deactivation won the lock -> agent is inactive and delivery stayed PENDING_ASSIGNMENT
      expect(agentAfter.is_active).toBe(false);
      expect(delivery.status).toBe('PENDING_ASSIGNMENT');
      expect(delivery.agent_id).toBeNull();

      // Reactivate, manually assign, then confirm deactivation is now blocked with 409 AGENT_HAS_ACTIVE_DELIVERIES
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/staff/${agentId}`)
        .set('Origin', allowedOrigin)
        .set('Cookie', primaryAdminCookie)
        .send({ isActive: true })
        .expect(200);

      await request(app.getHttpServer())
        .post(`/api/v1/admin/deliveries/${delivery.id}/assign`)
        .set('Origin', allowedOrigin)
        .set('Cookie', primaryAdminCookie)
        .send({ agentId })
        .expect(200);

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/staff/${agentId}`)
        .set('Origin', allowedOrigin)
        .set('Cookie', primaryAdminCookie)
        .send({ isActive: false })
        .expect(409)
        .expect(({ body }) => expect(body.error.code).toBe('AGENT_HAS_ACTIVE_DELIVERIES'));
    } else {
      // Approve won the lock -> agent received the ASSIGNED delivery and deactivation was blocked
      expect(deactivateRes.status).toBe(409);
      expect(deactivateRes.body.error.code).toBe('AGENT_HAS_ACTIVE_DELIVERIES');
      expect(agentAfter.is_active).toBe(true);
      expect(delivery.status).toBe('ASSIGNED');
      expect(delivery.agent_id).toBe(agentId);
    }
  });

  it('lists and toggles citizens (§10.4-§10.5), invalidates sessions/SSE, and records audit logs (§10.6) with append-only enforcement', async () => {
    const citizenReg = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .set('Origin', allowedOrigin)
      .send({
        fullName: 'Karim Mansour',
        nationalId: '29911030112319',
        email: 'karim.citizen@example.com',
        phone: '01512345678',
        password: 'CitizenKarimPass1!',
        acceptTerms: true,
      })
      .expect(201);
    const citizenId = citizenReg.body.data.id as string;
    const citizenCookie = extractCookie(citizenReg.headers['set-cookie']);

    // Search by exact 14-digit national ID
    const byId = await request(app.getHttpServer())
      .get('/api/v1/admin/citizens?q=29911030112319')
      .set('Cookie', primaryAdminCookie)
      .expect(200);
    expect(byId.body.meta.total).toBe(1);
    expect(byId.body.data[0]).toMatchObject({
      id: citizenId,
      fullName: 'Karim Mansour',
      nationalIdMasked: '29**********19',
      email: 'karim.citizen@example.com',
      phone: '01512345678',
      isActive: true,
    });
    expect(byId.body.data[0].nationalId).toBeUndefined();

    // Open SSE stream for citizen, then deactivate -> SSE closes & cookie rejected
    const citizenStream = await openSseStream(baseUrl, citizenCookie);
    expect(citizenStream.statusCode).toBe(200);

    const deactivated = await request(app.getHttpServer())
      .patch(`/api/v1/admin/citizens/${citizenId}`)
      .set('Origin', allowedOrigin)
      .set('Cookie', primaryAdminCookie)
      .send({ isActive: false })
      .expect(200);
    expect(deactivated.body.data.isActive).toBe(false);
    await citizenStream.closedPromise;

    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Cookie', citizenCookie)
      .expect(403)
      .expect(({ body }) => expect(body.error.code).toBe('ACCOUNT_DISABLED'));

    // Reactivate citizen; old cookie stays invalidated (401 UNAUTHENTICATED via bumped token_version)
    const reactivated = await request(app.getHttpServer())
      .patch(`/api/v1/admin/citizens/${citizenId}`)
      .set('Origin', allowedOrigin)
      .set('Cookie', primaryAdminCookie)
      .send({ isActive: true })
      .expect(200);
    expect(reactivated.body.data.isActive).toBe(true);

    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Cookie', citizenCookie)
      .expect(401)
      .expect(({ body }) => expect(body.error.code).toBe('UNAUTHENTICATED'));

    // Staff ID on citizen endpoint -> 404 USER_NOT_FOUND
    await request(app.getHttpServer())
      .patch(`/api/v1/admin/citizens/${primaryAdminId}`)
      .set('Origin', allowedOrigin)
      .set('Cookie', primaryAdminCookie)
      .send({ isActive: false })
      .expect(404)
      .expect(({ body }) => expect(body.error.code).toBe('USER_NOT_FOUND'));

    // Audit logs query (§10.6)
    const auditRes = await request(app.getHttpServer())
      .get(
        `/api/v1/admin/audit-logs?action=CITIZEN_DEACTIVATED,CITIZEN_REACTIVATED&entityType=USER&entityId=${citizenId}&actorId=${primaryAdminId}`,
      )
      .set('Cookie', primaryAdminCookie)
      .expect(200);
    expect(auditRes.body.meta.total).toBe(2);
    expect(auditRes.body.data[0].action).toBe('CITIZEN_REACTIVATED');
    expect(auditRes.body.data[1].action).toBe('CITIZEN_DEACTIVATED');
    expect(auditRes.body.data[0].actor).toMatchObject({
      id: primaryAdminId,
      role: 'ADMIN',
    });

    // Reject from > to on audit logs
    await request(app.getHttpServer())
      .get('/api/v1/admin/audit-logs?from=2026-12-01T00:00:00.000Z&to=2026-01-01T00:00:00.000Z')
      .set('Cookie', primaryAdminCookie)
      .expect(400)
      .expect(({ body }) => expect(body.error.code).toBe('VALIDATION_ERROR'));

    // Verify DB append-only trigger blocks direct UPDATE and DELETE on audit_logs
    const sampleAuditId = auditRes.body.data[0].id as string;
    await expect(
      prisma.$executeRaw`UPDATE audit_logs SET entity_id = 'tampered' WHERE id = ${sampleAuditId}::uuid`,
    ).rejects.toThrow(/append-only/i);
    await expect(
      prisma.$executeRaw`DELETE FROM audit_logs WHERE id = ${sampleAuditId}::uuid`,
    ).rejects.toThrow(/append-only/i);
  });

  it('computes dashboard stats (§10.7) and exports guarded CSV (§7.2) with row-cap and 5/min user rate limit', async () => {
    // Create a citizen whose name triggers CSV formula injection guard ('-Formula Citizen' starts with '-')
    const formulaCitizenRes = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .set('Origin', allowedOrigin)
      .send({
        fullName: '-Formula Citizen',
        nationalId: '29608150112317',
        email: 'formula.citizen@example.com',
        phone: '01155443322',
        password: 'FormulaCitizenPass1!',
        acceptTerms: true,
      })
      .expect(201);
    const formulaCookie = extractCookie(formulaCitizenRes.headers['set-cookie']);

    // Create a SUBMITTED application and make it overdue
    const draft1 = await request(app.getHttpServer())
      .post('/api/v1/applications')
      .set('Origin', allowedOrigin)
      .set('Cookie', formulaCookie)
      .send({ serviceId: 'extras-service' })
      .expect(201);
    const overdueAppId = draft1.body.data.id as string;

    await request(app.getHttpServer())
      .patch(`/api/v1/applications/${overdueAppId}`)
      .set('Origin', allowedOrigin)
      .set('Cookie', formulaCookie)
      .send({
        deliveryAddress: {
          governorate: 'CAIRO',
          city: 'Nasr City',
          addressLine: '12 Abbas El Akkad',
          phone: '01155443322',
          notes: null,
        },
      })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/v1/applications/${overdueAppId}/payment/mock`)
      .set('Origin', allowedOrigin)
      .set('Cookie', formulaCookie)
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/v1/applications/${overdueAppId}/submit`)
      .set('Origin', allowedOrigin)
      .set('Cookie', formulaCookie)
      .expect(200);

    // Backdate due_at by 2 days so it's overdue
    await prisma.$executeRaw`
      UPDATE applications
      SET due_at = now() - interval '2 days'
      WHERE id = ${overdueAppId}::uuid
    `;

    // Check stats (§10.7)
    const statsRes = await request(app.getHttpServer())
      .get('/api/v1/admin/stats')
      .set('Cookie', primaryAdminCookie)
      .expect(200);
    expect(statsRes.body.data.applicationsByStatus.DRAFT).toBeUndefined();
    expect(statsRes.body.data.applicationsByStatus.SUBMITTED).toBeGreaterThanOrEqual(1);
    expect(statsRes.body.data.applicationsByStatus.APPROVED).toBeGreaterThanOrEqual(1);
    expect(statsRes.body.data.applicationsByStatus.REJECTED).toBe(0);
    expect(statsRes.body.data.overdueApplications).toBeGreaterThanOrEqual(1);
    expect(statsRes.body.data.deliveriesByStatus).toHaveProperty('PENDING_ASSIGNMENT');
    expect(statsRes.body.data.deliveriesByStatus).toHaveProperty('ASSIGNED');
    expect(typeof statsRes.body.data.averageDecisionHours30d).toBe('number');

    // CSV export rejects page/pageSize (§7.2)
    await request(app.getHttpServer())
      .get('/api/v1/admin/applications/export?page=1')
      .set('Cookie', primaryAdminCookie)
      .expect(400)
      .expect(({ body }) => expect(body.error.code).toBe('UNKNOWN_FIELD'));

    // CSV export returns 400 EXPORT_TOO_LARGE when > 10,000 rows
    const countSpy = jest.spyOn(prisma.applications, 'count').mockResolvedValueOnce(10_001);
    await request(app.getHttpServer())
      .get('/api/v1/admin/applications/export')
      .set('Cookie', primaryAdminCookie)
      .expect(400)
      .expect(({ body }) => expect(body.error.code).toBe('EXPORT_TOO_LARGE'));
    countSpy.mockRestore();

    // Reset export rate limit before verifying export content + 5/min user limit
    app.get(UserRateLimitGuard).resetAll();

    const csvRes = await request(app.getHttpServer())
      .get('/api/v1/admin/applications/export?sort=-submittedAt')
      .set('Cookie', primaryAdminCookie)
      .expect(200);

    expect(csvRes.headers['content-type']).toContain('text/csv; charset=utf-8');
    expect(csvRes.headers['content-disposition']).toMatch(
      /^attachment; filename="applications-\d{8}\.csv"$/,
    );
    expect(csvRes.headers['cache-control']).toBe('no-store');
    expect(csvRes.text.startsWith('\uFEFF')).toBe(true);

    const lines = csvRes.text.slice(1).trim().split('\r\n');
    expect(lines[0]).toBe(
      'Application No.,Service,Citizen,National ID,Governorate,Status,Submitted At,Due At,Overdue,Fee (EGP),Payment,Delivery',
    );
    const formulaRow = lines.find((line) => line.includes("'-Formula Citizen"));
    expect(formulaRow).toBeDefined();
    expect(formulaRow).toContain('29**********17');
    expect(formulaRow).toContain('Cairo');
    expect(formulaRow).toContain('Submitted');
    expect(formulaRow).toContain('Yes');
    expect(formulaRow).toContain('50.00');
    expect(formulaRow).toContain('Paid');

    // 4 more calls succeed (total 5/min/user), 6th returns 429 RATE_LIMITED with Retry-After
    for (let i = 0; i < 4; i++) {
      await request(app.getHttpServer())
        .get('/api/v1/admin/applications/export')
        .set('Cookie', primaryAdminCookie)
        .expect(200);
    }

    const throttled = await request(app.getHttpServer())
      .get('/api/v1/admin/applications/export')
      .set('Cookie', primaryAdminCookie)
      .expect(429);
    expect(throttled.body.error.code).toBe('RATE_LIMITED');
    expect(Number(throttled.headers['retry-after'])).toBeGreaterThan(0);
  });
});
