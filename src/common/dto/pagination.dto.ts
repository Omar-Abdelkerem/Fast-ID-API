import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export const PAGINATED_MARKER = Symbol('PAGINATED_RESULT');

export interface PaginatedResult<T> {
  readonly [PAGINATED_MARKER]: true;
  data: T[];
  meta: PaginationMeta;
}

export function createPaginatedResult<T>(
  data: T[],
  total: number,
  page: number,
  pageSize: number,
): PaginatedResult<T> {
  const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);
  return {
    [PAGINATED_MARKER]: true,
    data,
    meta: { page, pageSize, total, totalPages },
  };
}

export function isPaginatedResult(value: unknown): value is PaginatedResult<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    PAGINATED_MARKER in value &&
    (value as PaginatedResult<unknown>)[PAGINATED_MARKER] === true
  );
}

export class PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 20;
}
