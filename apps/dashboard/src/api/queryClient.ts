import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { ApiClientError } from "./client";
import { qk } from "./qk";

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

/**
 * A 401 from any call means the session is gone: `me` becomes `null`
 * (signed out), so the shell's gate renders sign-in and unmounts the stream.
 */
export const makeQueryClient = () => {
  const onError = (error: unknown) => {
    if (error instanceof ApiClientError && error.code === "unauthorized")
      client.setQueryData(qk.me, null);
  };
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: { queries: { retry: shouldRetry } },
  });
  return client;
};
