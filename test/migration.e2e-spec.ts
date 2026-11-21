import './helpers/test-env';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';

describe('Database migration 0001_init invariants (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication({ bodyParser: false });
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('seeds the singleton settings row', async () => {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM settings WHERE id = 'singleton'
    `;
    expect(rows).toEqual([{ id: 'singleton' }]);
  });

  it('enforces append-only trigger on audit_logs', async () => {
    const inserted = await prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO audit_logs (action, entity_type, entity_id, metadata)
      VALUES ('SETTINGS_UPDATED', 'SETTINGS', 'singleton', '{}'::jsonb)
      RETURNING id::text
    `;
    const auditId = inserted[0].id;

    await expect(
      prisma.$executeRaw`
        UPDATE audit_logs SET entity_id = 'tampered' WHERE id = ${auditId}::uuid
      `,
    ).rejects.toThrow(/audit_logs is append-only/);

    await expect(
      prisma.$executeRaw`
        DELETE FROM audit_logs WHERE id = ${auditId}::uuid
      `,
    ).rejects.toThrow(/audit_logs is append-only/);
  });
});
