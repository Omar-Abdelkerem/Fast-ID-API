import './helpers/test-env';
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
import { SessionStreamRegistry } from '../src/modules/notifications/session-stream-registry';
import { SeedService } from '../src/modules/seed/seed.service';
import { resetTestDatabase, resetThrottlerStorage } from './helpers/db-reset';
import { getTestAllowedOrigin } from './helpers/test-env';

function extractSessionCookie(setCookieHeaders: string[] | string | undefined): string {
  const list = Array.isArray(setCookieHeaders)
    ? setCookieHeaders
    : setCookieHeaders
      ? [setCookieHeaders]
      : [];
  const sessionHeader = list.find((cookie) => cookie.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (!sessionHeader) {
    throw new Error('Expected fid_session Set-Cookie header');
  }
  return sessionHeader;
}

function cookiePairOnly(setCookieHeader: string): string {
  return setCookieHeader.split(';')[0];
}

describe('Auth module (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authService: AuthService;
  let jwtService: JwtService;
  let streamRegistry: SessionStreamRegistry;
  let userRateLimitGuard: UserRateLimitGuard;
  const allowedOrigin = getTestAllowedOrigin();
  const disconnectedUsers: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);
    authService = app.get(AuthService);
    jwtService = app.get(JwtService);
    streamRegistry = app.get(SessionStreamRegistry);
    userRateLimitGuard = app.get(UserRateLimitGuard);

    await resetTestDatabase(prisma);
    await app.get(SeedService).ensureBootstrapData();

    streamRegistry.registerHandler({
      disconnectUser: (userId) => disconnectedUsers.push(userId),
      publishNotifications: () => undefined,
      closeAll: () => undefined,
    });
  });

  beforeEach(() => {
    disconnectedUsers.length = 0;
    authService.resetRateLimiters();
    userRateLimitGuard.resetAll();
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

  describe('First-boot admin seed & mustChangePassword enforcement (§0.9)', () => {
    it('bootstrapped initial ADMIN with mustChangePassword=true and enforces forced change on authenticated routes only', async () => {
      const seedEmail = process.env.SEED_ADMIN_EMAIL!;
      const seedPassword = process.env.SEED_ADMIN_PASSWORD!;

      const loginRes = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', allowedOrigin)
        .send({ identifier: seedEmail, password: seedPassword })
        .expect(200);

      expect(loginRes.body.success).toBe(true);
      expect(loginRes.body.data.role).toBe('ADMIN');
      expect(loginRes.body.data.mustChangePassword).toBe(true);
      expect(loginRes.body.data.nationalId).toBeNull();
      expect(loginRes.body.data.governorate).toBeNull();

      const adminCookie = cookiePairOnly(extractSessionCookie(loginRes.headers['set-cookie']));

      // GET /auth/me allowed
      await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Cookie', adminCookie)
        .expect(200);

      // Public endpoints ignore cookies and remain accessible (§0.9, §0.15)
      await request(app.getHttpServer())
        .get('/api/v1/health')
        .set('Cookie', adminCookie)
        .expect(200);

      // Other authenticated endpoints blocked with 403 PASSWORD_CHANGE_REQUIRED
      const blockedPatch = await request(app.getHttpServer())
        .patch('/api/v1/auth/me')
        .set('Origin', allowedOrigin)
        .set('Cookie', adminCookie)
        .send({ preferredLanguage: 'en' })
        .expect(403);
      expect(blockedPatch.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');

      // Logout still works while mustChangePassword=true
      await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Origin', allowedOrigin)
        .set('Cookie', adminCookie)
        .expect(200)
        .expect(({ body }) => {
          expect(body).toEqual({ success: true, data: { loggedOut: true } });
        });
    });
  });

  describe('Register (§1.1) & Login (§1.2) & Profile (§1.3, §1.4)', () => {
    const citizenEmail = 'Citizen.One@Example.com';
    const citizenNationalId = '29901150112314';
    const citizenPassword = 'StrongPassword2026!';
    let citizenId: string;
    let citizenCookie: string;

    it('registers a citizen, sets httpOnly cookie flags, derives birthDate & gender, normalizes email/phone/name', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .set('Origin', allowedOrigin)
        .send({
          fullName: '  Ahmed   Mohamed  Kamal  ',
          nationalId: citizenNationalId,
          email: citizenEmail,
          phone: '+201012345678',
          password: citizenPassword,
          preferredLanguage: 'en',
          acceptTerms: true,
        })
        .expect(201);

      const rawSetCookie = extractSessionCookie(res.headers['set-cookie']);
      expect(rawSetCookie).toContain('HttpOnly');
      expect(rawSetCookie).toContain('Path=/');
      expect(rawSetCookie).toContain('SameSite=Lax');
      expect(rawSetCookie).toContain('Max-Age=43200');
      citizenCookie = cookiePairOnly(rawSetCookie);

      expect(res.body.success).toBe(true);
      expect(res.body.data).toMatchObject({
        role: 'CITIZEN',
        fullName: 'Ahmed Mohamed Kamal',
        email: 'citizen.one@example.com',
        phone: '01012345678',
        preferredLanguage: 'en',
        nationalId: citizenNationalId,
        birthDate: '1999-01-15',
        gender: 'MALE',
        governorate: null,
        isActive: true,
        mustChangePassword: false,
      });
      expect(res.body.data.passwordHash).toBeUndefined();
      expect(res.body.data.tokenVersion).toBeUndefined();
      citizenId = res.body.data.id;
    });

    it('enforces register validation & conflict codes (TERMS_NOT_ACCEPTED, INVALID_NATIONAL_ID, duplicates, UNKNOWN_FIELD)', async () => {
      const noTerms = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .set('Origin', allowedOrigin)
        .send({
          fullName: 'Sara Ali',
          nationalId: '30105100112324',
          email: 'sara.terms@example.com',
          phone: '01112345678',
          password: 'ValidPassword2026!',
          acceptTerms: false,
        })
        .expect(400);
      expect(noTerms.body.error.code).toBe('TERMS_NOT_ACCEPTED');
      expect(noTerms.body.error.field).toBe('acceptTerms');

      const badId = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .set('Origin', allowedOrigin)
        .send({
          fullName: 'Sara Ali',
          nationalId: '99901010112324',
          email: 'sara.badid@example.com',
          phone: '01112345678',
          password: 'ValidPassword2026!',
          acceptTerms: true,
        })
        .expect(400);
      expect(badId.body.error.code).toBe('INVALID_NATIONAL_ID');
      expect(badId.body.error.field).toBe('nationalId');

      const dupEmail = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .set('Origin', allowedOrigin)
        .send({
          fullName: 'Sara Ali',
          nationalId: '30105100112324',
          email: 'citizen.one@example.com',
          phone: '01112345678',
          password: 'ValidPassword2026!',
          acceptTerms: true,
        })
        .expect(409);
      expect(dupEmail.body.error.code).toBe('EMAIL_ALREADY_REGISTERED');

      const dupNid = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .set('Origin', allowedOrigin)
        .send({
          fullName: 'Sara Ali',
          nationalId: citizenNationalId,
          email: 'unique.nid@example.com',
          phone: '01112345678',
          password: 'ValidPassword2026!',
          acceptTerms: true,
        })
        .expect(409);
      expect(dupNid.body.error.code).toBe('NATIONAL_ID_ALREADY_REGISTERED');

      const unknownField = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .set('Origin', allowedOrigin)
        .send({
          fullName: 'Sara Ali',
          nationalId: '30105100112324',
          email: 'sara.extra@example.com',
          phone: '01112345678',
          password: 'ValidPassword2026!',
          acceptTerms: true,
          birthDate: '2001-05-10',
        })
        .expect(400);
      expect(unknownField.body.error.code).toBe('UNKNOWN_FIELD');
      expect(unknownField.body.error.field).toBe('birthDate');
    });

    it('logs in by email and by national ID, returns identical 401 on wrong credentials, and enforces ACCOUNT_DISABLED only after right password', async () => {
      // Login by email
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', allowedOrigin)
        .send({ identifier: 'CITIZEN.ONE@EXAMPLE.COM', password: citizenPassword })
        .expect(200);

      // Login by 14-digit national ID
      const nidLogin = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', allowedOrigin)
        .send({ identifier: citizenNationalId, password: citizenPassword })
        .expect(200);
      expect(nidLogin.body.data.id).toBe(citizenId);

      // Wrong password vs unknown identifier produce identical error body
      const wrongPass = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', allowedOrigin)
        .send({ identifier: citizenNationalId, password: 'WrongPassword1!' })
        .expect(401);
      const unknownUser = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', allowedOrigin)
        .send({ identifier: 'nobody@example.com', password: 'WrongPassword1!' })
        .expect(401);
      expect(wrongPass.body).toEqual(unknownUser.body);
      expect(wrongPass.body.error.code).toBe('INVALID_CREDENTIALS');

      // Deactivate citizen: wrong password still returns 401 (no enumeration), right password returns 403 ACCOUNT_DISABLED
      await prisma.users.update({ where: { id: citizenId }, data: { is_active: false } });

      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', allowedOrigin)
        .send({ identifier: citizenNationalId, password: 'WrongPassword1!' })
        .expect(401)
        .expect(({ body }) => expect(body.error.code).toBe('INVALID_CREDENTIALS'));

      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', allowedOrigin)
        .send({ identifier: citizenNationalId, password: citizenPassword })
        .expect(403)
        .expect(({ body }) => expect(body.error.code).toBe('ACCOUNT_DISABLED'));

      // Existing session cookie also gets 403 ACCOUNT_DISABLED
      await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Cookie', citizenCookie)
        .expect(403)
        .expect(({ body }) => expect(body.error.code).toBe('ACCOUNT_DISABLED'));

      // Re-activate for subsequent tests
      await prisma.users.update({ where: { id: citizenId }, data: { is_active: true } });
    });

    it('reads and patches own profile (§1.3, §1.4) and rejects immutable identity fields', async () => {
      await request(app.getHttpServer()).get('/api/v1/auth/me').expect(401);

      const meRes = await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Cookie', citizenCookie)
        .expect(200);
      expect(meRes.body.data.id).toBe(citizenId);

      // Empty body rejected
      await request(app.getHttpServer())
        .patch('/api/v1/auth/me')
        .set('Origin', allowedOrigin)
        .set('Cookie', citizenCookie)
        .send({})
        .expect(400)
        .expect(({ body }) => expect(body.error.code).toBe('VALIDATION_ERROR'));

      // Identity field rejected as UNKNOWN_FIELD
      await request(app.getHttpServer())
        .patch('/api/v1/auth/me')
        .set('Origin', allowedOrigin)
        .set('Cookie', citizenCookie)
        .send({ fullName: 'New Name' })
        .expect(400)
        .expect(({ body }) => expect(body.error.code).toBe('UNKNOWN_FIELD'));

      // Valid partial update
      const patchRes = await request(app.getHttpServer())
        .patch('/api/v1/auth/me')
        .set('Origin', allowedOrigin)
        .set('Cookie', citizenCookie)
        .send({ phone: '201212345678', preferredLanguage: 'ar' })
        .expect(200);
      expect(patchRes.body.data.phone).toBe('01212345678');
      expect(patchRes.body.data.preferredLanguage).toBe('ar');
    });

    it('handles public logout (§1.5) for active, expired, invalid, and missing cookies', async () => {
      // Active session logout disconnects SSE stream and clears cookie
      const activeLogout = await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Origin', allowedOrigin)
        .set('Cookie', citizenCookie)
        .expect(200);
      expect(activeLogout.body).toEqual({ success: true, data: { loggedOut: true } });
      expect(extractSessionCookie(activeLogout.headers['set-cookie'])).toContain(
        `${SESSION_COOKIE_NAME}=;`,
      );
      expect(disconnectedUsers).toContain(citizenId);

      // Expired cookie still returns 200 and clears cookie
      const expiredToken = await jwtService.signAsync(
        { sub: citizenId, tv: 0 },
        { algorithm: 'HS256', expiresIn: -10 },
      );
      await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Origin', allowedOrigin)
        .set('Cookie', `${SESSION_COOKIE_NAME}=${expiredToken}`)
        .expect(200);

      // Garbage cookie & missing cookie both return 200
      await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Origin', allowedOrigin)
        .set('Cookie', `${SESSION_COOKIE_NAME}=not-a-jwt`)
        .send({})
        .expect(200);

      await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Origin', allowedOrigin)
        .expect(200);

      // Missing Origin rejected (403); unknown body field rejected (400)
      await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .expect(403)
        .expect(({ body }) => expect(body.error.code).toBe('ORIGIN_NOT_ALLOWED'));

      await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Origin', allowedOrigin)
        .send({ extra: true })
        .expect(400)
        .expect(({ body }) => expect(body.error.code).toBe('UNKNOWN_FIELD'));
    });

    it('changes password (§1.6), invalidates old sessions, enqueues PASSWORD_CHANGED email, and issues fresh cookie', async () => {
      // Create two sessions
      const sessionA = cookiePairOnly(
        extractSessionCookie(
          (
            await request(app.getHttpServer())
              .post('/api/v1/auth/login')
              .set('Origin', allowedOrigin)
              .send({ identifier: citizenNationalId, password: citizenPassword })
              .expect(200)
          ).headers['set-cookie'],
        ),
      );
      const sessionB = cookiePairOnly(
        extractSessionCookie(
          (
            await request(app.getHttpServer())
              .post('/api/v1/auth/login')
              .set('Origin', allowedOrigin)
              .send({ identifier: citizenNationalId, password: citizenPassword })
              .expect(200)
          ).headers['set-cookie'],
        ),
      );

      // Wrong current password -> 401
      await request(app.getHttpServer())
        .post('/api/v1/auth/change-password')
        .set('Origin', allowedOrigin)
        .set('Cookie', sessionA)
        .send({ currentPassword: 'WrongPassword1!', newPassword: 'BrandNewPassword2026!' })
        .expect(401)
        .expect(({ body }) => expect(body.error.code).toBe('INVALID_CURRENT_PASSWORD'));

      // Same password -> 400 PASSWORD_UNCHANGED
      await request(app.getHttpServer())
        .post('/api/v1/auth/change-password')
        .set('Origin', allowedOrigin)
        .set('Cookie', sessionA)
        .send({ currentPassword: citizenPassword, newPassword: citizenPassword })
        .expect(400)
        .expect(({ body }) => expect(body.error.code).toBe('PASSWORD_UNCHANGED'));

      // Valid change
      const newPassword = 'BrandNewPassword2026!';
      const changeRes = await request(app.getHttpServer())
        .post('/api/v1/auth/change-password')
        .set('Origin', allowedOrigin)
        .set('Cookie', sessionA)
        .send({ currentPassword: citizenPassword, newPassword })
        .expect(200);

      expect(changeRes.body).toEqual({ success: true, data: { changed: true } });
      expect(disconnectedUsers).toContain(citizenId);

      const freshCookie = cookiePairOnly(extractSessionCookie(changeRes.headers['set-cookie']));

      // Old session B is invalidated immediately
      await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Cookie', sessionB)
        .expect(401)
        .expect(({ body }) => expect(body.error.code).toBe('UNAUTHENTICATED'));

      // Fresh cookie works
      await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Cookie', freshCookie)
        .expect(200);

      // PASSWORD_CHANGED email enqueued
      const outboxRows = await prisma.email_outbox.findMany({
        where: { to_user_id: citizenId, template: 'PASSWORD_CHANGED' },
      });
      expect(outboxRows.length).toBeGreaterThanOrEqual(1);
    });

    it('runs forgot-password (§1.7) and reset-password (§1.8) with anti-enumeration, expiry, audit, and concurrent race protection', async () => {
      await prisma.email_outbox.deleteMany({ where: { to_user_id: citizenId } });

      // Unknown email returns identical 200 and writes no outbox row
      const unknownRes = await request(app.getHttpServer())
        .post('/api/v1/auth/forgot-password')
        .set('Origin', allowedOrigin)
        .send({ email: 'does.not.exist@example.com' })
        .expect(200);
      expect(unknownRes.body).toEqual({ success: true, data: { requested: true } });

      // Known email creates hashed token and enqueues PASSWORD_RESET email
      const knownRes = await request(app.getHttpServer())
        .post('/api/v1/auth/forgot-password')
        .set('Origin', allowedOrigin)
        .send({ email: 'citizen.one@example.com' })
        .expect(200);
      expect(knownRes.body).toEqual({ success: true, data: { requested: true } });

      const resetOutbox = await prisma.email_outbox.findFirstOrThrow({
        where: { to_user_id: citizenId, template: 'PASSWORD_RESET' },
        orderBy: { created_at: 'desc' },
      });
      const resetUrl = (resetOutbox.payload as { resetUrl: string }).resetUrl;
      const rawToken = new URL(resetUrl).searchParams.get('token')!;
      expect(rawToken.length).toBeGreaterThanOrEqual(43);

      // Token is stored hashed, never raw
      const storedToken = await prisma.password_reset_tokens.findFirstOrThrow({
        where: { user_id: citizenId, used_at: null },
      });
      expect(storedToken.token_hash).not.toBe(rawToken);
      expect(storedToken.token_hash).toHaveLength(64);

      // Create an active session to verify reset invalidates it
      const activeSession = cookiePairOnly(
        extractSessionCookie(
          (
            await request(app.getHttpServer())
              .post('/api/v1/auth/login')
              .set('Origin', allowedOrigin)
              .send({ identifier: citizenNationalId, password: 'BrandNewPassword2026!' })
              .expect(200)
          ).headers['set-cookie'],
        ),
      );

      // Unknown token fails with 400 INVALID_RESET_TOKEN
      await request(app.getHttpServer())
        .post('/api/v1/auth/reset-password')
        .set('Origin', allowedOrigin)
        .send({
          token: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          newPassword: 'ResetPassword2026!',
        })
        .expect(400)
        .expect(({ body }) => expect(body.error.code).toBe('INVALID_RESET_TOKEN'));

      // Concurrent double reset with the SAME valid token: exactly 1 succeeds (200) and 1 fails (400)
      const [r1, r2] = await Promise.all([
        request(app.getHttpServer())
          .post('/api/v1/auth/reset-password')
          .set('Origin', allowedOrigin)
          .send({ token: rawToken, newPassword: 'ResetPassword2026!' }),
        request(app.getHttpServer())
          .post('/api/v1/auth/reset-password')
          .set('Origin', allowedOrigin)
          .send({ token: rawToken, newPassword: 'ResetPassword2026!' }),
      ]);

      const statuses = [r1.status, r2.status].sort((a, b) => a - b);
      expect(statuses).toEqual([200, 400]);
      const winner = r1.status === 200 ? r1 : r2;
      const loser = r1.status === 400 ? r1 : r2;

      expect(winner.body).toEqual({ success: true, data: { reset: true } });
      expect(winner.headers['set-cookie']).toBeUndefined(); // not logged in automatically
      expect(loser.body.error.code).toBe('INVALID_RESET_TOKEN');

      // Active session is now invalidated
      await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Cookie', activeSession)
        .expect(401);

      // Audit log PASSWORD_RESET_COMPLETED recorded
      const auditRow = await prisma.audit_logs.findFirst({
        where: { entity_id: citizenId, action: 'PASSWORD_RESET_COMPLETED' },
      });
      expect(auditRow).not.toBeNull();

      // PASSWORD_CHANGED email enqueued
      const changedEmail = await prisma.email_outbox.findFirst({
        where: { to_user_id: citizenId, template: 'PASSWORD_CHANGED' },
      });
      expect(changedEmail).not.toBeNull();

      // Expired token test: request another token, backdate its expiry, verify 400 INVALID_RESET_TOKEN
      await request(app.getHttpServer())
        .post('/api/v1/auth/forgot-password')
        .set('Origin', allowedOrigin)
        .send({ email: 'citizen.one@example.com' })
        .expect(200);

      const secondOutbox = await prisma.email_outbox.findFirstOrThrow({
        where: { to_user_id: citizenId, template: 'PASSWORD_RESET' },
        orderBy: { created_at: 'desc' },
      });
      const secondToken = new URL(
        (secondOutbox.payload as { resetUrl: string }).resetUrl,
      ).searchParams.get('token')!;

      await prisma.$executeRaw`
        UPDATE password_reset_tokens
        SET created_at = now() - interval '60 minutes',
            expires_at = now() - interval '30 minutes'
        WHERE user_id = ${citizenId}::uuid AND used_at IS NULL
      `;

      await request(app.getHttpServer())
        .post('/api/v1/auth/reset-password')
        .set('Origin', allowedOrigin)
        .send({ token: secondToken, newPassword: 'AnotherPassword2026!' })
        .expect(400)
        .expect(({ body }) => expect(body.error.code).toBe('INVALID_RESET_TOKEN'));
    });
  });
});
