import { Injectable } from '@nestjs/common';
import { application_status, applications, Prisma } from '@prisma/client';
import { AppException } from '../../common/errors/app-exception';
import { PrismaTx } from '../../database/transaction';

const ALLOWED_TRANSITIONS: Readonly<Record<application_status, readonly application_status[]>> = {
  DRAFT: ['SUBMITTED'],
  SUBMITTED: ['UNDER_REVIEW', 'CANCELLED'],
  UNDER_REVIEW: ['APPROVED', 'REJECTED'],
  APPROVED: ['OUT_FOR_DELIVERY'],
  REJECTED: [],
  OUT_FOR_DELIVERY: ['DELIVERED', 'APPROVED'],
  DELIVERED: [],
  CANCELLED: [],
};

export interface TransitionApplicationOptions {
  byUserId: string | null;
  citizenNote?: string | null;
  staffNote?: string | null;
  extraUpdate?: Omit<Prisma.applicationsUncheckedUpdateInput, 'status'>;
}

/**
 * Single authoritative writer of applications.status (Design §6.1, Prompt Rule #7).
 * Enforces the state machine, updates the application row, and appends to application_status_history.
 */
@Injectable()
export class ApplicationWorkflowService {
  canTransition(from: application_status, to: application_status): boolean {
    return ALLOWED_TRANSITIONS[from].includes(to);
  }

  async transition(
    tx: PrismaTx,
    application: Pick<applications, 'id' | 'status'>,
    toStatus: application_status,
    options: TransitionApplicationOptions,
  ): Promise<applications> {
    if (!this.canTransition(application.status, toStatus)) {
      throw new AppException(
        'INVALID_STATUS_TRANSITION',
        `Cannot transition application from ${application.status} to ${toStatus}.`,
      );
    }

    const updated = await tx.applications.update({
      where: { id: application.id },
      data: {
        ...(options.extraUpdate ?? {}),
        status: toStatus,
      },
    });

    await tx.application_status_history.create({
      data: {
        application_id: application.id,
        status: toStatus,
        by_user_id: options.byUserId,
        citizen_note: options.citizenNote ?? null,
        staff_note: options.staffNote ?? null,
      },
    });

    return updated;
  }
}
