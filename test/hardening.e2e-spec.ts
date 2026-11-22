import './helpers/test-env';
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

function extractCookie(setCookie: string[] | string | undefined): string {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const found = list.find((c) => c.startsWith('fid_session='));
  if (!found) {
    throw new Error('Expected fid_session cookie');
  }
  return found.split(';')[0];
}

describe('Hardening — Rate Limits, Security, Roles, Caching, Pagination (M7 e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const allowedOrigin = getTestAllowedOrigin();

  let adminCookie = '';
  let agentCookie = '';
  let citizenCookie = '';
  let mustChangeCookie = '';

  const login = async (identifier: string, password: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Origin', allowedOrigin)
      .send({ identifier, password })
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

    prisma = app.get(PrismaService);
    await resetTestDatabase(prisma);
    await app.get(SeedService).ensureBootstrapData();

    const seedEmail = process.env.SEED_ADMIN_EMAIL!;
    const seedPassword = process.env.SEED_ADMIN_PASSWORD!;
    const initAdminCookie = await login(seedEmail, seedPassword);
    const pwRes = await request(app.getHttpServer())
      .post('/api/v1/auth/change-password')
      .set('Origin', allowedOrigin)
      .set('Cookie', initAdminCookie)
      .send({ currentPassword: seedPassword, newPassword: 'HardeningRootPass1!' })
      .expect(200);
    adminCookie = extractCookie(pwRes.headers['set-cookie']);

    // Create an agent and change their temporary password
    await request(app.getHttpServer())
      .post('/api/v1/admin/staff')
      .set('Origin', allowedOrigin)
      .set('Cookie', adminCookie)
      .send({
        fullName: 'Hardening Agent',
        email: 'hardening.agent@example.com',
        phone: '01011223344',
        role: 'AGENT',
        governorate: 'CAIRO',
        temporaryPassword: 'TempAgentPass1!',
      })
      .expect(201);

    const tempAgentCookie = await login('hardening.agent@example.com', 'TempAgentPass1!');
    const agentPwRes = await request(app.getHttpServer())
      .post('/api/v1/auth/change-password')
      .set('Origin', allowedOrigin)
      .set('Cookie', tempAgentCookie)
      .send({ currentPassword: 'TempAgentPass1!', newPassword: 'StrongAgentPass9!' })
      .expect(200);
    agentCookie = extractCookie(agentPwRes.headers['set-cookie']);

    // Create a second admin who keeps mustChangePassword=true
    await request(app.getHttpServer())
      .post('/api/v1/admin/staff')
      .set('Origin', allowedOrigin)
      .set('Cookie', adminCookie)
      .send({
        fullName: 'Forced Change Admin',
        email: 'forced.staff@example.com',
        phone: '01022334455',
        role: 'ADMIN',
        temporaryPassword: 'ForcedTempPass1!',
      })
      .expect(201);
    mustChangeCookie = await login('forced.staff@example.com', 'ForcedTempPass1!');

    // Register a citizen
    const citRes = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .set('Origin', allowedOrigin)
      .send({
        fullName: 'Sara Ibrahim',
        nationalId: '29807100112328',
        email: 'sara.hardening@example.com',
        phone: '01122334455',
        password: 'StrongCitizenPass1!',
        acceptTerms: true,
      })
      .expect(201);
    citizenCookie = extractCookie(citRes.headers['set-cookie']);
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

  it('enforces role boundaries across anonymous, CITIZEN, AGENT, and ADMIN (§0.10)', async () => {
    // Anonymous blocked on protected endpoints
    await request(app.getHttpServer()).get('/api/v1/applications').expect(401);
    await request(app.getHttpServer()).get('/api/v1/agent/deliveries').expect(401);
    await request(app.getHttpServer()).get('/api/v1/admin/stats').expect(401);
    await request(app.getHttpServer()).get('/api/v1/notifications').expect(401);

    // CITIZEN -> 403 FORBIDDEN on /admin/* and /agent/*
    await request(app.getHttpServer())
      .get('/api/v1/admin/stats')
      .set('Cookie', citizenCookie)
      .expect(403)
      .expect(({ body }) => expect(body.error.code).toBe('FORBIDDEN'));

    await request(app.getHttpServer())
      .get('/api/v1/agent/deliveries')
      .set('Cookie', citizenCookie)
      .expect(403)
      .expect(({ body }) => expect(body.error.code).toBe('FORBIDDEN'));

    // AGENT -> 403 FORBIDDEN on /admin/*, /applications, /credentials
    await request(app.getHttpServer())
      .get('/api/v1/admin/staff')
      .set('Cookie', agentCookie)
      .expect(403)
      .expect(({ body }) => expect(body.error.code).toBe('FORBIDDEN'));

    await request(app.getHttpServer())
      .get('/api/v1/applications')
      .set('Cookie', agentCookie)
      .expect(403)
      .expect(({ body }) => expect(body.error.code).toBe('FORBIDDEN'));

    await request(app.getHttpServer())
      .get('/api/v1/credentials')
      .set('Cookie', agentCookie)
      .expect(403)
      .expect(({ body }) => expect(body.error.code).toBe('FORBIDDEN'));

    // ADMIN -> 403 FORBIDDEN on /applications, /credentials, /agent/*
    await request(app.getHttpServer())
      .get('/api/v1/applications')
      .set('Cookie', adminCookie)
      .expect(403)
      .expect(({ body }) => expect(body.error.code).toBe('FORBIDDEN'));

    await request(app.getHttpServer())
      .get('/api/v1/credentials')
      .set('Cookie', adminCookie)
      .expect(403)
      .expect(({ body }) => expect(body.error.code).toBe('FORBIDDEN'));

    await request(app.getHttpServer())
      .get('/api/v1/agent/deliveries')
      .set('Cookie', adminCookie)
      .expect(403)
      .expect(({ body }) => expect(body.error.code).toBe('FORBIDDEN'));
  });

  it('enforces Cache-Control, Vary: Origin, cookie-ignoring public routes, security headers, X-Request-Id, and CORS (§0.14, §0.15, §0.17)', async () => {
    // Public cacheable endpoints ignore mustChangePassword cookie and return exact Cache-Control + Vary: Origin
    const govRes = await request(app.getHttpServer())
      .get('/api/v1/reference/governorates')
      .set('Cookie', mustChangeCookie)
      .set('X-Request-Id', 'attacker-supplied-id')
      .expect(200);
    expect(govRes.headers['cache-control']).toBe('public, max-age=86400');
    expect(govRes.headers['vary']).toContain('Origin');
    expect(govRes.headers['x-content-type-options']).toBe('nosniff');
    expect(govRes.headers['referrer-policy']).toBe('no-referrer');
    expect(govRes.headers['x-request-id']).toBeDefined();
    expect(govRes.headers['x-request-id']).not.toBe('attacker-supplied-id');

    const settingsRes = await request(app.getHttpServer())
      .get('/api/v1/settings')
      .set('Cookie', mustChangeCookie)
      .expect(200);
    expect(settingsRes.headers['cache-control']).toBe('public, max-age=60');
    expect(settingsRes.headers['vary']).toContain('Origin');

    const servicesRes = await request(app.getHttpServer())
      .get('/api/v1/services')
      .set('Cookie', 'fid_session=corrupt.jwt.token')
      .expect(200);
    expect(servicesRes.headers['cache-control']).toBe(
      'public, max-age=60, stale-while-revalidate=300',
    );
    expect(servicesRes.headers['vary']).toContain('Origin');

    // Public non-cacheable endpoints use no-store
    const healthRes = await request(app.getHttpServer())
      .get('/api/v1/health')
      .set('Cookie', mustChangeCookie)
      .expect(200);
    expect(healthRes.headers['cache-control']).toBe('no-store');

    const verifyRes = await request(app.getHttpServer())
      .get('/api/v1/verify/nonexistent-token-check')
      .set('Cookie', mustChangeCookie)
      .expect(404);
    expect(verifyRes.headers['cache-control']).toBe('no-store');

    // Private endpoint uses no-store and blocks mustChangePassword
    await request(app.getHttpServer())
      .get('/api/v1/admin/stats')
      .set('Cookie', mustChangeCookie)
      .expect(403)
      .expect(({ body }) => expect(body.error.code).toBe('PASSWORD_CHANGE_REQUIRED'));

    const statsRes = await request(app.getHttpServer())
      .get('/api/v1/admin/stats')
      .set('Cookie', adminCookie)
      .expect(200);
    expect(statsRes.headers['cache-control']).toBe('no-store');
    expect(statsRes.headers['vary']).toContain('Origin');

    // CORS preflight: allowed origin vs disallowed origin (§0.14)
    const allowedPreflight = await request(app.getHttpServer())
      .options('/api/v1/auth/login')
      .set('Origin', allowedOrigin)
      .set('Access-Control-Request-Method', 'POST')
      .expect(204);
    expect(allowedPreflight.headers['access-control-allow-origin']).toBe(allowedOrigin);
    expect(allowedPreflight.headers['access-control-allow-credentials']).toBe('true');
    expect(allowedPreflight.headers['access-control-max-age']).toBe('600');
    expect(allowedPreflight.headers['access-control-expose-headers']).toContain('Retry-After');
    expect(allowedPreflight.headers['access-control-expose-headers']).toContain('X-Request-Id');
    expect(allowedPreflight.headers['access-control-expose-headers']).toContain(
      'Content-Disposition',
    );

    const disallowedPreflight = await request(app.getHttpServer())
      .options('/api/v1/auth/login')
      .set('Origin', 'https://evil.example.org')
      .set('Access-Control-Request-Method', 'POST')
      .expect(204);
    expect(disallowedPreflight.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('returns meta and rejects out-of-range page/pageSize on all 8 paginated endpoints (§0.16)', async () => {
    const paginatedCases: Array<{ path: string; cookie: string }> = [
      { path: '/api/v1/applications', cookie: citizenCookie },
      { path: '/api/v1/notifications', cookie: citizenCookie },
      { path: '/api/v1/admin/applications', cookie: adminCookie },
      { path: '/api/v1/admin/deliveries', cookie: adminCookie },
      { path: '/api/v1/admin/staff', cookie: adminCookie },
      { path: '/api/v1/admin/citizens', cookie: adminCookie },
      { path: '/api/v1/admin/audit-logs', cookie: adminCookie },
      { path: '/api/v1/agent/deliveries', cookie: agentCookie },
    ];

    for (const item of paginatedCases) {
      const ok = await request(app.getHttpServer())
        .get(`${item.path}?page=1&pageSize=10`)
        .set('Cookie', item.cookie)
        .expect(200);
      expect(ok.body.success).toBe(true);
      expect(Array.isArray(ok.body.data)).toBe(true);
      expect(ok.body.meta).toEqual(
        expect.objectContaining({
          page: 1,
          pageSize: 10,
          total: expect.any(Number),
          totalPages: expect.any(Number),
        }),
      );

      // Out-of-range page=0 -> 400 VALIDATION_ERROR (never clamped)
      await request(app.getHttpServer())
        .get(`${item.path}?page=0`)
        .set('Cookie', item.cookie)
        .expect(400)
        .expect(({ body }) => expect(body.error.code).toBe('VALIDATION_ERROR'));

      // Out-of-range pageSize=101 -> 400 VALIDATION_ERROR (never clamped)
      await request(app.getHttpServer())
        .get(`${item.path}?pageSize=101`)
        .set('Cookie', item.cookie)
        .expect(400)
        .expect(({ body }) => expect(body.error.code).toBe('VALIDATION_ERROR'));
    }
  });

  it('enforces §0.13 rate limits for verify (30/min), attachments (30/10m/user), agent deliver (20/min/user), and default (120/min/IP)', async () => {
    // 1. GET /verify/:qrToken -> 30/min per IP
    for (let i = 0; i < 30; i++) {
      await request(app.getHttpServer()).get('/api/v1/verify/missing-token').expect(404);
    }
    const verifyLimited = await request(app.getHttpServer())
      .get('/api/v1/verify/missing-token')
      .expect(429);
    expect(verifyLimited.body.error.code).toBe('RATE_LIMITED');
    expect(Number(verifyLimited.headers['retry-after'])).toBeGreaterThan(0);

    resetThrottlerStorage(app);

    // 2. POST /applications/:id/attachments -> 30/10m per user
    const fakeAppId = '00000000-0000-4000-8000-000000000001';
    for (let i = 0; i < 30; i++) {
      await request(app.getHttpServer())
        .post(`/api/v1/applications/${fakeAppId}/attachments`)
        .set('Origin', allowedOrigin)
        .set('Cookie', citizenCookie)
        .field('requirementKey', 'photo')
        .expect(400);
    }
    const uploadLimited = await request(app.getHttpServer())
      .post(`/api/v1/applications/${fakeAppId}/attachments`)
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenCookie)
      .field('requirementKey', 'photo')
      .expect(429);
    expect(uploadLimited.body.error.code).toBe('RATE_LIMITED');
    expect(Number(uploadLimited.headers['retry-after'])).toBeGreaterThan(0);

    resetThrottlerStorage(app);

    // 3. POST /agent/deliveries/:id/deliver -> 20/min per user
    const fakeDeliveryId = '00000000-0000-4000-8000-000000000002';
    for (let i = 0; i < 20; i++) {
      await request(app.getHttpServer())
        .post(`/api/v1/agent/deliveries/${fakeDeliveryId}/deliver`)
        .set('Origin', allowedOrigin)
        .set('Cookie', agentCookie)
        .send({ code: '123456' })
        .expect(404);
    }
    const deliverLimited = await request(app.getHttpServer())
      .post(`/api/v1/agent/deliveries/${fakeDeliveryId}/deliver`)
      .set('Origin', allowedOrigin)
      .set('Cookie', agentCookie)
      .send({ code: '123456' })
      .expect(429);
    expect(deliverLimited.body.error.code).toBe('RATE_LIMITED');
    expect(Number(deliverLimited.headers['retry-after'])).toBeGreaterThan(0);

    resetThrottlerStorage(app);

    // 4. Default rate limit (120/min per IP)
    for (let i = 0; i < 120; i++) {
      await request(app.getHttpServer()).get('/api/v1/settings').expect(200);
    }
    const defaultLimited = await request(app.getHttpServer()).get('/api/v1/settings').expect(429);
    expect(defaultLimited.body.error.code).toBe('RATE_LIMITED');
    expect(Number(defaultLimited.headers['retry-after'])).toBeGreaterThan(0);
  });
});
