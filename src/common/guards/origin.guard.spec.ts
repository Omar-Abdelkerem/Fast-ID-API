import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException } from '../errors/app-exception';
import { OriginGuard } from './origin.guard';

function createContext(method: string, origin?: string): ExecutionContext {
  const headers: Record<string, string> = {};
  if (origin !== undefined) {
    headers.origin = origin;
  }
  return {
    switchToHttp: () => ({
      getRequest: () => ({ method, headers }),
    }),
  } as unknown as ExecutionContext;
}

describe('OriginGuard (D-21)', () => {
  const allowedOrigin = 'http://127.0.0.1:5173';
  const guard = new OriginGuard({
    get: () => [allowedOrigin],
  } as unknown as ConfigService);

  it('allows safe methods without Origin header', () => {
    expect(guard.canActivate(createContext('GET'))).toBe(true);
    expect(guard.canActivate(createContext('HEAD'))).toBe(true);
    expect(guard.canActivate(createContext('OPTIONS'))).toBe(true);
  });

  it('allows state-changing requests with an exact allow-listed Origin', () => {
    expect(guard.canActivate(createContext('POST', allowedOrigin))).toBe(true);
    expect(guard.canActivate(createContext('PATCH', allowedOrigin))).toBe(true);
    expect(guard.canActivate(createContext('DELETE', allowedOrigin))).toBe(true);
  });

  it('rejects missing Origin on state-changing requests with 403 ORIGIN_NOT_ALLOWED', () => {
    expect(() => guard.canActivate(createContext('POST'))).toThrow(AppException);
    try {
      guard.canActivate(createContext('POST'));
    } catch (error) {
      expect(error).toBeInstanceOf(AppException);
      expect((error as AppException).code).toBe('ORIGIN_NOT_ALLOWED');
      expect((error as AppException).getStatus()).toBe(403);
    }
  });

  it('rejects disallowed Origin on state-changing requests with 403 ORIGIN_NOT_ALLOWED', () => {
    expect(() => guard.canActivate(createContext('PATCH', 'https://evil.example.test'))).toThrow(
      AppException,
    );
  });
});
