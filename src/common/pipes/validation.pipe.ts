import { ValidationError, ValidationPipe } from '@nestjs/common';
import { AppException, ErrorDetail } from '../errors/app-exception';

function mapConstraintToCode(constraintName: string): string {
  switch (constraintName) {
    case 'isDefined':
    case 'isNotEmpty':
    case 'isNotEmptyObject':
      return 'REQUIRED';
    case 'minLength':
      return 'TOO_SHORT';
    case 'maxLength':
      return 'TOO_LONG';
    case 'min':
    case 'max':
      return 'OUT_OF_RANGE';
    case 'matches':
    case 'isEmail':
    case 'isUUID':
    case 'isDateString':
    case 'isISO8601':
    case 'isUrl':
      return 'INVALID_FORMAT';
    default:
      return 'INVALID_VALUE';
  }
}

function buildFieldPath(parentPath: string, property: string): string {
  if (!parentPath) {
    return property;
  }
  if (/^\d+$/.test(property)) {
    return `${parentPath}[${property}]`;
  }
  return `${parentPath}.${property}`;
}

interface FlattenedValidationResult {
  unknownField?: string;
  details: ErrorDetail[];
}

function collectValidationErrors(
  errors: ValidationError[],
  parentPath = '',
  acc: FlattenedValidationResult = { details: [] },
): FlattenedValidationResult {
  for (const error of errors) {
    const currentPath = buildFieldPath(parentPath, error.property);

    if (error.constraints) {
      if ('whitelistValidation' in error.constraints) {
        if (!acc.unknownField) {
          acc.unknownField = currentPath;
        }
      } else {
        for (const [constraintName, message] of Object.entries(error.constraints)) {
          acc.details.push({
            field: currentPath,
            code: mapConstraintToCode(constraintName),
            message,
          });
        }
      }
    }

    if (error.children && error.children.length > 0) {
      collectValidationErrors(error.children, currentPath, acc);
    }
  }

  return acc;
}

export function validationExceptionFactory(errors: ValidationError[]): AppException {
  const flattened = collectValidationErrors(errors);

  if (flattened.unknownField) {
    return new AppException('UNKNOWN_FIELD', `Unknown field "${flattened.unknownField}".`, {
      field: flattened.unknownField,
    });
  }

  const first = flattened.details[0];
  if (!first) {
    return new AppException('VALIDATION_ERROR', 'Request validation failed.');
  }

  return new AppException('VALIDATION_ERROR', first.message, {
    field: first.field,
    details: flattened.details,
  });
}

export function createGlobalValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    stopAtFirstError: false,
    exceptionFactory: validationExceptionFactory,
  });
}
