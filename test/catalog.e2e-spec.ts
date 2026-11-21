import './helpers/test-env';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SESSION_COOKIE_NAME } from '../src/common/guards/auth.guard';
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

function makeServiceBody(id: string, enName: string, category = 'IDENTITY') {
  return {
    id,
    name: { ar: `خدمة ${enName}`, en: enName },
    description: { ar: `وصف ${enName}`, en: `Description for ${enName}` },
    category,
    fee: { amount: 5000, currency: 'EGP' },
    slaDays: 3,
    validityYears: 7,
    requiredDocuments: [
      {
        key: 'personalPhoto',
        label: { ar: 'صورة شخصية', en: 'Personal photo' },
        required: true,
        allowedMimeTypes: ['image/jpeg', 'image/png'],
        maxSizeBytes: 2097152,
      },
    ],
    formSchema: {
      fields: [
        {
          key: 'reason',
          label: { ar: 'السبب', en: 'Reason' },
          helpText: null,
          type: 'SELECT',
          required: true,
          options: [
            { value: 'FIRST_ISSUE', label: { ar: 'أول مرة', en: 'First issue' } },
            { value: 'REPLACEMENT', label: { ar: 'بدل فاقد', en: 'Replacement' } },
          ],
          validation: {},
        },
      ],
    },
  };
}

describe('Catalog, Reference Data, and Settings (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const allowedOrigin = getTestAllowedOrigin();
  let adminCookie: string;
  let citizenCookie: string;

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

    // Log in as seeded admin and satisfy mustChangePassword
    const adminLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Origin', allowedOrigin)
      .send({
        identifier: process.env.SEED_ADMIN_EMAIL!,
        password: process.env.SEED_ADMIN_PASSWORD!,
      })
      .expect(200);
    const initialAdminCookie = extractCookie(adminLogin.headers['set-cookie']);

    const changed = await request(app.getHttpServer())
      .post('/api/v1/auth/change-password')
      .set('Origin', allowedOrigin)
      .set('Cookie', initialAdminCookie)
      .send({
        currentPassword: process.env.SEED_ADMIN_PASSWORD!,
        newPassword: 'SecureRootPass2026!',
      })
      .expect(200);
    adminCookie = extractCookie(changed.headers['set-cookie']);

    // Register a citizen to verify RBAC rejections on admin routes
    const citizenReg = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .set('Origin', allowedOrigin)
      .send({
        fullName: 'Citizen Catalog',
        nationalId: '29905050112314',
        email: 'citizen.catalog@example.com',
        phone: '01012345678',
        password: 'CitizenPassword2026!',
        acceptTerms: true,
      })
      .expect(201);
    citizenCookie = extractCookie(citizenReg.headers['set-cookie']);
  });

  beforeEach(() => {
    app.get(AuthService).resetRateLimiters();
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

  describe('Reference governorates (§2.1)', () => {
    it('returns all 27 governorates sorted alphabetically by English name with public cache header', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/reference/governorates')
        .expect(200);

      expect(res.headers['cache-control']).toBe('public, max-age=86400');
      expect(res.headers['vary']).toContain('Origin');
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(27);
      expect(res.body.data[0].code).toBe('ALEXANDRIA');

      const englishNames = res.body.data.map((g: { name: { en: string } }) => g.name.en);
      const sorted = [...englishNames].sort((a, b) => a.localeCompare(b, 'en'));
      expect(englishNames).toEqual(sorted);
    });
  });

  describe('Settings (§2.2 & §10.8)', () => {
    it('serves public settings with max-age=60 and lets only ADMIN patch with audit logging', async () => {
      const pubRes = await request(app.getHttpServer()).get('/api/v1/settings').expect(200);
      expect(pubRes.headers['cache-control']).toBe('public, max-age=60');
      expect(pubRes.body.data).toMatchObject({
        id: 'singleton',
        supportEmail: null,
        supportPhone: null,
        announcement: null,
      });

      // Citizen forbidden
      await request(app.getHttpServer())
        .patch('/api/v1/admin/settings')
        .set('Origin', allowedOrigin)
        .set('Cookie', citizenCookie)
        .send({ supportEmail: 'help@example.com' })
        .expect(403)
        .expect(({ body }) => expect(body.error.code).toBe('FORBIDDEN'));

      // Empty body rejected
      await request(app.getHttpServer())
        .patch('/api/v1/admin/settings')
        .set('Origin', allowedOrigin)
        .set('Cookie', adminCookie)
        .send({})
        .expect(400)
        .expect(({ body }) => expect(body.error.code).toBe('VALIDATION_ERROR'));

      // Unknown field rejected
      await request(app.getHttpServer())
        .patch('/api/v1/admin/settings')
        .set('Origin', allowedOrigin)
        .set('Cookie', adminCookie)
        .send({ unexpected: 'x' })
        .expect(400)
        .expect(({ body }) => expect(body.error.code).toBe('UNKNOWN_FIELD'));

      // Valid admin patch
      const patchRes = await request(app.getHttpServer())
        .patch('/api/v1/admin/settings')
        .set('Origin', allowedOrigin)
        .set('Cookie', adminCookie)
        .send({
          supportEmail: 'Support@Example.com',
          supportPhone: '+201099998888',
          announcement: { ar: 'إعلان تجريبي', en: 'Test announcement' },
        })
        .expect(200);

      expect(patchRes.headers['cache-control']).toBe('no-store');
      expect(patchRes.body.data).toMatchObject({
        id: 'singleton',
        supportEmail: 'support@example.com',
        supportPhone: '01099998888',
        announcement: { ar: 'إعلان تجريبي', en: 'Test announcement' },
      });

      // Clear announcement with null
      const cleared = await request(app.getHttpServer())
        .patch('/api/v1/admin/settings')
        .set('Origin', allowedOrigin)
        .set('Cookie', adminCookie)
        .send({ announcement: null })
        .expect(200);
      expect(cleared.body.data.announcement).toBeNull();

      const audit = await prisma.audit_logs.findFirst({
        where: { action: 'SETTINGS_UPDATED', entity_type: 'SETTINGS', entity_id: 'singleton' },
      });
      expect(audit).not.toBeNull();
    });
  });

  describe('Services public catalog (§3) & admin draft/publish lifecycle (§8)', () => {
    it('enforces full draft, publish, edit, republish (D-18), versions, unpublish, delete, and public isolation rules', async () => {
      // Citizen cannot access admin services
      await request(app.getHttpServer())
        .get('/api/v1/admin/services')
        .set('Cookie', citizenCookie)
        .expect(403);

      // Invalid formSchema returns 400 INVALID_FORM_SCHEMA with detail path
      const badSchema = makeServiceBody('bad-schema', 'Bad Schema');
      badSchema.formSchema.fields[0].options = [
        { value: 'ONLY_ONE', label: { ar: 'واحد', en: 'One' } },
      ];
      const badRes = await request(app.getHttpServer())
        .post('/api/v1/admin/services')
        .set('Origin', allowedOrigin)
        .set('Cookie', adminCookie)
        .send(badSchema)
        .expect(400);
      expect(badRes.body.error.code).toBe('INVALID_FORM_SCHEMA');
      expect(badRes.body.error.field).toBe('formSchema.fields[0].options');

      // Create draft service
      const createRes = await request(app.getHttpServer())
        .post('/api/v1/admin/services')
        .set('Origin', allowedOrigin)
        .set('Cookie', adminCookie)
        .send(makeServiceBody('national-id', 'National ID Card', 'IDENTITY'))
        .expect(201);

      expect(createRes.body.data).toMatchObject({
        id: 'national-id',
        availability: 'DRAFT',
        publishedVersion: null,
        publishedAt: null,
        hasUnpublishedChanges: true,
      });

      // Duplicate id -> 409 SERVICE_ALREADY_EXISTS
      await request(app.getHttpServer())
        .post('/api/v1/admin/services')
        .set('Origin', allowedOrigin)
        .set('Cookie', adminCookie)
        .send(makeServiceBody('national-id', 'National ID Card', 'IDENTITY'))
        .expect(409)
        .expect(({ body }) => expect(body.error.code).toBe('SERVICE_ALREADY_EXISTS'));

      // Draft is hidden from public catalog
      const emptyPublic = await request(app.getHttpServer()).get('/api/v1/services').expect(200);
      expect(emptyPublic.headers['cache-control']).toBe(
        'public, max-age=60, stale-while-revalidate=300',
      );
      expect(emptyPublic.body.data).toEqual([]);

      await request(app.getHttpServer())
        .get('/api/v1/services/national-id')
        .expect(404)
        .expect(({ body }) => expect(body.error.code).toBe('SERVICE_NOT_FOUND'));

      // Publish v1
      const pubV1 = await request(app.getHttpServer())
        .post('/api/v1/admin/services/national-id/publish')
        .set('Origin', allowedOrigin)
        .set('Cookie', adminCookie)
        .expect(200);

      expect(pubV1.body.data).toMatchObject({
        id: 'national-id',
        availability: 'PUBLISHED',
        publishedVersion: 1,
        hasUnpublishedChanges: false,
      });

      // Publishing again with no changes -> 409 NO_CHANGES_TO_PUBLISH
      await request(app.getHttpServer())
        .post('/api/v1/admin/services/national-id/publish')
        .set('Origin', allowedOrigin)
        .set('Cookie', adminCookie)
        .expect(409)
        .expect(({ body }) => expect(body.error.code).toBe('NO_CHANGES_TO_PUBLISH'));

      // Create & publish a second service (LICENSE) to test ordering and category filtering
      await request(app.getHttpServer())
        .post('/api/v1/admin/services')
        .set('Origin', allowedOrigin)
        .set('Cookie', adminCookie)
        .send(makeServiceBody('driving-license', 'Driving License', 'LICENSE'))
        .expect(201);
      await request(app.getHttpServer())
        .post('/api/v1/admin/services/driving-license/publish')
        .set('Origin', allowedOrigin)
        .set('Cookie', adminCookie)
        .expect(200);

      // Public list ordered by English name: Driving License before National ID Card
      const pubList = await request(app.getHttpServer()).get('/api/v1/services').expect(200);
      expect(pubList.body.data.map((s: { id: string }) => s.id)).toEqual([
        'driving-license',
        'national-id',
      ]);

      // Category filter & invalid category
      const filtered = await request(app.getHttpServer())
        .get('/api/v1/services?category=LICENSE')
        .expect(200);
      expect(filtered.body.data.map((s: { id: string }) => s.id)).toEqual(['driving-license']);

      await request(app.getHttpServer())
        .get('/api/v1/services?category=INVALID')
        .expect(400)
        .expect(({ body }) => expect(body.error.code).toBe('VALIDATION_ERROR'));

      // Edit draft of national-id after publish: public STILL sees v1 fee (5000), admin sees draft fee (7500) + hasUnpublishedChanges=true
      const patchRes = await request(app.getHttpServer())
        .patch('/api/v1/admin/services/national-id')
        .set('Origin', allowedOrigin)
        .set('Cookie', adminCookie)
        .send({ fee: { amount: 7500, currency: 'EGP' } })
        .expect(200);
      expect(patchRes.body.data.hasUnpublishedChanges).toBe(true);
      expect(patchRes.body.data.draft.fee.amount).toBe(7500);

      const pubDetailBeforeRepublish = await request(app.getHttpServer())
        .get('/api/v1/services/national-id')
        .expect(200);
      expect(pubDetailBeforeRepublish.headers['cache-control']).toBe(
        'public, max-age=60, stale-while-revalidate=300',
      );
      expect(pubDetailBeforeRepublish.body.data.fee.amount).toBe(5000);
      expect(pubDetailBeforeRepublish.body.data.version).toBe(1);

      // Publish v2
      const pubV2 = await request(app.getHttpServer())
        .post('/api/v1/admin/services/national-id/publish')
        .set('Origin', allowedOrigin)
        .set('Cookie', adminCookie)
        .expect(200);
      expect(pubV2.body.data.publishedVersion).toBe(2);
      expect(pubV2.body.data.hasUnpublishedChanges).toBe(false);

      // Versions endpoint returns frozen v1 (5000) and v2 (7500)
      const v1 = await request(app.getHttpServer())
        .get('/api/v1/admin/services/national-id/versions/1')
        .set('Cookie', adminCookie)
        .expect(200);
      expect(v1.body.data.definition.fee.amount).toBe(5000);

      const v2 = await request(app.getHttpServer())
        .get('/api/v1/admin/services/national-id/versions/2')
        .set('Cookie', adminCookie)
        .expect(200);
      expect(v2.body.data.definition.fee.amount).toBe(7500);

      await request(app.getHttpServer())
        .get('/api/v1/admin/services/national-id/versions/99')
        .set('Cookie', adminCookie)
        .expect(404)
        .expect(({ body }) => expect(body.error.code).toBe('SERVICE_VERSION_NOT_FOUND'));

      // Unpublish hides from public; unpublishing again -> 409 SERVICE_NOT_PUBLISHED
      await request(app.getHttpServer())
        .post('/api/v1/admin/services/national-id/unpublish')
        .set('Origin', allowedOrigin)
        .set('Cookie', adminCookie)
        .expect(200)
        .expect(({ body }) => expect(body.data.availability).toBe('UNPUBLISHED'));

      await request(app.getHttpServer())
        .get('/api/v1/services/national-id')
        .expect(404)
        .expect(({ body }) => expect(body.error.code).toBe('SERVICE_NOT_FOUND'));

      await request(app.getHttpServer())
        .post('/api/v1/admin/services/national-id/unpublish')
        .set('Origin', allowedOrigin)
        .set('Cookie', adminCookie)
        .expect(409)
        .expect(({ body }) => expect(body.error.code).toBe('SERVICE_NOT_PUBLISHED'));

      // D-18 / C-1: Re-publishing an unchanged UNPUBLISHED service stays at version 2!
      const repub = await request(app.getHttpServer())
        .post('/api/v1/admin/services/national-id/publish')
        .set('Origin', allowedOrigin)
        .set('Cookie', adminCookie)
        .expect(200);
      expect(repub.body.data.availability).toBe('PUBLISHED');
      expect(repub.body.data.publishedVersion).toBe(2);

      // Cannot delete a published (or previously published) service -> 409 SERVICE_CANNOT_BE_DELETED
      await request(app.getHttpServer())
        .delete('/api/v1/admin/services/national-id')
        .set('Origin', allowedOrigin)
        .set('Cookie', adminCookie)
        .expect(409)
        .expect(({ body }) => expect(body.error.code).toBe('SERVICE_CANNOT_BE_DELETED'));

      // Can delete a never-published DRAFT service -> 200 delete envelope
      await request(app.getHttpServer())
        .post('/api/v1/admin/services')
        .set('Origin', allowedOrigin)
        .set('Cookie', adminCookie)
        .send(makeServiceBody('temp-draft', 'Temporary Draft', 'OTHER'))
        .expect(201);

      const delRes = await request(app.getHttpServer())
        .delete('/api/v1/admin/services/temp-draft')
        .set('Origin', allowedOrigin)
        .set('Cookie', adminCookie)
        .expect(200);
      expect(delRes.body).toEqual({
        success: true,
        data: { id: 'temp-draft', deleted: true },
      });

      const deletedAudit = await prisma.audit_logs.findFirst({
        where: { action: 'SERVICE_DELETED', entity_id: 'temp-draft' },
      });
      expect(deletedAudit).not.toBeNull();
    });
  });
});
