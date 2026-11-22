import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });
process.env.NODE_ENV = 'test';
// Keep automated e2e tests deterministic and offline against local disk storage.
process.env.STORAGE_DRIVER = 'local';
process.env.STORAGE_LOCAL_PATH = process.env.STORAGE_LOCAL_PATH || './storage';

export function getTestAllowedOrigin(): string {
  const raw = process.env.CORS_ORIGINS ?? '';
  const first = raw
    .split(',')
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);

  if (!first) {
    throw new Error('CORS_ORIGINS must be set in environment or .env to run e2e tests.');
  }

  return first;
}
