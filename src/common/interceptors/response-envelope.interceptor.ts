import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { SKIP_ENVELOPE_KEY } from '../decorators/skip-envelope.decorator';
import { isPaginatedResult } from '../dto/pagination.dto';

export interface SuccessEnvelope<T> {
  success: true;
  data: T;
  meta?: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const skipEnvelope = this.reflector.getAllAndOverride<boolean>(SKIP_ENVELOPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (skipEnvelope) {
      return next.handle();
    }

    return next.handle().pipe(
      map((payload: unknown): SuccessEnvelope<unknown> => {
        if (isPaginatedResult(payload)) {
          return {
            success: true,
            data: payload.data,
            meta: payload.meta,
          };
        }

        return {
          success: true,
          data: payload,
        };
      }),
    );
  }
}
