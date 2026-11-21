import { randomInt, timingSafeEqual } from 'crypto';
import { Injectable } from '@nestjs/common';
import { deliveries, delivery_status, governorate, notifications, Prisma } from '@prisma/client';
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { createPaginatedResult, PaginatedResult } from '../../common/dto/pagination.dto';
import { AppException } from '../../common/errors/app-exception';
import { isUuid } from '../../common/utils/uuid';
import { PrismaService } from '../../database/prisma.service';
import {
  acquireAdvisoryXactLock,
  lockApplication,
  lockDelivery,
  lockUser,
  PrismaTx,
  withTx,
} from '../../database/transaction';
import { ApplicationWorkflowService } from '../applications/application-workflow.service';
import { AuditService } from '../audit/audit.service';
import { EmailService } from '../email/email.service';
import { NotificationsWriterService } from '../notifications/notifications-writer.service';
import { GOVERNORATE_BY_CODE } from '../reference/governorates.data';
import { DeliveryAddressValue } from '../services/application-data.validator';
import { LocalizedText, ServiceDefinition } from '../services/service-definition.types';
import { AdminDeliveryResponse, mapAdminDelivery } from './delivery-response.mapper';
import { AssignDeliveryDto } from './dto/assign-delivery.dto';
import { DeliverDeliveryDto } from './dto/deliver-delivery.dto';
import { FailDeliveryDto } from './dto/fail-delivery.dto';
import {
  ALL_DELIVERY_STATUSES,
  ListAdminDeliveriesQueryDto,
} from './dto/list-admin-deliveries-query.dto';
import { ListAgentDeliveriesQueryDto } from './dto/list-agent-deliveries-query.dto';

const ASSIGNABLE_DELIVERY_STATUSES = new Set<delivery_status>([
  'PENDING_ASSIGNMENT',
  'ASSIGNED',
  'FAILED_ATTEMPT',
]);
const MAX_DELIVERY_CODE_TRIES = 5;

function parseDeliveryStatuses(
  raw: string | undefined,
  defaultStatuses?: delivery_status[],
): delivery_status[] | undefined {
  if (raw === undefined || raw.trim() === '') {
    return defaultStatuses;
  }

  const values = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (values.length === 0) {
    return defaultStatuses;
  }

  for (const val of values) {
    if (!ALL_DELIVERY_STATUSES.has(val)) {
      throw new AppException('VALIDATION_ERROR', `Invalid delivery status "${val}".`, {
        field: 'status',
        details: [
          { field: 'status', code: 'INVALID_VALUE', message: `Invalid delivery status "${val}".` },
        ],
      });
    }
  }

  return values as delivery_status[];
}

function generateDeliveryCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export interface CreateAndAutoAssignParams {
  applicationId: string;
  applicationNumber: string;
  governorate: governorate;
  actorId: string;
}

@Injectable()
export class DeliveriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workflowService: ApplicationWorkflowService,
    private readonly auditService: AuditService,
    private readonly emailService: EmailService,
    private readonly notificationsWriter: NotificationsWriterService,
  ) {}

  /**
   * Creates a delivery row and auto-assigns the least-loaded active AGENT in the same governorate
   * inside the approval transaction (Design §6.4, §6.5, Appendix A.3).
   */
  async createAndAutoAssignInTx(
    tx: PrismaTx,
    params: CreateAndAutoAssignParams,
  ): Promise<{ delivery: deliveries; agentNotification: notifications | null }> {
    await acquireAdvisoryXactLock(tx, `assign:${params.governorate}`);

    const candidates = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT u.id
      FROM users u
      LEFT JOIN deliveries d
        ON d.agent_id = u.id AND d.status IN ('ASSIGNED', 'OUT_FOR_DELIVERY')
      WHERE u.role = 'AGENT'
        AND u.is_active = true
        AND u.governorate = ${params.governorate}::governorate
      GROUP BY u.id
      ORDER BY COUNT(d.id) ASC, MAX(d.assigned_at) ASC NULLS FIRST, u.id ASC
      LIMIT 1
    `;

    const chosenAgentId = candidates[0]?.id ?? null;

    const delivery = await tx.deliveries.create({
      data: {
        application_id: params.applicationId,
        agent_id: chosenAgentId,
        status: chosenAgentId ? 'ASSIGNED' : 'PENDING_ASSIGNMENT',
        assigned_at: chosenAgentId ? new Date() : null,
      },
    });

    await this.auditService.recordInTx(tx, {
      actorId: params.actorId,
      action: 'DELIVERY_CREATED',
      entityType: 'DELIVERY',
      entityId: delivery.id,
      metadata: { applicationId: params.applicationId, status: delivery.status },
    });

    let agentNotification: notifications | null = null;
    if (chosenAgentId) {
      await this.auditService.recordInTx(tx, {
        actorId: null,
        action: 'DELIVERY_ASSIGNED',
        entityType: 'DELIVERY',
        entityId: delivery.id,
        metadata: { agentId: chosenAgentId, autoAssigned: true },
      });

      // C-4: agent notifications use entityType = 'DELIVERY'
      agentNotification = await this.notificationsWriter.createInTx(tx, {
        userId: chosenAgentId,
        type: 'DELIVERY_ASSIGNED',
        entityType: 'DELIVERY',
        entityId: delivery.id,
        templateParams: { applicationNumber: params.applicationNumber },
      });
    }

    return { delivery, agentNotification };
  }

  async listAdmin(
    query: ListAdminDeliveriesQueryDto,
  ): Promise<PaginatedResult<AdminDeliveryResponse>> {
    const statuses = parseDeliveryStatuses(query.status);

    if (query.governorate && !GOVERNORATE_BY_CODE.has(query.governorate)) {
      throw new AppException('VALIDATION_ERROR', 'Invalid governorate code.', {
        field: 'governorate',
        details: [
          { field: 'governorate', code: 'INVALID_VALUE', message: 'Invalid governorate code.' },
        ],
      });
    }

    const where: Prisma.deliveriesWhereInput = {};
    if (query.unassigned === 'true') {
      where.status = 'PENDING_ASSIGNMENT';
    } else if (statuses) {
      where.status = { in: statuses };
    }

    if (query.agentId) {
      where.agent_id = query.agentId;
    }

    if (query.governorate) {
      where.applications = {
        delivery_address: {
          path: ['governorate'],
          equals: query.governorate,
        },
      };
    }

    const orderBy: Prisma.deliveriesOrderByWithRelationInput =
      query.sort === 'createdAt' ? { created_at: 'asc' } : { created_at: 'desc' };

    const skip = (query.page - 1) * query.pageSize;

    const [total, rows] = await Promise.all([
      this.prisma.deliveries.count({ where }),
      this.prisma.deliveries.findMany({
        where,
        orderBy,
        skip,
        take: query.pageSize,
        include: {
          users: { select: { id: true, full_name: true } },
          applications: {
            include: {
              users_applications_citizen_idTousers: { select: { full_name: true } },
              services: { select: { published_version: true, draft: true } },
            },
          },
        },
      }),
    ]);

    const items = await Promise.all(rows.map((row) => this.mapFullDeliveryRow(row)));
    return createPaginatedResult(items, total, query.page, query.pageSize);
  }

  async getAdminById(id: string): Promise<AdminDeliveryResponse> {
    if (!isUuid(id)) {
      throw new AppException('DELIVERY_NOT_FOUND', 'Delivery not found.');
    }

    const row = await this.prisma.deliveries.findUnique({
      where: { id },
      include: {
        users: { select: { id: true, full_name: true } },
        applications: {
          include: {
            users_applications_citizen_idTousers: { select: { full_name: true } },
            services: { select: { published_version: true, draft: true } },
          },
        },
      },
    });
    if (!row) {
      throw new AppException('DELIVERY_NOT_FOUND', 'Delivery not found.');
    }

    return this.mapFullDeliveryRow(row);
  }

  async assign(
    admin: AuthenticatedUser,
    id: string,
    dto: AssignDeliveryDto,
  ): Promise<AdminDeliveryResponse> {
    if (!isUuid(id)) {
      throw new AppException('DELIVERY_NOT_FOUND', 'Delivery not found.');
    }

    const createdNotifications = await withTx(this.prisma, async (tx) => {
      // Lock order (Design §6.2, §6.3): delivery -> users -> advisory lock assign:<governorate>
      const deliveryExists = await lockDelivery(tx, id);
      if (!deliveryExists) {
        throw new AppException('DELIVERY_NOT_FOUND', 'Delivery not found.');
      }

      const delivery = await tx.deliveries.findUniqueOrThrow({
        where: { id },
        include: { applications: { select: { application_number: true } } },
      });

      if (!ASSIGNABLE_DELIVERY_STATUSES.has(delivery.status)) {
        throw new AppException(
          'INVALID_STATUS_TRANSITION',
          `Cannot assign delivery in status ${delivery.status}.`,
        );
      }

      const agentLocked = await lockUser(tx, dto.agentId);
      if (!agentLocked) {
        throw new AppException('AGENT_NOT_FOUND', 'Active delivery agent not found.');
      }

      const agent = await tx.users.findUnique({ where: { id: dto.agentId } });
      if (!agent || agent.role !== 'AGENT' || !agent.is_active || !agent.governorate) {
        throw new AppException('AGENT_NOT_FOUND', 'Active delivery agent not found.');
      }

      // D-25: serialize against concurrent agent deactivation
      await acquireAdvisoryXactLock(tx, `assign:${agent.governorate}`);

      const recheckedAgent = await tx.users.findUniqueOrThrow({ where: { id: agent.id } });
      if (!recheckedAgent.is_active) {
        throw new AppException('AGENT_NOT_FOUND', 'Active delivery agent not found.');
      }

      await tx.$executeRaw`
        UPDATE deliveries
        SET agent_id = ${agent.id}::uuid,
            status = 'ASSIGNED',
            assigned_at = now(),
            out_for_delivery_at = NULL
        WHERE id = ${delivery.id}::uuid
      `;

      await this.auditService.recordInTx(tx, {
        actorId: admin.id,
        action: 'DELIVERY_ASSIGNED',
        entityType: 'DELIVERY',
        entityId: delivery.id,
        metadata: { agentId: agent.id, fromStatus: delivery.status },
      });

      const notif = await this.notificationsWriter.createInTx(tx, {
        userId: agent.id,
        type: 'DELIVERY_ASSIGNED',
        entityType: 'DELIVERY',
        entityId: delivery.id,
        templateParams: { applicationNumber: delivery.applications.application_number },
      });

      return [notif];
    });

    this.notificationsWriter.publishAfterCommit(createdNotifications);
    return this.getAdminById(id);
  }

  async listAgent(
    agent: AuthenticatedUser,
    query: ListAgentDeliveriesQueryDto,
  ): Promise<PaginatedResult<AdminDeliveryResponse>> {
    const statuses = parseDeliveryStatuses(query.status, ['ASSIGNED', 'OUT_FOR_DELIVERY']);

    const where: Prisma.deliveriesWhereInput = {
      agent_id: agent.id,
      ...(statuses ? { status: { in: statuses } } : {}),
    };

    const orderBy: Prisma.deliveriesOrderByWithRelationInput =
      query.sort === '-assignedAt' ? { assigned_at: 'desc' } : { assigned_at: 'asc' };

    const skip = (query.page - 1) * query.pageSize;

    const [total, rows] = await Promise.all([
      this.prisma.deliveries.count({ where }),
      this.prisma.deliveries.findMany({
        where,
        orderBy,
        skip,
        take: query.pageSize,
        include: {
          users: { select: { id: true, full_name: true } },
          applications: {
            include: {
              users_applications_citizen_idTousers: { select: { full_name: true } },
              services: { select: { published_version: true, draft: true } },
            },
          },
        },
      }),
    ]);

    const items = await Promise.all(rows.map((row) => this.mapFullDeliveryRow(row)));
    return createPaginatedResult(items, total, query.page, query.pageSize);
  }

  async getAgentById(agent: AuthenticatedUser, id: string): Promise<AdminDeliveryResponse> {
    if (!isUuid(id)) {
      throw new AppException('DELIVERY_NOT_FOUND', 'Delivery not found.');
    }

    const row = await this.prisma.deliveries.findFirst({
      where: { id, agent_id: agent.id },
      include: {
        users: { select: { id: true, full_name: true } },
        applications: {
          include: {
            users_applications_citizen_idTousers: { select: { full_name: true } },
            services: { select: { published_version: true, draft: true } },
          },
        },
      },
    });
    if (!row) {
      throw new AppException('DELIVERY_NOT_FOUND', 'Delivery not found.');
    }

    return this.mapFullDeliveryRow(row);
  }

  async startDelivery(agent: AuthenticatedUser, id: string): Promise<AdminDeliveryResponse> {
    if (!isUuid(id)) {
      throw new AppException('DELIVERY_NOT_FOUND', 'Delivery not found.');
    }

    const pre = await this.prisma.deliveries.findFirst({
      where: { id, agent_id: agent.id },
      select: { application_id: true },
    });
    if (!pre) {
      throw new AppException('DELIVERY_NOT_FOUND', 'Delivery not found.');
    }

    const createdNotifications = await withTx(this.prisma, async (tx) => {
      // Lock order (Design §6.2): application -> delivery
      await lockApplication(tx, pre.application_id);
      await lockDelivery(tx, id);

      const delivery = await tx.deliveries.findFirst({
        where: { id, agent_id: agent.id },
        include: {
          applications: {
            include: {
              users_applications_citizen_idTousers: {
                select: { id: true, email: true, preferred_language: true },
              },
            },
          },
        },
      });
      if (!delivery) {
        throw new AppException('DELIVERY_NOT_FOUND', 'Delivery not found.');
      }

      if (delivery.status !== 'ASSIGNED') {
        throw new AppException(
          'INVALID_STATUS_TRANSITION',
          'Delivery can only be started from ASSIGNED status.',
        );
      }

      const code = generateDeliveryCode();

      await tx.$executeRaw`
        UPDATE deliveries
        SET status = 'OUT_FOR_DELIVERY',
            delivery_code = ${code},
            code_failed_tries = 0,
            out_for_delivery_at = now()
        WHERE id = ${delivery.id}::uuid
      `;

      await this.workflowService.transition(tx, delivery.applications, 'OUT_FOR_DELIVERY', {
        byUserId: agent.id,
      });

      await this.auditService.recordInTx(tx, {
        actorId: agent.id,
        action: 'DELIVERY_OUT_FOR_DELIVERY',
        entityType: 'DELIVERY',
        entityId: delivery.id,
        metadata: { applicationId: delivery.application_id },
      });

      const citizen = delivery.applications.users_applications_citizen_idTousers;
      const notif = await this.notificationsWriter.createInTx(tx, {
        userId: citizen.id,
        type: 'DELIVERY_OUT_FOR_DELIVERY',
        entityType: 'APPLICATION',
        entityId: delivery.application_id,
        templateParams: { applicationNumber: delivery.applications.application_number },
      });

      const agentFirstName = agent.full_name.trim().split(/\s+/)[0] ?? '';
      await this.emailService.enqueueInTx(tx, {
        toEmail: citizen.email,
        toUserId: citizen.id,
        template: 'DELIVERY_OUT_FOR_DELIVERY',
        language: citizen.preferred_language,
        payload: {
          applicationNumber: delivery.applications.application_number,
          agentFirstName,
        },
      });

      return [notif];
    });

    this.notificationsWriter.publishAfterCommit(createdNotifications);
    return this.getAgentById(agent, id);
  }

  async completeDelivery(
    agent: AuthenticatedUser,
    id: string,
    dto: DeliverDeliveryDto,
  ): Promise<AdminDeliveryResponse> {
    if (!isUuid(id)) {
      throw new AppException('DELIVERY_NOT_FOUND', 'Delivery not found.');
    }

    const pre = await this.prisma.deliveries.findFirst({
      where: { id, agent_id: agent.id },
      select: { application_id: true },
    });
    if (!pre) {
      throw new AppException('DELIVERY_NOT_FOUND', 'Delivery not found.');
    }

    // Design §6.2: failed code tries MUST persist even when the request returns 400/409.
    const txOutcome = await withTx(this.prisma, async (tx) => {
      await lockApplication(tx, pre.application_id);
      await lockDelivery(tx, id);

      const delivery = await tx.deliveries.findFirst({
        where: { id, agent_id: agent.id },
        include: {
          applications: {
            include: {
              users_applications_citizen_idTousers: {
                select: { id: true, email: true, preferred_language: true },
              },
            },
          },
        },
      });
      if (!delivery) {
        throw new AppException('DELIVERY_NOT_FOUND', 'Delivery not found.');
      }

      if (delivery.status !== 'OUT_FOR_DELIVERY' || !delivery.delivery_code) {
        throw new AppException(
          'INVALID_STATUS_TRANSITION',
          'Delivery can only be completed while OUT_FOR_DELIVERY.',
        );
      }

      if (delivery.code_failed_tries >= MAX_DELIVERY_CODE_TRIES) {
        return { kind: 'LOCKED' as const };
      }

      const matches = constantTimeEquals(dto.code, delivery.delivery_code);
      if (!matches) {
        const nextTries = delivery.code_failed_tries + 1;
        await tx.deliveries.update({
          where: { id: delivery.id },
          data: { code_failed_tries: nextTries },
        });
        return {
          kind: nextTries >= MAX_DELIVERY_CODE_TRIES ? ('LOCKED' as const) : ('INVALID' as const),
        };
      }

      await tx.$executeRaw`
        UPDATE deliveries
        SET status = 'DELIVERED',
            delivery_code = NULL,
            delivered_at = now()
        WHERE id = ${delivery.id}::uuid
      `;

      await this.workflowService.transition(tx, delivery.applications, 'DELIVERED', {
        byUserId: agent.id,
      });

      await this.auditService.recordInTx(tx, {
        actorId: agent.id,
        action: 'DELIVERY_COMPLETED',
        entityType: 'DELIVERY',
        entityId: delivery.id,
        metadata: { applicationId: delivery.application_id },
      });

      const citizen = delivery.applications.users_applications_citizen_idTousers;
      const notif = await this.notificationsWriter.createInTx(tx, {
        userId: citizen.id,
        type: 'DELIVERY_COMPLETED',
        entityType: 'APPLICATION',
        entityId: delivery.application_id,
        templateParams: { applicationNumber: delivery.applications.application_number },
      });

      await this.emailService.enqueueInTx(tx, {
        toEmail: citizen.email,
        toUserId: citizen.id,
        template: 'DELIVERY_COMPLETED',
        language: citizen.preferred_language,
        payload: { applicationNumber: delivery.applications.application_number },
      });

      return { kind: 'DELIVERED' as const, notifications: [notif] };
    });

    if (txOutcome.kind === 'LOCKED') {
      throw new AppException(
        'DELIVERY_CODE_LOCKED',
        'Maximum wrong delivery code attempts reached. Record a failed attempt instead.',
      );
    }

    if (txOutcome.kind === 'INVALID') {
      throw new AppException('INVALID_DELIVERY_CODE', 'Delivery code is incorrect.', {
        field: 'code',
      });
    }

    if (txOutcome.notifications) {
      this.notificationsWriter.publishAfterCommit(txOutcome.notifications);
    }
    return this.getAgentById(agent, id);
  }

  async failDelivery(
    agent: AuthenticatedUser,
    id: string,
    dto: FailDeliveryDto,
  ): Promise<AdminDeliveryResponse> {
    if (!isUuid(id)) {
      throw new AppException('DELIVERY_NOT_FOUND', 'Delivery not found.');
    }

    const reasonText = dto.reason && dto.reason.length > 0 ? dto.reason : null;
    if (dto.reasonCode === 'OTHER') {
      if (!reasonText || reasonText.length < 5) {
        throw new AppException(
          'VALIDATION_ERROR',
          'reason must be 5-300 characters when reasonCode is OTHER.',
          {
            field: 'reason',
            details: [
              {
                field: 'reason',
                code: !reasonText ? 'REQUIRED' : 'TOO_SHORT',
                message: 'reason must be 5-300 characters when reasonCode is OTHER.',
              },
            ],
          },
        );
      }
    }

    const pre = await this.prisma.deliveries.findFirst({
      where: { id, agent_id: agent.id },
      select: { application_id: true },
    });
    if (!pre) {
      throw new AppException('DELIVERY_NOT_FOUND', 'Delivery not found.');
    }

    const createdNotifications = await withTx(this.prisma, async (tx) => {
      await lockApplication(tx, pre.application_id);
      await lockDelivery(tx, id);

      const delivery = await tx.deliveries.findFirst({
        where: { id, agent_id: agent.id },
        include: {
          applications: {
            include: {
              users_applications_citizen_idTousers: {
                select: { id: true, email: true, preferred_language: true },
              },
            },
          },
        },
      });
      if (!delivery) {
        throw new AppException('DELIVERY_NOT_FOUND', 'Delivery not found.');
      }

      if (delivery.status !== 'OUT_FOR_DELIVERY') {
        throw new AppException(
          'INVALID_STATUS_TRANSITION',
          'Delivery failure can only be recorded while OUT_FOR_DELIVERY.',
        );
      }

      await tx.$executeRaw`
        UPDATE deliveries
        SET status = 'FAILED_ATTEMPT',
            attempts = attempts + 1,
            delivery_code = NULL,
            code_failed_tries = 0,
            last_failure_code = ${dto.reasonCode}::delivery_failure_code,
            last_failure_reason = ${reasonText},
            last_failure_at = now()
        WHERE id = ${delivery.id}::uuid
      `;

      await this.workflowService.transition(tx, delivery.applications, 'APPROVED', {
        byUserId: agent.id,
        citizenNote: reasonText,
      });

      await this.auditService.recordInTx(tx, {
        actorId: agent.id,
        action: 'DELIVERY_FAILED',
        entityType: 'DELIVERY',
        entityId: delivery.id,
        metadata: { applicationId: delivery.application_id, reasonCode: dto.reasonCode },
      });

      const citizen = delivery.applications.users_applications_citizen_idTousers;
      const notif = await this.notificationsWriter.createInTx(tx, {
        userId: citizen.id,
        type: 'DELIVERY_FAILED_ATTEMPT',
        entityType: 'APPLICATION',
        entityId: delivery.application_id,
        templateParams: { applicationNumber: delivery.applications.application_number },
      });

      await this.emailService.enqueueInTx(tx, {
        toEmail: citizen.email,
        toUserId: citizen.id,
        template: 'DELIVERY_FAILED_ATTEMPT',
        language: citizen.preferred_language,
        payload: { applicationNumber: delivery.applications.application_number },
      });

      return [notif];
    });

    this.notificationsWriter.publishAfterCommit(createdNotifications);
    return this.getAgentById(agent, id);
  }

  private async mapFullDeliveryRow(
    row: deliveries & {
      users: { id: string; full_name: string } | null;
      applications: {
        application_number: string;
        service_id: string;
        service_version: number | null;
        delivery_address: Prisma.JsonValue;
        users_applications_citizen_idTousers: { full_name: string };
        services: { published_version: number | null; draft: Prisma.JsonValue };
      };
    },
  ): Promise<AdminDeliveryResponse> {
    const version = row.applications.service_version ?? row.applications.services.published_version;
    let serviceName: LocalizedText = (
      row.applications.services.draft as unknown as ServiceDefinition
    ).name;

    if (version !== null) {
      const sv = await this.prisma.service_versions.findUnique({
        where: { service_id_version: { service_id: row.applications.service_id, version } },
        select: { definition: true },
      });
      if (sv) {
        serviceName = (sv.definition as unknown as ServiceDefinition).name;
      }
    }

    return mapAdminDelivery({
      delivery: row,
      applicationNumber: row.applications.application_number,
      serviceId: row.applications.service_id,
      serviceName,
      recipientName: row.applications.users_applications_citizen_idTousers.full_name,
      deliveryAddress: row.applications.delivery_address as unknown as DeliveryAddressValue,
      agent: row.users,
    });
  }
}
