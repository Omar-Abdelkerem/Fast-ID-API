import './helpers/test-env';
import { Body, Controller, Get, HttpCode, INestApplication, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Type } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, MinLength, ValidateNested } from 'class-validator';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { Public } from '../src/common/decorators/public.decorator';
import { PublicCache } from '../src/common/decorators/public-cache.decorator';
import { createPaginatedResult } from '../src/common/dto/pagination.dto';
import { getTestAllowedOrigin } from './helpers/test-env';

class ProbeAddressDto {
  @IsString()
  @IsNotEmpty()
  city: string;
}

class ProbeCreateDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  name: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ProbeAddressDto)
  address?: ProbeAddressDto;
}

@Controller('__probe')
class PipelineProbeController {
  @Public()
  @PublicCache(60, 300)
  @Get('cached')
  getCached() {
    return { ok: true };
  }

  @Public()
  @Get('paginated')
  getPaginated() {
    return createPaginatedResult([{ id: '1' }], 1, 1, 20);
  }

  @Public()
  @HttpCode(200)
  @Post('bodyless')
  bodylessWrite() {
    return { done: true };
  }

  @Public()
  @Post('validated')
  validatedWrite(@Body() body: ProbeCreateDto) {
    return { received: body };
  }
}

describe('HTTP pipeline & security conventions (e2e)', () => {
  let app: INestApplication;
  const allowedOrigin = getTestAllowedOrigin();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [PipelineProbeController],
    }).compile();

    app = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects state-changing requests with missing or disallowed Origin (403 ORIGIN_NOT_ALLOWED)', async () => {
    const missingRes = await request(app.getHttpServer())
      .post('/api/v1/__probe/bodyless')
      .expect(403);
    expect(missingRes.body.error.code).toBe('ORIGIN_NOT_ALLOWED');

    const badOriginRes = await request(app.getHttpServer())
      .post('/api/v1/__probe/bodyless')
      .set('Origin', 'https://disallowed.example.test')
      .expect(403);
    expect(badOriginRes.body.error.code).toBe('ORIGIN_NOT_ALLOWED');
  });

  it('allows bodyless write with omitted Content-Type, empty JSON, or {} JSON (D-24)', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/__probe/bodyless')
      .set('Origin', allowedOrigin)
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual({ success: true, data: { done: true } });
      });

    await request(app.getHttpServer())
      .post('/api/v1/__probe/bodyless')
      .set('Origin', allowedOrigin)
      .set('Content-Type', 'application/json')
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/__probe/bodyless')
      .set('Origin', allowedOrigin)
      .set('Content-Type', 'application/json')
      .send({})
      .expect(200);
  });

  it('rejects disallowed Content-Type with 415 UNSUPPORTED_MEDIA_TYPE even with empty body (D-24)', async () => {
    const textRes = await request(app.getHttpServer())
      .post('/api/v1/__probe/bodyless')
      .set('Origin', allowedOrigin)
      .set('Content-Type', 'text/plain')
      .expect(415);

    expect(textRes.body).toEqual({
      success: false,
      error: {
        code: 'UNSUPPORTED_MEDIA_TYPE',
        message: 'Content-Type must be application/json.',
      },
    });
    expect(textRes.headers['cache-control']).toBe('no-store');
    expect(textRes.headers['vary']).toContain('Origin');

    const formRes = await request(app.getHttpServer())
      .post('/api/v1/__probe/bodyless')
      .set('Origin', allowedOrigin)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(415);

    expect(formRes.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('rejects JSON payload larger than 100 KB with 413 PAYLOAD_TOO_LARGE', async () => {
    const oversizedPayload = JSON.stringify({ name: 'a'.repeat(110 * 1024) });

    const res = await request(app.getHttpServer())
      .post('/api/v1/__probe/validated')
      .set('Origin', allowedOrigin)
      .set('Content-Type', 'application/json')
      .send(oversizedPayload)
      .expect(413);

    expect(res.body).toEqual({
      success: false,
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Request payload exceeds the 100 KB limit.',
      },
    });
  });

  it('rejects malformed JSON with 400 VALIDATION_ERROR', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/__probe/validated')
      .set('Origin', allowedOrigin)
      .set('Content-Type', 'application/json')
      .send('{"name": ')
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects unknown fields with 400 UNKNOWN_FIELD (top-level and nested)', async () => {
    const topRes = await request(app.getHttpServer())
      .post('/api/v1/__probe/validated')
      .set('Origin', allowedOrigin)
      .send({ name: 'Valid Name', createdAt: '2026-01-01T00:00:00.000Z' })
      .expect(400);

    expect(topRes.body).toEqual({
      success: false,
      error: {
        code: 'UNKNOWN_FIELD',
        message: 'Unknown field "createdAt".',
        field: 'createdAt',
      },
    });

    const nestedRes = await request(app.getHttpServer())
      .post('/api/v1/__probe/validated')
      .set('Origin', allowedOrigin)
      .send({ name: 'Valid Name', address: { city: 'Cairo', extra: true } })
      .expect(400);

    expect(nestedRes.body).toEqual({
      success: false,
      error: {
        code: 'UNKNOWN_FIELD',
        message: 'Unknown field "address.extra".',
        field: 'address.extra',
      },
    });
  });

  it('returns 400 VALIDATION_ERROR with details array for invalid fields', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/__probe/validated')
      .set('Origin', allowedOrigin)
      .send({ name: 'ab' })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.field).toBe('name');
    expect(Array.isArray(res.body.error.details)).toBe(true);
    expect(res.body.error.details[0]).toEqual(
      expect.objectContaining({
        field: 'name',
        code: 'TOO_SHORT',
      }),
    );
  });

  it('applies @PublicCache directives and paginated response envelope', async () => {
    const cachedRes = await request(app.getHttpServer()).get('/api/v1/__probe/cached').expect(200);
    expect(cachedRes.headers['cache-control']).toBe(
      'public, max-age=60, stale-while-revalidate=300',
    );
    expect(cachedRes.headers['vary']).toContain('Origin');

    const paginatedRes = await request(app.getHttpServer())
      .get('/api/v1/__probe/paginated')
      .expect(200);
    expect(paginatedRes.body).toEqual({
      success: true,
      data: [{ id: '1' }],
      meta: { page: 1, pageSize: 20, total: 1, totalPages: 1 },
    });
  });

  it('handles CORS preflight for allowed origins only', async () => {
    const allowedPreflight = await request(app.getHttpServer())
      .options('/api/v1/__probe/validated')
      .set('Origin', allowedOrigin)
      .set('Access-Control-Request-Method', 'POST')
      .expect(204);

    expect(allowedPreflight.headers['access-control-allow-origin']).toBe(allowedOrigin);
    expect(allowedPreflight.headers['access-control-allow-credentials']).toBe('true');
    expect(allowedPreflight.headers['access-control-max-age']).toBe('600');

    const deniedPreflight = await request(app.getHttpServer())
      .options('/api/v1/__probe/validated')
      .set('Origin', 'https://disallowed.example.test')
      .set('Access-Control-Request-Method', 'POST')
      .expect(204);

    expect(deniedPreflight.headers['access-control-allow-origin']).toBeUndefined();
  });
});
