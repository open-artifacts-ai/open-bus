import { toast } from "@ob/ui/shadcn";
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
 * Signed out (sign-out or any 401): drop every cached query but `me`, every
 * mutation and every toast, then set `me` to null so the gate renders
 * sign-in. Another owner signing in on this tab never sees the previous
 * one's machines, agents or revoke feedback.
 */
export const signOutLocally = (client: QueryClient) => {
  client.removeQueries({
    predicate: (q) => q.queryKey[0] !== qk.me[0],
  });
  client.getMutationCache().clear();
  toast.dismiss();
  client.setQueryData(qk.me, null);
};

/** False once signed out: late callbacks (a revoke settling) must stay quiet. */
export const isSignedIn = (client: QueryClient) =>
  client.getQueryData(qk.me) != null;

/**
 * A 401 from any call means the session is gone: `me` becomes `null`
 * (signed out), so the shell's gate renders sign-in and unmounts the stream.
 */
export const makeQueryClient = () => {
  const onError = (error: unknown) => {
    if (error instanceof ApiClientError && error.code === "unauthorized")
      signOutLocally(client);
  };
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: { queries: { retry: shouldRetry } },
  });
  return client;
};
