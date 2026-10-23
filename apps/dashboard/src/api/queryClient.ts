import { QueryClient } from "@tanstack/react-query";
import { ApiClientError } from "./client";

/** 4xx never retries (a revoked session just re-loops); otherwise at most twice. */
export const shouldRetry = (failureCount: number, error: unknown): boolean => {
  if (
    error instanceof ApiClientError &&
    error.status >= 400 &&
    error.status < 500
  )
    return false;
  return failureCount < 2;
};

export const makeQueryClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: shouldRetry } } });
