// Read-only check that the Cloudflare API token can do what staging, the
// custom domains and the Access app need (issue #4). Edit permissions imply
// read, so each check is a GET; a 403 names the missing permission.
// Usage: node --experimental-strip-types scripts/ops/cf-token-check.ts
//   env CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID; zones default to OB_ZONES.
export const OB_ZONES = ["open-bus.ai", "leourbina.com"];
const API = "https://api.cloudflare.com/client/v4";

export type Check = { name: string; ok: boolean; detail: string };
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export async function checkToken(
  fetch: Fetch,
  token: string,
  account: string,
  zones: string[] = OB_ZONES,
): Promise<Check[]> {
  const get = async (path: string) => {
    const r = await fetch(`${API}${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = (await r.json().catch(() => ({}))) as {
      result?: unknown;
      errors?: { message?: string }[];
    };
    return { status: r.status, body };
  };
  const out: Check[] = [];
  const add = async (name: string, path: string, need: string) => {
    const { status, body } = await get(path);
    const ok = status === 200;
    out.push({
      name,
      ok,
      detail: ok
        ? "ok"
        : `HTTP ${status}: needs ${need}${body.errors?.[0]?.message ? ` (${body.errors[0].message})` : ""}`,
    });
    return ok ? body.result : undefined;
  };

  const v = (await add("token", "/user/tokens/verify", "a valid token")) as
    | { status?: string }
    | undefined;
  if (v && v.status !== "active") {
    out[out.length - 1] = {
      name: "token",
      ok: false,
      detail: `token status is ${v.status}`,
    };
    return out;
  }
  if (!v) return out;
  const a = `/accounts/${encodeURIComponent(account)}`;
  await add(
    "workers-scripts",
    `${a}/workers/scripts`,
    "Account | Workers Scripts: Edit",
  );
  await add(
    "access-apps",
    `${a}/access/apps`,
    "Account | Access: Apps and Policies: Edit",
  );
  for (const z of zones) {
    const found = (await add(
      `zone ${z}`,
      `/zones?name=${encodeURIComponent(z)}&account.id=${encodeURIComponent(account)}`,
      `the ${z} zone on this account`,
    )) as { id: string }[] | undefined;
    if (!found) continue;
    if (found.length === 0) {
      out[out.length - 1] = {
        name: `zone ${z}`,
        ok: false,
        detail: `${z} is not on this account, or the token has no Zone permission for it`,
      };
      continue;
    }
    const zid = encodeURIComponent(found[0].id);
    await add(
      `dns ${z}`,
      `/zones/${zid}/dns_records?per_page=1`,
      `Zone | DNS: Edit on ${z}`,
    );
    await add(
      `routes ${z}`,
      `/zones/${zid}/workers/routes`,
      `Zone | Workers Routes: Edit on ${z}`,
    );
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
  const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  if (!token || !account) {
    console.log(
      "::error::CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required",
    );
    process.exit(1);
  }
  const checks = await checkToken(fetch, token, account);
  for (const c of checks)
    console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`);
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
}
