import { AppException } from '../../common/errors/app-exception';
import {
  validateCreateServicePayload,
  validatePatchServicePayload,
} from './service-definition.validator';

function makeValidServicePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'national-id',
    name: { ar: 'بطاقة الرقم القومي', en: 'National ID Card' },
    description: { ar: 'إصدار بطاقة رقم قومي', en: 'Issue a national ID card' },
    category: 'IDENTITY',
    fee: { amount: 5000, currency: 'EGP' },
    slaDays: 3,
    validityYears: 7,
    requiredDocuments: [
      {
        key: 'personalPhoto',
        label: { ar: 'صورة شخصية', en: 'Personal photo' },
        required: true,
        allowedMimeTypes: ['image/jpeg', 'image/png'],
        maxSizeBytes: 2097152,
      },
    ],
    formSchema: {
      fields: [
        {
          key: 'reason',
          label: { ar: 'سبب الطلب', en: 'Reason' },
          helpText: null,
          type: 'SELECT',
          required: true,
          options: [
            { value: 'FIRST_ISSUE', label: { ar: 'أول مرة', en: 'First issue' } },
            { value: 'REPLACEMENT', label: { ar: 'بدل فاقد', en: 'Replacement' } },
          ],
          validation: {},
        },
        {
          key: 'notes',
          label: { ar: 'ملاحظات', en: 'Notes' },
          type: 'TEXT',
          required: false,
          validation: { minLength: 2, maxLength: 100, pattern: '^[a-zA-Z0-9 ]+$' },
        },
      ],
    },
    ...overrides,
  };
}

describe('service-definition.validator', () => {
  it('validates and canonicalizes a valid service payload', () => {
    const result = validateCreateServicePayload(makeValidServicePayload());

    expect(result.id).toBe('national-id');
    expect(result.definition.formSchema.fields[1]).toMatchObject({
      key: 'notes',
      helpText: null,
      options: null,
      validation: { minLength: 2, maxLength: 100, pattern: '^[a-zA-Z0-9 ]+$' },
    });
  });

  it('throws 400 UNKNOWN_FIELD for extra keys anywhere in the payload', () => {
    try {
      validateCreateServicePayload(makeValidServicePayload({ extraKey: true }));
      fail('Expected UNKNOWN_FIELD');
    } catch (error) {
      expect(error).toBeInstanceOf(AppException);
      expect((error as AppException).code).toBe('UNKNOWN_FIELD');
      expect((error as AppException).field).toBe('extraKey');
    }

    try {
      validateCreateServicePayload(
        makeValidServicePayload({
          formSchema: {
            fields: [
              {
                key: 'fieldOne',
                label: { ar: 'حقل', en: 'Field' },
                type: 'TEXT',
                required: false,
                options: null,
                validation: { bogusRule: 5 },
              },
            ],
          },
        }),
      );
      fail('Expected UNKNOWN_FIELD');
    } catch (error) {
      expect((error as AppException).code).toBe('UNKNOWN_FIELD');
      expect((error as AppException).field).toBe('formSchema.fields[0].validation.bogusRule');
    }
  });

  it('throws 400 INVALID_FORM_SCHEMA with exact detail paths for schema & document rule violations', () => {
    try {
      validateCreateServicePayload(
        makeValidServicePayload({
          requiredDocuments: [
            {
              key: 'docOne',
              label: { ar: 'مستند 1', en: 'Doc 1' },
              required: true,
              allowedMimeTypes: ['image/jpeg'],
              maxSizeBytes: 1000,
            },
            {
              key: 'docOne', // duplicate key
              label: { ar: 'مستند 2', en: 'Doc 2' },
              required: true,
              allowedMimeTypes: ['text/plain'], // disallowed MIME
              maxSizeBytes: 1000,
            },
          ],
          formSchema: {
            fields: [
              {
                key: 'selectOne',
                label: { ar: 'اختيار', en: 'Select' },
                helpText: null,
                type: 'SELECT',
                required: true,
                options: [{ value: 'ONLY_ONE', label: { ar: 'واحد', en: 'One' } }], // needs >= 2
                validation: {},
              },
              {
                key: 'numField',
                label: { ar: 'رقم', en: 'Number' },
                helpText: null,
                type: 'NUMBER',
                required: false,
                options: null,
                validation: { min: 10, max: 5, pattern: '^[0-9]+$' }, // min>max & pattern invalid on NUMBER
              },
            ],
          },
        }),
      );
      fail('Expected INVALID_FORM_SCHEMA');
    } catch (error) {
      const appErr = error as AppException;
      expect(appErr.code).toBe('INVALID_FORM_SCHEMA');
      const fields = appErr.details?.map((d) => d.field) ?? [];
      expect(fields).toContain('requiredDocuments[1].key');
      expect(fields).toContain('requiredDocuments[1].allowedMimeTypes');
      expect(fields).toContain('formSchema.fields[0].options');
      expect(fields).toContain('formSchema.fields[1].validation.min');
      expect(fields).toContain('formSchema.fields[1].validation.pattern');
    }
  });

  it('rejects unsafe ReDoS regex pattern as INVALID_FORM_SCHEMA', () => {
    try {
      validateCreateServicePayload(
        makeValidServicePayload({
          formSchema: {
            fields: [
              {
                key: 'code',
                label: { ar: 'كود', en: 'Code' },
                helpText: null,
                type: 'TEXT',
                required: true,
                options: null,
                validation: { pattern: '(a+)+$' },
              },
            ],
          },
        }),
      );
      fail('Expected INVALID_FORM_SCHEMA');
    } catch (error) {
      expect((error as AppException).code).toBe('INVALID_FORM_SCHEMA');
      expect((error as AppException).field).toBe('formSchema.fields[0].validation.pattern');
    }
  });

  it('forbids id on PATCH and merges top-level definition fields wholesale', () => {
    const existing = validateCreateServicePayload(makeValidServicePayload()).definition;

    try {
      validatePatchServicePayload({ id: 'renamed-id' }, existing);
      fail('Expected UNKNOWN_FIELD');
    } catch (error) {
      expect((error as AppException).code).toBe('UNKNOWN_FIELD');
      expect((error as AppException).field).toBe('id');
    }

    const patched = validatePatchServicePayload({ slaDays: 5, validityYears: null }, existing);
    expect(patched.updatedFields).toEqual(['slaDays', 'validityYears']);
    expect(patched.definition.slaDays).toBe(5);
    expect(patched.definition.validityYears).toBeNull();
    expect(patched.definition.fee).toEqual({ amount: 5000, currency: 'EGP' });
  });
});
