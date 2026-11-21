import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Response } from 'express';
import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';
import { RequestWithId } from '../middleware/request-id.middleware';

interface BodyParserLikeError {
  type?: string;
  status?: number;
  statusCode?: number;
  message?: string;
}

const PRISMA_UNIQUE_CONSTRAINT_MAP: Record<string, { code: ErrorCode; message: string }> = {
  users_email_unique: {
    code: 'EMAIL_ALREADY_REGISTERED',
    message: 'An account with this email already exists.',
  },
  users_national_id_unique: {
    code: 'NATIONAL_ID_ALREADY_REGISTERED',
    message: 'An account with this national ID already exists.',
  },
  applications_one_active_per_service: {
    code: 'ACTIVE_APPLICATION_EXISTS',
    message: 'An active application already exists for this service.',
  },
  services_pkey: {
    code: 'SERVICE_ALREADY_EXISTS',
    message: 'A service with this ID already exists.',
  },
};

function extractConstraintName(error: Prisma.PrismaClientKnownRequestError): string | undefined {
  const target = error.meta?.target;
  const modelName = typeof error.meta?.modelName === 'string' ? error.meta.modelName : undefined;

  if (typeof target === 'string') {
    return target;
  }

  if (Array.isArray(target)) {
    const columns = target.map((col) => String(col));
    if (columns.includes('email')) {
      return 'users_email_unique';
    }
    if (columns.includes('national_id')) {
      return 'users_national_id_unique';
    }
    if (columns.includes('citizen_id') && columns.includes('service_id')) {
      return 'applications_one_active_per_service';
    }
    if (modelName === 'services' && columns.includes('id')) {
      return 'services_pkey';
    }
  }

  const messageMatch = /constraint\s+`?"?([a-z0-9_]+)`?"?/i.exec(error.message);
  return messageMatch?.[1];
}

function mapBodyParserError(exception: unknown): AppException | null {
  if (typeof exception !== 'object' || exception === null) {
    return null;
  }

  const err = exception as BodyParserLikeError;
  if (err.type === 'entity.too.large' || err.status === 413 || err.statusCode === 413) {
    return new AppException('PAYLOAD_TOO_LARGE', 'Request payload exceeds the 100 KB limit.');
  }

  if (err.type === 'entity.parse.failed') {
    return new AppException('VALIDATION_ERROR', 'Malformed JSON request body.');
  }

  return null;
}

function mapPrismaError(exception: unknown): AppException | null {
  if (exception instanceof Prisma.PrismaClientKnownRequestError && exception.code === 'P2002') {
    const constraint = extractConstraintName(exception);
    if (constraint && PRISMA_UNIQUE_CONSTRAINT_MAP[constraint]) {
      const mapped = PRISMA_UNIQUE_CONSTRAINT_MAP[constraint];
      return new AppException(mapped.code, mapped.message);
    }
  }
  return null;
}

function mapHttpException(exception: HttpException): AppException | null {
  const status = exception.getStatus();
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return new AppException('VALIDATION_ERROR', 'Invalid request.');
    case HttpStatus.UNAUTHORIZED:
      return new AppException('UNAUTHENTICATED', 'Authentication is required.');
    case HttpStatus.FORBIDDEN:
      return new AppException('FORBIDDEN', 'You do not have permission to perform this action.');
    case HttpStatus.PAYLOAD_TOO_LARGE:
      return new AppException('PAYLOAD_TOO_LARGE', 'Request payload exceeds the 100 KB limit.');
    case HttpStatus.UNSUPPORTED_MEDIA_TYPE:
      return new AppException('UNSUPPORTED_MEDIA_TYPE', 'Unsupported Content-Type.');
    case HttpStatus.TOO_MANY_REQUESTS:
      return new AppException('RATE_LIMITED', 'Too many requests. Please try again later.');
    case HttpStatus.SERVICE_UNAVAILABLE:
      return new AppException('SERVICE_UNAVAILABLE', 'Service is temporarily unavailable.');
    default:
      return null;
  }
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<RequestWithId>();
    const res = ctx.getResponse<Response>();

    res.setHeader('Cache-Control', 'no-store');
    res.vary('Origin');

    if (exception instanceof AppException) {
      res.status(exception.getStatus()).json(exception.toEnvelope());
      return;
    }

    const prismaMapped = mapPrismaError(exception);
    if (prismaMapped) {
      res.status(prismaMapped.getStatus()).json(prismaMapped.toEnvelope());
      return;
    }

    const bodyParserMapped = mapBodyParserError(exception);
    if (bodyParserMapped) {
      res.status(bodyParserMapped.getStatus()).json(bodyParserMapped.toEnvelope());
      return;
    }

    if (exception instanceof HttpException) {
      const httpMapped = mapHttpException(exception);
      if (httpMapped) {
        res.status(httpMapped.getStatus()).json(httpMapped.toEnvelope());
        return;
      }
    }

    // Unexpected failure: log with requestId, never leak internals to client.
    this.logger.error(
      {
        requestId: req?.requestId,
        method: req?.method,
        path: req?.originalUrl,
        err: exception instanceof Error ? exception.message : 'Unknown error',
      },
      exception instanceof Error ? exception.stack : undefined,
    );

    const internalError = new AppException('INTERNAL_ERROR', 'An unexpected error occurred.');
    res.status(internalError.getStatus()).json(internalError.toEnvelope());
  }
}
