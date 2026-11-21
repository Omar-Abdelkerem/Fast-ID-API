import { randomBytes } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { application_status, payment_status, Prisma } from '@prisma/client';
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { createPaginatedResult, PaginatedResult } from '../../common/dto/pagination.dto';
import { AppException, ErrorDetail } from '../../common/errors/app-exception';
import { isUuid } from '../../common/utils/uuid';
import { PrismaService } from '../../database/prisma.service';
import { lockApplication, PrismaTx, withTx } from '../../database/transaction';
import { AuditService } from '../audit/audit.service';
import { EmailService } from '../email/email.service';
import { NotificationsWriterService } from '../notifications/notifications-writer.service';
import {
  DeliveryAddressValue,
  mergeApplicationDataPatch,
  mergeDeliveryAddressPatch,
  validateApplicationPayload,
} from '../services/application-data.validator';
import { ServiceDefinition } from '../services/service-definition.types';
import { STORAGE_DRIVER, StorageDriver } from '../storage/storage-driver.interface';
import { CitizenApplicationResponse, mapCitizenApplication } from './application-response.mapper';
import { ApplicationWorkflowService } from './application-workflow.service';
import { CancelApplicationDto } from './dto/cancel-application.dto';
import { CreateApplicationDto } from './dto/create-application.dto';
import {
  ALL_APPLICATION_STATUSES,
  ListApplicationsQueryDto,
} from './dto/list-applications-query.dto';

const ALLOWED_PATCH_KEYS = new Set(['data', 'deliveryAddress']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseStatusList(raw?: string): application_status[] | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }

  const values = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  if (values.length === 0) {
    return undefined;
  }

  for (const val of values) {
    if (!ALL_APPLICATION_STATUSES.has(val)) {
      throw new AppException('VALIDATION_ERROR', `Invalid status filter value "${val}".`, {
        field: 'status',
        details: [
          {
            field: 'status',
            code: 'INVALID_VALUE',
            message: `Invalid status filter value "${val}".`,
          },
        ],
      });
    }
  }

  return values as application_status[];
}

function derivePaymentForFee(feeAmount: number): { status: payment_status; amount: number } {
  return {
    amount: feeAmount,
    status: feeAmount === 0 ? 'NOT_REQUIRED' : 'UNPAID',
  };
}

@Injectable()
export class ApplicationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly workflowService: ApplicationWorkflowService,
    private readonly auditService: AuditService,
    private readonly emailService: EmailService,
    private readonly notificationsWriter: NotificationsWriterService,
    @Inject(STORAGE_DRIVER) private readonly storageDriver: StorageDriver,
  ) {}

  async createDraft(
    citizen: AuthenticatedUser,
    dto: CreateApplicationDto,
  ): Promise<CitizenApplicationResponse> {
    const service = await this.prisma.services.findUnique({
      where: { id: dto.serviceId },
    });

    if (!service) {
      throw new AppException('SERVICE_NOT_FOUND', 'Service not found.');
    }

    if (service.availability !== 'PUBLISHED' || service.published_version === null) {
      throw new AppException('SERVICE_NOT_AVAILABLE', 'Service is not currently published.');
    }

    const publishedVersion = await this.prisma.service_versions.findUniqueOrThrow({
      where: {
        service_id_version: {
          service_id: service.id,
          version: service.published_version,
        },
      },
    });
    const definition = publishedVersion.definition as unknown as ServiceDefinition;
    const initialPayment = derivePaymentForFee(definition.fee.amount);

    // Draft writes NO row to application_status_history (Contract §4.1, Design §6.1).
    const created = await this.prisma.applications.create({
      data: {
        citizen_id: citizen.id,
        service_id: service.id,
        service_version: null,
        data: {},
        delivery_address: Prisma.DbNull,
        payment_status: initialPayment.status,
        payment_amount: initialPayment.amount,
      },
    });

    return mapCitizenApplication({
      application: created,
      serviceName: definition.name,
      resolvedServiceVersion: service.published_version,
      attachments: [],
      statusHistory: [],
      credential: null,
      delivery: null,
    });
  }

  async listForCitizen(
    citizen: AuthenticatedUser,
    query: ListApplicationsQueryDto,
  ): Promise<PaginatedResult<CitizenApplicationResponse>> {
    const statuses = parseStatusList(query.status);
    const where: Prisma.applicationsWhereInput = {
      citizen_id: citizen.id,
      ...(statuses ? { status: { in: statuses } } : {}),
      ...(query.serviceId ? { service_id: query.serviceId } : {}),
    };

    const orderBy: Prisma.applicationsOrderByWithRelationInput =
      query.sort === 'createdAt'
        ? { created_at: 'asc' }
        : query.sort === 'updatedAt'
          ? { updated_at: 'asc' }
          : query.sort === '-updatedAt'
            ? { updated_at: 'desc' }
            : { created_at: 'desc' };

    const skip = (query.page - 1) * query.pageSize;

    const [total, rows] = await Promise.all([
      this.prisma.applications.count({ where }),
      this.prisma.applications.findMany({
        where,
        orderBy,
        skip,
        take: query.pageSize,
        include: {
          services: true,
          credentials: true,
          deliveries: {
            include: {
              users: { select: { full_name: true, phone: true } },
            },
          },
        },
      }),
    ]);

    const items: CitizenApplicationResponse[] = [];
    for (const row of rows) {
      const resolvedVersion = row.service_version ?? row.services.published_version ?? 1;
      const versionRow = await this.prisma.service_versions.findUniqueOrThrow({
        where: {
          service_id_version: {
            service_id: row.service_id,
            version: resolvedVersion,
          },
        },
      });
      const definition = versionRow.definition as unknown as ServiceDefinition;

      // C-10: re-sync unpaid/free drafts to service's current published fee on read
      let paymentOverride: { status: payment_status; amount: number } | undefined;
      if (row.status === 'DRAFT' && row.payment_status !== 'PAID') {
        const synced = derivePaymentForFee(definition.fee.amount);
        if (synced.amount !== row.payment_amount || synced.status !== row.payment_status) {
          await this.prisma.applications.update({
            where: { id: row.id },
            data: { payment_amount: synced.amount, payment_status: synced.status },
          });
          paymentOverride = synced;
        }
      }

      items.push(
        mapCitizenApplication({
          application: row,
          serviceName: definition.name,
          resolvedServiceVersion: resolvedVersion,
          credential: row.credentials,
          delivery: row.deliveries,
          paymentOverride,
          listMode: true,
        }),
      );
    }

    return createPaginatedResult(items, total, query.page, query.pageSize);
  }

  async getByIdForCitizen(
    citizen: AuthenticatedUser,
    id: string,
  ): Promise<CitizenApplicationResponse> {
    if (!isUuid(id)) {
      throw new AppException('APPLICATION_NOT_FOUND', 'Application not found.');
    }

    const row = await this.prisma.applications.findFirst({
      where: { id, citizen_id: citizen.id },
      include: {
        services: true,
        attachments: { orderBy: { uploaded_at: 'asc' } },
        application_status_history: { orderBy: [{ created_at: 'asc' }, { id: 'asc' }] },
        credentials: true,
        deliveries: {
          include: {
            users: { select: { full_name: true, phone: true } },
          },
        },
      },
    });

    if (!row) {
      throw new AppException('APPLICATION_NOT_FOUND', 'Application not found.');
    }

    const resolvedVersion = row.service_version ?? row.services.published_version ?? 1;
    const versionRow = await this.prisma.service_versions.findUniqueOrThrow({
      where: {
        service_id_version: {
          service_id: row.service_id,
          version: resolvedVersion,
        },
      },
    });
    const definition = versionRow.definition as unknown as ServiceDefinition;

    // C-10: re-sync unpaid/free drafts to service's current published fee on read
    let paymentOverride: { status: payment_status; amount: number } | undefined;
    if (row.status === 'DRAFT' && row.payment_status !== 'PAID') {
      const synced = derivePaymentForFee(definition.fee.amount);
      if (synced.amount !== row.payment_amount || synced.status !== row.payment_status) {
        await this.prisma.applications.update({
          where: { id: row.id },
          data: { payment_amount: synced.amount, payment_status: synced.status },
        });
        paymentOverride = synced;
      }
    }

    return mapCitizenApplication({
      application: row,
      serviceName: definition.name,
      resolvedServiceVersion: resolvedVersion,
      attachments: row.attachments,
      statusHistory: row.application_status_history,
      credential: row.credentials,
      delivery: row.deliveries,
      paymentOverride,
    });
  }

  async updateDraft(
    citizen: AuthenticatedUser,
    id: string,
    rawBody: unknown,
  ): Promise<CitizenApplicationResponse> {
    if (!isUuid(id)) {
      throw new AppException('APPLICATION_NOT_FOUND', 'Application not found.');
    }

    if (!isPlainObject(rawBody)) {
      throw new AppException('VALIDATION_ERROR', 'Request body must be a JSON object.');
    }

    for (const key of Object.keys(rawBody)) {
      if (!ALLOWED_PATCH_KEYS.has(key)) {
        throw new AppException('UNKNOWN_FIELD', `Unknown field "${key}".`, { field: key });
      }
    }

    if (!('data' in rawBody) && !('deliveryAddress' in rawBody)) {
      throw new AppException(
        'VALIDATION_ERROR',
        'At least one of data or deliveryAddress must be provided.',
      );
    }

    await withTx(this.prisma, async (tx) => {
      const exists = await lockApplication(tx, id);
      if (!exists) {
        throw new AppException('APPLICATION_NOT_FOUND', 'Application not found.');
      }

      const app = await tx.applications.findFirst({
        where: { id, citizen_id: citizen.id },
        include: { services: true },
      });
      if (!app) {
        throw new AppException('APPLICATION_NOT_FOUND', 'Application not found.');
      }

      if (app.status !== 'DRAFT') {
        throw new AppException(
          'APPLICATION_NOT_EDITABLE',
          'Only DRAFT applications can be edited.',
        );
      }

      if (app.services.availability !== 'PUBLISHED' || app.services.published_version === null) {
        throw new AppException('SERVICE_NOT_AVAILABLE', 'Service is no longer published.');
      }

      const versionRow = await tx.service_versions.findUniqueOrThrow({
        where: {
          service_id_version: {
            service_id: app.service_id,
            version: app.services.published_version,
          },
        },
      });
      const definition = versionRow.definition as unknown as ServiceDefinition;

      const existingData = (app.data as Record<string, unknown>) ?? {};
      const existingAddress = (app.delivery_address as DeliveryAddressValue | null) ?? null;

      const mergedData =
        'data' in rawBody
          ? mergeApplicationDataPatch(definition, existingData, rawBody.data)
          : existingData;
      const mergedAddress =
        'deliveryAddress' in rawBody
          ? mergeDeliveryAddressPatch(existingAddress, rawBody.deliveryAddress)
          : existingAddress;

      const validated = validateApplicationPayload({
        definition,
        data: mergedData,
        deliveryAddress: mergedAddress,
        mode: 'partial',
      });

      const syncedPayment =
        app.payment_status !== 'PAID' ? derivePaymentForFee(definition.fee.amount) : undefined;

      await tx.applications.update({
        where: { id: app.id },
        data: {
          data: validated.data as Prisma.InputJsonValue,
          delivery_address:
            validated.deliveryAddress === null
              ? Prisma.DbNull
              : (validated.deliveryAddress as unknown as Prisma.InputJsonValue),
          ...(syncedPayment
            ? { payment_amount: syncedPayment.amount, payment_status: syncedPayment.status }
            : {}),
        },
      });
    });

    return this.getByIdForCitizen(citizen, id);
  }

  async deleteDraft(
    citizen: AuthenticatedUser,
    id: string,
  ): Promise<{ id: string; deleted: true }> {
    if (!isUuid(id)) {
      throw new AppException('APPLICATION_NOT_FOUND', 'Application not found.');
    }

    const storageKeysToDelete = await withTx(this.prisma, async (tx) => {
      const exists = await lockApplication(tx, id);
      if (!exists) {
        throw new AppException('APPLICATION_NOT_FOUND', 'Application not found.');
      }

      const app = await tx.applications.findFirst({
        where: { id, citizen_id: citizen.id },
      });
      if (!app) {
        throw new AppException('APPLICATION_NOT_FOUND', 'Application not found.');
      }

      if (app.status !== 'DRAFT') {
        throw new AppException(
          'APPLICATION_NOT_EDITABLE',
          'Only DRAFT applications can be deleted.',
        );
      }

      // Read storage keys BEFORE cascading delete (Design §6.2, §8).
      const attachmentRows = await tx.attachments.findMany({
        where: { application_id: app.id },
        select: { storage_key: true },
      });

      await tx.applications.delete({ where: { id: app.id } });
      return attachmentRows.map((row) => row.storage_key);
    });

    // Delete stored files after commit only.
    for (const key of storageKeysToDelete) {
      await this.storageDriver.delete(key);
    }

    return { id, deleted: true };
  }

  async mockPay(citizen: AuthenticatedUser, id: string): Promise<CitizenApplicationResponse> {
    if (!isUuid(id)) {
      throw new AppException('APPLICATION_NOT_FOUND', 'Application not found.');
    }

    const paymentMode = this.configService.get<string>('PAYMENT_MODE');
    if (paymentMode !== 'mock') {
      throw new AppException('PAYMENT_NOT_ENABLED', 'Mock payment mode is disabled.');
    }

    await withTx(this.prisma, async (tx) => {
      const exists = await lockApplication(tx, id);
      if (!exists) {
        throw new AppException('APPLICATION_NOT_FOUND', 'Application not found.');
      }

      const app = await tx.applications.findFirst({
        where: { id, citizen_id: citizen.id },
        include: { services: true },
      });
      if (!app) {
        throw new AppException('APPLICATION_NOT_FOUND', 'Application not found.');
      }

      if (app.status !== 'DRAFT') {
        throw new AppException(
          'APPLICATION_NOT_EDITABLE',
          'Payment can only be completed for DRAFT applications.',
        );
      }

      if (app.payment_status === 'PAID') {
        throw new AppException(
          'PAYMENT_ALREADY_COMPLETED',
          'Payment has already been completed for this application.',
        );
      }

      const versionNumber = app.services.published_version ?? 1;
      const versionRow = await tx.service_versions.findUniqueOrThrow({
        where: {
          service_id_version: {
            service_id: app.service_id,
            version: versionNumber,
          },
        },
      });
      const definition = versionRow.definition as unknown as ServiceDefinition;

      // C-10: re-sync fee from latest published definition before payment
      if (definition.fee.amount === 0) {
        throw new AppException('PAYMENT_NOT_REQUIRED', 'This service has no fee.');
      }

      const reference = `MOCK-${randomBytes(8).toString('hex').toUpperCase()}`;

      await tx.$executeRaw`
        UPDATE applications
        SET payment_status = 'PAID',
            payment_amount = ${definition.fee.amount},
            paid_at = now(),
            payment_reference = ${reference}
        WHERE id = ${app.id}::uuid
      `;

      await this.auditService.recordInTx(tx, {
        actorId: citizen.id,
        action: 'PAYMENT_MARKED_PAID_MOCK',
        entityType: 'APPLICATION',
        entityId: app.id,
        metadata: { amount: definition.fee.amount },
      });
    });

    return this.getByIdForCitizen(citizen, id);
  }

  async submit(citizen: AuthenticatedUser, id: string): Promise<CitizenApplicationResponse> {
    if (!isUuid(id)) {
      throw new AppException('APPLICATION_NOT_FOUND', 'Application not found.');
    }

    const createdNotifications = await withTx(this.prisma, async (tx) => {
      // 1. Existence & ownership
      const exists = await lockApplication(tx, id);
      if (!exists) {
        throw new AppException('APPLICATION_NOT_FOUND', 'Application not found.');
      }

      const app = await tx.applications.findFirst({
        where: { id, citizen_id: citizen.id },
        include: {
          services: true,
          attachments: true,
        },
      });
      if (!app) {
        throw new AppException('APPLICATION_NOT_FOUND', 'Application not found.');
      }

      // 2. Status is DRAFT
      if (app.status !== 'DRAFT') {
        throw new AppException(
          'APPLICATION_NOT_EDITABLE',
          'Only DRAFT applications can be submitted.',
        );
      }

      // 3. Service is currently published
      if (app.services.availability !== 'PUBLISHED' || app.services.published_version === null) {
        throw new AppException('SERVICE_NOT_AVAILABLE', 'Service is no longer published.');
      }

      const versionRow = await tx.service_versions.findUniqueOrThrow({
        where: {
          service_id_version: {
            service_id: app.service_id,
            version: app.services.published_version,
          },
        },
      });
      const definition = versionRow.definition as unknown as ServiceDefinition;

      // 4. Full form & deliveryAddress completeness + constraint validation
      const validated = validateApplicationPayload({
        definition,
        data: (app.data as Record<string, unknown>) ?? {},
        deliveryAddress: (app.delivery_address as DeliveryAddressValue | null) ?? null,
        mode: 'full',
      });

      // 5. Required documents check
      const uploadedKeys = new Set(app.attachments.map((att) => att.requirement_key));
      const missingDocDetails: ErrorDetail[] = [];
      for (const reqDoc of definition.requiredDocuments) {
        if (reqDoc.required && !uploadedKeys.has(reqDoc.key)) {
          missingDocDetails.push({
            field: `attachments.${reqDoc.key}`,
            code: 'REQUIRED',
            message: `Required document "${reqDoc.key}" has not been uploaded.`,
          });
        }
      }
      if (missingDocDetails.length > 0) {
        throw new AppException('MISSING_REQUIRED_DOCUMENTS', missingDocDetails[0].message, {
          field: missingDocDetails[0].field,
          details: missingDocDetails,
        });
      }

      // 6. Payment check after C-10 fee re-sync
      let paymentUpdate: { payment_amount: number; payment_status: payment_status } | undefined;
      if (app.payment_status !== 'PAID') {
        const synced = derivePaymentForFee(definition.fee.amount);
        if (synced.status === 'UNPAID') {
          throw new AppException(
            'PAYMENT_NOT_COMPLETED',
            'Payment must be completed before submitting this application.',
          );
        }
        paymentUpdate = {
          payment_amount: synced.amount,
          payment_status: synced.status,
        };
      }

      // Compute server timestamps using PostgreSQL now() + slaDays * 24h (C-5)
      const [timestamps] = await tx.$queryRaw<Array<{ submitted_at: Date; due_at: Date }>>`
        SELECT now() AS submitted_at,
               now() + make_interval(days => ${definition.slaDays}::int) AS due_at
      `;

      await this.workflowService.transition(tx, app, 'SUBMITTED', {
        byUserId: citizen.id,
        extraUpdate: {
          service_version: app.services.published_version,
          data: validated.data as Prisma.InputJsonValue,
          delivery_address: validated.deliveryAddress as unknown as Prisma.InputJsonValue,
          submitted_at: timestamps.submitted_at,
          due_at: timestamps.due_at,
          ...(paymentUpdate ?? {}),
        },
      });

      await this.auditService.recordInTx(tx, {
        actorId: citizen.id,
        action: 'APPLICATION_SUBMITTED',
        entityType: 'APPLICATION',
        entityId: app.id,
        metadata: {
          serviceId: app.service_id,
          serviceVersion: app.services.published_version,
        },
      });

      const notification = await this.notificationsWriter.createInTx(tx, {
        userId: citizen.id,
        type: 'APPLICATION_SUBMITTED',
        entityType: 'APPLICATION',
        entityId: app.id,
        templateParams: { applicationNumber: app.application_number },
      });

      await this.emailService.enqueueInTx(tx, {
        toEmail: citizen.email,
        toUserId: citizen.id,
        template: 'APPLICATION_SUBMITTED',
        language: citizen.preferred_language,
        payload: { applicationNumber: app.application_number },
      });

      return [notification];
    });

    this.notificationsWriter.publishAfterCommit(createdNotifications);
    return this.getByIdForCitizen(citizen, id);
  }

  async cancel(
    citizen: AuthenticatedUser,
    id: string,
    dto: CancelApplicationDto,
  ): Promise<CitizenApplicationResponse> {
    if (!isUuid(id)) {
      throw new AppException('APPLICATION_NOT_FOUND', 'Application not found.');
    }

    const reason = dto.reason && dto.reason.length > 0 ? dto.reason : null;

    const createdNotifications = await withTx(this.prisma, async (tx) => {
      const exists = await lockApplication(tx, id);
      if (!exists) {
        throw new AppException('APPLICATION_NOT_FOUND', 'Application not found.');
      }

      const app = await tx.applications.findFirst({
        where: { id, citizen_id: citizen.id },
      });
      if (!app) {
        throw new AppException('APPLICATION_NOT_FOUND', 'Application not found.');
      }

      // Only SUBMITTED -> CANCELLED is valid (else 409 INVALID_STATUS_TRANSITION)
      await this.workflowService.transition(tx, app, 'CANCELLED', {
        byUserId: citizen.id,
        citizenNote: reason,
      });

      await this.auditService.recordInTx(tx, {
        actorId: citizen.id,
        action: 'APPLICATION_CANCELLED',
        entityType: 'APPLICATION',
        entityId: app.id,
        metadata: { fromStatus: app.status, toStatus: 'CANCELLED' },
      });

      const notification = await this.notificationsWriter.createInTx(tx, {
        userId: citizen.id,
        type: 'APPLICATION_CANCELLED',
        entityType: 'APPLICATION',
        entityId: app.id,
        templateParams: { applicationNumber: app.application_number },
      });

      return [notification];
    });

    this.notificationsWriter.publishAfterCommit(createdNotifications);
    return this.getByIdForCitizen(citizen, id);
  }

  async loadPublishedServiceDefinition(
    tx: PrismaTx | PrismaService,
    serviceId: string,
    version: number,
  ): Promise<ServiceDefinition> {
    const row = await tx.service_versions.findUniqueOrThrow({
      where: {
        service_id_version: {
          service_id: serviceId,
          version,
        },
      },
    });
    return row.definition as unknown as ServiceDefinition;
  }
}
