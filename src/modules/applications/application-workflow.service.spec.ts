import { AppException } from '../../common/errors/app-exception';
import { PrismaTx } from '../../database/transaction';
import { ApplicationWorkflowService } from './application-workflow.service';

describe('ApplicationWorkflowService', () => {
  const service = new ApplicationWorkflowService();

  it('allows every transition in the Design §6.1 state machine and rejects illegal ones', () => {
    expect(service.canTransition('DRAFT', 'SUBMITTED')).toBe(true);
    expect(service.canTransition('SUBMITTED', 'UNDER_REVIEW')).toBe(true);
    expect(service.canTransition('SUBMITTED', 'CANCELLED')).toBe(true);
    expect(service.canTransition('UNDER_REVIEW', 'APPROVED')).toBe(true);
    expect(service.canTransition('UNDER_REVIEW', 'REJECTED')).toBe(true);
    expect(service.canTransition('APPROVED', 'OUT_FOR_DELIVERY')).toBe(true);
    expect(service.canTransition('OUT_FOR_DELIVERY', 'DELIVERED')).toBe(true);
    expect(service.canTransition('OUT_FOR_DELIVERY', 'APPROVED')).toBe(true);

    expect(service.canTransition('DRAFT', 'CANCELLED')).toBe(false);
    expect(service.canTransition('UNDER_REVIEW', 'CANCELLED')).toBe(false);
    expect(service.canTransition('REJECTED', 'APPROVED')).toBe(false);
    expect(service.canTransition('DELIVERED', 'APPROVED')).toBe(false);
  });

  it('throws 409 INVALID_STATUS_TRANSITION without touching DB on illegal transition', async () => {
    const update = jest.fn();
    const createHistory = jest.fn();
    const tx = {
      applications: { update },
      application_status_history: { create: createHistory },
    } as unknown as PrismaTx;

    await expect(
      service.transition(tx, { id: 'app-1', status: 'UNDER_REVIEW' }, 'CANCELLED', {
        byUserId: 'user-1',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATUS_TRANSITION' });

    expect(update).not.toHaveBeenCalled();
    expect(createHistory).not.toHaveBeenCalled();
  });

  it('updates status and writes history row atomically on legal transition', async () => {
    const update = jest.fn().mockResolvedValue({ id: 'app-1', status: 'CANCELLED' });
    const createHistory = jest.fn().mockResolvedValue({});
    const tx = {
      applications: { update },
      application_status_history: { create: createHistory },
    } as unknown as PrismaTx;

    const result = await service.transition(tx, { id: 'app-1', status: 'SUBMITTED' }, 'CANCELLED', {
      byUserId: 'user-1',
      citizenNote: 'Changed my mind',
    });

    expect(result.status).toBe('CANCELLED');
    expect(update).toHaveBeenCalledWith({
      where: { id: 'app-1' },
      data: { status: 'CANCELLED' },
    });
    expect(createHistory).toHaveBeenCalledWith({
      data: {
        application_id: 'app-1',
        status: 'CANCELLED',
        by_user_id: 'user-1',
        citizen_note: 'Changed my mind',
        staff_note: null,
      },
    });
    expect(new AppException('INVALID_STATUS_TRANSITION', 'x').getStatus()).toBe(409);
  });
});
