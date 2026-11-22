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
import { DEMO_ACCOUNTS, seedDemoData } from '../src/scripts/seed-demo';
import { resetTestDatabase, resetThrottlerStorage } from './helpers/db-reset';
import { getTestAllowedOrigin } from './helpers/test-env';

const VALID_PNG_BUFFER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde,
]);

function extractCookie(setCookie: string[] | string | undefined): string {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const found = list.find((c) => c.startsWith('fid_session='));
  if (!found) {
    throw new Error('Expected fid_session cookie');
  }
  return found.split(';')[0];
}

describe('End-to-End Demo Integration Scenario (M8 e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const allowedOrigin = getTestAllowedOrigin();
  const demoPassword = 'DemoUserPass2026!';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);
    await resetTestDatabase(prisma);
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

  it('seeds demo data idempotently and completes the full citizen -> admin -> agent -> public QR verify demo scenario', async () => {
    // 1. Seed demo data twice to verify idempotency
    const firstRun = await seedDemoData(prisma, demoPassword);
    expect(firstRun.servicesCreated).toEqual([
      'national-id',
      'driving-license',
      'birth-certificate',
    ]);
    expect(firstRun.usersCreated).toHaveLength(4);

    const secondRun = await seedDemoData(prisma, demoPassword);
    expect(secondRun.servicesCreated).toEqual([]);
    expect(secondRun.servicesExisting).toEqual([
      'national-id',
      'driving-license',
      'birth-certificate',
    ]);
    expect(secondRun.usersCreated).toEqual([]);
    expect(secondRun.usersExisting).toHaveLength(4);

    // 2. Public browsing of the 3 seeded services
    const catalog = await request(app.getHttpServer()).get('/api/v1/services').expect(200);
    expect(catalog.body.data).toHaveLength(3);

    // 3. Demo citizen logs in, creates a National ID renewal draft, fills form + attachments, pays, submits
    const citizenLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Origin', allowedOrigin)
      .send({ identifier: DEMO_ACCOUNTS.citizenEmail, password: demoPassword })
      .expect(200);
    const citizenCookie = extractCookie(citizenLogin.headers['set-cookie']);

    const draftRes = await request(app.getHttpServer())
      .post('/api/v1/applications')
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenCookie)
      .send({ serviceId: 'national-id' })
      .expect(201);
    const appId = draftRes.body.data.id as string;

    await request(app.getHttpServer())
      .patch(`/api/v1/applications/${appId}`)
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenCookie)
      .send({
        data: {
          maritalStatus: 'SINGLE',
          occupation: 'Software Engineer',
          confirmAccuracy: true,
        },
        deliveryAddress: {
          governorate: 'CAIRO',
          city: 'Heliopolis',
          addressLine: '42 El Merghany Street, Apt 5',
          phone: '01010000004',
          notes: 'Call before arriving',
        },
      })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/v1/applications/${appId}/attachments`)
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenCookie)
      .field('requirementKey', 'personalPhoto')
      .attach('file', VALID_PNG_BUFFER, { filename: 'photo.png', contentType: 'image/png' })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/api/v1/applications/${appId}/attachments`)
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenCookie)
      .field('requirementKey', 'oldIdCopy')
      .attach('file', VALID_PNG_BUFFER, { filename: 'old-id.png', contentType: 'image/png' })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/api/v1/applications/${appId}/payment/mock`)
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenCookie)
      .expect(200);

    const submitted = await request(app.getHttpServer())
      .post(`/api/v1/applications/${appId}/submit`)
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenCookie)
      .expect(200);
    expect(submitted.body.data.status).toBe('SUBMITTED');
    expect(submitted.body.data.serviceVersion).toBe(1);

    // 4. Demo admin reviews and approves -> auto-assigns Demo Cairo Agent and issues credential
    const adminLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Origin', allowedOrigin)
      .send({ identifier: DEMO_ACCOUNTS.adminEmail, password: demoPassword })
      .expect(200);
    const adminCookie = extractCookie(adminLogin.headers['set-cookie']);

    await request(app.getHttpServer())
      .post(`/api/v1/admin/applications/${appId}/start-review`)
      .set('Origin', allowedOrigin)
      .set('Cookie', adminCookie)
      .expect(200);

    const approved = await request(app.getHttpServer())
      .post(`/api/v1/admin/applications/${appId}/approve`)
      .set('Origin', allowedOrigin)
      .set('Cookie', adminCookie)
      .send({ note: 'All documents verified.' })
      .expect(200);
    expect(approved.body.data.status).toBe('APPROVED');
    expect(approved.body.data.delivery).toBeUndefined();
    expect(approved.body.data.deliveryRecord.status).toBe('ASSIGNED');
    expect(approved.body.data.credential.status).toBe('ACTIVE');

    const deliveryId = approved.body.data.deliveryRecord.id as string;
    const qrToken = approved.body.data.credential.qrToken as string;

    // 5. Demo Cairo Agent starts delivery, citizen reads deliveryCode, agent completes delivery
    const agentLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Origin', allowedOrigin)
      .send({ identifier: DEMO_ACCOUNTS.cairoAgentEmail, password: demoPassword })
      .expect(200);
    const agentCookie = extractCookie(agentLogin.headers['set-cookie']);

    await request(app.getHttpServer())
      .post(`/api/v1/agent/deliveries/${deliveryId}/start`)
      .set('Origin', allowedOrigin)
      .set('Cookie', agentCookie)
      .expect(200);

    const citizenView = await request(app.getHttpServer())
      .get(`/api/v1/applications/${appId}`)
      .set('Cookie', citizenCookie)
      .expect(200);
    const deliveryCode = citizenView.body.data.delivery.deliveryCode as string;
    expect(deliveryCode).toMatch(/^[0-9]{6}$/);

    const delivered = await request(app.getHttpServer())
      .post(`/api/v1/agent/deliveries/${deliveryId}/deliver`)
      .set('Origin', allowedOrigin)
      .set('Cookie', agentCookie)
      .send({ code: deliveryCode })
      .expect(200);
    expect(delivered.body.data.status).toBe('DELIVERED');

    // 6. Public QR verification succeeds with privacy-masked holderName
    const verified = await request(app.getHttpServer())
      .get(`/api/v1/verify/${qrToken}`)
      .expect(200);
    expect(verified.body.data).toMatchObject({
      valid: true,
      status: 'ACTIVE',
      credential: {
        service: { id: 'national-id' },
        holderName: 'Salma A. H.',
      },
    });

    // 7. Admin dashboard stats & CSV export reflect the completed delivery
    const stats = await request(app.getHttpServer())
      .get('/api/v1/admin/stats')
      .set('Cookie', adminCookie)
      .expect(200);
    expect(stats.body.data.applicationsByStatus.DELIVERED).toBe(1);
    expect(stats.body.data.deliveriesByStatus.DELIVERED).toBe(1);

    const csv = await request(app.getHttpServer())
      .get('/api/v1/admin/applications/export')
      .set('Cookie', adminCookie)
      .expect(200);
    expect(csv.text).toContain('National ID Renewal');
    expect(csv.text).toContain('29**********19');
    expect(csv.text).toContain('150.00');
    expect(csv.text).toContain('Delivered');
  });
});
