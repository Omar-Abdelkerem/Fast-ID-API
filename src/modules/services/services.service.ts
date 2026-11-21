import { Injectable } from '@nestjs/common';
import { Prisma, service_availability } from '@prisma/client';
import { AppException } from '../../common/errors/app-exception';
import { PrismaService } from '../../database/prisma.service';
import { lockService, PrismaTx, withTx } from '../../database/transaction';
import { AuditService } from '../audit/audit.service';
import {
  AdminServiceResponse,
  PublicServiceResponse,
  SERVICE_CATEGORIES,
  ServiceCategory,
  ServiceDefinition,
  ServiceSummaryResponse,
  ServiceVersionResponse,
} from './service-definition.types';
import {
  validateCreateServicePayload,
  validatePatchServicePayload,
} from './service-definition.validator';

interface AdminServiceRow {
  id: string;
  availability: service_availability;
  draft: ServiceDefinition;
  published_version: number | null;
  published_at: Date | null;
  created_at: Date;
  updated_at: Date;
  has_unpublished_changes: boolean;
}

interface PublishedServiceRow {
  id: string;
  published_version: number;
  published_at: Date;
  definition: ServiceDefinition;
}

const VALID_CATEGORY_SET = new Set<string>(SERVICE_CATEGORIES);

function mapAdminService(row: AdminServiceRow): AdminServiceResponse {
  return {
    id: row.id,
    availability: row.availability,
    draft: row.draft,
    publishedVersion: row.published_version ?? null,
    publishedAt: row.published_at ? row.published_at.toISOString() : null,
    hasUnpublishedChanges: row.has_unpublished_changes,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapServiceSummary(row: PublishedServiceRow): ServiceSummaryResponse {
  return {
    id: row.id,
    name: row.definition.name,
    description: row.definition.description,
    category: row.definition.category,
    fee: row.definition.fee,
    slaDays: row.definition.slaDays,
    validityYears: row.definition.validityYears,
    version: row.published_version,
  };
}

function mapPublicService(row: PublishedServiceRow): PublicServiceResponse {
  return {
    ...mapServiceSummary(row),
    requiredDocuments: row.definition.requiredDocuments,
    formSchema: row.definition.formSchema,
    publishedAt: row.published_at.toISOString(),
  };
}

@Injectable()
export class ServicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async listPublished(category?: string): Promise<ServiceSummaryResponse[]> {
    let filterCategory: ServiceCategory | undefined;
    if (category !== undefined && category !== '') {
      const trimmed = category.trim();
      if (!VALID_CATEGORY_SET.has(trimmed)) {
        throw new AppException(
          'VALIDATION_ERROR',
          `category must be one of ${SERVICE_CATEGORIES.join(', ')}.`,
          {
            field: 'category',
            details: [
              {
                field: 'category',
                code: 'INVALID_VALUE',
                message: `category must be one of ${SERVICE_CATEGORIES.join(', ')}.`,
              },
            ],
          },
        );
      }
      filterCategory = trimmed as ServiceCategory;
    }

    const rows = filterCategory
      ? await this.prisma.$queryRaw<PublishedServiceRow[]>`
          SELECT s.id, s.published_version, s.published_at, sv.definition
          FROM services s
          INNER JOIN service_versions sv
            ON sv.service_id = s.id AND sv.version = s.published_version
          WHERE s.availability = 'PUBLISHED'
            AND sv.definition->>'category' = ${filterCategory}
          ORDER BY sv.definition->'name'->>'en' ASC
        `
      : await this.prisma.$queryRaw<PublishedServiceRow[]>`
          SELECT s.id, s.published_version, s.published_at, sv.definition
          FROM services s
          INNER JOIN service_versions sv
            ON sv.service_id = s.id AND sv.version = s.published_version
          WHERE s.availability = 'PUBLISHED'
          ORDER BY sv.definition->'name'->>'en' ASC
        `;

    return rows.map(mapServiceSummary);
  }

  async getPublishedById(id: string): Promise<PublicServiceResponse> {
    const rows = await this.prisma.$queryRaw<PublishedServiceRow[]>`
      SELECT s.id, s.published_version, s.published_at, sv.definition
      FROM services s
      INNER JOIN service_versions sv
        ON sv.service_id = s.id AND sv.version = s.published_version
      WHERE s.id = ${id} AND s.availability = 'PUBLISHED'
    `;

    const row = rows[0];
    if (!row) {
      throw new AppException('SERVICE_NOT_FOUND', 'Service not found.');
    }

    return mapPublicService(row);
  }

  async listAdmin(): Promise<AdminServiceResponse[]> {
    const rows = await this.prisma.$queryRaw<AdminServiceRow[]>`
      SELECT s.id,
             s.availability,
             s.draft,
             s.published_version,
             s.published_at,
             s.created_at,
             s.updated_at,
             CASE
               WHEN s.published_version IS NULL THEN true
               ELSE (s.draft IS DISTINCT FROM sv.definition)
             END AS has_unpublished_changes
      FROM services s
      LEFT JOIN service_versions sv
        ON sv.service_id = s.id AND sv.version = s.published_version
      ORDER BY s.draft->'name'->>'en' ASC, s.id ASC
    `;

    return rows.map(mapAdminService);
  }

  async getAdminById(id: string): Promise<AdminServiceResponse> {
    const row = await this.findAdminRow(this.prisma, id);
    if (!row) {
      throw new AppException('SERVICE_NOT_FOUND', 'Service not found.');
    }
    return mapAdminService(row);
  }

  async getVersion(id: string, rawVersion: string): Promise<ServiceVersionResponse> {
    if (!/^[1-9]\d*$/.test(rawVersion)) {
      throw new AppException('VALIDATION_ERROR', 'version must be a positive integer.', {
        field: 'version',
        details: [
          {
            field: 'version',
            code: 'INVALID_VALUE',
            message: 'version must be a positive integer.',
          },
        ],
      });
    }

    const version = Number.parseInt(rawVersion, 10);
    const service = await this.prisma.services.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!service) {
      throw new AppException('SERVICE_NOT_FOUND', 'Service not found.');
    }

    const versionRow = await this.prisma.service_versions.findUnique({
      where: {
        service_id_version: {
          service_id: id,
          version,
        },
      },
    });
    if (!versionRow) {
      throw new AppException('SERVICE_VERSION_NOT_FOUND', 'Service version not found.');
    }

    return {
      version: versionRow.version,
      publishedAt: versionRow.published_at.toISOString(),
      definition: versionRow.definition as unknown as ServiceDefinition,
    };
  }

  async create(adminId: string, rawBody: unknown): Promise<AdminServiceResponse> {
    const { id, definition } = validateCreateServicePayload(rawBody);

    const row = await withTx(this.prisma, async (tx) => {
      await tx.services.create({
        data: {
          id,
          availability: 'DRAFT',
          draft: definition as unknown as Prisma.InputJsonValue,
        },
      });

      await this.auditService.recordInTx(tx, {
        actorId: adminId,
        action: 'SERVICE_CREATED',
        entityType: 'SERVICE',
        entityId: id,
        metadata: { category: definition.category },
      });

      return (await this.findAdminRow(tx, id))!;
    });

    return mapAdminService(row);
  }

  async updateDraft(adminId: string, id: string, rawBody: unknown): Promise<AdminServiceResponse> {
    const row = await withTx(this.prisma, async (tx) => {
      const exists = await lockService(tx, id);
      if (!exists) {
        throw new AppException('SERVICE_NOT_FOUND', 'Service not found.');
      }

      const current = await tx.services.findUniqueOrThrow({ where: { id } });
      const existingDraft = current.draft as unknown as ServiceDefinition;
      const { definition, updatedFields } = validatePatchServicePayload(rawBody, existingDraft);

      await tx.services.update({
        where: { id },
        data: {
          draft: definition as unknown as Prisma.InputJsonValue,
        },
      });

      await this.auditService.recordInTx(tx, {
        actorId: adminId,
        action: 'SERVICE_UPDATED',
        entityType: 'SERVICE',
        entityId: id,
        metadata: { updatedFields },
      });

      return (await this.findAdminRow(tx, id))!;
    });

    return mapAdminService(row);
  }

  async publish(adminId: string, id: string): Promise<AdminServiceResponse> {
    const row = await withTx(this.prisma, async (tx) => {
      const exists = await lockService(tx, id);
      if (!exists) {
        throw new AppException('SERVICE_NOT_FOUND', 'Service not found.');
      }

      const current = (await this.findAdminRow(tx, id))!;

      if (current.availability === 'PUBLISHED' && !current.has_unpublished_changes) {
        throw new AppException(
          'NO_CHANGES_TO_PUBLISH',
          'Draft is identical to the latest published version.',
        );
      }

      // D-18 / C-1: re-publishing an unchanged UNPUBLISHED service flips availability back without a new version.
      if (
        current.availability === 'UNPUBLISHED' &&
        !current.has_unpublished_changes &&
        current.published_version !== null
      ) {
        await tx.services.update({
          where: { id },
          data: { availability: 'PUBLISHED' },
        });

        await this.auditService.recordInTx(tx, {
          actorId: adminId,
          action: 'SERVICE_PUBLISHED',
          entityType: 'SERVICE',
          entityId: id,
          metadata: { version: current.published_version, republished: true },
        });

        return (await this.findAdminRow(tx, id))!;
      }

      const nextVersion = (current.published_version ?? 0) + 1;
      const createdVersion = await tx.service_versions.create({
        data: {
          service_id: id,
          version: nextVersion,
          definition: current.draft as unknown as Prisma.InputJsonValue,
        },
      });

      await tx.services.update({
        where: { id },
        data: {
          availability: 'PUBLISHED',
          published_version: nextVersion,
          published_at: createdVersion.published_at,
        },
      });

      await this.auditService.recordInTx(tx, {
        actorId: adminId,
        action: 'SERVICE_PUBLISHED',
        entityType: 'SERVICE',
        entityId: id,
        metadata: { version: nextVersion },
      });

      return (await this.findAdminRow(tx, id))!;
    });

    return mapAdminService(row);
  }

  async unpublish(adminId: string, id: string): Promise<AdminServiceResponse> {
    const row = await withTx(this.prisma, async (tx) => {
      const exists = await lockService(tx, id);
      if (!exists) {
        throw new AppException('SERVICE_NOT_FOUND', 'Service not found.');
      }

      const current = await tx.services.findUniqueOrThrow({ where: { id } });
      if (current.availability !== 'PUBLISHED') {
        throw new AppException('SERVICE_NOT_PUBLISHED', 'Service is not currently published.');
      }

      await tx.services.update({
        where: { id },
        data: { availability: 'UNPUBLISHED' },
      });

      await this.auditService.recordInTx(tx, {
        actorId: adminId,
        action: 'SERVICE_UNPUBLISHED',
        entityType: 'SERVICE',
        entityId: id,
        metadata: { version: current.published_version },
      });

      return (await this.findAdminRow(tx, id))!;
    });

    return mapAdminService(row);
  }

  async delete(adminId: string, id: string): Promise<{ id: string; deleted: true }> {
    await withTx(this.prisma, async (tx) => {
      const exists = await lockService(tx, id);
      if (!exists) {
        throw new AppException('SERVICE_NOT_FOUND', 'Service not found.');
      }

      const current = await tx.services.findUniqueOrThrow({ where: { id } });
      if (current.published_version !== null || current.availability !== 'DRAFT') {
        throw new AppException(
          'SERVICE_CANNOT_BE_DELETED',
          'Published or previously published services cannot be deleted.',
        );
      }

      const applicationCount = await tx.applications.count({
        where: { service_id: id },
      });
      if (applicationCount > 0) {
        throw new AppException(
          'SERVICE_CANNOT_BE_DELETED',
          'Services with existing applications cannot be deleted.',
        );
      }

      await tx.services.delete({ where: { id } });

      await this.auditService.recordInTx(tx, {
        actorId: adminId,
        action: 'SERVICE_DELETED',
        entityType: 'SERVICE',
        entityId: id,
        metadata: {},
      });
    });

    return { id, deleted: true };
  }

  private async findAdminRow(
    db: PrismaService | PrismaTx,
    id: string,
  ): Promise<AdminServiceRow | null> {
    const rows = await db.$queryRaw<AdminServiceRow[]>`
      SELECT s.id,
             s.availability,
             s.draft,
             s.published_version,
             s.published_at,
             s.created_at,
             s.updated_at,
             CASE
               WHEN s.published_version IS NULL THEN true
               ELSE (s.draft IS DISTINCT FROM sv.definition)
             END AS has_unpublished_changes
      FROM services s
      LEFT JOIN service_versions sv
        ON sv.service_id = s.id AND sv.version = s.published_version
      WHERE s.id = ${id}
    `;
    return rows[0] ?? null;
  }
}
