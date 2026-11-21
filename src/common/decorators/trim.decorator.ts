import { Transform } from 'class-transformer';

/**
 * Trims string input before validation (Contract §0.11).
 */
export const Trim = () =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));
