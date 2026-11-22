import './helpers/test-env';
import * as http from 'http';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SESSION_COOKIE_NAME } from '../src/common/guards/auth.guard';
import { UserRateLimitGuard } from '../src/common/guards/user-rate-limit.guard';
import { PrismaService } from '../src/database/prisma.service';
import { AuthService } from '../src/modules/auth/auth.service';
import { CleanupJob } from '../src/modules/email/cleanup.job';
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

interface SseConnection {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  chunks: string[];
  closedPromise: Promise<void>;
  close: () => void;
  waitForText: (substring: string, timeoutMs?: number) => Promise<void>;
}

function openSseStream(baseUrl: string, cookie: string): Promise<SseConnection> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      `${baseUrl}/api/v1/notifications/stream`,
      { headers: { Cookie: cookie, Accept: 'text/event-stream' } },
      (res) => {
        const chunks: string[] = [];
        const waiters: Array<{ sub: string; resolve: () => void }> = [];

        const closedPromise = new Promise<void>((resClose) => {
          res.on('end', () => resClose());
          res.on('close', () => resClose());
        });

        res.on('data', (buf: Buffer) => {
          chunks.push(buf.toString('utf8'));
          const combined = chunks.join('');
          for (let i = waiters.length - 1; i >= 0; i -= 1) {
            if (combined.includes(waiters[i].sub)) {
              waiters[i].resolve();
              waiters.splice(i, 1);
            }
          }
        });

        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          chunks,
          closedPromise,
          close: () => {
            req.destroy();
          },
          waitForText: (sub: string, timeoutMs = 4000) => {
            if (chunks.join('').includes(sub)) {
              return Promise.resolve();
            }
            return new Promise<void>((resWait, rejWait) => {
              const timer = setTimeout(
                () => rejWait(new Error(`Timed out waiting for SSE text: ${sub}`)),
                timeoutMs,
              );
              waiters.push({
                sub,
                resolve: () => {
                  clearTimeout(timer);
                  resWait();
                },
              });
            });
          },
        });
      },
    );

    req.on('error', reject);
  });
}

describe('Notifications, Live SSE, and Cleanup Job (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let cleanupJob: CleanupJob;
  let baseUrl: string;
  const allowedOrigin = getTestAllowedOrigin();
  let adminInitialCookie: string;
  let adminCookie: string;
  let citizenOneCookie: string;
  let citizenOneId: string;
  let citizenTwoCookie: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.listen(0, '127.0.0.1');
    const addr = app.getHttpServer().address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;

    prisma = app.get(PrismaService);
    jwtService = app.get(JwtService);
    cleanupJob = app.get(CleanupJob);

    await resetTestDatabase(prisma);
    await app.get(SeedService).ensureBootstrapData();
    resetThrottlerStorage(app);

    // Seeded admin login (mustChangePassword=true initially)
    const adminLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Origin', allowedOrigin)
      .send({
        identifier: process.env.SEED_ADMIN_EMAIL!,
        password: process.env.SEED_ADMIN_PASSWORD!,
      })
      .expect(200);
    adminInitialCookie = extractCookie(adminLogin.headers['set-cookie']);

    // Verify mustChangePassword blocks SSE before headers (403 PASSWORD_CHANGE_REQUIRED)
    await request(app.getHttpServer())
      .get('/api/v1/notifications/stream')
      .set('Cookie', adminInitialCookie)
      .expect(403)
      .expect(({ body }) => expect(body.error.code).toBe('PASSWORD_CHANGE_REQUIRED'));

    // Change admin password
    const changed = await request(app.getHttpServer())
      .post('/api/v1/auth/change-password')
      .set('Origin', allowedOrigin)
      .set('Cookie', adminInitialCookie)
      .send({
        currentPassword: process.env.SEED_ADMIN_PASSWORD!,
        newPassword: 'SecureRootPass2026!',
      })
      .expect(200);
    adminCookie = extractCookie(changed.headers['set-cookie']);

    // Create & publish a free service
    await request(app.getHttpServer())
      .post('/api/v1/admin/services')
      .set('Origin', allowedOrigin)
      .set('Cookie', adminCookie)
      .send({
        id: 'notif-service',
        name: { ar: 'خدمة إشعارات', en: 'Notification Service' },
        description: { ar: 'وصف', en: 'Description' },
        category: 'OTHER',
        fee: { amount: 0, currency: 'EGP' },
        slaDays: 2,
        validityYears: null,
        requiredDocuments: [],
        formSchema: { fields: [] },
      })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/admin/services/notif-service/publish')
      .set('Origin', allowedOrigin)
      .set('Cookie', adminCookie)
      .expect(200);

    // Register two citizens
    const c1 = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .set('Origin', allowedOrigin)
      .send({
        fullName: 'Hassan Nabil',
        nationalId: '29908150112314',
        email: 'citizen.notif1@example.com',
        phone: '01012345678',
        password: 'CitizenNotifPassword1!',
        acceptTerms: true,
      })
      .expect(201);
    citizenOneCookie = extractCookie(c1.headers['set-cookie']);
    citizenOneId = c1.body.data.id;

    const c2 = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .set('Origin', allowedOrigin)
      .send({
        fullName: 'Layla Mahmoud',
        nationalId: '30109150112324',
        email: 'citizen.notif2@example.com',
        phone: '01112345678',
        password: 'CitizenNotifPassword2!',
        acceptTerms: true,
      })
      .expect(201);
    citizenTwoCookie = extractCookie(c2.headers['set-cookie']);
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

  it('lists notifications, tracks unread count, marks read idempotently, and enforces ownership (§6.1-§6.4)', async () => {
    // Submit and cancel an application to produce 2 citizen notifications
    const draft = await request(app.getHttpServer())
      .post('/api/v1/applications')
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenOneCookie)
      .send({ serviceId: 'notif-service' })
      .expect(201);
    const appId = draft.body.data.id as string;

    await request(app.getHttpServer())
      .patch(`/api/v1/applications/${appId}`)
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenOneCookie)
      .send({
        deliveryAddress: {
          governorate: 'CAIRO',
          city: 'Maadi',
          addressLine: '10 Road 9 Maadi',
          phone: '01012345678',
          notes: null,
        },
      })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/v1/applications/${appId}/submit`)
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenOneCookie)
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/v1/applications/${appId}/cancel`)
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenOneCookie)
      .send({})
      .expect(200);

    const unread = await request(app.getHttpServer())
      .get('/api/v1/notifications/unread-count')
      .set('Cookie', citizenOneCookie)
      .expect(200);
    expect(unread.body.data).toEqual({ count: 2 });

    const list = await request(app.getHttpServer())
      .get('/api/v1/notifications?isRead=false&page=1&pageSize=10')
      .set('Cookie', citizenOneCookie)
      .expect(200);
    expect(list.body.meta.total).toBe(2);
    expect(list.body.data[0].type).toBe('APPLICATION_CANCELLED');
    expect(list.body.data[0].entity).toEqual({ type: 'APPLICATION', id: appId });
    const firstId = list.body.data[0].id as string;

    // Another user cannot mark citizenOne's notification read (404 NOTIFICATION_NOT_FOUND)
    await request(app.getHttpServer())
      .post(`/api/v1/notifications/${firstId}/read`)
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenTwoCookie)
      .expect(404)
      .expect(({ body }) => expect(body.error.code).toBe('NOTIFICATION_NOT_FOUND'));

    // Mark first read (idempotent: second call preserves readAt)
    const read1 = await request(app.getHttpServer())
      .post(`/api/v1/notifications/${firstId}/read`)
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenOneCookie)
      .expect(200);
    expect(read1.body.data.isRead).toBe(true);
    expect(read1.body.data.readAt).not.toBeNull();

    const read2 = await request(app.getHttpServer())
      .post(`/api/v1/notifications/${firstId}/read`)
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenOneCookie)
      .expect(200);
    expect(read2.body.data.readAt).toBe(read1.body.data.readAt);

    // Mark all remaining read
    const readAll = await request(app.getHttpServer())
      .post('/api/v1/notifications/read-all')
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenOneCookie)
      .expect(200);
    expect(readAll.body.data).toEqual({ updated: 1 });

    const unreadAfter = await request(app.getHttpServer())
      .get('/api/v1/notifications/unread-count')
      .set('Cookie', citizenOneCookie)
      .expect(200);
    expect(unreadAfter.body.data).toEqual({ count: 0 });
  });

  it('streams live notifications via SSE, enforces 3-stream cap, and disconnects on logout, password change, and JWT exp (§6.6)', async () => {
    // Unauthenticated returns 401 JSON envelope before SSE headers
    await request(app.getHttpServer())
      .get('/api/v1/notifications/stream')
      .expect(401)
      .expect(({ body }) => expect(body.error.code).toBe('UNAUTHENTICATED'));

    // Open 3 concurrent SSE streams
    const s1 = await openSseStream(baseUrl, citizenOneCookie);
    const s2 = await openSseStream(baseUrl, citizenOneCookie);
    const s3 = await openSseStream(baseUrl, citizenOneCookie);

    expect(s1.statusCode).toBe(200);
    expect(s1.headers['content-type']).toContain('text/event-stream');
    expect(s1.headers['cache-control']).toBe('no-store');
    expect(s1.headers['x-accel-buffering']).toBe('no');

    // 4th concurrent stream returns 429 RATE_LIMITED JSON envelope
    await request(app.getHttpServer())
      .get('/api/v1/notifications/stream')
      .set('Cookie', citizenOneCookie)
      .expect(429)
      .expect(({ body }) => expect(body.error.code).toBe('RATE_LIMITED'));

    // Close extra streams s2 & s3; keep s1 open to receive a live event
    s2.close();
    s3.close();

    const draft = await request(app.getHttpServer())
      .post('/api/v1/applications')
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenOneCookie)
      .send({ serviceId: 'notif-service' })
      .expect(201);
    const appId = draft.body.data.id as string;

    await request(app.getHttpServer())
      .patch(`/api/v1/applications/${appId}`)
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenOneCookie)
      .send({
        deliveryAddress: {
          governorate: 'CAIRO',
          city: 'Maadi',
          addressLine: '10 Road 9 Maadi',
          phone: '01012345678',
          notes: null,
        },
      })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/v1/applications/${appId}/submit`)
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenOneCookie)
      .expect(200);

    await s1.waitForText('event: notification');
    expect(s1.chunks.join('')).toContain('APPLICATION_SUBMITTED');

    // Logout immediately closes the open SSE stream
    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenOneCookie)
      .expect(200);
    await s1.closedPromise;

    // Log back in, open SSE, change password -> stream disconnects immediately
    const relogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Origin', allowedOrigin)
      .send({ identifier: 'citizen.notif1@example.com', password: 'CitizenNotifPassword1!' })
      .expect(200);
    citizenOneCookie = extractCookie(relogin.headers['set-cookie']);

    const sAfterLogin = await openSseStream(baseUrl, citizenOneCookie);
    const pwChanged = await request(app.getHttpServer())
      .post('/api/v1/auth/change-password')
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenOneCookie)
      .send({
        currentPassword: 'CitizenNotifPassword1!',
        newPassword: 'CitizenNotifPassword9!',
      })
      .expect(200);
    citizenOneCookie = extractCookie(pwChanged.headers['set-cookie']);
    await sAfterLogin.closedPromise;

    // Short-lived JWT exp auto-closes stream cleanly
    const currentUser = await prisma.users.findUniqueOrThrow({ where: { id: citizenOneId } });
    const shortToken = await jwtService.signAsync(
      { sub: currentUser.id, tv: currentUser.token_version },
      { algorithm: 'HS256', expiresIn: 1 },
    );
    const shortStream = await openSseStream(baseUrl, `${SESSION_COOKIE_NAME}=${shortToken}`);
    expect(shortStream.statusCode).toBe(200);
    await shortStream.closedPromise;
  });

  it('cleans up old reset tokens (>7d) and SENT outbox rows (>30d) while preserving recent and FAILED rows (§12)', async () => {
    // Old expired reset token (>7d) -> should be deleted
    await prisma.$executeRaw`
      INSERT INTO password_reset_tokens (user_id, token_hash, created_at, expires_at)
      VALUES (${citizenOneId}::uuid, ${'a'.repeat(64)}, now() - interval '10 days', now() - interval '9 days')
    `;
    // Recent reset token -> should remain
    await prisma.$executeRaw`
      INSERT INTO password_reset_tokens (user_id, token_hash, created_at, expires_at)
      VALUES (${citizenOneId}::uuid, ${'b'.repeat(64)}, now(), now() + interval '30 minutes')
    `;

    // Old SENT email (>30d) -> should be deleted
    await prisma.$executeRaw`
      INSERT INTO email_outbox (to_email, template, language, status, created_at, sent_at)
      VALUES ('old.sent@example.com', 'PASSWORD_CHANGED', 'en', 'SENT', now() - interval '40 days', now() - interval '35 days')
    `;
    // Old FAILED email (>30d) -> MUST BE KEPT for diagnosis!
    await prisma.$executeRaw`
      INSERT INTO email_outbox (to_email, template, language, status, attempts, last_error, created_at)
      VALUES ('old.failed@example.com', 'PASSWORD_CHANGED', 'en', 'FAILED', 5, 'boom', now() - interval '40 days')
    `;

    const result = await cleanupJob.runCleanup();
    expect(result.deletedResetTokens).toBeGreaterThanOrEqual(1);
    expect(result.deletedSentEmails).toBeGreaterThanOrEqual(1);

    const remainingRecentToken = await prisma.password_reset_tokens.findUnique({
      where: { token_hash: 'b'.repeat(64) },
    });
    expect(remainingRecentToken).not.toBeNull();

    const remainingFailedEmail = await prisma.email_outbox.findFirst({
      where: { to_email: 'old.failed@example.com', status: 'FAILED' },
    });
    expect(remainingFailedEmail).not.toBeNull();
  });
});
