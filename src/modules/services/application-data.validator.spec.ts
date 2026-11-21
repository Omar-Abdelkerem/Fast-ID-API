import { AppException } from '../../common/errors/app-exception';
import {
  mergeApplicationDataPatch,
  mergeDeliveryAddressPatch,
  validateApplicationPayload,
} from './application-data.validator';
import { ServiceDefinition } from './service-definition.types';

const sampleDefinition: ServiceDefinition = {
  name: { ar: 'خدمة', en: 'Service' },
  description: { ar: 'وصف', en: 'Desc' },
  category: 'IDENTITY',
  fee: { amount: 5000, currency: 'EGP' },
  slaDays: 3,
  validityYears: 7,
  requiredDocuments: [],
  formSchema: {
    fields: [
      {
        key: 'reason',
        label: { ar: 'سبب', en: 'Reason' },
        helpText: null,
        type: 'SELECT',
        required: true,
        options: [
          { value: 'FIRST', label: { ar: 'أول', en: 'First' } },
          { value: 'RENEW', label: { ar: 'تجديد', en: 'Renew' } },
        ],
        validation: {},
      },
      {
        key: 'code',
        label: { ar: 'كود', en: 'Code' },
        helpText: null,
        type: 'TEXT',
        required: false,
        options: null,
        validation: { minLength: 3, maxLength: 10, pattern: '^[A-Z0-9]+$' },
      },
      {
        key: 'copies',
        label: { ar: 'عدد النسخ', en: 'Copies' },
        helpText: null,
        type: 'NUMBER',
        required: false,
        options: null,
        validation: { min: 1, max: 5 },
      },
      {
        key: 'issueDate',
        label: { ar: 'تاريخ', en: 'Date' },
        helpText: null,
        type: 'DATE',
        required: false,
        options: null,
        validation: { minDate: '2020-01-01', maxDate: '2026-12-31' },
      },
      {
        key: 'confirmTruth',
        label: { ar: 'تأكيد', en: 'Confirm' },
        helpText: null,
        type: 'CHECKBOX',
        required: true,
        options: null,
        validation: {},
      },
    ],
  },
};

describe('application-data.validator (Design §7.2, C-3)', () => {
  it('merges PATCH data keys, clears null keys, and rejects unknown data keys with UNKNOWN_FIELD', () => {
    const merged = mergeApplicationDataPatch(
      sampleDefinition,
      { reason: 'FIRST', code: 'ABC123' },
      { code: null, copies: 2 },
    );
    expect(merged).toEqual({ reason: 'FIRST', copies: 2 });

    expect(() => mergeApplicationDataPatch(sampleDefinition, {}, { bogusKey: 'x' })).toThrow(
      AppException,
    );
    try {
      mergeApplicationDataPatch(sampleDefinition, {}, { bogusKey: 'x' });
    } catch (err) {
      expect((err as AppException).code).toBe('UNKNOWN_FIELD');
      expect((err as AppException).field).toBe('data.bogusKey');
    }
  });

  it('allows partial draft data in partial mode while enforcing constraints on present fields', () => {
    const valid = validateApplicationPayload({
      definition: sampleDefinition,
      data: { code: '  AB12  ', copies: 3, issueDate: '2025-05-01', confirmTruth: false },
      deliveryAddress: { city: 'Nasr City', phone: '+201012345678', notes: null },
      mode: 'partial',
    });

    expect(valid.data).toEqual({
      code: 'AB12',
      copies: 3,
      issueDate: '2025-05-01',
      confirmTruth: false,
    });
    expect(valid.deliveryAddress).toEqual({
      city: 'Nasr City',
      phone: '01012345678',
      notes: null,
    });

    try {
      validateApplicationPayload({
        definition: sampleDefinition,
        data: { code: 'bad-lower', copies: 9 },
        deliveryAddress: null,
        mode: 'partial',
      });
      fail('Expected VALIDATION_ERROR');
    } catch (err) {
      const appErr = err as AppException;
      expect(appErr.code).toBe('VALIDATION_ERROR');
      expect(appErr.details?.map((d) => d.field)).toEqual(['data.code', 'data.copies']);
    }
  });

  it('enforces required CHECKBOX=true and emits individual deliveryAddress subfields as MISSING_REQUIRED_FIELDS on full submit', () => {
    try {
      validateApplicationPayload({
        definition: sampleDefinition,
        data: { confirmTruth: false, code: 'bad-lower' },
        deliveryAddress: null,
        mode: 'full',
      });
      fail('Expected MISSING_REQUIRED_FIELDS');
    } catch (err) {
      const appErr = err as AppException;
      expect(appErr.code).toBe('MISSING_REQUIRED_FIELDS');
      const fields = appErr.details?.map((d) => d.field) ?? [];
      expect(fields).toContain('data.reason');
      expect(fields).toContain('data.confirmTruth');
      expect(fields).toContain('deliveryAddress.governorate');
      expect(fields).toContain('deliveryAddress.city');
      expect(fields).toContain('deliveryAddress.addressLine');
      expect(fields).toContain('deliveryAddress.phone');
      expect(fields).toContain('data.code'); // invalid field also listed in details
    }
  });

  it('returns VALIDATION_ERROR (not MISSING_REQUIRED_FIELDS) on submit when all required fields are present but a value is invalid', () => {
    try {
      validateApplicationPayload({
        definition: sampleDefinition,
        data: { reason: 'FIRST', confirmTruth: true, issueDate: '2025-02-30' },
        deliveryAddress: {
          governorate: 'CAIRO',
          city: 'Nasr City',
          addressLine: '12 Abbas El Akkad St',
          phone: '01012345678',
          notes: null,
        },
        mode: 'full',
      });
      fail('Expected VALIDATION_ERROR');
    } catch (err) {
      const appErr = err as AppException;
      expect(appErr.code).toBe('VALIDATION_ERROR');
      expect(appErr.field).toBe('data.issueDate');
    }
  });

  it('rejects null on non-nullable deliveryAddress subfields and unknown address keys', () => {
    expect(() => mergeDeliveryAddressPatch(null, { country: 'EG' })).toThrow(AppException);

    const patched = mergeDeliveryAddressPatch({ city: 'Cairo' }, { city: null });
    try {
      validateApplicationPayload({
        definition: sampleDefinition,
        data: {},
        deliveryAddress: patched,
        mode: 'partial',
      });
      fail('Expected VALIDATION_ERROR');
    } catch (err) {
      expect((err as AppException).code).toBe('VALIDATION_ERROR');
      expect((err as AppException).field).toBe('deliveryAddress.city');
    }
  });
});
