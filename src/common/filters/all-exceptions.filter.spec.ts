import { ArgumentsHost } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppException } from '../errors/app-exception';
import { AllExceptionsFilter } from './all-exceptions.filter';

function createMockHost() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const setHeader = jest.fn();
  const vary = jest.fn();
  const req = { requestId: 'req-123', method: 'POST', originalUrl: '/api/v1/test' };
  const res = { status, setHeader, vary };

  const host = {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
  } as unknown as ArgumentsHost;

  return { host, res, status, json, setHeader, vary };
}

describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;

  beforeEach(() => {
    filter = new AllExceptionsFilter();
  });

  it('serializes AppException with exact envelope and no-store/Vary headers', () => {
    const { host, status, json, setHeader, vary } = createMockHost();
    const err = new AppException('SERVICE_NOT_FOUND', 'Service not found.');

    filter.catch(err, host);

    expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(vary).toHaveBeenCalledWith('Origin');
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({
      success: false,
      error: {
        code: 'SERVICE_NOT_FOUND',
        message: 'Service not found.',
      },
    });
  });

  it.each([
    ['users_email_unique', 'EMAIL_ALREADY_REGISTERED'],
    ['users_national_id_unique', 'NATIONAL_ID_ALREADY_REGISTERED'],
    ['applications_one_active_per_service', 'ACTIVE_APPLICATION_EXISTS'],
    ['services_pkey', 'SERVICE_ALREADY_EXISTS'],
  ])('maps Prisma P2002 on %s to 409 %s', (constraint, expectedCode) => {
    const { host, status, json } = createMockHost();
    const prismaError = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: '6.6.0',
      meta: { target: constraint },
    });

    filter.catch(prismaError, host);

    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: expectedCode }),
      }),
    );
  });

  it('maps Prisma P2002 with array target for services primary key to 409 SERVICE_ALREADY_EXISTS', () => {
    const { host, status, json } = createMockHost();
    const prismaError = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: '6.6.0',
      meta: { modelName: 'services', target: ['id'] },
    });

    filter.catch(prismaError, host);

    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: 'SERVICE_ALREADY_EXISTS' }),
      }),
    );
  });

  it('maps unexpected errors to 500 INTERNAL_ERROR without leaking details', () => {
    const { host, status, json } = createMockHost();
    const loggerSpy = jest
      .spyOn((filter as unknown as { logger: { error: jest.Mock } }).logger, 'error')
      .mockImplementation(() => undefined);

    filter.catch(new Error('sensitive database detail'), host);

    expect(loggerSpy).toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred.',
      },
    });
  });
});
