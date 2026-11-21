import { HttpException } from '@nestjs/common';
import { DETAILS_ALLOWED_ERROR_CODES, ERROR_STATUS_MAP, ErrorCode } from './error-codes';

export interface ErrorDetail {
  field: string;
  code: string;
  message: string;
}

export interface AppExceptionOptions {
  field?: string;
  details?: ErrorDetail[];
}

export interface ErrorEnvelopeBody {
  success: false;
  error: {
    code: ErrorCode;
    message: string;
    field?: string;
    details?: ErrorDetail[];
  };
}

export class AppException extends HttpException {
  public readonly code: ErrorCode;
  public readonly errorMessage: string;
  public readonly field?: string;
  public readonly details?: ErrorDetail[];

  constructor(code: ErrorCode, message: string, options?: AppExceptionOptions) {
    const status = ERROR_STATUS_MAP[code];
    const errorPayload: ErrorEnvelopeBody['error'] = { code, message };

    if (options?.field) {
      errorPayload.field = options.field;
    }

    if (options?.details && options.details.length > 0 && DETAILS_ALLOWED_ERROR_CODES.has(code)) {
      errorPayload.details = options.details;
    }

    super({ success: false, error: errorPayload } satisfies ErrorEnvelopeBody, status);

    this.message = message;
    this.code = code;
    this.errorMessage = message;
    this.field = errorPayload.field;
    this.details = errorPayload.details;
  }

  toEnvelope(): ErrorEnvelopeBody {
    const error: ErrorEnvelopeBody['error'] = {
      code: this.code,
      message: this.errorMessage,
    };
    if (this.field) {
      error.field = this.field;
    }
    if (this.details && this.details.length > 0) {
      error.details = this.details;
    }
    return { success: false, error };
  }
}
