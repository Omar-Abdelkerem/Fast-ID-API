import './helpers/test-env';
import * as fs from 'fs';
import * as path from 'path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
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

const VALID_PNG_BUFFER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const VALID_JPEG_BUFFER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

function extractCookie(setCookie: string[] | string | undefined): string {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const found = list.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (!found) {
    throw new Error('Expected fid_session cookie');
  }
  return found.split(';')[0];
}

function makeServicePayload(id: string, feeAmount: number) {
  return {
    id,
    name: { ar: 'بطاقة الرقم القومي', en: 'National ID Card' },
    description: { ar: 'إصدار بطاقة رقم قومي', en: 'Issue national ID card' },
    category: 'IDENTITY',
    fee: { amount: feeAmount, currency: 'EGP' },
    slaDays: 3,
    validityYears: 7,
    requiredDocuments: [
      {
        key: 'personalPhoto',
        label: { ar: 'صورة شخصية', en: 'Personal photo' },
        required: true,
        allowedMimeTypes: ['image/png', 'image/jpeg'],
        maxSizeBytes: 1024,
      },
      {
        key: 'optionalDoc',
        label: { ar: 'مستند إضافي', en: 'Optional doc' },
        required: false,
        allowedMimeTypes: ['image/png', 'application/pdf'],
        maxSizeBytes: 2048,
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
        {
          key: 'referenceCode',
          label: { ar: 'كود مرجعي', en: 'Reference code' },
          helpText: null,
          type: 'TEXT',
          required: false,
          options: null,
          validation: { minLength: 3, maxLength: 10, pattern: '^[A-Z0-9]+$' },
        },
        {
          key: 'acceptDeclaration',
          label: { ar: 'إقرار', en: 'Declaration' },
          helpText: null,
          type: 'CHECKBOX',
          required: true,
          options: null,
          validation: {},
        },
      ],
    },
  };
}

describe('Citizen Applications & Attachments (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const allowedOrigin = getTestAllowedOrigin();
  const storageRoot = path.resolve(process.env.STORAGE_LOCAL_PATH ?? './storage');
  let adminCookie: string;
  let citizenOneCookie: string;
  let citizenTwoCookie: string;

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

    // Log in admin and complete forced password change
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
        fullName: 'Ahmed Kamal',
        nationalId: '29901150112314',
        email: 'citizen.one.apps@example.com',
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
        fullName: 'Mona Hassan',
        nationalId: '30103150112324',
        email: 'citizen.two.apps@example.com',
        phone: '01112345678',
        password: 'CitizenTwoPassword2026!',
        acceptTerms: true,
      })
      .expect(201);
    citizenTwoCookie = extractCookie(c2.headers['set-cookie']);

    // Create and publish test service
    await request(app.getHttpServer())
      .post('/api/v1/admin/services')
      .set('Origin', allowedOrigin)
      .set('Cookie', adminCookie)
      .send(makeServicePayload('national-id', 5000))
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/admin/services/national-id/publish')
      .set('Origin', allowedOrigin)
      .set('Cookie', adminCookie)
      .expect(200);
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
      await fs.promises.rm(storageRoot, { recursive: true, force: true });
    } finally {
      await app.close();
    }
  });

  it('prevents duplicate active applications under concurrent double create (§4.1 race test)', async () => {
    const [r1, r2] = await Promise.all([
      request(app.getHttpServer())
        .post('/api/v1/applications')
        .set('Origin', allowedOrigin)
        .set('Cookie', citizenOneCookie)
        .send({ serviceId: 'national-id' }),
      request(app.getHttpServer())
        .post('/api/v1/applications')
        .set('Origin', allowedOrigin)
        .set('Cookie', citizenOneCookie)
        .send({ serviceId: 'national-id' }),
    ]);

    const statuses = [r1.status, r2.status].sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409]);

    const created = r1.status === 201 ? r1 : r2;
    const conflict = r1.status === 409 ? r1 : r2;

    expect(conflict.body.error.code).toBe('ACTIVE_APPLICATION_EXISTS');
    expect(created.body.data).toMatchObject({
      status: 'DRAFT',
      serviceVersion: 1,
      data: {},
      deliveryAddress: null,
      statusHistory: [],
      payment: {
        status: 'UNPAID',
        amount: { amount: 5000, currency: 'EGP' },
        paidAt: null,
        reference: null,
      },
    });
    expect(created.body.data.applicationNumber).toMatch(/^APP-\d{4}-\d{6}$/);

    // Verify 0 history rows exist for a draft
    const historyCount = await prisma.application_status_history.count({
      where: { application_id: created.body.data.id },
    });
    expect(historyCount).toBe(0);

    // Another citizen cannot see or mutate citizenOne's draft (404 APPLICATION_NOT_FOUND)
    await request(app.getHttpServer())
      .get(`/api/v1/applications/${created.body.data.id}`)
      .set('Cookie', citizenTwoCookie)
      .expect(404)
      .expect(({ body }) => expect(body.error.code).toBe('APPLICATION_NOT_FOUND'));

    // Clean up draft
    await request(app.getHttpServer())
      .delete(`/api/v1/applications/${created.body.data.id}`)
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenOneCookie)
      .expect(200);
  });

  it('syncs unpaid/free draft fees on service fee changes (C-10) and locks amount once PAID (§4.6)', async () => {
    const draftRes = await request(app.getHttpServer())
      .post('/api/v1/applications')
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenOneCookie)
      .send({ serviceId: 'national-id' })
      .expect(201);
    const appId = draftRes.body.data.id;

    // Admin updates fee 5000 -> 0 and publishes v2
    await request(app.getHttpServer())
      .patch('/api/v1/admin/services/national-id')
      .set('Origin', allowedOrigin)
      .set('Cookie', adminCookie)
      .send({ fee: { amount: 0, currency: 'EGP' } })
      .expect(200);
    await request(app.getHttpServer())
      .post('/api/v1/admin/services/national-id/publish')
      .set('Origin', allowedOrigin)
      .set('Cookie', adminCookie)
      .expect(200);

    // Reading draft re-syncs payment to NOT_REQUIRED / 0
    const freeRead = await request(app.getHttpServer())
      .get(`/api/v1/applications/${appId}`)
      .set('Cookie', citizenOneCookie)
      .expect(200);
    expect(freeRead.body.data.payment).toMatchObject({
      status: 'NOT_REQUIRED',
      amount: { amount: 0, currency: 'EGP' },
    });

    // Mock payment on free service -> 409 PAYMENT_NOT_REQUIRED
    await request(app.getHttpServer())
      .post(`/api/v1/applications/${appId}/payment/mock`)
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenOneCookie)
      .expect(409)
      .expect(({ body }) => expect(body.error.code).toBe('PAYMENT_NOT_REQUIRED'));

    // Admin updates fee 0 -> 7500 and publishes v3
    await request(app.getHttpServer())
      .patch('/api/v1/admin/services/national-id')
      .set('Origin', allowedOrigin)
      .set('Cookie', adminCookie)
      .send({ fee: { amount: 7500, currency: 'EGP' } })
      .expect(200);
    await request(app.getHttpServer())
      .post('/api/v1/admin/services/national-id/publish')
      .set('Origin', allowedOrigin)
      .set('Cookie', adminCookie)
      .expect(200);

    // Mock payment marks PAID at 7500
    const paidRes = await request(app.getHttpServer())
      .post(`/api/v1/applications/${appId}/payment/mock`)
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenOneCookie)
      .expect(200);
    expect(paidRes.body.data.payment.status).toBe('PAID');
    expect(paidRes.body.data.payment.amount.amount).toBe(7500);
    expect(paidRes.body.data.payment.reference).toMatch(/^MOCK-[0-9A-F]+$/);

    // Paying again -> 409 PAYMENT_ALREADY_COMPLETED
    await request(app.getHttpServer())
      .post(`/api/v1/applications/${appId}/payment/mock`)
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenOneCookie)
      .expect(409)
      .expect(({ body }) => expect(body.error.code).toBe('PAYMENT_ALREADY_COMPLETED'));

    // Admin changes fee to 9900 and publishes v4 -> already PAID draft stays locked at 7500
    await request(app.getHttpServer())
      .patch('/api/v1/admin/services/national-id')
      .set('Origin', allowedOrigin)
      .set('Cookie', adminCookie)
      .send({ fee: { amount: 9900, currency: 'EGP' } })
      .expect(200);
    await request(app.getHttpServer())
      .post('/api/v1/admin/services/national-id/publish')
      .set('Origin', allowedOrigin)
      .set('Cookie', adminCookie)
      .expect(200);

    const lockedRead = await request(app.getHttpServer())
      .get(`/api/v1/applications/${appId}`)
      .set('Cookie', citizenOneCookie)
      .expect(200);
    expect(lockedRead.body.data.payment.status).toBe('PAID');
    expect(lockedRead.body.data.payment.amount.amount).toBe(7500);

    // Clean up draft
    await request(app.getHttpServer())
      .delete(`/api/v1/applications/${appId}`)
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenOneCookie)
      .expect(200);
  });

  it('handles attachments pipeline (sniffing, mismatch, size, unpublished, replace, CSP+RFC5987 download, delete, draft-delete cleanup)', async () => {
    const draftRes = await request(app.getHttpServer())
      .post('/api/v1/applications')
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenOneCookie)
      .send({ serviceId: 'national-id' })
      .expect(201);
    const appId = draftRes.body.data.id;

    // Missing file -> 400 FILE_REQUIRED
    await request(app.getHttpServer())
      .post(`/api/v1/applications/${appId}/attachments`)
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenOneCookie)
      .field('requirementKey', 'personalPhoto')
      .expect(400)
      .expect(({ body }) => expect(body.error.code).toBe('FILE_REQUIRED'));

    // Unknown requirementKey -> 400 UNKNOWN_REQUIREMENT_KEY
    await request(app.getHttpServer())
      .post(`/api/v1/applications/${appId}/attachments`)
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenOneCookie)
      .field('requirementKey', 'unknownKey')
      .attach('file', VALID_PNG_BUFFER, { filename: 'a.png', contentType: 'image/png' })
      .expect(400)
      .expect(({ body }) => expect(body.error.code).toBe('UNKNOWN_REQUIREMENT_KEY'));

    // Oversized file (> 1024 bytes maxSizeBytes) -> 413 FILE_TOO_LARGE
    const bigPng = Buffer.concat([VALID_PNG_BUFFER, Buffer.alloc(1200, 1)]);
    await request(app.getHttpServer())
      .post(`/api/v1/applications/${appId}/attachments`)
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenOneCookie)
      .field('requirementKey', 'personalPhoto')
      .attach('file', bigPng, { filename: 'big.png', contentType: 'image/png' })
      .expect(413)
      .expect(({ body }) => expect(body.error.code).toBe('FILE_TOO_LARGE'));

    // Spoofed HTML bytes claiming image/png -> 415 UNSUPPORTED_FILE_TYPE
    await request(app.getHttpServer())
      .post(`/api/v1/applications/${appId}/attachments`)
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenOneCookie)
      .field('requirementKey', 'personalPhoto')
      .attach('file', Buffer.from('<html>evil</html>'), {
        filename: 'fake.png',
        contentType: 'image/png',
      })
      .expect(415)
      .expect(({ body }) => expect(body.error.code).toBe('UNSUPPORTED_FILE_TYPE'));

    // Real PNG bytes claiming image/jpeg -> 415 FILE_CONTENT_MISMATCH
    await request(app.getHttpServer())
      .post(`/api/v1/applications/${appId}/attachments`)
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenOneCookie)
      .field('requirementKey', 'personalPhoto')
      .attach('file', VALID_PNG_BUFFER, { filename: 'x.jpg', contentType: 'image/jpeg' })
      .expect(415)
      .expect(({ body }) => expect(body.error.code).toBe('FILE_CONTENT_MISMATCH'));

    // Upload valid PNG with Arabic filename
    const upload1 = await request(app.getHttpServer())
      .post(`/api/v1/applications/${appId}/attachments`)
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenOneCookie)
      .field('requirementKey', 'personalPhoto')
      .attach('file', VALID_PNG_BUFFER, {
        filename: 'صورة.png',
        contentType: 'image/png',
      })
      .expect(201);
    const attId = upload1.body.data.id;
    const firstKey = (await prisma.attachments.findUniqueOrThrow({ where: { id: attId } }))
      .storage_key;
    expect(fs.existsSync(path.join(storageRoot, firstKey))).toBe(true);

    // Replace same requirementKey with JPEG -> old file removed from disk
    const upload2 = await request(app.getHttpServer())
      .post(`/api/v1/applications/${appId}/attachments`)
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenOneCookie)
      .field('requirementKey', 'personalPhoto')
      .attach('file', VALID_JPEG_BUFFER, {
        filename: 'صورة شخصية.jpg',
        contentType: 'image/jpeg',
      })
      .expect(201);
    const secondKey = (
      await prisma.attachments.findUniqueOrThrow({ where: { id: upload2.body.data.id } })
    ).storage_key;
    expect(fs.existsSync(path.join(storageRoot, firstKey))).toBe(false);
    expect(fs.existsSync(path.join(storageRoot, secondKey))).toBe(true);

    // Download by owning citizen verifies CSP sandbox & RFC 5987 UTF-8 Content-Disposition
    const dlCitizen = await request(app.getHttpServer())
      .get(`/api/v1/applications/${appId}/attachments/${upload2.body.data.id}/file`)
      .set('Cookie', citizenOneCookie)
      .expect(200);
    expect(dlCitizen.headers['content-type']).toContain('image/jpeg');
    expect(dlCitizen.headers['x-content-type-options']).toBe('nosniff');
    expect(dlCitizen.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(dlCitizen.headers['cache-control']).toBe('no-store');
    expect(dlCitizen.headers['content-disposition']).toContain("filename*=UTF-8''");
    expect(Buffer.from(dlCitizen.body)).toEqual(VALID_JPEG_BUFFER);

    // Admin can also download; another citizen gets 404 APPLICATION_NOT_FOUND
    await request(app.getHttpServer())
      .get(`/api/v1/applications/${appId}/attachments/${upload2.body.data.id}/file`)
      .set('Cookie', adminCookie)
      .expect(200);

    await request(app.getHttpServer())
      .get(`/api/v1/applications/${appId}/attachments/${upload2.body.data.id}/file`)
      .set('Cookie', citizenTwoCookie)
      .expect(404)
      .expect(({ body }) => expect(body.error.code).toBe('APPLICATION_NOT_FOUND'));

    // Unpublished service rejects uploads with 409 SERVICE_NOT_AVAILABLE
    await request(app.getHttpServer())
      .post('/api/v1/admin/services/national-id/unpublish')
      .set('Origin', allowedOrigin)
      .set('Cookie', adminCookie)
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/v1/applications/${appId}/attachments`)
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenOneCookie)
      .field('requirementKey', 'optionalDoc')
      .attach('file', VALID_PNG_BUFFER, { filename: 'opt.png', contentType: 'image/png' })
      .expect(409)
      .expect(({ body }) => expect(body.error.code).toBe('SERVICE_NOT_AVAILABLE'));

    // Re-publish service
    await request(app.getHttpServer())
      .post('/api/v1/admin/services/national-id/publish')
      .set('Origin', allowedOrigin)
      .set('Cookie', adminCookie)
      .expect(200);

    // Deleting draft cascades attachment metadata AND removes physical file from disk
    await request(app.getHttpServer())
      .delete(`/api/v1/applications/${appId}`)
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenOneCookie)
      .expect(200);

    expect(fs.existsSync(path.join(storageRoot, secondKey))).toBe(false);
  });

  it('runs full patch, submit check order, concurrent upload-vs-submit race (D-25), list, and cancel flow (§4.2, §4.4, §4.7, §4.8)', async () => {
    const draftRes = await request(app.getHttpServer())
      .post('/api/v1/applications')
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenOneCookie)
      .send({ serviceId: 'national-id' })
      .expect(201);
    const appId = draftRes.body.data.id;

    // Submit empty draft -> 400 MISSING_REQUIRED_FIELDS with individual address subfields
    const missingFields = await request(app.getHttpServer())
      .post(`/api/v1/applications/${appId}/submit`)
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenOneCookie)
      .expect(400);
    expect(missingFields.body.error.code).toBe('MISSING_REQUIRED_FIELDS');
    const missingPaths = missingFields.body.error.details.map((d: { field: string }) => d.field);
    expect(missingPaths).toContain('data.reason');
    expect(missingPaths).toContain('data.acceptDeclaration');
    expect(missingPaths).toContain('deliveryAddress.governorate');
    expect(missingPaths).toContain('deliveryAddress.city');
    expect(missingPaths).toContain('deliveryAddress.addressLine');
    expect(missingPaths).toContain('deliveryAddress.phone');

    // PATCH with merge & null-clearing + unknown key check
    await request(app.getHttpServer())
      .patch(`/api/v1/applications/${appId}`)
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenOneCookie)
      .send({ data: { unknownKey: 'x' } })
      .expect(400)
      .expect(({ body }) => {
        expect(body.error.code).toBe('UNKNOWN_FIELD');
        expect(body.error.field).toBe('data.unknownKey');
      });

    await request(app.getHttpServer())
      .patch(`/api/v1/applications/${appId}`)
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenOneCookie)
      .send({
        data: { reason: 'FIRST_ISSUE', referenceCode: 'ABC123', acceptDeclaration: true },
        deliveryAddress: {
          governorate: 'CAIRO',
          city: 'Nasr City',
          addressLine: '12 Abbas El Akkad Street',
          phone: '+201012345678',
          notes: 'Call on arrival',
        },
      })
      .expect(200);

    // Clear referenceCode and notes with null
    const clearedPatch = await request(app.getHttpServer())
      .patch(`/api/v1/applications/${appId}`)
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenOneCookie)
      .send({ data: { referenceCode: null }, deliveryAddress: { notes: null } })
      .expect(200);
    expect(clearedPatch.body.data.data).toEqual({
      reason: 'FIRST_ISSUE',
      acceptDeclaration: true,
    });
    expect(clearedPatch.body.data.deliveryAddress.notes).toBeNull();

    // Submit without required document -> 400 MISSING_REQUIRED_DOCUMENTS
    const missingDocs = await request(app.getHttpServer())
      .post(`/api/v1/applications/${appId}/submit`)
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenOneCookie)
      .expect(400);
    expect(missingDocs.body.error.code).toBe('MISSING_REQUIRED_DOCUMENTS');
    expect(missingDocs.body.error.field).toBe('attachments.personalPhoto');

    // Upload required document
    await request(app.getHttpServer())
      .post(`/api/v1/applications/${appId}/attachments`)
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenOneCookie)
      .field('requirementKey', 'personalPhoto')
      .attach('file', VALID_PNG_BUFFER, { filename: 'photo.png', contentType: 'image/png' })
      .expect(201);

    // Submit before payment -> 409 PAYMENT_NOT_COMPLETED
    await request(app.getHttpServer())
      .post(`/api/v1/applications/${appId}/submit`)
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenOneCookie)
      .expect(409)
      .expect(({ body }) => expect(body.error.code).toBe('PAYMENT_NOT_COMPLETED'));

    // Complete mock payment
    await request(app.getHttpServer())
      .post(`/api/v1/applications/${appId}/payment/mock`)
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenOneCookie)
      .expect(200);

    // Cancel while still DRAFT -> 409 INVALID_STATUS_TRANSITION
    await request(app.getHttpServer())
      .post(`/api/v1/applications/${appId}/cancel`)
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenOneCookie)
      .send({ reason: 'Too early' })
      .expect(409)
      .expect(({ body }) => expect(body.error.code).toBe('INVALID_STATUS_TRANSITION'));

    // Concurrent upload (optionalDoc) vs submit race test (D-25)
    const [submitRes, uploadRaceRes] = await Promise.all([
      request(app.getHttpServer())
        .post(`/api/v1/applications/${appId}/submit`)
        .set('Origin', allowedOrigin)
        .set('Cookie', citizenOneCookie),
      request(app.getHttpServer())
        .post(`/api/v1/applications/${appId}/attachments`)
        .set('Origin', allowedOrigin)
        .set('Cookie', citizenOneCookie)
        .field('requirementKey', 'optionalDoc')
        .attach('file', VALID_PNG_BUFFER, { filename: 'opt.png', contentType: 'image/png' }),
    ]);

    expect(submitRes.status).toBe(200);
    expect(submitRes.body.data.status).toBe('SUBMITTED');
    expect(submitRes.body.data.submittedAt).not.toBeNull();
    expect(submitRes.body.data.dueAt).not.toBeNull();
    expect(submitRes.body.data.statusHistory).toHaveLength(1);
    expect(submitRes.body.data.statusHistory[0].status).toBe('SUBMITTED');
    // Upload either won the lock BEFORE submit (201) or lost and got rejected (409 APPLICATION_NOT_EDITABLE)
    expect([201, 409]).toContain(uploadRaceRes.status);
    if (uploadRaceRes.status === 409) {
      expect(uploadRaceRes.body.error.code).toBe('APPLICATION_NOT_EDITABLE');
    }

    // Verify submit side effects: audit, notification (APPLICATION entity), email_outbox
    const subNotif = await prisma.notifications.findFirst({
      where: { entity_id: appId, type: 'APPLICATION_SUBMITTED' },
    });
    expect(subNotif).not.toBeNull();
    expect(subNotif?.entity_type).toBe('APPLICATION');

    const subEmail = await prisma.email_outbox.findFirst({
      where: { template: 'APPLICATION_SUBMITTED', to_email: 'citizen.one.apps@example.com' },
    });
    expect(subEmail).not.toBeNull();

    // Paginated list omits attachments & statusHistory (returns [])
    const listRes = await request(app.getHttpServer())
      .get('/api/v1/applications?status=SUBMITTED&page=1&pageSize=10')
      .set('Cookie', citizenOneCookie)
      .expect(200);
    expect(listRes.body.meta).toEqual({ page: 1, pageSize: 10, total: 1, totalPages: 1 });
    expect(listRes.body.data[0].attachments).toEqual([]);
    expect(listRes.body.data[0].statusHistory).toEqual([]);

    // Cancel SUBMITTED application -> 200 CANCELLED with citizen note
    const cancelRes = await request(app.getHttpServer())
      .post(`/api/v1/applications/${appId}/cancel`)
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenOneCookie)
      .send({ reason: 'Applied by mistake' })
      .expect(200);
    expect(cancelRes.body.data.status).toBe('CANCELLED');
    expect(cancelRes.body.data.statusHistory).toHaveLength(2);
    expect(cancelRes.body.data.statusHistory[1].note).toBe('Applied by mistake');

    // CANCELLED does not block creating a new draft for the same service
    await request(app.getHttpServer())
      .post('/api/v1/applications')
      .set('Origin', allowedOrigin)
      .set('Cookie', citizenOneCookie)
      .send({ serviceId: 'national-id' })
      .expect(201);
  });
});
