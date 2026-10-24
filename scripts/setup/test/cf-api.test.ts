import { describe, expect, it } from "vitest";
import { type Deps, makeApi, type Wrangler } from "../src/cf.ts";

const api = (res: () => Response) =>
  makeApi(
    { env: {}, fetch: async () => res() } as unknown as Deps,
    {} as Wrangler,
    "t",
  );

describe("makeApi", () => {
  // Live: DELETE workers/domains/:id answers 200 with an empty body (I3 scratch run).
  it("accepts a 2xx with an empty body", async () => {
    await expect(
      api(() => new Response(null, { status: 200 }))("DELETE", "/x"),
    ).resolves.toBeUndefined();
  });

  it("still refuses a 2xx envelope with success false", async () => {
    await expect(
      api(() => Response.json({ success: false, errors: [{ message: "no" }] }))(
        "GET",
        "/x",
      ),
    ).rejects.toThrow("GET /x: 200 no");
  });

  it("refuses a non-2xx with an empty body", async () => {
    await expect(
      api(() => new Response(null, { status: 404, statusText: "Not Found" }))(
        "DELETE",
        "/x",
      ),
    ).rejects.toThrow("DELETE /x: 404 Not Found");
  });
});
