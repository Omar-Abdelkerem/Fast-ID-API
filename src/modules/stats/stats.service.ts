import { Injectable } from '@nestjs/common';
import { application_status, delivery_status } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

export type NonDraftApplicationStatus = Exclude<application_status, 'DRAFT'>;

export interface AdminStatsResponse {
  applicationsByStatus: Record<NonDraftApplicationStatus, number>;
  overdueApplications: number;
  deliveriesByStatus: Record<delivery_status, number>;
  unassignedDeliveries: number;
  averageDecisionHours30d: number | null;
}

const NON_DRAFT_APPLICATION_STATUSES: readonly NonDraftApplicationStatus[] = [
  'SUBMITTED',
  'UNDER_REVIEW',
  'APPROVED',
  'REJECTED',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'CANCELLED',
];

const ALL_DELIVERY_STATUSES: readonly delivery_status[] = [
  'PENDING_ASSIGNMENT',
  'ASSIGNED',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'FAILED_ATTEMPT',
];

/**
 * Dashboard statistics service (Contract §10.7, Design §11).
 * Executes four compact aggregate queries and zero-fills every status key in code.
 */
@Injectable()
export class StatsService {
  constructor(private readonly prisma: PrismaService) {}

  async getAdminStats(): Promise<AdminStatsResponse> {
    const [appGroups, overdueApplications, deliveryGroups, avgRows] = await Promise.all([
      this.prisma.applications.groupBy({
        by: ['status'],
        where: { status: { not: 'DRAFT' } },
        _count: { _all: true },
      }),
      this.prisma.applications.count({
        where: {
          status: { in: ['SUBMITTED', 'UNDER_REVIEW'] },
          due_at: { lt: new Date() },
        },
      }),
      this.prisma.deliveries.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      this.prisma.$queryRaw<Array<{ avg_hours: string | number | null }>>`
        SELECT AVG(EXTRACT(EPOCH FROM (decided_at - submitted_at)) / 3600.0) AS avg_hours
        FROM applications
        WHERE decided_at IS NOT NULL
          AND submitted_at IS NOT NULL
          AND decided_at >= now() - interval '30 days'
      `,
    ]);

    const applicationsByStatus = {} as Record<NonDraftApplicationStatus, number>;
    for (const status of NON_DRAFT_APPLICATION_STATUSES) {
      applicationsByStatus[status] = 0;
    }
    for (const row of appGroups) {
      if (row.status !== 'DRAFT') {
        applicationsByStatus[row.status] = row._count._all;
      }
    }

    const deliveriesByStatus = {} as Record<delivery_status, number>;
    for (const status of ALL_DELIVERY_STATUSES) {
      deliveriesByStatus[status] = 0;
    }
    for (const row of deliveryGroups) {
      deliveriesByStatus[row.status] = row._count._all;
    }

    const rawAvg = avgRows[0]?.avg_hours;
    const averageDecisionHours30d =
      rawAvg === null || rawAvg === undefined ? null : Math.round(Number(rawAvg) * 10) / 10;

    return {
      applicationsByStatus,
      overdueApplications,
      deliveriesByStatus,
      unassignedDeliveries: deliveriesByStatus.PENDING_ASSIGNMENT,
      averageDecisionHours30d,
    };
  }
}
