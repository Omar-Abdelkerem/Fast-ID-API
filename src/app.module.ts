import { randomUUID } from 'crypto';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { IncomingMessage } from 'http';
import { LoggerModule } from 'nestjs-pino';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { AppThrottlerGuard } from './common/guards/app-throttler.guard';
import { AuthGuard } from './common/guards/auth.guard';
import { OriginGuard } from './common/guards/origin.guard';
import { PasswordChangeGuard } from './common/guards/password-change.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { UserRateLimitGuard } from './common/guards/user-rate-limit.guard';
import { CacheControlInterceptor } from './common/interceptors/cache-control.interceptor';
import { ResponseEnvelopeInterceptor } from './common/interceptors/response-envelope.interceptor';
import { RequestWithId } from './common/middleware/request-id.middleware';
import { BoundedThrottlerStorage } from './common/rate-limit/bounded-throttler-storage';
import { validateEnv } from './config/env.schema';
import { DatabaseModule } from './database/database.module';
import { AuditModule } from './modules/audit/audit.module';
import { ApplicationsModule } from './modules/applications/applications.module';
import { AttachmentsModule } from './modules/attachments/attachments.module';
import { AuthModule } from './modules/auth/auth.module';
import { EmailModule } from './modules/email/email.module';
import { HealthModule } from './modules/health/health.module';
import { NotificationsRegistryModule } from './modules/notifications/notifications-registry.module';
import { ReferenceModule } from './modules/reference/reference.module';
import { SeedModule } from './modules/seed/seed.module';
import { ServicesModule } from './modules/services/services.module';
import { SettingsModule } from './modules/settings/settings.module';
import { StorageModule } from './modules/storage/storage.module';

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
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.getOrThrow<string>('JWT_SECRET'),
        signOptions: {
          algorithm: 'HS256',
          expiresIn: 43_200,
        },
      }),
    }),
    ThrottlerModule.forRoot({
      throttlers: [
        {
          name: 'default',
          ttl: 60_000,
          limit: 120,
        },
      ],
      storage: new BoundedThrottlerStorage(),
    }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    StorageModule,
    AuditModule,
    EmailModule,
    NotificationsRegistryModule,
    SeedModule,
    HealthModule,
    AuthModule,
    ReferenceModule,
    SettingsModule,
    ServicesModule,
    ApplicationsModule,
    AttachmentsModule,
  ],
  providers: [
    // Guard execution order matches Design §5:
    // Origin -> IP Throttler -> Auth -> User Rate Limit -> PasswordChange -> Roles
    {
      provide: APP_GUARD,
      useClass: OriginGuard,
    },
    {
      provide: APP_GUARD,
      useClass: AppThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
    UserRateLimitGuard,
    {
      provide: APP_GUARD,
      useExisting: UserRateLimitGuard,
    },
    {
      provide: APP_GUARD,
      useClass: PasswordChangeGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
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
