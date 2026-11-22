import { validateEnv } from './env.schema';

function makeValidEnv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    NODE_ENV: 'test',
    PORT: '3000',
    DATABASE_URL: 'postgresql://user:pass@127.0.0.1:5432/fastid?schema=public',
    JWT_SECRET: 'a-test-secret-that-is-clearly-longer-than-32-bytes',
    CORS_ORIGINS: 'http://127.0.0.1:5173',
    FRONTEND_BASE_URL: 'http://127.0.0.1:5173/',
    EMAIL_DRIVER: 'log',
    STORAGE_DRIVER: 'local',
    STORAGE_LOCAL_PATH: './storage',
    PAYMENT_MODE: 'mock',
    ...overrides,
  };
}

describe('envSchema / validateEnv', () => {
  it('accepts valid local development/test configuration without SEED_ADMIN_*', () => {
    const parsed = validateEnv(makeValidEnv());

    expect(parsed.NODE_ENV).toBe('test');
    expect(parsed.PORT).toBe(3000);
    expect(parsed.CORS_ORIGINS).toEqual(['http://127.0.0.1:5173']);
    expect(parsed.FRONTEND_BASE_URL).toBe('http://127.0.0.1:5173');
    expect(parsed.COOKIE_SAMESITE).toBe('lax');
    expect(parsed.TRUST_PROXY).toBe(false);
    expect(parsed.SEED_ADMIN_EMAIL).toBeUndefined();
    expect(parsed.SEED_ADMIN_PASSWORD).toBeUndefined();
  });

  it('rejects JWT_SECRET shorter than 32 bytes', () => {
    expect(() => validateEnv(makeValidEnv({ JWT_SECRET: 'too-short' }))).toThrow(
      /JWT_SECRET must be at least 32 bytes/,
    );
  });

  it('rejects wildcard * in CORS_ORIGINS', () => {
    expect(() => validateEnv(makeValidEnv({ CORS_ORIGINS: '*' }))).toThrow(/CORS_ORIGINS/);
    expect(() =>
      validateEnv(makeValidEnv({ CORS_ORIGINS: 'http://127.0.0.1:5173,https://*.example.com' })),
    ).toThrow(/CORS_ORIGINS/);
  });

  it('rejects CORS_ORIGINS with paths or trailing slashes', () => {
    expect(() => validateEnv(makeValidEnv({ CORS_ORIGINS: 'http://127.0.0.1:5173/' }))).toThrow(
      /CORS_ORIGINS/,
    );
  });

  it('supports multiple comma-separated exact CORS_ORIGINS', () => {
    const parsed = validateEnv(
      makeValidEnv({ CORS_ORIGINS: 'http://127.0.0.1:5173, http://127.0.0.1:4173' }),
    );
    expect(parsed.CORS_ORIGINS).toEqual(['http://127.0.0.1:5173', 'http://127.0.0.1:4173']);
  });

  it('requires STORAGE_LOCAL_PATH when STORAGE_DRIVER=local', () => {
    expect(() =>
      validateEnv(makeValidEnv({ STORAGE_DRIVER: 'local', STORAGE_LOCAL_PATH: '' })),
    ).toThrow(/STORAGE_LOCAL_PATH/);
  });

  it('requires S3 credentials when STORAGE_DRIVER=s3', () => {
    expect(() =>
      validateEnv(makeValidEnv({ STORAGE_DRIVER: 's3', STORAGE_LOCAL_PATH: '' })),
    ).toThrow(/STORAGE_BUCKET/);

    const parsed = validateEnv(
      makeValidEnv({
        STORAGE_DRIVER: 's3',
        STORAGE_LOCAL_PATH: '',
        STORAGE_BUCKET: 'fastid-bucket',
        STORAGE_ENDPOINT: 'https://storage.example.test',
        STORAGE_ACCESS_KEY: 'key',
        STORAGE_SECRET_KEY: 'secret',
        STORAGE_REGION: 'auto',
      }),
    );
    expect(parsed.STORAGE_DRIVER).toBe('s3');
    expect(parsed.STORAGE_BUCKET).toBe('fastid-bucket');
  });

  it('requires Cloudinary credentials when STORAGE_DRIVER=cloudinary', () => {
    expect(() =>
      validateEnv(makeValidEnv({ STORAGE_DRIVER: 'cloudinary', STORAGE_LOCAL_PATH: '' })),
    ).toThrow(/CLOUDINARY_CLOUD_NAME/);

    const withVars = validateEnv(
      makeValidEnv({
        STORAGE_DRIVER: 'cloudinary',
        STORAGE_LOCAL_PATH: '',
        CLOUDINARY_CLOUD_NAME: 'demo-cloud',
        CLOUDINARY_API_KEY: '123456',
        CLOUDINARY_API_SECRET: 'secret-value',
      }),
    );
    expect(withVars.STORAGE_DRIVER).toBe('cloudinary');
    expect(withVars.CLOUDINARY_FOLDER).toBe('fast-id');

    const withUrl = validateEnv(
      makeValidEnv({
        STORAGE_DRIVER: 'cloudinary',
        STORAGE_LOCAL_PATH: '',
        CLOUDINARY_URL: 'cloudinary://123456:secret-value@demo-cloud',
      }),
    );
    expect(withUrl.STORAGE_DRIVER).toBe('cloudinary');
  });

  it('requires EMAIL_PROVIDER_API_KEY and EMAIL_FROM when EMAIL_DRIVER=resend', () => {
    expect(() => validateEnv(makeValidEnv({ EMAIL_DRIVER: 'resend' }))).toThrow(
      /EMAIL_PROVIDER_API_KEY/,
    );
  });

  it('parses TRUST_PROXY boolean and hop count values', () => {
    expect(validateEnv(makeValidEnv({ TRUST_PROXY: 'true' })).TRUST_PROXY).toBe(true);
    expect(validateEnv(makeValidEnv({ TRUST_PROXY: '1' })).TRUST_PROXY).toBe(1);
    expect(() => validateEnv(makeValidEnv({ TRUST_PROXY: 'invalid' }))).toThrow(/TRUST_PROXY/);
  });
});
