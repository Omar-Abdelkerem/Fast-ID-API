import { PrismaService } from '../../database/prisma.service';
import { StatsService } from './stats.service';

describe('StatsService (Contract §10.7)', () => {
  it('zero-fills every status key, excludes DRAFT, and returns null avg when no decisions exist', async () => {
    const prisma = {
      applications: {
        groupBy: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      deliveries: {
        groupBy: jest.fn().mockResolvedValue([]),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ avg_hours: null }]),
    } as unknown as PrismaService;

    const service = new StatsService(prisma);
    const stats = await service.getAdminStats();

    expect(stats).toEqual({
      applicationsByStatus: {
        SUBMITTED: 0,
        UNDER_REVIEW: 0,
        APPROVED: 0,
        REJECTED: 0,
        OUT_FOR_DELIVERY: 0,
        DELIVERED: 0,
        CANCELLED: 0,
      },
      overdueApplications: 0,
      deliveriesByStatus: {
        PENDING_ASSIGNMENT: 0,
        ASSIGNED: 0,
        OUT_FOR_DELIVERY: 0,
        DELIVERED: 0,
        FAILED_ATTEMPT: 0,
      },
      unassignedDeliveries: 0,
      averageDecisionHours30d: null,
    });
    expect('DRAFT' in stats.applicationsByStatus).toBe(false);
  });

  it('aggregates counts and rounds averageDecisionHours30d to 1 decimal place', async () => {
    const prisma = {
      applications: {
        groupBy: jest.fn().mockResolvedValue([
          { status: 'SUBMITTED', _count: { _all: 5 } },
          { status: 'DELIVERED', _count: { _all: 12 } },
        ]),
        count: jest.fn().mockResolvedValue(2),
      },
      deliveries: {
        groupBy: jest.fn().mockResolvedValue([
          { status: 'PENDING_ASSIGNMENT', _count: { _all: 3 } },
          { status: 'DELIVERED', _count: { _all: 12 } },
        ]),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ avg_hours: '18.46' }]),
    } as unknown as PrismaService;

    const service = new StatsService(prisma);
    const stats = await service.getAdminStats();

    expect(stats.applicationsByStatus.SUBMITTED).toBe(5);
    expect(stats.applicationsByStatus.DELIVERED).toBe(12);
    expect(stats.applicationsByStatus.UNDER_REVIEW).toBe(0);
    expect(stats.overdueApplications).toBe(2);
    expect(stats.deliveriesByStatus.PENDING_ASSIGNMENT).toBe(3);
    expect(stats.unassignedDeliveries).toBe(3);
    expect(stats.averageDecisionHours30d).toBe(18.5);
  });
});
