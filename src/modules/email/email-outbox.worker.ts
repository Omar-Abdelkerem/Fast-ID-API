import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { email_outbox } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { withTx } from '../../database/transaction';
import { EMAIL_PROVIDER, EmailProvider } from './email-provider.interface';
import { renderEmailTemplate } from './email-templates';

// Backoff intervals in seconds: 1m, 5m, 30m, 2h, 6h (Design §9)
const BACKOFF_SECONDS = [60, 300, 1800, 7200, 21600] as const;
const MAX_FAILED_ATTEMPTS = 5;

@Injectable()
export class EmailOutboxWorker implements OnModuleDestroy {
  private readonly logger = new Logger(EmailOutboxWorker.name);
  private readonly isTestEnv: boolean;
  private isRunning = false;
  private isShuttingDown = false;
  private activeBatchPromise: Promise<number> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    @Inject(EMAIL_PROVIDER) private readonly emailProvider: EmailProvider,
  ) {
    this.isTestEnv = this.configService.get<string>('NODE_ENV') === 'test';
  }

  @Interval(10_000)
  async scheduledTick(): Promise<void> {
    if (this.isTestEnv || this.isShuttingDown) {
      return;
    }
    await this.processBatch();
  }

  async processBatch(): Promise<number> {
    if (this.isRunning || this.isShuttingDown) {
      return 0;
    }

    this.isRunning = true;
    const runPromise = this.executeBatch();
    this.activeBatchPromise = runPromise;

    try {
      return await runPromise;
    } finally {
      this.isRunning = false;
      this.activeBatchPromise = null;
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.isShuttingDown = true;
    if (this.activeBatchPromise) {
      await this.activeBatchPromise.catch(() => undefined);
    }
  }

  private async executeBatch(): Promise<number> {
    let claimedRows: email_outbox[] = [];
    try {
      // 1. Claim due rows inside a short DB transaction (never hold a DB lock during HTTP sends).
      claimedRows = await withTx(this.prisma, async (tx) => {
        return tx.$queryRaw<email_outbox[]>`
          WITH due AS (
            SELECT id FROM email_outbox
            WHERE status = 'PENDING'
              AND next_attempt_at <= now()
              AND (locked_until IS NULL OR locked_until <= now())
            ORDER BY next_attempt_at
            LIMIT 20
            FOR UPDATE SKIP LOCKED
          )
          UPDATE email_outbox
          SET locked_until = now() + interval '2 minutes'
          WHERE id IN (SELECT id FROM due)
          RETURNING *
        `;
      });
    } catch (error) {
      this.logger.error(
        'Failed to claim email_outbox batch',
        error instanceof Error ? error.stack : undefined,
      );
      return 0;
    }

    // 2. Render & dispatch outside any DB transaction, then update each row in a short update.
    for (const row of claimedRows) {
      const payload =
        typeof row.payload === 'object' && row.payload !== null
          ? (row.payload as Record<string, unknown>)
          : {};

      try {
        const rendered = renderEmailTemplate({
          to: row.to_email,
          template: row.template,
          language: row.language,
          payload,
        });
        await this.emailProvider.send(rendered);

        await this.prisma.$executeRaw`
          UPDATE email_outbox
          SET status = 'SENT', sent_at = now(), locked_until = NULL, last_error = NULL
          WHERE id = ${row.id}::uuid
        `;
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message.slice(0, 500) : 'Email send failed';
        const nextAttempts = row.attempts + 1;

        if (nextAttempts >= MAX_FAILED_ATTEMPTS) {
          await this.prisma.$executeRaw`
            UPDATE email_outbox
            SET status = 'FAILED',
                attempts = ${nextAttempts},
                locked_until = NULL,
                last_error = ${errorMessage}
            WHERE id = ${row.id}::uuid
          `;
        } else {
          const delaySeconds =
            BACKOFF_SECONDS[Math.min(nextAttempts - 1, BACKOFF_SECONDS.length - 1)];
          await this.prisma.$executeRaw`
            UPDATE email_outbox
            SET attempts = ${nextAttempts},
                locked_until = NULL,
                last_error = ${errorMessage},
                next_attempt_at = now() + make_interval(secs => ${delaySeconds})
            WHERE id = ${row.id}::uuid
          `;
        }

        this.logger.warn({
          msg: 'Email outbox delivery attempt failed',
          outboxId: row.id,
          template: row.template,
          attempts: nextAttempts,
        });
      }
    }

    return claimedRows.length;
  }
}
