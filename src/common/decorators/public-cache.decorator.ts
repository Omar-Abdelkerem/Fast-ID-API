import { SetMetadata } from '@nestjs/common';

export const PUBLIC_CACHE_KEY = 'publicCache';

export interface PublicCacheOptions {
  maxAgeSeconds: number;
  staleWhileRevalidateSeconds?: number;
}

export const PublicCache = (maxAgeSeconds: number, staleWhileRevalidateSeconds?: number) =>
  SetMetadata(PUBLIC_CACHE_KEY, {
    maxAgeSeconds,
    staleWhileRevalidateSeconds,
  } satisfies PublicCacheOptions);
