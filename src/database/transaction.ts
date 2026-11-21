import { Prisma } from '@prisma/client';
import { PrismaService } from './prisma.service';

export type PrismaTx = Prisma.TransactionClient;

/**
 * Runs a callback inside a single READ COMMITTED interactive transaction (Design §6.2).
 */
export async function withTx<T>(
  prisma: PrismaService,
  work: (tx: PrismaTx) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(work, {
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  });
}

/**
 * Lock order (Design §6.2):
 * application -> delivery -> credential -> users -> advisory locks (assign:<governorate>, staff:admin_active)
 */
export async function lockApplication(tx: PrismaTx, applicationId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM applications WHERE id = ${applicationId}::uuid FOR UPDATE
  `;
  return rows.length > 0;
}

export async function lockDelivery(tx: PrismaTx, deliveryId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM deliveries WHERE id = ${deliveryId}::uuid FOR UPDATE
  `;
  return rows.length > 0;
}

export async function lockCredential(tx: PrismaTx, credentialId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM credentials WHERE id = ${credentialId}::uuid FOR UPDATE
  `;
  return rows.length > 0;
}

export async function lockUser(tx: PrismaTx, userId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE
  `;
  return rows.length > 0;
}

export async function acquireAdvisoryXactLock(tx: PrismaTx, lockKey: string): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
}
