import { z } from 'zod';

const optionalNonEmptyString = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().min(1).optional(),
);

const optionalEmail = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().email().max(254).optional(),
);

const optionalSeedPassword = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().min(8).max(128).optional(),
);

function isValidHttpOrigin(origin: string): boolean {
  if (origin === '*' || origin.includes('*')) {
    return false;
  }
  try {
    const parsed = new URL(origin);
    const isHttp = parsed.protocol === 'http:' || parsed.protocol === 'https:';
    return isHttp && parsed.origin === origin;
  } catch {
    return false;
  }
}

function parseTrustProxy(value: unknown): boolean | number {
  if (value === undefined || value === null || value === '') {
    return false;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();
    if (trimmed === 'false') {
      return false;
    }
    if (trimmed === 'true') {
      return true;
    }
    if (/^\d+$/.test(trimmed)) {
      return Number.parseInt(trimmed, 10);
    }
  }
  throw new Error('TRUST_PROXY must be "true", "false", or a non-negative integer');
}

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']),
    PORT: z.coerce.number().int().min(1).max(65535),
    DATABASE_URL: z
      .string()
      .trim()
      .min(1)
      .refine(
        (value) => {
          try {
            const parsed = new URL(value);
            return parsed.protocol === 'postgresql:' || parsed.protocol === 'postgres:';
          } catch {
            return false;
          }
        },
        { message: 'DATABASE_URL must be a valid PostgreSQL connection URL' },
      ),
    JWT_SECRET: z.string().refine((value) => Buffer.byteLength(value, 'utf8') >= 32, {
      message: 'JWT_SECRET must be at least 32 bytes',
    }),
    COOKIE_SAMESITE: z.preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      z.enum(['lax', 'strict', 'none']).default('lax'),
    ),
    COOKIE_DOMAIN: optionalNonEmptyString,
    CORS_ORIGINS: z
      .string()
      .trim()
      .min(1, 'CORS_ORIGINS must contain at least one exact origin')
      .transform((value) =>
        value
          .split(',')
          .map((item) => item.trim())
          .filter((item) => item.length > 0),
      )
      .refine((origins) => origins.length > 0, {
        message: 'CORS_ORIGINS must contain at least one exact origin',
      })
      .refine((origins) => origins.every(isValidHttpOrigin), {
        message:
          'Each entry in CORS_ORIGINS must be an exact http/https origin without path or wildcard (*)',
      }),
    FRONTEND_BASE_URL: z
      .string()
      .trim()
      .url()
      .refine(
        (value) => {
          const parsed = new URL(value);
          return parsed.protocol === 'http:' || parsed.protocol === 'https:';
        },
        { message: 'FRONTEND_BASE_URL must use http or https' },
      )
      .transform((value) => value.replace(/\/+$/, '')),
    TRUST_PROXY: z
      .unknown()
      .default(false)
      .transform((value, ctx) => {
        try {
          return parseTrustProxy(value);
        } catch (err) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: err instanceof Error ? err.message : 'Invalid TRUST_PROXY value',
          });
          return z.NEVER;
        }
      }),
    EMAIL_DRIVER: z.preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      z.enum(['log', 'resend']).default('log'),
    ),
    EMAIL_PROVIDER_API_KEY: optionalNonEmptyString,
    EMAIL_FROM: optionalNonEmptyString,
    STORAGE_DRIVER: z.enum(['local', 's3']),
    STORAGE_LOCAL_PATH: optionalNonEmptyString,
    STORAGE_BUCKET: optionalNonEmptyString,
    STORAGE_ENDPOINT: optionalNonEmptyString,
    STORAGE_ACCESS_KEY: optionalNonEmptyString,
    STORAGE_SECRET_KEY: optionalNonEmptyString,
    STORAGE_REGION: optionalNonEmptyString,
    PAYMENT_MODE: z.enum(['mock', 'disabled']),
    // Optional in Zod; enforced at boot only when zero ADMIN rows exist in users.
    SEED_ADMIN_EMAIL: optionalEmail,
    SEED_ADMIN_PASSWORD: optionalSeedPassword,
    LOG_LEVEL: z.preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    ),
  })
  .superRefine((env, ctx) => {
    if (env.EMAIL_DRIVER === 'resend') {
      if (!env.EMAIL_PROVIDER_API_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['EMAIL_PROVIDER_API_KEY'],
          message: 'EMAIL_PROVIDER_API_KEY is required when EMAIL_DRIVER=resend',
        });
      }
      if (!env.EMAIL_FROM) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['EMAIL_FROM'],
          message: 'EMAIL_FROM is required when EMAIL_DRIVER=resend',
        });
      }
    }

    if (env.STORAGE_DRIVER === 'local' && !env.STORAGE_LOCAL_PATH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['STORAGE_LOCAL_PATH'],
        message: 'STORAGE_LOCAL_PATH is required when STORAGE_DRIVER=local',
      });
    }

    if (env.STORAGE_DRIVER === 's3') {
      const s3RequiredFields = [
        'STORAGE_BUCKET',
        'STORAGE_ENDPOINT',
        'STORAGE_ACCESS_KEY',
        'STORAGE_SECRET_KEY',
        'STORAGE_REGION',
      ] as const;

      for (const field of s3RequiredFields) {
        if (!env[field]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `${field} is required when STORAGE_DRIVER=s3`,
          });
        }
      }
    }
  });

export type EnvConfig = z.infer<typeof envSchema>;

export function validateEnv(rawEnv: Record<string, unknown>): EnvConfig {
  const result = envSchema.safeParse(rawEnv);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  return result.data;
}
