import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { SkipEnvelope } from '../../common/decorators/skip-envelope.decorator';
import { EmptyBodyDto } from '../../common/dto/empty-body.dto';
import { PaginatedResult } from '../../common/dto/pagination.dto';
import { ListNotificationsQueryDto } from './dto/list-notifications-query.dto';
import { NotificationResponse } from './notification-response.mapper';
import { NotificationsBroadcasterService } from './notifications-broadcaster.service';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly broadcaster: NotificationsBroadcasterService,
  ) {}

  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListNotificationsQueryDto,
  ): Promise<PaginatedResult<NotificationResponse>> {
    return this.notificationsService.listForUser(user, query);
  }

  @Get('unread-count')
  async getUnreadCount(@CurrentUser() user: AuthenticatedUser): Promise<{ count: number }> {
    return this.notificationsService.getUnreadCount(user);
  }

  @SkipEnvelope()
  @Get('stream')
  stream(@CurrentUser() user: AuthenticatedUser, @Req() req: Request, @Res() res: Response): void {
    this.broadcaster.attachStream(user, req, res);
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  async markAllRead(
    @CurrentUser() user: AuthenticatedUser,
    @Body() _body: EmptyBodyDto,
  ): Promise<{ updated: number }> {
    return this.notificationsService.markAllRead(user);
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  async markRead(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() _body: EmptyBodyDto,
  ): Promise<NotificationResponse> {
    return this.notificationsService.markRead(user, id);
  }
}
