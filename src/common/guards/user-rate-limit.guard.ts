import {
  CanActivate,
  ExecutionContext,
  Injectable,
  OnModuleDestroy,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Response } from 'express';
import { RequestWithUser } from '../decorators/current-user.decorator';
import { AppException } from '../errors/app-exception';
import { BoundedRateLimiter } from '../rate-limit/bounded-rate-limiter';

export const USER_RATE_LIMIT_KEY = 'userRateLimit';

export interface UserRateLimitConfig {
  name: string;
  limit: number;
  windowMs: number;
}

export const UserRateLimit = (config: UserRateLimitConfig) =>
  SetMetadata(USER_RATE_LIMIT_KEY, config);

@Injectable()
export class UserRateLimitGuard implements CanActivate, OnModuleDestroy {
  private readonly limiters = new Map<string, BoundedRateLimiter>();

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const config = this.reflector.getAllAndOverride<UserRateLimitConfig | undefined>(
      USER_RATE_LIMIT_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!config) {
      return true;
    }

    const req = context.switchToHttp().getRequest<RequestWithUser>();
    if (!req.user) {
      return true;
    }

    let limiter = this.limiters.get(config.name);
    if (!limiter) {
      limiter = new BoundedRateLimiter(config.limit, config.windowMs);
      this.limiters.set(config.name, limiter);
    }

    const result = limiter.consume(req.user.id);
    if (!result.allowed) {
      const res = context.switchToHttp().getResponse<Response>();
      res.setHeader('Retry-After', String(result.retryAfterSeconds));
      throw new AppException('RATE_LIMITED', 'Too many requests. Please try again later.');
    }

    return true;
  }

  resetAll(): void {
    for (const limiter of this.limiters.values()) {
      limiter.clear();
    }
  }

  onModuleDestroy(): void {
    for (const limiter of this.limiters.values()) {
      limiter.destroy();
    }
    this.limiters.clear();
  }
}
