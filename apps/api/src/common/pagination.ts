import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class PageQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page = 1;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  pageSize = 25;

  @IsOptional() @IsString()
  search?: string;

  @IsOptional() @IsString()
  sortBy?: string;

  @IsOptional() @IsIn(['asc', 'desc'])
  sortDir: 'asc' | 'desc' = 'desc';
}

export interface Page<T> {
  data: T[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
}

export function pageArgs(q: PageQuery, allowedSort: string[], defaultSort: string) {
  const field = q.sortBy && allowedSort.includes(q.sortBy) ? q.sortBy : defaultSort;
  return {
    skip: (q.page - 1) * q.pageSize,
    take: q.pageSize,
    orderBy: { [field]: q.sortDir },
  };
}

export function toPage<T>(data: T[], total: number, q: PageQuery): Page<T> {
  return { data, meta: { page: q.page, pageSize: q.pageSize, total, totalPages: Math.ceil(total / q.pageSize) } };
}
