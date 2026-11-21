import './helpers/test-env';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { EmailOutboxWorker } from '../src/modules/email/email-outbox.worker';
import {
  EMAIL_PROVIDER,
  EmailProvider,
  RenderedEmail,
} from '../src/modules/email/email-provider.interface';

describe('EmailOutboxWorker lease & retry (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let worker: EmailOutboxWorker;
  const sentEmails: RenderedEmail[] = [];
  let shouldFail = false;

  const mockProvider: EmailProvider = {
    async send(email: RenderedEmail) {
      if (shouldFail) {
        throw new Error('SMTP provider timeout');
      }
      sentEmails.push(email);
    },
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(EMAIL_PROVIDER)
      .useValue(mockProvider)
      .compile();

    app = moduleRef.createNestApplication({ bodyParser: false });
    await app.init();

    prisma = app.get(PrismaService);
    worker = app.get(EmailOutboxWorker);
  });

  beforeEach(async () => {
    sentEmails.length = 0;
    shouldFail = false;
    await prisma.email_outbox.deleteMany();
  });

  afterAll(async () => {
    await prisma.email_outbox.deleteMany();
    await app.close();
  });

  it('claims due PENDING rows with lease, sends outside tx, and marks SENT', async () => {
    const row = await prisma.email_outbox.create({
      data: {
        to_email: 'worker.ok@example.com',
        template: 'PASSWORD_CHANGED',
        language: 'en',
        payload: {},
        status: 'PENDING',
      },
    });

    const processed = await worker.processBatch();
    expect(processed).toBe(1);
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].to).toBe('worker.ok@example.com');

    const updated = await prisma.email_outbox.findUniqueOrThrow({ where: { id: row.id } });
    expect(updated.status).toBe('SENT');
    expect(updated.sent_at).not.toBeNull();
    expect(updated.locked_until).toBeNull();
  });

  it('retries with backoff on failure and marks FAILED on the 5th attempt', async () => {
    shouldFail = true;
    const row = await prisma.email_outbox.create({
      data: {
        to_email: 'worker.fail@example.com',
        template: 'PASSWORD_CHANGED',
        language: 'ar',
        payload: {},
        status: 'PENDING',
      },
    });

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await prisma.$executeRaw`
        UPDATE email_outbox SET next_attempt_at = now() - interval '1 second' WHERE id = ${row.id}::uuid
      `;
      const processed = await worker.processBatch();
      expect(processed).toBe(1);

      const mid = await prisma.email_outbox.findUniqueOrThrow({ where: { id: row.id } });
      expect(mid.status).toBe('PENDING');
      expect(mid.attempts).toBe(attempt);
      expect(mid.locked_until).toBeNull();
      expect(mid.last_error).toContain('SMTP provider timeout');
      expect(mid.next_attempt_at.getTime()).toBeGreaterThan(Date.now());
    }

    // 5th failure transitions status to FAILED
    await prisma.$executeRaw`
      UPDATE email_outbox SET next_attempt_at = now() - interval '1 second' WHERE id = ${row.id}::uuid
    `;
    await worker.processBatch();

    const finalRow = await prisma.email_outbox.findUniqueOrThrow({ where: { id: row.id } });
    expect(finalRow.status).toBe('FAILED');
    expect(finalRow.attempts).toBe(5);
    expect(finalRow.locked_until).toBeNull();
    expect(finalRow.sent_at).toBeNull();
  });
});
