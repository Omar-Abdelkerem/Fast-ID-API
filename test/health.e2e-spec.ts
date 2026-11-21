import './helpers/test-env';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/database/prisma.service';
import { getTestAllowedOrigin } from './helpers/test-env';

describe('Health endpoint (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const allowedOrigin = getTestAllowedOrigin();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/v1/health returns 200 envelope, security headers, no-store, Vary: Origin, and server X-Request-Id', async () => {
    const clientRequestId = 'client-supplied-id-must-be-ignored';

    const res = await request(app.getHttpServer())
      .get('/api/v1/health')
      .set('Origin', allowedOrigin)
      .set('X-Request-Id', clientRequestId)
      .expect(200);

    expect(res.body).toEqual({
      success: true,
      data: { status: 'ok' },
    });

    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['vary']).toContain('Origin');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['access-control-allow-origin']).toBe(allowedOrigin);
    expect(res.headers['access-control-allow-credentials']).toBe('true');

    const responseRequestId = res.headers['x-request-id'];
    expect(typeof responseRequestId).toBe('string');
    expect(responseRequestId).not.toBe(clientRequestId);
    expect(responseRequestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('GET /api/v1/health returns 503 SERVICE_UNAVAILABLE envelope when DB is unreachable', async () => {
    const querySpy = jest
      .spyOn(prisma, '$queryRaw')
      .mockRejectedValueOnce(new Error('connection refused'));

    const res = await request(app.getHttpServer()).get('/api/v1/health').expect(503);

    expect(res.body).toEqual({
      success: false,
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Database is currently unreachable.',
      },
    });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['vary']).toContain('Origin');

    querySpy.mockRestore();
  });
});
