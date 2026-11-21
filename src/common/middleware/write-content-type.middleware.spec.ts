import { Request, Response } from 'express';
import { writeContentTypeMiddleware } from './write-content-type.middleware';

function runMiddleware(options: {
  method: string;
  originalUrl?: string;
  headers?: Record<string, string>;
}) {
  const req = {
    method: options.method,
    originalUrl: options.originalUrl ?? '/api/v1/auth/logout',
    url: options.originalUrl ?? '/api/v1/auth/logout',
    headers: options.headers ?? {},
  } as unknown as Request;

  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const setHeader = jest.fn();
  const vary = jest.fn();
  const res = { status, setHeader, vary } as unknown as Response;
  const next = jest.fn();

  writeContentTypeMiddleware(req, res, next);
  return { next, status, json, setHeader, vary };
}

describe('writeContentTypeMiddleware (D-24)', () => {
  it('allows safe methods without Content-Type', () => {
    const { next } = runMiddleware({ method: 'GET', originalUrl: '/api/v1/health' });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('allows bodyless write with omitted Content-Type and empty body', () => {
    const { next } = runMiddleware({ method: 'POST', headers: {} });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('allows write with application/json (with or without charset)', () => {
    expect(
      runMiddleware({
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': '2' },
      }).next,
    ).toHaveBeenCalledTimes(1);

    expect(
      runMiddleware({
        method: 'DELETE',
        headers: { 'content-type': 'application/json', 'content-length': '0' },
      }).next,
    ).toHaveBeenCalledTimes(1);
  });

  it('rejects disallowed Content-Type on write with 415 even when body is empty', () => {
    const { next, status, json } = runMiddleware({
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'content-length': '0' },
    });

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(415);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: 'UNSUPPORTED_MEDIA_TYPE' }),
      }),
    );
  });

  it('rejects write with non-empty body and omitted Content-Type with 415', () => {
    const { next, status } = runMiddleware({
      method: 'PATCH',
      headers: { 'content-length': '15' },
    });

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(415);
  });

  it('requires multipart/form-data on attachment upload endpoint and rejects it elsewhere', () => {
    const uploadAllowed = runMiddleware({
      method: 'POST',
      originalUrl: '/api/v1/applications/11111111-1111-4111-8111-111111111111/attachments',
      headers: { 'content-type': 'multipart/form-data; boundary=---123', 'content-length': '100' },
    });
    expect(uploadAllowed.next).toHaveBeenCalledTimes(1);

    const uploadWithJson = runMiddleware({
      method: 'POST',
      originalUrl: '/api/v1/applications/11111111-1111-4111-8111-111111111111/attachments',
      headers: { 'content-type': 'application/json', 'content-length': '2' },
    });
    expect(uploadWithJson.status).toHaveBeenCalledWith(415);

    const normalWithMultipart = runMiddleware({
      method: 'POST',
      originalUrl: '/api/v1/applications',
      headers: { 'content-type': 'multipart/form-data; boundary=---123', 'content-length': '100' },
    });
    expect(normalWithMultipart.status).toHaveBeenCalledWith(415);
  });
});
