import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { validatePasswordStrength } from '../../common/utils/password';
import { PrismaService } from '../../database/prisma.service';
import { acquireAdvisoryXactLock, withTx } from '../../database/transaction';

/**
 * First-boot bootstrap (Contract Appendix A.2, Database Design §11, Prompt Rule #4):
 * - Ensures the settings singleton row exists.
 * - Creates the first ADMIN account from SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD
 *   ONLY when zero ADMIN rows exist; fails boot if missing and zero admins exist.
 */
@Injectable()
export class SeedService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SeedService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.ensureBootstrapData();
  }

  async ensureBootstrapData(): Promise<void> {
    // 1. Always guarantee the singleton settings row exists.
    await this.prisma.$executeRaw`
      INSERT INTO settings (id) VALUES ('singleton') ON CONFLICT (id) DO NOTHING
    `;

    // 2. Enforce first-boot ADMIN bootstrap under the staff:admin_active advisory lock.
    await withTx(this.prisma, async (tx) => {
      await acquireAdvisoryXactLock(tx, 'staff:admin_active');

      const adminCount = await tx.users.count({
        where: { role: 'ADMIN' },
      });

      if (adminCount > 0) {
        return;
      }

      const rawEmail = this.configService.get<string>('SEED_ADMIN_EMAIL');
      const rawPassword = this.configService.get<string>('SEED_ADMIN_PASSWORD');

      if (!rawEmail || !rawPassword) {
        throw new Error(
          'Zero ADMIN accounts exist in the database. Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD for first boot.',
        );
      }

      const normalizedEmail = rawEmail.trim().toLowerCase();
      const strengthCheck = validatePasswordStrength(rawPassword, { email: normalizedEmail });
      if (!strengthCheck.valid) {
        throw new Error(`Invalid SEED_ADMIN_PASSWORD: ${strengthCheck.message}`);
      }

      const passwordHash = await argon2.hash(rawPassword, { type: argon2.argon2id });

      await tx.users.create({
        data: {
          role: 'ADMIN',
          full_name: 'System Administrator',
          email: normalizedEmail,
          phone: '01000000000',
          password_hash: passwordHash,
          preferred_language: 'ar',
          is_active: true,
          must_change_password: true,
        },
      });

      this.logger.log('Bootstrapped initial ADMIN account (mustChangePassword=true)');
    });
  }
}
