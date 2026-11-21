import { randomInt } from 'crypto';
import { Injectable } from '@nestjs/common';
import { credentials, Prisma } from '@prisma/client';
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { AppException } from '../../common/errors/app-exception';
import { generateOpaqueToken } from '../../common/utils/crypto';
import { isUuid } from '../../common/utils/uuid';
import { PrismaService } from '../../database/prisma.service';
import { lockCredential, PrismaTx, withTx } from '../../database/transaction';
import { AuditService } from '../audit/audit.service';
import { EmailService } from '../email/email.service';
import { NotificationsWriterService } from '../notifications/notifications-writer.service';
import { LocalizedText, ServiceDefinition } from '../services/service-definition.types';
import {
  CredentialResponse,
  mapCredentialResponse,
  mapVerifyCredentialResponse,
  VerifyCredentialResponse,
} from './credential-response.mapper';

const CREDENTIAL_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function generateCredentialNumber(): string {
  let suffix = '';
  for (let i = 0; i < 10; i += 1) {
    suffix += CREDENTIAL_ALPHABET[randomInt(0, CREDENTIAL_ALPHABET.length)];
  }
  return `CRD-${suffix}`;
}

export interface IssueCredentialParams {
  applicationId: string;
  holderId: string;
  serviceId: string;
  holderName: string;
  validityYears: number | null;
}

@Injectable()
export class CredentialsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly emailService: EmailService,
    private readonly notificationsWriter: NotificationsWriterService,
  ) {}

  /**
   * Issues a credential inside the caller's approval transaction (Design §6.4, C-5).
   * Computes expires_at in PostgreSQL via issued_at + make_interval(years => validityYears)
   * (leap-day safe: Feb 29 + 1 year clamps to Feb 28). Retries up to 3 times on unique collision.
   */
  async issueInTx(tx: PrismaTx, params: IssueCredentialParams): Promise<credentials> {
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const number = generateCredentialNumber();
      const qrToken = generateOpaqueToken(32);

      try {
        const [inserted] =
          params.validityYears === null
            ? await tx.$queryRaw<credentials[]>`
                INSERT INTO credentials (
                  application_id, holder_id, service_id, holder_name, number, qr_token, issued_at, expires_at
                )
                VALUES (
                  ${params.applicationId}::uuid,
                  ${params.holderId}::uuid,
                  ${params.serviceId},
                  ${params.holderName},
                  ${number},
                  ${qrToken},
                  now(),
                  NULL
                )
                RETURNING *
              `
            : await tx.$queryRaw<credentials[]>`
                WITH ts AS (SELECT now() AS issued_at)
                INSERT INTO credentials (
                  application_id, holder_id, service_id, holder_name, number, qr_token, issued_at, expires_at
                )
                SELECT
                  ${params.applicationId}::uuid,
                  ${params.holderId}::uuid,
                  ${params.serviceId},
                  ${params.holderName},
                  ${number},
                  ${qrToken},
                  ts.issued_at,
                  ts.issued_at + make_interval(years => ${params.validityYears}::int)
                FROM ts
                RETURNING *
              `;

        return inserted;
      } catch (error) {
        const isUniqueCollision =
          error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
        if (!isUniqueCollision || attempt === maxAttempts) {
          throw error;
        }
      }
    }

    throw new AppException('INTERNAL_ERROR', 'Failed to generate unique credential.');
  }

  async listForCitizen(citizen: AuthenticatedUser): Promise<CredentialResponse[]> {
    const rows = await this.prisma.credentials.findMany({
      where: { holder_id: citizen.id },
      orderBy: { issued_at: 'desc' },
      take: 100,
      include: {
        applications: { select: { service_version: true } },
        services: { select: { published_version: true, draft: true } },
      },
    });

    const results: CredentialResponse[] = [];
    for (const row of rows) {
      const serviceName = await this.resolveServiceName(
        row.service_id,
        row.applications.service_version ?? row.services.published_version,
        row.services.draft,
      );
      results.push(mapCredentialResponse(row, serviceName));
    }

    return results;
  }

  async getByIdForCitizen(citizen: AuthenticatedUser, id: string): Promise<CredentialResponse> {
    if (!isUuid(id)) {
      throw new AppException('CREDENTIAL_NOT_FOUND', 'Credential not found.');
    }

    const row = await this.prisma.credentials.findFirst({
      where: { id, holder_id: citizen.id },
      include: {
        applications: { select: { service_version: true } },
        services: { select: { published_version: true, draft: true } },
      },
    });
    if (!row) {
      throw new AppException('CREDENTIAL_NOT_FOUND', 'Credential not found.');
    }

    const serviceName = await this.resolveServiceName(
      row.service_id,
      row.applications.service_version ?? row.services.published_version,
      row.services.draft,
    );
    return mapCredentialResponse(row, serviceName);
  }

  async verifyByQrToken(qrToken: string): Promise<VerifyCredentialResponse> {
    if (!qrToken || qrToken.length > 64) {
      throw new AppException('CREDENTIAL_NOT_FOUND', 'Credential not found.');
    }

    const row = await this.prisma.credentials.findUnique({
      where: { qr_token: qrToken },
      include: {
        applications: { select: { service_version: true } },
        services: { select: { published_version: true, draft: true } },
      },
    });
    if (!row) {
      throw new AppException('CREDENTIAL_NOT_FOUND', 'Credential not found.');
    }

    const serviceName = await this.resolveServiceName(
      row.service_id,
      row.applications.service_version ?? row.services.published_version,
      row.services.draft,
    );
    return mapVerifyCredentialResponse(row, serviceName);
  }

  async revoke(admin: AuthenticatedUser, id: string, reason: string): Promise<CredentialResponse> {
    if (!isUuid(id)) {
      throw new AppException('CREDENTIAL_NOT_FOUND', 'Credential not found.');
    }

    const { revokedRow, serviceName, notifications } = await withTx(this.prisma, async (tx) => {
      const exists = await lockCredential(tx, id);
      if (!exists) {
        throw new AppException('CREDENTIAL_NOT_FOUND', 'Credential not found.');
      }

      const [check] = await tx.$queryRaw<
        Array<{
          id: string;
          status: string;
          is_not_expired: boolean;
        }>
      >`
        SELECT id, status::text, (expires_at IS NULL OR expires_at > now()) AS is_not_expired
        FROM credentials
        WHERE id = ${id}::uuid
      `;

      if (!check || check.status !== 'ACTIVE' || !check.is_not_expired) {
        throw new AppException(
          'CREDENTIAL_NOT_ACTIVE',
          'Only active, non-expired credentials can be revoked.',
        );
      }

      await tx.$executeRaw`
        UPDATE credentials
        SET status = 'REVOKED',
            revoked_at = now(),
            revoked_by = ${admin.id}::uuid,
            revoked_reason = ${reason}
        WHERE id = ${id}::uuid
      `;

      const updated = await tx.credentials.findUniqueOrThrow({
        where: { id },
        include: {
          applications: { select: { id: true, application_number: true, service_version: true } },
          services: { select: { published_version: true, draft: true } },
          users_credentials_holder_idTousers: {
            select: { id: true, email: true, preferred_language: true },
          },
        },
      });

      await this.auditService.recordInTx(tx, {
        actorId: admin.id,
        action: 'CREDENTIAL_REVOKED',
        entityType: 'CREDENTIAL',
        entityId: updated.id,
        metadata: { reason },
      });

      const holder = updated.users_credentials_holder_idTousers;
      const notif = await this.notificationsWriter.createInTx(tx, {
        userId: holder.id,
        type: 'CREDENTIAL_REVOKED',
        entityType: 'APPLICATION',
        entityId: updated.application_id,
        templateParams: {
          applicationNumber: updated.applications.application_number,
          credentialNumber: updated.number,
        },
      });

      await this.emailService.enqueueInTx(tx, {
        toEmail: holder.email,
        toUserId: holder.id,
        template: 'CREDENTIAL_REVOKED',
        language: holder.preferred_language,
        payload: {
          applicationNumber: updated.applications.application_number,
          credentialNumber: updated.number,
        },
      });

      const resolvedName = await this.resolveServiceName(
        updated.service_id,
        updated.applications.service_version ?? updated.services.published_version,
        updated.services.draft,
        tx,
      );

      return {
        revokedRow: updated,
        serviceName: resolvedName,
        notifications: [notif],
      };
    });

    this.notificationsWriter.publishAfterCommit(notifications);
    return mapCredentialResponse(revokedRow, serviceName);
  }

  private async resolveServiceName(
    serviceId: string,
    version: number | null,
    fallbackDraft: Prisma.JsonValue,
    db: PrismaService | PrismaTx = this.prisma,
  ): Promise<LocalizedText> {
    if (version !== null) {
      const sv = await db.service_versions.findUnique({
        where: { service_id_version: { service_id: serviceId, version } },
        select: { definition: true },
      });
      if (sv) {
        return (sv.definition as unknown as ServiceDefinition).name;
      }
    }
    return (fallbackDraft as unknown as ServiceDefinition).name;
  }
}
