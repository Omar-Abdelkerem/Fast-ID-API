import './helpers/test-env';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/database/prisma.service';
import { AuthService } from '../src/modules/auth/auth.service';
import { SeedService } from '../src/modules/seed/seed.service';
import { resetTestDatabase, resetThrottlerStorage } from './helpers/db-reset';
import { getTestAllowedOrigin } from './helpers/test-env';

describe('Auth rate limits (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authService: AuthService;
  const allowedOrigin = getTestAllowedOrigin();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);
    authService = app.get(AuthService);
  });

  beforeEach(() => {
    authService.resetRateLimiters();
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

  it('enforces 5 failed login attempts per (IP + identifier) and returns 429 with Retry-After', async () => {
    authService.resetRateLimiters();
    const targetEmail = 'ratelimit.login@example.com';

    for (let i = 0; i < 5; i += 1) {
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', allowedOrigin)
        .send({ identifier: targetEmail, password: 'WrongPassword1' })
        .expect(401);
    }

    const blocked = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Origin', allowedOrigin)
      .send({ identifier: targetEmail, password: 'WrongPassword1' })
      .expect(429);

    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);

    // Different identifier from the same IP is NOT locked out by the per-identifier counter
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Origin', allowedOrigin)
      .send({ identifier: 'other.user@example.com', password: 'WrongPassword1' })
      .expect(401);
  });

  it('enforces 3/hour forgot-password limit and returns 429 with Retry-After', async () => {
    authService.resetRateLimiters();

    for (let i = 0; i < 3; i += 1) {
      await request(app.getHttpServer())
        .post('/api/v1/auth/forgot-password')
        .set('Origin', allowedOrigin)
        .send({ email: 'forgot.limit@example.com' })
        .expect(200);
    }

    const blocked = await request(app.getHttpServer())
      .post('/api/v1/auth/forgot-password')
      .set('Origin', allowedOrigin)
      .send({ email: 'forgot.limit@example.com' })
      .expect(429);

    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('enforces 5/hour register limit and returns 429 with Retry-After', async () => {
    for (let i = 0; i < 5; i += 1) {
      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .set('Origin', allowedOrigin)
        .send({
          fullName: 'Rate Limit User',
          nationalId: 'invalid-id',
          email: `rl${i}@example.com`,
          phone: '01012345678',
          password: 'ValidPassword1',
          acceptTerms: true,
        })
        .expect(400);
    }

    const blocked = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .set('Origin', allowedOrigin)
      .send({
        fullName: 'Rate Limit User',
        nationalId: 'invalid-id',
        email: 'rl5@example.com',
        phone: '01012345678',
        password: 'ValidPassword1',
        acceptTerms: true,
      })
      .expect(429);

    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('enforces 5/15m change-password per-user rate limit and returns 429 with Retry-After', async () => {
    const reg = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .set('Origin', allowedOrigin)
      .send({
        fullName: 'Change Pass Limit',
        nationalId: '29805050112314',
        email: 'cp.limit@example.com',
        phone: '01099887766',
        password: 'ValidPassword2026!',
        acceptTerms: true,
      })
      .expect(201);

    const setCookie = reg.headers['set-cookie'];
    const rawCookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0];

    for (let i = 0; i < 5; i += 1) {
      await request(app.getHttpServer())
        .post('/api/v1/auth/change-password')
        .set('Origin', allowedOrigin)
        .set('Cookie', rawCookie)
        .send({ currentPassword: 'WrongPassword1!', newPassword: 'NewPassword2026!' })
        .expect(401);
    }

    const blocked = await request(app.getHttpServer())
      .post('/api/v1/auth/change-password')
      .set('Origin', allowedOrigin)
      .set('Cookie', rawCookie)
      .send({ currentPassword: 'WrongPassword1!', newPassword: 'NewPassword2026!' })
      .expect(429);

    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });
});
