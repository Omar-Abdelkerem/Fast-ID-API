import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { createPaginatedResult, PaginatedResult } from '../../common/dto/pagination.dto';
import { AppException } from '../../common/errors/app-exception';
import { isUuid } from '../../common/utils/uuid';
import { PrismaService } from '../../database/prisma.service';
import { ListNotificationsQueryDto } from './dto/list-notifications-query.dto';
import { mapNotificationResponse, NotificationResponse } from './notification-response.mapper';

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async listForUser(
    user: AuthenticatedUser,
    query: ListNotificationsQueryDto,
  ): Promise<PaginatedResult<NotificationResponse>> {
    const where: Prisma.notificationsWhereInput = {
      user_id: user.id,
      ...(query.isRead !== undefined ? { is_read: query.isRead === 'true' } : {}),
    };

    const skip = (query.page - 1) * query.pageSize;

    const [total, rows] = await Promise.all([
      this.prisma.notifications.count({ where }),
      this.prisma.notifications.findMany({
        where,
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        skip,
        take: query.pageSize,
      }),
    ]);

    return createPaginatedResult(
      rows.map(mapNotificationResponse),
      total,
      query.page,
      query.pageSize,
    );
  }

  async getUnreadCount(user: AuthenticatedUser): Promise<{ count: number }> {
    const count = await this.prisma.notifications.count({
      where: { user_id: user.id, is_read: false },
    });
    return { count };
  }

  async markRead(user: AuthenticatedUser, id: string): Promise<NotificationResponse> {
    if (!isUuid(id)) {
      throw new AppException('NOTIFICATION_NOT_FOUND', 'Notification not found.');
    }

    const existing = await this.prisma.notifications.findFirst({
      where: { id, user_id: user.id },
    });
    if (!existing) {
      throw new AppException('NOTIFICATION_NOT_FOUND', 'Notification not found.');
    }

    // Idempotent: already-read notification returns unchanged (Contract §6.3).
    if (existing.is_read) {
      return mapNotificationResponse(existing);
    }

    const updated = await this.prisma.notifications.update({
      where: { id: existing.id },
      data: {
        is_read: true,
        read_at: new Date(),
      },
    });

    return mapNotificationResponse(updated);
  }

  async markAllRead(user: AuthenticatedUser): Promise<{ updated: number }> {
    const result = await this.prisma.notifications.updateMany({
      where: { user_id: user.id, is_read: false },
      data: {
        is_read: true,
        read_at: new Date(),
      },
    });

    return { updated: result.count };
  }
}
