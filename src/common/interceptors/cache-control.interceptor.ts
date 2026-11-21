import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Response } from 'express';
import { Observable } from 'rxjs';
import { PUBLIC_CACHE_KEY, PublicCacheOptions } from '../decorators/public-cache.decorator';

/**
 * Enforces Contract §0.15:
 * - Default Cache-Control is `no-store` for every endpoint.
 * - Routes marked with @PublicCache(...) emit public cache directives.
 * - Every response carries `Vary: Origin`.
 */
@Injectable()
export class CacheControlInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const res = context.switchToHttp().getResponse<Response>();
    const cacheOptions = this.reflector.getAllAndOverride<PublicCacheOptions | undefined>(
      PUBLIC_CACHE_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (cacheOptions) {
      const directives = [`public`, `max-age=${cacheOptions.maxAgeSeconds}`];
      if (cacheOptions.staleWhileRevalidateSeconds !== undefined) {
        directives.push(`stale-while-revalidate=${cacheOptions.staleWhileRevalidateSeconds}`);
      }
      res.setHeader('Cache-Control', directives.join(', '));
    } else {
      res.setHeader('Cache-Control', 'no-store');
    }

    res.vary('Origin');

    return next.handle();
  }
}
