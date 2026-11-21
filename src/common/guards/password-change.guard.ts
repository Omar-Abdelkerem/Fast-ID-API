import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ALLOW_MUST_CHANGE_PASSWORD_KEY } from '../decorators/allow-must-change-password.decorator';
import { RequestWithUser } from '../decorators/current-user.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { AppException } from '../errors/app-exception';

/**
 * Enforces Contract §0.9: accounts with mustChangePassword: true may only call
 * GET /auth/me, POST /auth/change-password, and public endpoints (including POST /auth/logout).
 */
@Injectable()
export class PasswordChangeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const allowMustChange = this.reflector.getAllAndOverride<boolean>(
      ALLOW_MUST_CHANGE_PASSWORD_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (allowMustChange) {
      return true;
    }

    const req = context.switchToHttp().getRequest<RequestWithUser>();
    if (req.user?.must_change_password) {
      throw new AppException(
        'PASSWORD_CHANGE_REQUIRED',
        'You must change your temporary password before continuing.',
      );
    }

    return true;
  }
}
