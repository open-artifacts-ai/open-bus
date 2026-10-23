/**
 * The Cloudflare API tokens setup asks the user for. Only the Access token so
 * far: `wrangler login` cannot edit Access. The permission keys are the
 * dashboard's `permissionGroupKeys`
 * (developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/).
 */

export type Perm = { key: string; type: "read" | "edit"; label: string };
export type Token = {
  id: "access";
  name: string;
  permissions: Perm[];
  /** The env var setup also reads the token from. */
  env: string;
  /** `~/.openbus/<name>-access-token`, relative to HOME. */
  file: string;
  /** Saves the token hidden at `file`, mode 0600. */
  saveCommand: string;
};

const ACCESS: Perm[] = [
  { key: "access", type: "edit", label: "Access: Apps and Policies: Edit" },
  { key: "access_acct", type: "read", label: "Access: Organizations: Read" },
];

/** The one line the user runs in their own terminal: reads the token hidden, saves it 0600. */
export const saveCommand = (file: string, label: string) =>
  `bash -c 'set -e; umask 077; d="$HOME/.openbus"; mkdir -p "$d"; chmod 700 "$d"; read -rsp "${label} (hidden, then Enter): " T; echo; [ -n "$T" ] || { echo "nothing entered; not saved"; exit 1; }; rm -f "$d/${file}"; printf "%s" "$T" > "$d/${file}"; chmod 600 "$d/${file}"; echo "saved to $d/${file}"'`;

export function tokenById(_id: Token["id"], o: { name: string }): Token {
  // The name sits inside a single-quoted bash line: keep it shell-safe.
  const safe = o.name.replace(/[^\w.-]/g, "_");
  const file = `${safe}-access-token`;
  return {
    id: "access",
    name: `OpenBus ${o.name} access`,
    permissions: ACCESS,
    env: "OB_ACCESS_TOKEN",
    file: `.openbus/${file}`,
    saveCommand: saveCommand(file, "Cloudflare Access token"),
  };
}

/** The dashboard's create-token form, pre-filled. */
export function linkFor(t: Token, o: { accountId?: string } = {}): string {
  const keys = JSON.stringify(
    t.permissions.map(({ key, type }) => ({ key, type })),
  );
  const q = [`permissionGroupKeys=${encodeURIComponent(keys)}`];
  if (o.accountId) q.push(`accountId=${encodeURIComponent(o.accountId)}`);
  q.push(`name=${encodeURIComponent(t.name)}`);
  return `https://dash.cloudflare.com/profile/api-tokens?${q.join("&")}`;
}
