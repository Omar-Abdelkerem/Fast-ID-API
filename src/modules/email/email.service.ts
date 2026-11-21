import { Injectable } from '@nestjs/common';
import { email_template, language_code, Prisma } from '@prisma/client';
import { PrismaTx } from '../../database/transaction';

export interface EnqueueEmailParams {
  toEmail: string;
  toUserId?: string | null;
  template: email_template;
  language: language_code;
  payload?: Prisma.InputJsonObject;
}

/**
 * Transactional email outbox producer (Design D-07, §9).
 * Always inserts inside the caller's DB transaction so emails are never lost or sent for rolled-back work.
 */
@Injectable()
export class EmailService {
  async enqueueInTx(tx: PrismaTx, params: EnqueueEmailParams): Promise<void> {
    await tx.email_outbox.create({
      data: {
        to_email: params.toEmail,
        to_user_id: params.toUserId ?? null,
        template: params.template,
        language: params.language,
        payload: params.payload ?? {},
        status: 'PENDING',
      },
    });
  }
}
