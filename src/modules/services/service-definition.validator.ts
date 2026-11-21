import { AppException, ErrorDetail } from '../../common/errors/app-exception';
import { parseDateOnlyUtc } from '../../common/utils/dates';
import { checkRegexSafety } from './regex-safety';
import {
  ALLOWED_DOCUMENT_MIME_TYPES,
  AllowedDocumentMimeType,
  FORM_FIELD_TYPES,
  FormFieldDefinition,
  FormFieldOption,
  FormFieldType,
  FormFieldValidation,
  LocalizedText,
  RequiredDocumentDefinition,
  SERVICE_CATEGORIES,
  ServiceCategory,
  ServiceDefinition,
} from './service-definition.types';

const SERVICE_SLUG_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const CAMEL_KEY_REGEX = /^[a-z][a-zA-Z0-9]{0,39}$/;
const MAX_FEE_AMOUNT = 10_000_000;
const MAX_DOCUMENT_SIZE_BYTES = 10_485_760;

const ALLOWED_DEFINITION_KEYS = new Set([
  'name',
  'description',
  'category',
  'fee',
  'slaDays',
  'validityYears',
  'requiredDocuments',
  'formSchema',
]);
const ALLOWED_CREATE_KEYS = new Set(['id', ...ALLOWED_DEFINITION_KEYS]);
const ALLOWED_LOCALIZED_KEYS = new Set(['ar', 'en']);
const ALLOWED_MONEY_KEYS = new Set(['amount', 'currency']);
const ALLOWED_REQ_DOC_KEYS = new Set([
  'key',
  'label',
  'required',
  'allowedMimeTypes',
  'maxSizeBytes',
]);
const ALLOWED_FORM_SCHEMA_KEYS = new Set(['fields']);
const ALLOWED_FORM_FIELD_KEYS = new Set([
  'key',
  'label',
  'helpText',
  'type',
  'required',
  'options',
  'validation',
]);
const ALLOWED_OPTION_KEYS = new Set(['value', 'label']);
const ALLOWED_VALIDATION_KEYS = new Set([
  'minLength',
  'maxLength',
  'min',
  'max',
  'minDate',
  'maxDate',
  'pattern',
]);

const ALLOWED_CATEGORY_SET = new Set<string>(SERVICE_CATEGORIES);
const ALLOWED_MIME_SET = new Set<string>(ALLOWED_DOCUMENT_MIME_TYPES);
const ALLOWED_FIELD_TYPE_SET = new Set<string>(FORM_FIELD_TYPES);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertAllowedKeys(
  obj: Record<string, unknown>,
  allowedKeys: Set<string>,
  prefix = '',
): void {
  for (const key of Object.keys(obj)) {
    if (!allowedKeys.has(key)) {
      const fullPath = prefix ? `${prefix}.${key}` : key;
      throw new AppException('UNKNOWN_FIELD', `Unknown field "${fullPath}".`, {
        field: fullPath,
      });
    }
  }
}

function validateLocalized(
  raw: unknown,
  path: string,
  maxLength: number,
  details: ErrorDetail[],
): LocalizedText | null {
  if (!isPlainObject(raw)) {
    details.push({
      field: path,
      code: 'INVALID_VALUE',
      message: `${path} must be a Localized object ({ ar, en }).`,
    });
    return null;
  }

  assertAllowedKeys(raw, ALLOWED_LOCALIZED_KEYS, path);

  const ar = typeof raw.ar === 'string' ? raw.ar.trim() : '';
  const en = typeof raw.en === 'string' ? raw.en.trim() : '';
  let ok = true;

  if (!ar) {
    details.push({ field: `${path}.ar`, code: 'REQUIRED', message: `${path}.ar is required.` });
    ok = false;
  } else if (ar.length > maxLength) {
    details.push({
      field: `${path}.ar`,
      code: 'TOO_LONG',
      message: `${path}.ar must be at most ${maxLength} characters.`,
    });
    ok = false;
  }

  if (!en) {
    details.push({ field: `${path}.en`, code: 'REQUIRED', message: `${path}.en is required.` });
    ok = false;
  } else if (en.length > maxLength) {
    details.push({
      field: `${path}.en`,
      code: 'TOO_LONG',
      message: `${path}.en must be at most ${maxLength} characters.`,
    });
    ok = false;
  }

  return ok ? { ar, en } : null;
}

function validateRequiredDocuments(
  raw: unknown,
  schemaDetails: ErrorDetail[],
): RequiredDocumentDefinition[] {
  if (!Array.isArray(raw)) {
    schemaDetails.push({
      field: 'requiredDocuments',
      code: 'INVALID_VALUE',
      message: 'requiredDocuments must be an array.',
    });
    return [];
  }

  if (raw.length > 10) {
    schemaDetails.push({
      field: 'requiredDocuments',
      code: 'OUT_OF_RANGE',
      message: 'requiredDocuments may contain at most 10 items.',
    });
    return [];
  }

  const seenKeys = new Set<string>();
  const canonical: RequiredDocumentDefinition[] = [];

  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    const basePath = `requiredDocuments[${i}]`;

    if (!isPlainObject(item)) {
      schemaDetails.push({
        field: basePath,
        code: 'INVALID_VALUE',
        message: `${basePath} must be an object.`,
      });
      continue;
    }

    assertAllowedKeys(item, ALLOWED_REQ_DOC_KEYS, basePath);

    const key = typeof item.key === 'string' ? item.key.trim() : '';
    if (!key) {
      schemaDetails.push({
        field: `${basePath}.key`,
        code: 'REQUIRED',
        message: `${basePath}.key is required.`,
      });
    } else if (!CAMEL_KEY_REGEX.test(key)) {
      schemaDetails.push({
        field: `${basePath}.key`,
        code: 'INVALID_FORMAT',
        message: `${basePath}.key must be camelCase (1-40 chars, starting with a lowercase letter).`,
      });
    } else if (seenKeys.has(key)) {
      schemaDetails.push({
        field: `${basePath}.key`,
        code: 'INVALID_VALUE',
        message: `Duplicate document key "${key}".`,
      });
    } else {
      seenKeys.add(key);
    }

    const label = validateLocalized(item.label, `${basePath}.label`, 200, schemaDetails);

    if (typeof item.required !== 'boolean') {
      schemaDetails.push({
        field: `${basePath}.required`,
        code: 'INVALID_VALUE',
        message: `${basePath}.required must be a boolean.`,
      });
    }

    const validMimes: AllowedDocumentMimeType[] = [];
    if (!Array.isArray(item.allowedMimeTypes) || item.allowedMimeTypes.length === 0) {
      schemaDetails.push({
        field: `${basePath}.allowedMimeTypes`,
        code: 'INVALID_VALUE',
        message: `${basePath}.allowedMimeTypes must be a non-empty array.`,
      });
    } else {
      const seenMimes = new Set<string>();
      for (const mime of item.allowedMimeTypes) {
        const trimmedMime = typeof mime === 'string' ? mime.trim() : '';
        if (!ALLOWED_MIME_SET.has(trimmedMime)) {
          schemaDetails.push({
            field: `${basePath}.allowedMimeTypes`,
            code: 'INVALID_VALUE',
            message: `${basePath}.allowedMimeTypes contains unsupported MIME type.`,
          });
          break;
        }
        if (!seenMimes.has(trimmedMime)) {
          seenMimes.add(trimmedMime);
          validMimes.push(trimmedMime as AllowedDocumentMimeType);
        }
      }
    }

    const maxSizeBytes = item.maxSizeBytes;
    if (
      typeof maxSizeBytes !== 'number' ||
      !Number.isInteger(maxSizeBytes) ||
      maxSizeBytes < 1 ||
      maxSizeBytes > MAX_DOCUMENT_SIZE_BYTES
    ) {
      schemaDetails.push({
        field: `${basePath}.maxSizeBytes`,
        code: 'OUT_OF_RANGE',
        message: `${basePath}.maxSizeBytes must be an integer between 1 and ${MAX_DOCUMENT_SIZE_BYTES}.`,
      });
    }

    if (
      key &&
      label &&
      typeof item.required === 'boolean' &&
      validMimes.length > 0 &&
      typeof maxSizeBytes === 'number' &&
      Number.isInteger(maxSizeBytes)
    ) {
      canonical.push({
        key,
        label,
        required: item.required,
        allowedMimeTypes: validMimes,
        maxSizeBytes,
      });
    }
  }

  return canonical;
}

function validateFieldValidation(
  rawValidation: unknown,
  fieldType: FormFieldType,
  basePath: string,
  schemaDetails: ErrorDetail[],
): FormFieldValidation {
  if (rawValidation === undefined) {
    return {};
  }

  if (!isPlainObject(rawValidation)) {
    schemaDetails.push({
      field: `${basePath}.validation`,
      code: 'INVALID_VALUE',
      message: `${basePath}.validation must be an object.`,
    });
    return {};
  }

  assertAllowedKeys(rawValidation, ALLOWED_VALIDATION_KEYS, `${basePath}.validation`);

  const canonical: FormFieldValidation = {};
  const allowsLength = fieldType === 'TEXT' || fieldType === 'TEXTAREA';
  const allowsMinMax = fieldType === 'NUMBER';
  const allowsDates = fieldType === 'DATE';
  const allowsPattern = fieldType === 'TEXT';

  if ('minLength' in rawValidation) {
    if (!allowsLength) {
      schemaDetails.push({
        field: `${basePath}.validation.minLength`,
        code: 'INVALID_VALUE',
        message: `minLength is only allowed for TEXT and TEXTAREA fields.`,
      });
    } else if (
      typeof rawValidation.minLength !== 'number' ||
      !Number.isInteger(rawValidation.minLength) ||
      rawValidation.minLength < 0 ||
      rawValidation.minLength > 2000
    ) {
      schemaDetails.push({
        field: `${basePath}.validation.minLength`,
        code: 'OUT_OF_RANGE',
        message: `minLength must be an integer between 0 and 2000.`,
      });
    } else {
      canonical.minLength = rawValidation.minLength;
    }
  }

  if ('maxLength' in rawValidation) {
    if (!allowsLength) {
      schemaDetails.push({
        field: `${basePath}.validation.maxLength`,
        code: 'INVALID_VALUE',
        message: `maxLength is only allowed for TEXT and TEXTAREA fields.`,
      });
    } else if (
      typeof rawValidation.maxLength !== 'number' ||
      !Number.isInteger(rawValidation.maxLength) ||
      rawValidation.maxLength < 0 ||
      rawValidation.maxLength > 2000
    ) {
      schemaDetails.push({
        field: `${basePath}.validation.maxLength`,
        code: 'OUT_OF_RANGE',
        message: `maxLength must be an integer between 0 and 2000.`,
      });
    } else {
      canonical.maxLength = rawValidation.maxLength;
    }
  }

  if (
    canonical.minLength !== undefined &&
    canonical.maxLength !== undefined &&
    canonical.minLength > canonical.maxLength
  ) {
    schemaDetails.push({
      field: `${basePath}.validation.minLength`,
      code: 'OUT_OF_RANGE',
      message: `minLength must be less than or equal to maxLength.`,
    });
  }

  if ('min' in rawValidation) {
    if (!allowsMinMax) {
      schemaDetails.push({
        field: `${basePath}.validation.min`,
        code: 'INVALID_VALUE',
        message: `min is only allowed for NUMBER fields.`,
      });
    } else if (typeof rawValidation.min !== 'number' || !Number.isFinite(rawValidation.min)) {
      schemaDetails.push({
        field: `${basePath}.validation.min`,
        code: 'INVALID_VALUE',
        message: `min must be a finite number.`,
      });
    } else {
      canonical.min = rawValidation.min;
    }
  }

  if ('max' in rawValidation) {
    if (!allowsMinMax) {
      schemaDetails.push({
        field: `${basePath}.validation.max`,
        code: 'INVALID_VALUE',
        message: `max is only allowed for NUMBER fields.`,
      });
    } else if (typeof rawValidation.max !== 'number' || !Number.isFinite(rawValidation.max)) {
      schemaDetails.push({
        field: `${basePath}.validation.max`,
        code: 'INVALID_VALUE',
        message: `max must be a finite number.`,
      });
    } else {
      canonical.max = rawValidation.max;
    }
  }

  if (canonical.min !== undefined && canonical.max !== undefined && canonical.min > canonical.max) {
    schemaDetails.push({
      field: `${basePath}.validation.min`,
      code: 'OUT_OF_RANGE',
      message: `min must be less than or equal to max.`,
    });
  }

  if ('minDate' in rawValidation) {
    if (!allowsDates) {
      schemaDetails.push({
        field: `${basePath}.validation.minDate`,
        code: 'INVALID_VALUE',
        message: `minDate is only allowed for DATE fields.`,
      });
    } else if (
      typeof rawValidation.minDate !== 'string' ||
      !parseDateOnlyUtc(rawValidation.minDate.trim())
    ) {
      schemaDetails.push({
        field: `${basePath}.validation.minDate`,
        code: 'INVALID_FORMAT',
        message: `minDate must be a valid YYYY-MM-DD date.`,
      });
    } else {
      canonical.minDate = rawValidation.minDate.trim();
    }
  }

  if ('maxDate' in rawValidation) {
    if (!allowsDates) {
      schemaDetails.push({
        field: `${basePath}.validation.maxDate`,
        code: 'INVALID_VALUE',
        message: `maxDate is only allowed for DATE fields.`,
      });
    } else if (
      typeof rawValidation.maxDate !== 'string' ||
      !parseDateOnlyUtc(rawValidation.maxDate.trim())
    ) {
      schemaDetails.push({
        field: `${basePath}.validation.maxDate`,
        code: 'INVALID_FORMAT',
        message: `maxDate must be a valid YYYY-MM-DD date.`,
      });
    } else {
      canonical.maxDate = rawValidation.maxDate.trim();
    }
  }

  if (
    canonical.minDate !== undefined &&
    canonical.maxDate !== undefined &&
    canonical.minDate > canonical.maxDate
  ) {
    schemaDetails.push({
      field: `${basePath}.validation.minDate`,
      code: 'OUT_OF_RANGE',
      message: `minDate must be less than or equal to maxDate.`,
    });
  }

  if ('pattern' in rawValidation) {
    if (!allowsPattern) {
      schemaDetails.push({
        field: `${basePath}.validation.pattern`,
        code: 'INVALID_VALUE',
        message: `pattern is only allowed for TEXT fields.`,
      });
    } else if (typeof rawValidation.pattern !== 'string') {
      schemaDetails.push({
        field: `${basePath}.validation.pattern`,
        code: 'INVALID_VALUE',
        message: `pattern must be a string.`,
      });
    } else {
      const safety = checkRegexSafety(rawValidation.pattern);
      if (!safety.safe) {
        schemaDetails.push({
          field: `${basePath}.validation.pattern`,
          code: 'INVALID_FORMAT',
          message: safety.reason ?? 'pattern failed safety validation.',
        });
      } else {
        canonical.pattern = rawValidation.pattern;
      }
    }
  }

  return canonical;
}

function validateFormSchema(raw: unknown, schemaDetails: ErrorDetail[]): FormFieldDefinition[] {
  if (!isPlainObject(raw)) {
    schemaDetails.push({
      field: 'formSchema',
      code: 'INVALID_VALUE',
      message: 'formSchema must be an object with a fields array.',
    });
    return [];
  }

  assertAllowedKeys(raw, ALLOWED_FORM_SCHEMA_KEYS, 'formSchema');

  if (!Array.isArray(raw.fields)) {
    schemaDetails.push({
      field: 'formSchema.fields',
      code: 'INVALID_VALUE',
      message: 'formSchema.fields must be an array.',
    });
    return [];
  }

  if (raw.fields.length > 30) {
    schemaDetails.push({
      field: 'formSchema.fields',
      code: 'OUT_OF_RANGE',
      message: 'formSchema.fields may contain at most 30 fields.',
    });
    return [];
  }

  const seenKeys = new Set<string>();
  const canonicalFields: FormFieldDefinition[] = [];

  for (let i = 0; i < raw.fields.length; i += 1) {
    const field = raw.fields[i];
    const basePath = `formSchema.fields[${i}]`;

    if (!isPlainObject(field)) {
      schemaDetails.push({
        field: basePath,
        code: 'INVALID_VALUE',
        message: `${basePath} must be an object.`,
      });
      continue;
    }

    assertAllowedKeys(field, ALLOWED_FORM_FIELD_KEYS, basePath);

    const key = typeof field.key === 'string' ? field.key.trim() : '';
    if (!key) {
      schemaDetails.push({
        field: `${basePath}.key`,
        code: 'REQUIRED',
        message: `${basePath}.key is required.`,
      });
    } else if (!CAMEL_KEY_REGEX.test(key)) {
      schemaDetails.push({
        field: `${basePath}.key`,
        code: 'INVALID_FORMAT',
        message: `${basePath}.key must match ^[a-z][a-zA-Z0-9]{0,39}$.`,
      });
    } else if (seenKeys.has(key)) {
      schemaDetails.push({
        field: `${basePath}.key`,
        code: 'INVALID_VALUE',
        message: `Duplicate form field key "${key}".`,
      });
    } else {
      seenKeys.add(key);
    }

    const label = validateLocalized(field.label, `${basePath}.label`, 200, schemaDetails);

    let helpText: LocalizedText | null = null;
    if (field.helpText !== null && field.helpText !== undefined) {
      helpText = validateLocalized(field.helpText, `${basePath}.helpText`, 200, schemaDetails);
    }

    const rawType = typeof field.type === 'string' ? field.type.trim() : '';
    const validType = ALLOWED_FIELD_TYPE_SET.has(rawType) ? (rawType as FormFieldType) : null;
    if (!validType) {
      schemaDetails.push({
        field: `${basePath}.type`,
        code: 'INVALID_VALUE',
        message: `${basePath}.type must be one of ${FORM_FIELD_TYPES.join(', ')}.`,
      });
    }

    if (typeof field.required !== 'boolean') {
      schemaDetails.push({
        field: `${basePath}.required`,
        code: 'INVALID_VALUE',
        message: `${basePath}.required must be a boolean.`,
      });
    }

    let options: FormFieldOption[] | null = null;
    if (validType === 'SELECT') {
      if (!Array.isArray(field.options) || field.options.length < 2 || field.options.length > 50) {
        schemaDetails.push({
          field: `${basePath}.options`,
          code: 'OUT_OF_RANGE',
          message: `${basePath}.options must contain between 2 and 50 items for SELECT fields.`,
        });
      } else {
        const seenValues = new Set<string>();
        const parsedOptions: FormFieldOption[] = [];
        for (let j = 0; j < field.options.length; j += 1) {
          const opt = field.options[j];
          const optPath = `${basePath}.options[${j}]`;
          if (!isPlainObject(opt)) {
            schemaDetails.push({
              field: optPath,
              code: 'INVALID_VALUE',
              message: `${optPath} must be an object.`,
            });
            continue;
          }
          assertAllowedKeys(opt, ALLOWED_OPTION_KEYS, optPath);

          const optValue = typeof opt.value === 'string' ? opt.value.trim() : '';
          if (!optValue) {
            schemaDetails.push({
              field: `${optPath}.value`,
              code: 'REQUIRED',
              message: `${optPath}.value is required.`,
            });
          } else if (optValue.length > 100) {
            schemaDetails.push({
              field: `${optPath}.value`,
              code: 'TOO_LONG',
              message: `${optPath}.value must be at most 100 characters.`,
            });
          } else if (seenValues.has(optValue)) {
            schemaDetails.push({
              field: `${optPath}.value`,
              code: 'INVALID_VALUE',
              message: `Duplicate option value "${optValue}".`,
            });
          } else {
            seenValues.add(optValue);
          }

          const optLabel = validateLocalized(opt.label, `${optPath}.label`, 200, schemaDetails);
          if (optValue && optLabel) {
            parsedOptions.push({ value: optValue, label: optLabel });
          }
        }
        options = parsedOptions;
      }
    } else if (validType !== null) {
      if (field.options !== null && field.options !== undefined) {
        schemaDetails.push({
          field: `${basePath}.options`,
          code: 'INVALID_VALUE',
          message: `${basePath}.options must be null for ${validType} fields.`,
        });
      }
      options = null;
    }

    const validation = validType
      ? validateFieldValidation(field.validation, validType, basePath, schemaDetails)
      : {};

    if (key && label && validType && typeof field.required === 'boolean') {
      canonicalFields.push({
        key,
        label,
        helpText,
        type: validType,
        required: field.required,
        options,
        validation,
      });
    }
  }

  return canonicalFields;
}

export function validateServiceDefinition(raw: Record<string, unknown>): ServiceDefinition {
  const scalarDetails: ErrorDetail[] = [];
  const schemaDetails: ErrorDetail[] = [];

  const name = validateLocalized(raw.name, 'name', 100, scalarDetails);
  const description = validateLocalized(raw.description, 'description', 500, scalarDetails);

  const rawCategory = typeof raw.category === 'string' ? raw.category.trim() : '';
  const category = ALLOWED_CATEGORY_SET.has(rawCategory) ? (rawCategory as ServiceCategory) : null;
  if (!category) {
    scalarDetails.push({
      field: 'category',
      code: 'INVALID_VALUE',
      message: `category must be one of ${SERVICE_CATEGORIES.join(', ')}.`,
    });
  }

  let feeAmount: number | null = null;
  if (!isPlainObject(raw.fee)) {
    scalarDetails.push({
      field: 'fee',
      code: 'INVALID_VALUE',
      message: 'fee must be a Money object ({ amount, currency: "EGP" }).',
    });
  } else {
    assertAllowedKeys(raw.fee, ALLOWED_MONEY_KEYS, 'fee');
    if (
      typeof raw.fee.amount !== 'number' ||
      !Number.isInteger(raw.fee.amount) ||
      raw.fee.amount < 0 ||
      raw.fee.amount > MAX_FEE_AMOUNT
    ) {
      scalarDetails.push({
        field: 'fee.amount',
        code: 'OUT_OF_RANGE',
        message: `fee.amount must be an integer between 0 and ${MAX_FEE_AMOUNT}.`,
      });
    } else {
      feeAmount = raw.fee.amount;
    }
    if (raw.fee.currency !== 'EGP') {
      scalarDetails.push({
        field: 'fee.currency',
        code: 'INVALID_VALUE',
        message: 'fee.currency must be "EGP".',
      });
    }
  }

  let slaDays: number | null = null;
  if (
    typeof raw.slaDays !== 'number' ||
    !Number.isInteger(raw.slaDays) ||
    raw.slaDays < 1 ||
    raw.slaDays > 90
  ) {
    scalarDetails.push({
      field: 'slaDays',
      code: 'OUT_OF_RANGE',
      message: 'slaDays must be an integer between 1 and 90.',
    });
  } else {
    slaDays = raw.slaDays;
  }

  let validityYears: number | null = null;
  if (raw.validityYears === null) {
    validityYears = null;
  } else if (
    typeof raw.validityYears !== 'number' ||
    !Number.isInteger(raw.validityYears) ||
    raw.validityYears < 1 ||
    raw.validityYears > 30
  ) {
    scalarDetails.push({
      field: 'validityYears',
      code: 'OUT_OF_RANGE',
      message: 'validityYears must be null or an integer between 1 and 30.',
    });
  } else {
    validityYears = raw.validityYears;
  }

  const requiredDocuments = validateRequiredDocuments(raw.requiredDocuments, schemaDetails);
  const fields = validateFormSchema(raw.formSchema, schemaDetails);

  if (schemaDetails.length > 0) {
    throw new AppException('INVALID_FORM_SCHEMA', schemaDetails[0].message, {
      field: schemaDetails[0].field,
      details: schemaDetails,
    });
  }

  if (scalarDetails.length > 0) {
    throw new AppException('VALIDATION_ERROR', scalarDetails[0].message, {
      field: scalarDetails[0].field,
      details: scalarDetails,
    });
  }

  return {
    name: name!,
    description: description!,
    category: category!,
    fee: { amount: feeAmount!, currency: 'EGP' },
    slaDays: slaDays!,
    validityYears,
    requiredDocuments,
    formSchema: { fields },
  };
}

export function validateCreateServicePayload(rawBody: unknown): {
  id: string;
  definition: ServiceDefinition;
} {
  if (!isPlainObject(rawBody)) {
    throw new AppException('VALIDATION_ERROR', 'Request body must be a JSON object.');
  }

  assertAllowedKeys(rawBody, ALLOWED_CREATE_KEYS);

  const rawId = typeof rawBody.id === 'string' ? rawBody.id.trim() : '';
  if (!rawId) {
    throw new AppException('VALIDATION_ERROR', 'id is required.', {
      field: 'id',
      details: [{ field: 'id', code: 'REQUIRED', message: 'id is required.' }],
    });
  }

  if (rawId.length < 3 || rawId.length > 60 || !SERVICE_SLUG_REGEX.test(rawId)) {
    throw new AppException(
      'VALIDATION_ERROR',
      'id must be a lowercase slug of 3-60 characters (letters, digits, hyphens).',
      {
        field: 'id',
        details: [
          {
            field: 'id',
            code: 'INVALID_FORMAT',
            message: 'id must be a lowercase slug of 3-60 characters (letters, digits, hyphens).',
          },
        ],
      },
    );
  }

  const definition = validateServiceDefinition(rawBody);
  return { id: rawId, definition };
}

export function validatePatchServicePayload(
  rawBody: unknown,
  existingDraft: ServiceDefinition,
): {
  definition: ServiceDefinition;
  updatedFields: string[];
} {
  if (!isPlainObject(rawBody)) {
    throw new AppException('VALIDATION_ERROR', 'Request body must be a JSON object.');
  }

  assertAllowedKeys(rawBody, ALLOWED_DEFINITION_KEYS);

  const updatedFields = Object.keys(rawBody);
  if (updatedFields.length === 0) {
    throw new AppException(
      'VALIDATION_ERROR',
      'At least one service definition field must be provided.',
    );
  }

  // Wholesale replacement of any provided top-level key (Contract §8.5)
  const merged: Record<string, unknown> = {
    ...existingDraft,
    ...rawBody,
  };

  const definition = validateServiceDefinition(merged);
  return { definition, updatedFields };
}
