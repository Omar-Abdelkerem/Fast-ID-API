import { ValidationError } from 'class-validator';
import { validationExceptionFactory } from './validation.pipe';

describe('validationExceptionFactory', () => {
  it('returns 400 UNKNOWN_FIELD for non-whitelisted properties including nested paths', () => {
    const errors: ValidationError[] = [
      {
        property: 'deliveryAddress',
        children: [
          {
            property: 'extraField',
            constraints: {
              whitelistValidation: 'property extraField should not exist',
            },
          },
        ],
      },
    ];

    const exception = validationExceptionFactory(errors);
    expect(exception.getStatus()).toBe(400);
    expect(exception.toEnvelope()).toEqual({
      success: false,
      error: {
        code: 'UNKNOWN_FIELD',
        message: 'Unknown field "deliveryAddress.extraField".',
        field: 'deliveryAddress.extraField',
      },
    });
  });

  it('returns 400 VALIDATION_ERROR with mapped details and mirrors the first problem', () => {
    const errors: ValidationError[] = [
      {
        property: 'fullName',
        constraints: {
          isNotEmpty: 'fullName should not be empty',
        },
      },
      {
        property: 'phone',
        constraints: {
          matches: 'phone must match Egyptian mobile format',
        },
      },
      {
        property: 'items',
        children: [
          {
            property: '2',
            children: [
              {
                property: 'key',
                constraints: {
                  minLength: 'key is too short',
                },
              },
            ],
          },
        ],
      },
    ];

    const exception = validationExceptionFactory(errors);
    expect(exception.getStatus()).toBe(400);
    expect(exception.toEnvelope()).toEqual({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'fullName should not be empty',
        field: 'fullName',
        details: [
          {
            field: 'fullName',
            code: 'REQUIRED',
            message: 'fullName should not be empty',
          },
          {
            field: 'phone',
            code: 'INVALID_FORMAT',
            message: 'phone must match Egyptian mobile format',
          },
          {
            field: 'items[2].key',
            code: 'TOO_SHORT',
            message: 'key is too short',
          },
        ],
      },
    });
  });
});
