/**
 * Standard API response envelope shared by every endpoint.
 * The backend builds these via `sendResponse`; the web client consumes them.
 */

type ApiStatus = "success" | "fail" | "error";

interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

interface ApiSuccess<TData> {
  status: "success";
  message: string;
  data: TData;
  meta?: PaginationMeta;
}

interface ApiError {
  status: "fail" | "error";
  message: string;
}

type ApiResponse<TData> = ApiSuccess<TData> | ApiError;

export type { ApiStatus, PaginationMeta, ApiSuccess, ApiError, ApiResponse };
