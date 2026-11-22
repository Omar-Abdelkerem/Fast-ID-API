import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../database/prisma.service';

export interface CleanupResult {
  deletedResetTokens: number;
  deletedSentEmails: number;
}

/**
 * Daily cleanup job at 03:00 Africa/Cairo (Design §12, Database Design §9):
 * - Deletes used or expired password_reset_tokens older than 7 days.
 * - Deletes SENT email_outbox rows older than 30 days (FAILED rows are kept for diagnosis).
 */
@Injectable()
export class CleanupJob {
  private readonly logger = new Logger(CleanupJob.name);
  private readonly isTestEnv: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    this.isTestEnv = this.configService.get<string>('NODE_ENV') === 'test';
  }

  @Cron('0 0 3 * * *', { timeZone: 'Africa/Cairo' })
  async scheduledCleanup(): Promise<void> {
    if (this.isTestEnv) {
      return;
    }

    try {
      const result = await this.runCleanup();
      this.logger.log({
        msg: 'Daily cleanup completed',
        deletedResetTokens: result.deletedResetTokens,
        deletedSentEmails: result.deletedSentEmails,
      });
    } catch (error) {
      this.logger.error('Daily cleanup failed', error instanceof Error ? error.stack : undefined);
    }
  }

  async runCleanup(): Promise<CleanupResult> {
    const deletedResetTokens = await this.prisma.$executeRaw`
      DELETE FROM password_reset_tokens
      WHERE (used_at IS NOT NULL AND used_at < now() - interval '7 days')
         OR expires_at < now() - interval '7 days'
    `;

    const deletedSentEmails = await this.prisma.$executeRaw`
      DELETE FROM email_outbox
      WHERE status = 'SENT'
        AND sent_at < now() - interval '30 days'
    `;

    return { deletedResetTokens, deletedSentEmails };
  }
}
