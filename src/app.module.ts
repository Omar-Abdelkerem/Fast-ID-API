import { randomUUID } from 'crypto';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { IncomingMessage } from 'http';
import { LoggerModule } from 'nestjs-pino';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { OriginGuard } from './common/guards/origin.guard';
import { CacheControlInterceptor } from './common/interceptors/cache-control.interceptor';
import { ResponseEnvelopeInterceptor } from './common/interceptors/response-envelope.interceptor';
import { RequestWithId } from './common/middleware/request-id.middleware';
import { validateEnv } from './config/env.schema';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const logLevel = configService.get<string>('LOG_LEVEL', 'info');
        return {
          pinoHttp: {
            level: logLevel,
            genReqId: (req: IncomingMessage) => (req as RequestWithId).requestId ?? randomUUID(),
            customProps: (req: IncomingMessage) => ({
              requestId: (req as RequestWithId).requestId,
            }),
            redact: {
              paths: [
                'req.headers.cookie',
                'req.headers.authorization',
                'res.headers["set-cookie"]',
                '*.password',
                '*.currentPassword',
                '*.newPassword',
                '*.temporaryPassword',
                '*.token',
                '*.nationalId',
                '*.deliveryCode',
                '*.email',
                '*.phone',
              ],
              censor: '[REDACTED]',
            },
            serializers: {
              req(req: IncomingMessage & { method?: string; url?: string }) {
                return {
                  method: req.method,
                  path: (req.url ?? '').split('?')[0],
                };
              },
              res(res: { statusCode?: number }) {
                return {
                  statusCode: res.statusCode,
                };
              },
            },
          },
        };
      },
    }),
    DatabaseModule,
    HealthModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: OriginGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: ResponseEnvelopeInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: CacheControlInterceptor,
    },
    {
      provide: APP_FILTER,
      useClass: AllExceptionsFilter,
    },
  ],
})
export class AppModule {}
