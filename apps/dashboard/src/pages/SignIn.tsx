import { BrandMark, Button } from "@ob/ui/shadcn";
import { AUTH } from "../api/contract";
import { useDocumentTitle } from "../layout/useDocumentTitle";

/**
 * Sign-in hands off to the Worker's OIDC start (Cloudflare Access); the
 * approval page is the Worker's too. `next` is where the Worker sends the
 * owner back afterwards.
 */
export function SignIn({
  failed = false,
  next = "/",
}: {
  failed?: boolean;
  next?: string;
}) {
  useDocumentTitle("Sign in");
  return (
    <main className="flex min-h-svh items-center justify-center px-4 py-10">
      <div className="w-full max-w-[400px] rounded-lg border bg-card p-8 text-card-foreground shadow-(--ob-shadow-1)">
        <BrandMark className="mb-5 size-10" />
        <h1 className="text-(length:--ob-text-xl) font-semibold">Sign in</h1>
        <p className="mt-2 text-(--ob-text-2)">
          OpenBus is self-hosted. Sign in with the account your Access policy
          allows.
        </p>
        {failed && (
          <p
            role="alert"
            className="mt-4 rounded-md bg-(--ob-warning-soft) px-3 py-2 text-foreground"
          >
            Sign-in didn't finish. Try again.
          </p>
        )}
        <Button asChild size="lg" className="mt-6 w-full">
          <a href={`${AUTH.login}?next=${encodeURIComponent(next)}`}>
            Continue with Cloudflare Access
          </a>
        </Button>
      </div>
    </main>
  );
}
