import { governorate } from '@prisma/client';
import { AppException, ErrorDetail } from '../../common/errors/app-exception';
import { parseDateOnlyUtc } from '../../common/utils/dates';
import { normalizePhone } from '../../common/utils/phone';
import { GOVERNORATE_BY_CODE } from '../reference/governorates.data';
import { FormFieldDefinition, ServiceDefinition } from './service-definition.types';

export interface DeliveryAddressValue {
  governorate?: governorate;
  city?: string;
  addressLine?: string;
  phone?: string;
  notes?: string | null;
}

export type ValidationMode = 'partial' | 'full';

const ALLOWED_ADDRESS_KEYS = new Set(['governorate', 'city', 'addressLine', 'phone', 'notes']);
const REQUIRED_ADDRESS_KEYS = ['governorate', 'city', 'addressLine', 'phone'] as const;
const MAX_REGEX_INPUT_LENGTH = 2000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Merges incoming PATCH `data` into existing draft data (Contract §4.4):
 * - unknown key -> 400 UNKNOWN_FIELD (`field: "data.<key>"`)
 * - present with null -> removes key
 * - present with non-null -> replaces value
 * - omitted -> untouched
 */
export function mergeApplicationDataPatch(
  definition: ServiceDefinition,
  existingData: Record<string, unknown>,
  incomingPatch: unknown,
): Record<string, unknown> {
  if (!isPlainObject(incomingPatch)) {
    throw new AppException('VALIDATION_ERROR', 'data must be an object.', {
      field: 'data',
      details: [{ field: 'data', code: 'INVALID_VALUE', message: 'data must be an object.' }],
    });
  }

  const fieldKeys = new Set(definition.formSchema.fields.map((f) => f.key));
  for (const key of Object.keys(incomingPatch)) {
    if (!fieldKeys.has(key)) {
      throw new AppException('UNKNOWN_FIELD', `Unknown field "data.${key}".`, {
        field: `data.${key}`,
      });
    }
  }

  const merged: Record<string, unknown> = { ...existingData };
  for (const [key, value] of Object.entries(incomingPatch)) {
    if (value === null) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }

  return merged;
}

/**
 * Merges incoming PATCH `deliveryAddress` into existing draft deliveryAddress (Contract §4.4):
 * - unknown key -> 400 UNKNOWN_FIELD (`field: "deliveryAddress.<key>"`)
 * - `notes: null` clears notes to null
 * - other subfields cannot be null
 */
export function mergeDeliveryAddressPatch(
  existingAddress: DeliveryAddressValue | null,
  incomingPatch: unknown,
): DeliveryAddressValue {
  if (!isPlainObject(incomingPatch)) {
    throw new AppException('VALIDATION_ERROR', 'deliveryAddress must be an object.', {
      field: 'deliveryAddress',
      details: [
        {
          field: 'deliveryAddress',
          code: 'INVALID_VALUE',
          message: 'deliveryAddress must be an object.',
        },
      ],
    });
  }

  for (const key of Object.keys(incomingPatch)) {
    if (!ALLOWED_ADDRESS_KEYS.has(key)) {
      throw new AppException('UNKNOWN_FIELD', `Unknown field "deliveryAddress.${key}".`, {
        field: `deliveryAddress.${key}`,
      });
    }
  }

  const merged: Record<string, unknown> = existingAddress ? { ...existingAddress } : {};
  for (const [key, value] of Object.entries(incomingPatch)) {
    merged[key] = value;
  }

  return merged as DeliveryAddressValue;
}

function validateFieldValue(
  field: FormFieldDefinition,
  rawValue: unknown,
  mode: ValidationMode,
  missingDetails: ErrorDetail[],
  invalidDetails: ErrorDetail[],
): { normalized?: unknown; present: boolean } {
  const path = `data.${field.key}`;

  if (rawValue === undefined || rawValue === null) {
    if (mode === 'full' && field.required) {
      missingDetails.push({
        field: path,
        code: 'REQUIRED',
        message: `${path} is required.`,
      });
    }
    return { present: false };
  }

  switch (field.type) {
    case 'TEXT':
    case 'TEXTAREA': {
      if (typeof rawValue !== 'string') {
        invalidDetails.push({
          field: path,
          code: 'INVALID_VALUE',
          message: `${path} must be a string.`,
        });
        return { present: true };
      }

      const trimmed = rawValue.trim();
      // Contract §0.11: empty string after trimming counts as missing
      if (trimmed.length === 0) {
        if (mode === 'full' && field.required) {
          missingDetails.push({
            field: path,
            code: 'REQUIRED',
            message: `${path} is required.`,
          });
        }
        return { present: false };
      }

      if (trimmed.length > MAX_REGEX_INPUT_LENGTH) {
        invalidDetails.push({
          field: path,
          code: 'TOO_LONG',
          message: `${path} must be at most ${MAX_REGEX_INPUT_LENGTH} characters.`,
        });
        return { present: true };
      }

      if (field.validation.minLength !== undefined && trimmed.length < field.validation.minLength) {
        invalidDetails.push({
          field: path,
          code: 'TOO_SHORT',
          message: `${path} must be at least ${field.validation.minLength} characters.`,
        });
        return { present: true };
      }

      if (field.validation.maxLength !== undefined && trimmed.length > field.validation.maxLength) {
        invalidDetails.push({
          field: path,
          code: 'TOO_LONG',
          message: `${path} must be at most ${field.validation.maxLength} characters.`,
        });
        return { present: true };
      }

      if (field.type === 'TEXT' && field.validation.pattern !== undefined) {
        const regex = new RegExp(field.validation.pattern);
        if (!regex.test(trimmed)) {
          invalidDetails.push({
            field: path,
            code: 'INVALID_FORMAT',
            message: `${path} does not match the required format.`,
          });
          return { present: true };
        }
      }

      return { present: true, normalized: trimmed };
    }

    case 'NUMBER': {
      if (typeof rawValue !== 'number' || !Number.isFinite(rawValue)) {
        invalidDetails.push({
          field: path,
          code: 'INVALID_VALUE',
          message: `${path} must be a finite number.`,
        });
        return { present: true };
      }

      if (field.validation.min !== undefined && rawValue < field.validation.min) {
        invalidDetails.push({
          field: path,
          code: 'OUT_OF_RANGE',
          message: `${path} must be at least ${field.validation.min}.`,
        });
        return { present: true };
      }

      if (field.validation.max !== undefined && rawValue > field.validation.max) {
        invalidDetails.push({
          field: path,
          code: 'OUT_OF_RANGE',
          message: `${path} must be at most ${field.validation.max}.`,
        });
        return { present: true };
      }

      return { present: true, normalized: rawValue };
    }

    case 'DATE': {
      if (typeof rawValue !== 'string') {
        invalidDetails.push({
          field: path,
          code: 'INVALID_VALUE',
          message: `${path} must be a YYYY-MM-DD date string.`,
        });
        return { present: true };
      }

      const trimmed = rawValue.trim();
      if (trimmed.length === 0) {
        if (mode === 'full' && field.required) {
          missingDetails.push({
            field: path,
            code: 'REQUIRED',
            message: `${path} is required.`,
          });
        }
        return { present: false };
      }

      if (!parseDateOnlyUtc(trimmed)) {
        invalidDetails.push({
          field: path,
          code: 'INVALID_FORMAT',
          message: `${path} must be a valid calendar date (YYYY-MM-DD).`,
        });
        return { present: true };
      }

      if (field.validation.minDate !== undefined && trimmed < field.validation.minDate) {
        invalidDetails.push({
          field: path,
          code: 'OUT_OF_RANGE',
          message: `${path} must be on or after ${field.validation.minDate}.`,
        });
        return { present: true };
      }

      if (field.validation.maxDate !== undefined && trimmed > field.validation.maxDate) {
        invalidDetails.push({
          field: path,
          code: 'OUT_OF_RANGE',
          message: `${path} must be on or before ${field.validation.maxDate}.`,
        });
        return { present: true };
      }

      return { present: true, normalized: trimmed };
    }

    case 'SELECT': {
      if (typeof rawValue !== 'string') {
        invalidDetails.push({
          field: path,
          code: 'INVALID_VALUE',
          message: `${path} must be a string matching an allowed option.`,
        });
        return { present: true };
      }

      const trimmed = rawValue.trim();
      if (trimmed.length === 0) {
        if (mode === 'full' && field.required) {
          missingDetails.push({
            field: path,
            code: 'REQUIRED',
            message: `${path} is required.`,
          });
        }
        return { present: false };
      }

      const allowedValues = new Set((field.options ?? []).map((opt) => opt.value));
      if (!allowedValues.has(trimmed)) {
        invalidDetails.push({
          field: path,
          code: 'INVALID_VALUE',
          message: `${path} must be one of the allowed options.`,
        });
        return { present: true };
      }

      return { present: true, normalized: trimmed };
    }

    case 'CHECKBOX': {
      if (typeof rawValue !== 'boolean') {
        invalidDetails.push({
          field: path,
          code: 'INVALID_VALUE',
          message: `${path} must be a boolean.`,
        });
        return { present: true };
      }

      // Clarification C-3: for a CHECKBOX, required: true means value must be true.
      if (mode === 'full' && field.required && rawValue !== true) {
        missingDetails.push({
          field: path,
          code: 'REQUIRED',
          message: `${path} must be accepted.`,
        });
      }

      return { present: true, normalized: rawValue };
    }
  }
}

function validateDeliveryAddressInternal(
  rawAddress: DeliveryAddressValue | null,
  mode: ValidationMode,
  missingDetails: ErrorDetail[],
  invalidDetails: ErrorDetail[],
): DeliveryAddressValue | null {
  if (rawAddress === null) {
    if (mode === 'full') {
      for (const key of REQUIRED_ADDRESS_KEYS) {
        missingDetails.push({
          field: `deliveryAddress.${key}`,
          code: 'REQUIRED',
          message: `deliveryAddress.${key} is required.`,
        });
      }
    }
    return null;
  }

  const normalized: DeliveryAddressValue = {};

  if ('governorate' in rawAddress && rawAddress.governorate !== undefined) {
    if (rawAddress.governorate === null || typeof rawAddress.governorate !== 'string') {
      invalidDetails.push({
        field: 'deliveryAddress.governorate',
        code: 'INVALID_VALUE',
        message: 'deliveryAddress.governorate must be a valid governorate code.',
      });
    } else {
      const gov = rawAddress.governorate.trim() as governorate;
      if (gov.length === 0) {
        if (mode === 'full') {
          missingDetails.push({
            field: 'deliveryAddress.governorate',
            code: 'REQUIRED',
            message: 'deliveryAddress.governorate is required.',
          });
        } else {
          invalidDetails.push({
            field: 'deliveryAddress.governorate',
            code: 'REQUIRED',
            message: 'deliveryAddress.governorate cannot be empty.',
          });
        }
      } else if (!GOVERNORATE_BY_CODE.has(gov)) {
        invalidDetails.push({
          field: 'deliveryAddress.governorate',
          code: 'INVALID_VALUE',
          message: 'deliveryAddress.governorate must be a valid Egyptian governorate code.',
        });
      } else {
        normalized.governorate = gov;
      }
    }
  } else if (mode === 'full') {
    missingDetails.push({
      field: 'deliveryAddress.governorate',
      code: 'REQUIRED',
      message: 'deliveryAddress.governorate is required.',
    });
  }

  if ('city' in rawAddress && rawAddress.city !== undefined) {
    if (rawAddress.city === null || typeof rawAddress.city !== 'string') {
      invalidDetails.push({
        field: 'deliveryAddress.city',
        code: 'INVALID_VALUE',
        message: 'deliveryAddress.city must be a string (2-60 characters).',
      });
    } else {
      const city = rawAddress.city.trim();
      if (city.length === 0 && mode === 'full') {
        missingDetails.push({
          field: 'deliveryAddress.city',
          code: 'REQUIRED',
          message: 'deliveryAddress.city is required.',
        });
      } else if (city.length < 2) {
        invalidDetails.push({
          field: 'deliveryAddress.city',
          code: 'TOO_SHORT',
          message: 'deliveryAddress.city must be at least 2 characters.',
        });
      } else if (city.length > 60) {
        invalidDetails.push({
          field: 'deliveryAddress.city',
          code: 'TOO_LONG',
          message: 'deliveryAddress.city must be at most 60 characters.',
        });
      } else {
        normalized.city = city;
      }
    }
  } else if (mode === 'full') {
    missingDetails.push({
      field: 'deliveryAddress.city',
      code: 'REQUIRED',
      message: 'deliveryAddress.city is required.',
    });
  }

  if ('addressLine' in rawAddress && rawAddress.addressLine !== undefined) {
    if (rawAddress.addressLine === null || typeof rawAddress.addressLine !== 'string') {
      invalidDetails.push({
        field: 'deliveryAddress.addressLine',
        code: 'INVALID_VALUE',
        message: 'deliveryAddress.addressLine must be a string (5-200 characters).',
      });
    } else {
      const line = rawAddress.addressLine.trim();
      if (line.length === 0 && mode === 'full') {
        missingDetails.push({
          field: 'deliveryAddress.addressLine',
          code: 'REQUIRED',
          message: 'deliveryAddress.addressLine is required.',
        });
      } else if (line.length < 5) {
        invalidDetails.push({
          field: 'deliveryAddress.addressLine',
          code: 'TOO_SHORT',
          message: 'deliveryAddress.addressLine must be at least 5 characters.',
        });
      } else if (line.length > 200) {
        invalidDetails.push({
          field: 'deliveryAddress.addressLine',
          code: 'TOO_LONG',
          message: 'deliveryAddress.addressLine must be at most 200 characters.',
        });
      } else {
        normalized.addressLine = line;
      }
    }
  } else if (mode === 'full') {
    missingDetails.push({
      field: 'deliveryAddress.addressLine',
      code: 'REQUIRED',
      message: 'deliveryAddress.addressLine is required.',
    });
  }

  if ('phone' in rawAddress && rawAddress.phone !== undefined) {
    if (rawAddress.phone === null || typeof rawAddress.phone !== 'string') {
      invalidDetails.push({
        field: 'deliveryAddress.phone',
        code: 'INVALID_VALUE',
        message: 'deliveryAddress.phone must be a valid Egyptian mobile number.',
      });
    } else {
      const trimmed = rawAddress.phone.trim();
      if (trimmed.length === 0 && mode === 'full') {
        missingDetails.push({
          field: 'deliveryAddress.phone',
          code: 'REQUIRED',
          message: 'deliveryAddress.phone is required.',
        });
      } else {
        const phone = normalizePhone(trimmed);
        if (!phone) {
          invalidDetails.push({
            field: 'deliveryAddress.phone',
            code: 'INVALID_FORMAT',
            message: 'deliveryAddress.phone must be a valid Egyptian mobile number.',
          });
        } else {
          normalized.phone = phone;
        }
      }
    }
  } else if (mode === 'full') {
    missingDetails.push({
      field: 'deliveryAddress.phone',
      code: 'REQUIRED',
      message: 'deliveryAddress.phone is required.',
    });
  }

  if ('notes' in rawAddress && rawAddress.notes !== undefined) {
    if (rawAddress.notes === null) {
      normalized.notes = null;
    } else if (typeof rawAddress.notes !== 'string') {
      invalidDetails.push({
        field: 'deliveryAddress.notes',
        code: 'INVALID_VALUE',
        message: 'deliveryAddress.notes must be a string or null.',
      });
    } else {
      const notes = rawAddress.notes.trim();
      if (notes.length > 300) {
        invalidDetails.push({
          field: 'deliveryAddress.notes',
          code: 'TOO_LONG',
          message: 'deliveryAddress.notes must be at most 300 characters.',
        });
      } else {
        normalized.notes = notes.length === 0 ? null : notes;
      }
    }
  } else if (mode === 'full') {
    normalized.notes = null;
  }

  return normalized;
}

/**
 * Validates application form `data` and `deliveryAddress` (Design §7.2, Contract §4.4 & §4.7).
 * - In `partial` mode (draft save): validates present values; errors throw 400 VALIDATION_ERROR.
 * - In `full` mode (submit): enforces required fields & address subfields; if any required field is
 *   missing throws 400 MISSING_REQUIRED_FIELDS (including all missing + any invalid details);
 *   otherwise if any value fails constraints throws 400 VALIDATION_ERROR.
 */
export function validateApplicationPayload(params: {
  definition: ServiceDefinition;
  data: Record<string, unknown>;
  deliveryAddress: DeliveryAddressValue | null;
  mode: ValidationMode;
}): {
  data: Record<string, unknown>;
  deliveryAddress: DeliveryAddressValue | null;
} {
  const { definition, data, deliveryAddress, mode } = params;
  const missingDetails: ErrorDetail[] = [];
  const invalidDetails: ErrorDetail[] = [];
  const normalizedData: Record<string, unknown> = {};

  for (const field of definition.formSchema.fields) {
    const rawValue = data[field.key];
    const result = validateFieldValue(field, rawValue, mode, missingDetails, invalidDetails);
    if (result.present && result.normalized !== undefined) {
      normalizedData[field.key] = result.normalized;
    }
  }

  const normalizedAddress = validateDeliveryAddressInternal(
    deliveryAddress,
    mode,
    missingDetails,
    invalidDetails,
  );

  if (mode === 'full' && missingDetails.length > 0) {
    const combined = [...missingDetails, ...invalidDetails];
    throw new AppException('MISSING_REQUIRED_FIELDS', combined[0].message, {
      field: combined[0].field,
      details: combined,
    });
  }

  if (invalidDetails.length > 0) {
    throw new AppException('VALIDATION_ERROR', invalidDetails[0].message, {
      field: invalidDetails[0].field,
      details: invalidDetails,
    });
  }

  return {
    data: normalizedData,
    deliveryAddress: normalizedAddress,
  };
}
