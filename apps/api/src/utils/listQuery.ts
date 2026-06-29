import type { PaginationMeta } from "@maria-matera/shared";

/**
 * Shared list-query parser for paginated/sorted admin and public listings.
 * Sort fields are whitelisted to prevent arbitrary-field sorting.
 */

type SortDirection = 1 | -1;

interface ParseOptions {
  allowedSort: string[];
  defaultSort?: string; // e.g. "-createdAt"
  maxPageSize?: number;
}

interface ParsedListQuery {
  page: number;
  pageSize: number;
  skip: number;
  sort: Record<string, SortDirection>;
}

const toInt = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const parseSort = (
  value: unknown,
  { allowedSort, defaultSort }: ParseOptions,
): Record<string, SortDirection> => {
  const raw = typeof value === "string" && value.trim() ? value.trim() : defaultSort;
  if (!raw) {
    return { createdAt: -1 };
  }
  const direction: SortDirection = raw.startsWith("-") ? -1 : 1;
  const field = raw.replace(/^-/, "");
  if (!allowedSort.includes(field)) {
    return { createdAt: -1 };
  }
  return { [field]: direction };
};

const parseListQuery = (
  query: Record<string, unknown>,
  options: ParseOptions,
): ParsedListQuery => {
  const page = toInt(query.page, 1);
  const pageSize = Math.min(options.maxPageSize ?? 50, toInt(query.pageSize, 20));
  return {
    page,
    pageSize,
    skip: (page - 1) * pageSize,
    sort: parseSort(query.sort, options),
  };
};

const buildMeta = (page: number, pageSize: number, total: number): PaginationMeta => ({
  page,
  pageSize,
  total,
  totalPages: Math.max(1, Math.ceil(total / pageSize)),
});

export type { ParsedListQuery, ParseOptions };
export { parseListQuery, buildMeta };
