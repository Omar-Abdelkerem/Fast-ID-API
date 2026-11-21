import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../database/prisma.service';
import { RequestWithUser } from '../decorators/current-user.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { AppException } from '../errors/app-exception';

export const SESSION_COOKIE_NAME = 'fid_session';

export interface SessionJwtPayload {
  sub: string;
  tv: number;
  exp: number;
  iat: number;
}

/**
 * Verifies the httpOnly fid_session JWT cookie against live DB state (Contract §0.9, Design §5.3).
 * Skipped on @Public() routes (which ignore cookies per Contract §0.15).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const req = context.switchToHttp().getRequest<RequestWithUser>();
    const token = req.cookies?.[SESSION_COOKIE_NAME] as string | undefined;
    if (!token) {
      throw new AppException('UNAUTHENTICATED', 'Authentication is required.');
    }

    let payload: SessionJwtPayload;
    try {
      payload = await this.jwtService.verifyAsync<SessionJwtPayload>(token, {
        algorithms: ['HS256'],
      });
    } catch {
      throw new AppException('UNAUTHENTICATED', 'Session is invalid or expired.');
    }

    if (!payload.sub || typeof payload.tv !== 'number' || typeof payload.exp !== 'number') {
      throw new AppException('UNAUTHENTICATED', 'Session is invalid.');
    }

    const user = await this.prisma.users.findUnique({
      where: { id: payload.sub },
    });

    if (!user) {
      throw new AppException('UNAUTHENTICATED', 'Session is invalid.');
    }

    if (!user.is_active) {
      throw new AppException('ACCOUNT_DISABLED', 'Your account has been deactivated.');
    }

    if (user.token_version !== payload.tv) {
      throw new AppException('UNAUTHENTICATED', 'Session has been invalidated.');
    }

    req.user = {
      ...user,
      jwtExp: payload.exp,
    };

    return true;
  }
}
