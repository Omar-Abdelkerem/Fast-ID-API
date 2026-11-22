import { Injectable } from '@nestjs/common';
import { application_status, governorate, notifications, Prisma } from '@prisma/client';
import { Response } from 'express';
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { createPaginatedResult, PaginatedResult } from '../../common/dto/pagination.dto';
import { AppException } from '../../common/errors/app-exception';
import {
  ADMIN_EXPORT_CSV_HEADERS,
  formatApplicationStatusLabel,
  formatCairoCompactDate,
  formatCairoDateTime,
  formatCsvRow,
  formatDeliveryStatusLabel,
  formatMoneyEgp,
  formatPaymentStatusLabel,
  UTF8_BOM,
} from '../../common/utils/csv';
import { maskNationalId } from '../../common/utils/mask';
import { isUuid } from '../../common/utils/uuid';
import { PrismaService } from '../../database/prisma.service';
import { lockApplication, PrismaTx, withTx } from '../../database/transaction';
import { AuditService } from '../audit/audit.service';
import { CredentialsService } from '../credentials/credentials.service';
import { DeliveriesService } from '../deliveries/deliveries.service';
import { EmailService } from '../email/email.service';
import { NotificationsWriterService } from '../notifications/notifications-writer.service';
import { GOVERNORATE_BY_CODE } from '../reference/governorates.data';
import { DeliveryAddressValue } from '../services/application-data.validator';
import { LocalizedText, ServiceDefinition } from '../services/service-definition.types';
import {
  AdminApplicationListItemResponse,
  AdminApplicationResponse,
  mapAdminApplicationDetail,
  mapAdminApplicationListItem,
} from './admin-application-response.mapper';
import { ApplicationWorkflowService } from './application-workflow.service';
import { ApproveApplicationDto } from './dto/approve-application.dto';
import { ExportAdminApplicationsQueryDto } from './dto/export-admin-applications-query.dto';
import {
  ADMIN_APPLICATION_STATUSES,
  ListAdminApplicationsQueryDto,
} from './dto/list-admin-applications-query.dto';
import { RejectApplicationDto } from './dto/reject-application.dto';

const MAX_EXPORT_ROWS = 10_000;
const EXPORT_BATCH_SIZE = 500;

function parseAdminStatuses(raw?: string): application_status[] | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }

  const values = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (values.length === 0) {
    return undefined;
  }

  for (const val of values) {
    if (!ADMIN_APPLICATION_STATUSES.has(val)) {
      throw new AppException(
        'VALIDATION_ERROR',
        `Invalid admin status filter value "${val}". DRAFT is not allowed.`,
        {
          field: 'status',
          details: [
            {
              field: 'status',
              code: 'INVALID_VALUE',
              message: `Invalid admin status filter value "${val}".`,
            },
          ],
        },
      );
    }
  }

  return values as application_status[];
}

export function buildAdminApplicationsWhere(
  query: Omit<ListAdminApplicationsQueryDto, 'page' | 'pageSize'>,
): Prisma.applicationsWhereInput {
  const statuses = parseAdminStatuses(query.status);

  if (query.governorate && !GOVERNORATE_BY_CODE.has(query.governorate)) {
    throw new AppException('VALIDATION_ERROR', 'Invalid governorate code.', {
      field: 'governorate',
      details: [
        { field: 'governorate', code: 'INVALID_VALUE', message: 'Invalid governorate code.' },
      ],
    });
  }

  const submittedFromDate = query.submittedFrom ? new Date(query.submittedFrom) : undefined;
  const submittedToDate = query.submittedTo ? new Date(query.submittedTo) : undefined;
  if (
    submittedFromDate &&
    submittedToDate &&
    submittedFromDate.getTime() > submittedToDate.getTime()
  ) {
    throw new AppException(
      'VALIDATION_ERROR',
      'submittedFrom must be less than or equal to submittedTo.',
      {
        field: 'submittedFrom',
        details: [
          {
            field: 'submittedFrom',
            code: 'OUT_OF_RANGE',
            message: 'submittedFrom must be less than or equal to submittedTo.',
          },
        ],
      },
    );
  }

  const andClauses: Prisma.applicationsWhereInput[] = [{ status: { not: 'DRAFT' } }];

  if (statuses) {
    andClauses.push({ status: { in: statuses } });
  }

  if (query.serviceId) {
    andClauses.push({ service_id: query.serviceId });
  }

  if (query.governorate) {
    andClauses.push({
      delivery_address: {
        path: ['governorate'],
        equals: query.governorate,
      },
    });
  }

  if (query.overdue === 'true') {
    andClauses.push({
      status: { in: ['SUBMITTED', 'UNDER_REVIEW'] },
      due_at: { lt: new Date() },
    });
  } else if (query.overdue === 'false') {
    andClauses.push({
      NOT: {
        AND: [{ status: { in: ['SUBMITTED', 'UNDER_REVIEW'] } }, { due_at: { lt: new Date() } }],
      },
    });
  }

  if (submittedFromDate || submittedToDate) {
    andClauses.push({
      submitted_at: {
        ...(submittedFromDate ? { gte: submittedFromDate } : {}),
        ...(submittedToDate ? { lte: submittedToDate } : {}),
      },
    });
  }

  if (query.q) {
    const q = query.q.trim();
    const orSearch: Prisma.applicationsWhereInput[] = [
      // application_number is always uppercase (APP-YYYY-NNNNNN); uppercase prefix enables applications_number_prefix_idx (text_pattern_ops).
      { application_number: { startsWith: q.toUpperCase() } },
      { users_applications_citizen_idTousers: { full_name: { contains: q, mode: 'insensitive' } } },
    ];
    if (/^[0-9]{14}$/.test(q)) {
      orSearch.push({ users_applications_citizen_idTousers: { national_id: q } });
    }
    andClauses.push({ OR: orSearch });
  }

  return { AND: andClauses };
}

export function buildAdminApplicationsOrderBy(
  sort: ListAdminApplicationsQueryDto['sort'],
): Prisma.applicationsOrderByWithRelationInput {
  switch (sort) {
    case 'submittedAt':
      return { submitted_at: 'asc' };
    case 'dueAt':
      return { due_at: 'asc' };
    case '-dueAt':
      return { due_at: 'desc' };
    case '-submittedAt':
    default:
      return { submitted_at: 'desc' };
  }
}

@Injectable()
export class AdminApplicationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workflowService: ApplicationWorkflowService,
    private readonly credentialsService: CredentialsService,
    private readonly deliveriesService: DeliveriesService,
    private readonly auditService: AuditService,
    private readonly emailService: EmailService,
    private readonly notificationsWriter: NotificationsWriterService,
  ) {}

  async list(
    query: ListAdminApplicationsQueryDto,
  ): Promise<PaginatedResult<AdminApplicationListItemResponse>> {
    const where = buildAdminApplicationsWhere(query);
    const orderBy = buildAdminApplicationsOrderBy(query.sort);
    const skip = (query.page - 1) * query.pageSize;

    const [total, rows] = await Promise.all([
      this.prisma.applications.count({ where }),
      this.prisma.applications.findMany({
        where,
        orderBy,
        skip,
        take: query.pageSize,
        include: {
          services: { select: { published_version: true, draft: true } },
          users_applications_citizen_idTousers: {
            select: { id: true, full_name: true, national_id: true },
          },
          deliveries: { select: { status: true } },
        },
      }),
    ]);

    const items: AdminApplicationListItemResponse[] = [];
    for (const row of rows) {
      const serviceName = await this.resolveServiceName(
        row.service_id,
        row.service_version ?? row.services.published_version,
        row.services.draft,
      );
      items.push(
        mapAdminApplicationListItem({
          application: row,
          serviceName,
          citizen: row.users_applications_citizen_idTousers,
          deliveryStatus: row.deliveries?.status ?? null,
        }),
      );
    }

    return createPaginatedResult(items, total, query.page, query.pageSize);
  }

  /**
   * Streams filtered non-draft applications as a UTF-8 BOM CSV (Contract §7.2, Design §10).
   */
  async exportCsv(query: ExportAdminApplicationsQueryDto, res: Response): Promise<void> {
    const where = buildAdminApplicationsWhere(query);
    const orderBy = buildAdminApplicationsOrderBy(query.sort);

    const total = await this.prisma.applications.count({ where });
    if (total > MAX_EXPORT_ROWS) {
      throw new AppException(
        'EXPORT_TOO_LARGE',
        `Export matches ${total} rows, exceeding the maximum of ${MAX_EXPORT_ROWS}. Narrow your filters and retry.`,
      );
    }

    const filename = `applications-${formatCairoCompactDate()}.csv`;
    res.status(200);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.vary('Origin');

    res.write(UTF8_BOM);
    res.write(formatCsvRow(ADMIN_EXPORT_CSV_HEADERS));

    const serviceNameCache = new Map<string, string>();
    const nowMs = Date.now();

    for (let offset = 0; offset < total; offset += EXPORT_BATCH_SIZE) {
      const rows = await this.prisma.applications.findMany({
        where,
        orderBy: [orderBy, { id: 'asc' }],
        skip: offset,
        take: EXPORT_BATCH_SIZE,
        include: {
          services: { select: { published_version: true, draft: true } },
          users_applications_citizen_idTousers: {
            select: { full_name: true, national_id: true },
          },
          deliveries: { select: { status: true } },
        },
      });

      if (rows.length === 0) {
        break;
      }

      for (const row of rows) {
        const version = row.service_version ?? row.services.published_version;
        const cacheKey = `${row.service_id}:${version ?? 'draft'}`;
        let englishServiceName = serviceNameCache.get(cacheKey);
        if (englishServiceName === undefined) {
          const localized = await this.resolveServiceName(
            row.service_id,
            version,
            row.services.draft,
          );
          englishServiceName = localized.en;
          serviceNameCache.set(cacheKey, englishServiceName);
        }

        const address = row.delivery_address as unknown as DeliveryAddressValue | null;
        const govCode = address?.governorate;
        const govEnglish = govCode ? (GOVERNORATE_BY_CODE.get(govCode)?.name.en ?? govCode) : '';

        const isOverdue =
          (row.status === 'SUBMITTED' || row.status === 'UNDER_REVIEW') &&
          row.due_at !== null &&
          row.due_at.getTime() < nowMs;

        const nationalId = row.users_applications_citizen_idTousers.national_id;
        const maskedId = nationalId ? maskNationalId(nationalId) : '';

        res.write(
          formatCsvRow([
            row.application_number,
            englishServiceName,
            row.users_applications_citizen_idTousers.full_name,
            maskedId,
            govEnglish,
            formatApplicationStatusLabel(row.status),
            formatCairoDateTime(row.submitted_at),
            formatCairoDateTime(row.due_at),
            isOverdue ? 'Yes' : 'No',
            formatMoneyEgp(row.payment_amount),
            formatPaymentStatusLabel(row.payment_status),
            formatDeliveryStatusLabel(row.deliveries?.status ?? null),
          ]),
        );
      }
    }

    res.end();
  }

  async getById(id: string): Promise<AdminApplicationResponse> {
    if (!isUuid(id)) {
      throw new AppException('APPLICATION_NOT_FOUND', 'Application not found.');
    }

    const row = await this.prisma.applications.findFirst({
      where: { id, status: { not: 'DRAFT' } },
      include: {
        services: { select: { published_version: true, draft: true } },
        users_applications_citizen_idTousers: {
          select: {
            id: true,
            full_name: true,
            national_id: true,
            birth_date: true,
            gender: true,
            email: true,
            phone: true,
          },
        },
        users_applications_decided_byTousers: {
          select: { id: true, full_name: true },
        },
        attachments: { orderBy: { uploaded_at: 'asc' } },
        application_status_history: {
          orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
          include: {
            users: { select: { id: true, full_name: true, role: true } },
          },
        },
        credentials: true,
        deliveries: {
          include: {
            users: { select: { id: true, full_name: true } },
          },
        },
      },
    });

    if (!row) {
      throw new AppException('APPLICATION_NOT_FOUND', 'Application not found.');
    }

    const resolvedVersion = row.service_version ?? row.services.published_version ?? 1;
    const serviceName = await this.resolveServiceName(
      row.service_id,
      resolvedVersion,
      row.services.draft,
    );

    return mapAdminApplicationDetail({
      application: row,
      serviceName,
      resolvedServiceVersion: resolvedVersion,
      citizen: row.users_applications_citizen_idTousers,
      decidedBy: row.users_applications_decided_byTousers,
      attachments: row.attachments,
      statusHistory: row.application_status_history,
      credential: row.credentials,
      delivery: row.deliveries,
    });
  }

  async startReview(admin: AuthenticatedUser, id: string): Promise<AdminApplicationResponse> {
    if (!isUuid(id)) {
      throw new AppException('APPLICATION_NOT_FOUND', 'Application not found.');
    }

    const createdNotifications = await withTx(this.prisma, async (tx) => {
      const exists = await lockApplication(tx, id);
      if (!exists) {
        throw new AppException('APPLICATION_NOT_FOUND', 'Application not found.');
      }

      const app = await tx.applications.findUnique({ where: { id } });
      if (!app || app.status === 'DRAFT') {
        throw new AppException('APPLICATION_NOT_FOUND', 'Application not found.');
      }

      await this.workflowService.transition(tx, app, 'UNDER_REVIEW', {
        byUserId: admin.id,
      });

      await this.auditService.recordInTx(tx, {
        actorId: admin.id,
        action: 'APPLICATION_REVIEW_STARTED',
        entityType: 'APPLICATION',
        entityId: app.id,
        metadata: { fromStatus: app.status, toStatus: 'UNDER_REVIEW' },
      });

      const notif = await this.notificationsWriter.createInTx(tx, {
        userId: app.citizen_id,
        type: 'APPLICATION_UNDER_REVIEW',
        entityType: 'APPLICATION',
        entityId: app.id,
        templateParams: { applicationNumber: app.application_number },
      });

      return [notif];
    });

    this.notificationsWriter.publishAfterCommit(createdNotifications);
    return this.getById(id);
  }

  async approve(
    admin: AuthenticatedUser,
    id: string,
    dto: ApproveApplicationDto,
  ): Promise<AdminApplicationResponse> {
    if (!isUuid(id)) {
      throw new AppException('APPLICATION_NOT_FOUND', 'Application not found.');
    }

    const staffNote = dto.note && dto.note.length > 0 ? dto.note : null;

    const createdNotifications = await withTx(this.prisma, async (tx) => {
      // 1. Lock application row (Design §6.4)
      const exists = await lockApplication(tx, id);
      if (!exists) {
        throw new AppException('APPLICATION_NOT_FOUND', 'Application not found.');
      }

      const app = await tx.applications.findUnique({
        where: { id },
        include: {
          users_applications_citizen_idTousers: {
            select: { id: true, full_name: true, email: true, preferred_language: true },
          },
        },
      });
      if (!app || app.status === 'DRAFT') {
        throw new AppException('APPLICATION_NOT_FOUND', 'Application not found.');
      }

      if (app.status !== 'UNDER_REVIEW') {
        throw new AppException(
          'INVALID_STATUS_TRANSITION',
          `Cannot approve application in status ${app.status}.`,
        );
      }

      // 2. Load pinned service version definition for validityYears
      const versionRow = await tx.service_versions.findUniqueOrThrow({
        where: {
          service_id_version: {
            service_id: app.service_id,
            version: app.service_version!,
          },
        },
      });
      const definition = versionRow.definition as unknown as ServiceDefinition;
      const citizen = app.users_applications_citizen_idTousers;
      const address = app.delivery_address as DeliveryAddressValue;

      // 3 & 4. Transition UNDER_REVIEW -> APPROVED and record staff_note history
      await this.workflowService.transition(tx, app, 'APPROVED', {
        byUserId: admin.id,
        staffNote,
        extraUpdate: {
          decided_at: new Date(),
          decided_by: admin.id,
          decision_outcome: 'APPROVED',
        },
      });

      // 5. Issue credential (PostgreSQL leap-day-safe expiry)
      const credential = await this.credentialsService.issueInTx(tx, {
        applicationId: app.id,
        holderId: citizen.id,
        serviceId: app.service_id,
        holderName: citizen.full_name,
        validityYears: definition.validityYears,
      });

      // 6. Create delivery & run advisory-locked auto-assignment
      const { agentNotification } = await this.deliveriesService.createAndAutoAssignInTx(tx, {
        applicationId: app.id,
        applicationNumber: app.application_number,
        governorate: address.governorate as governorate,
        actorId: admin.id,
      });

      // 7. Audit rows, citizen notification, and email outbox in same tx
      await this.auditService.recordInTx(tx, {
        actorId: admin.id,
        action: 'APPLICATION_APPROVED',
        entityType: 'APPLICATION',
        entityId: app.id,
        metadata: { fromStatus: 'UNDER_REVIEW', toStatus: 'APPROVED' },
      });

      await this.auditService.recordInTx(tx, {
        actorId: admin.id,
        action: 'CREDENTIAL_ISSUED',
        entityType: 'CREDENTIAL',
        entityId: credential.id,
        metadata: { applicationId: app.id, serviceId: app.service_id },
      });

      const citizenNotification = await this.notificationsWriter.createInTx(tx, {
        userId: citizen.id,
        type: 'APPLICATION_APPROVED',
        entityType: 'APPLICATION',
        entityId: app.id,
        templateParams: {
          applicationNumber: app.application_number,
          credentialNumber: credential.number,
        },
      });

      await this.emailService.enqueueInTx(tx, {
        toEmail: citizen.email,
        toUserId: citizen.id,
        template: 'APPLICATION_APPROVED',
        language: citizen.preferred_language,
        payload: {
          applicationNumber: app.application_number,
          credentialNumber: credential.number,
        },
      });

      const allNotifications: notifications[] = [citizenNotification];
      if (agentNotification) {
        allNotifications.push(agentNotification);
      }
      return allNotifications;
    });

    // 8. Publish SSE notifications after commit only
    this.notificationsWriter.publishAfterCommit(createdNotifications);
    return this.getById(id);
  }

  async reject(
    admin: AuthenticatedUser,
    id: string,
    dto: RejectApplicationDto,
  ): Promise<AdminApplicationResponse> {
    if (!isUuid(id)) {
      throw new AppException('APPLICATION_NOT_FOUND', 'Application not found.');
    }

    const createdNotifications = await withTx(this.prisma, async (tx) => {
      const exists = await lockApplication(tx, id);
      if (!exists) {
        throw new AppException('APPLICATION_NOT_FOUND', 'Application not found.');
      }

      const app = await tx.applications.findUnique({
        where: { id },
        include: {
          users_applications_citizen_idTousers: {
            select: { id: true, email: true, preferred_language: true },
          },
        },
      });
      if (!app || app.status === 'DRAFT') {
        throw new AppException('APPLICATION_NOT_FOUND', 'Application not found.');
      }

      await this.workflowService.transition(tx, app, 'REJECTED', {
        byUserId: admin.id,
        citizenNote: dto.reason,
        extraUpdate: {
          decided_at: new Date(),
          decided_by: admin.id,
          decision_outcome: 'REJECTED',
          decision_reason_code: dto.reasonCode,
          decision_reason: dto.reason,
        },
      });

      await this.auditService.recordInTx(tx, {
        actorId: admin.id,
        action: 'APPLICATION_REJECTED',
        entityType: 'APPLICATION',
        entityId: app.id,
        metadata: {
          fromStatus: 'UNDER_REVIEW',
          toStatus: 'REJECTED',
          reasonCode: dto.reasonCode,
        },
      });

      const citizen = app.users_applications_citizen_idTousers;
      const notif = await this.notificationsWriter.createInTx(tx, {
        userId: citizen.id,
        type: 'APPLICATION_REJECTED',
        entityType: 'APPLICATION',
        entityId: app.id,
        templateParams: { applicationNumber: app.application_number },
      });

      await this.emailService.enqueueInTx(tx, {
        toEmail: citizen.email,
        toUserId: citizen.id,
        template: 'APPLICATION_REJECTED',
        language: citizen.preferred_language,
        payload: {
          applicationNumber: app.application_number,
          reason: dto.reason,
        },
      });

      return [notif];
    });

    this.notificationsWriter.publishAfterCommit(createdNotifications);
    return this.getById(id);
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
