import { INestApplication } from '@nestjs/common';
import { getStorageToken } from '@nestjs/throttler';
import { PrismaService } from '../../src/database/prisma.service';

export async function resetTestDatabase(prisma: PrismaService): Promise<void> {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      audit_logs,
      email_outbox,
      notifications,
      deliveries,
      credentials,
      attachments,
      application_status_history,
      applications,
      password_reset_tokens,
      service_versions,
      services,
      users
    RESTART IDENTITY CASCADE
  `);
}

export function resetThrottlerStorage(app: INestApplication): void {
  const storage = app.get<{ clear?: () => void }>(getStorageToken());
  storage?.clear?.();
}
