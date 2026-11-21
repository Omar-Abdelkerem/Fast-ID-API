import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import express, { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppException } from './common/errors/app-exception';
import { requestIdMiddleware } from './common/middleware/request-id.middleware';
import { writeContentTypeMiddleware } from './common/middleware/write-content-type.middleware';
import { createGlobalValidationPipe } from './common/pipes/validation.pipe';

interface BodyParserError {
  type?: string;
  status?: number;
  statusCode?: number;
}

function bodyParserErrorMiddleware(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!err || typeof err !== 'object') {
    next(err);
    return;
  }

  const parsedErr = err as BodyParserError;
  if (
    parsedErr.type === 'entity.too.large' ||
    parsedErr.status === 413 ||
    parsedErr.statusCode === 413
  ) {
    const appErr = new AppException(
      'PAYLOAD_TOO_LARGE',
      'Request payload exceeds the 100 KB limit.',
    );
    res.setHeader('Cache-Control', 'no-store');
    res.vary('Origin');
    res.status(appErr.getStatus()).json(appErr.toEnvelope());
    return;
  }

  if (parsedErr.type === 'entity.parse.failed') {
    const appErr = new AppException('VALIDATION_ERROR', 'Malformed JSON request body.');
    res.setHeader('Cache-Control', 'no-store');
    res.vary('Origin');
    res.status(appErr.getStatus()).json(appErr.toEnvelope());
    return;
  }

  next(err);
}

/**
 * Configures the NestJS + Express HTTP pipeline in the exact order specified by Design §5.
 * Shared by src/main.ts and e2e tests so production and test pipelines never diverge.
 */
export function configureApp(app: INestApplication): void {
  const configService = app.get(ConfigService);
  const nodeEnv = configService.get<string>('NODE_ENV', 'development');
  const corsOrigins = configService.get<string[]>('CORS_ORIGINS', []);
  const trustProxy = configService.get<boolean | number>('TRUST_PROXY', false);

  app.useLogger(app.get(Logger));

  const expressApp = app as NestExpressApplication;
  expressApp.set('trust proxy', trustProxy);

  // 1. Security headers (Contract §0.17) and cookies
  app.use(
    helmet({
      hsts: nodeEnv !== 'development',
      referrerPolicy: { policy: 'no-referrer' },
      noSniff: true,
    }),
  );
  app.use(cookieParser());

  // 2. Request ID (Contract §0.17: ignore client X-Request-Id)
  app.use(requestIdMiddleware);

  // 3. Strict CORS allow-list (Contract §0.14)
  app.enableCors({
    origin: corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Accept'],
    exposedHeaders: ['Retry-After', 'X-Request-Id', 'Content-Disposition'],
    maxAge: 600,
  });

  // 4. Write Content-Type enforcement (D-24) and 100 KB JSON body limit (Contract §0.2)
  app.use(writeContentTypeMiddleware);
  app.use(express.json({ limit: '100kb' }));
  app.use(bodyParserErrorMiddleware);

  // 5. Global API prefix, validation pipe, and graceful shutdown hooks (D-27)
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(createGlobalValidationPipe());
  app.enableShutdownHooks();
}
