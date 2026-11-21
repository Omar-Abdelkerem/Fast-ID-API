import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { users } from '@prisma/client';
import { Request } from 'express';

export interface AuthenticatedUser extends users {
  jwtExp: number;
}

export interface RequestWithUser extends Request {
  user?: AuthenticatedUser;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const req = ctx.switchToHttp().getRequest<RequestWithUser>();
    if (!req.user) {
      throw new Error('CurrentUser decorator used on a route without an authenticated user.');
    }
    return req.user;
  },
);
