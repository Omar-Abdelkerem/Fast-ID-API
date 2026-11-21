import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { AppException } from '../errors/app-exception';

const STATE_CHANGING_METHODS = new Set(['POST', 'PATCH', 'DELETE', 'PUT']);

/**
 * Enforces Contract §0.9 and Design D-21:
 * Every state-changing request must carry an Origin header matching CORS_ORIGINS.
 * Missing or disallowed Origin returns 403 ORIGIN_NOT_ALLOWED.
 */
@Injectable()
export class OriginGuard implements CanActivate {
  private readonly allowedOrigins: Set<string>;

  constructor(private readonly configService: ConfigService) {
    const origins = this.configService.get<string[]>('CORS_ORIGINS', []);
    this.allowedOrigins = new Set(origins);
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (!STATE_CHANGING_METHODS.has(req.method.toUpperCase())) {
      return true;
    }

    const origin = req.headers.origin;
    if (typeof origin !== 'string' || !this.allowedOrigins.has(origin)) {
      throw new AppException('ORIGIN_NOT_ALLOWED', 'Request origin is not allowed.');
    }

    return true;
  }
}
