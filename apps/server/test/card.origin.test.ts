import { OriginSchema } from "@ob/shared";
import { describe, expect, it } from "vitest";
import { parseOrigin } from "../src/card/origin.js";

// AC4b: the one origin parser for a linked app's aud (Task 7) and /link (Task 9).

const prod = { ENVIRONMENT: "production" as const };
const dev = { ENVIRONMENT: "dev" as const };

describe("parseOrigin", () => {
  it("accepts an exact https origin and normalizes case and :443", () => {
    expect(parseOrigin("https://oa.example.com", prod)).toBe(
      "https://oa.example.com",
    );
    expect(parseOrigin("HTTPS://X", prod)).toBe("https://x");
    expect(parseOrigin("https://OA.Example.COM:8443", prod)).toBe(
      "https://oa.example.com:8443",
    );
    expect(parseOrigin("https://x:443", prod)).toBe("https://x");
    expect(parseOrigin("https://127.0.0.1", prod)).toBe("https://127.0.0.1");
    expect(parseOrigin("https://[::1]:8443", prod)).toBe("https://[::1]:8443");
  });

  it("refuses a path, query, fragment or userinfo (Review Focus 4)", () => {
    for (const s of [
      "https://x/",
      "https://x/a",
      "https://x:443/",
      "https://x?q",
      "https://x?",
      "https://x#f",
      "https://x#",
      "https://u@x",
      "https://u:p@x",
      "https://@x",
    ])
      expect(parseOrigin(s, prod), s).toBeNull();
  });

  it("refuses http outside dev loopback", () => {
    expect(parseOrigin("http://x", prod)).toBeNull();
    expect(parseOrigin("http://x", dev)).toBeNull();
    expect(parseOrigin("http://localhost:8787", prod)).toBeNull();
    expect(parseOrigin("http://localhost:8787", dev)).toBe(
      "http://localhost:8787",
    );
    expect(parseOrigin("http://127.0.0.1", dev)).toBe("http://127.0.0.1");
    expect(parseOrigin("http://[::1]:80", dev)).toBe("http://[::1]");
    expect(parseOrigin("http://LOCALHOST", dev)).toBe("http://localhost");
  });

  it("refuses a trailing dot, empty labels and malformed hosts or ports", () => {
    for (const s of [
      "https://x.",
      "https://x.example.com.",
      "https://.x",
      "https://x..y",
      "https://",
      "https://x:",
      "https://x:0",
      "https://x:0443",
      "https://x:65536",
      "https://x_y",
      "https://b%C3%BCcher.de",
      "https://bücher.de",
      "https://0x7f.1",
      "https://1.2.3",
      " https://x",
      "https://x ",
      "https:x",
      "https:/x",
      "ftp://x",
      "x",
      "",
      `https://${"a".repeat(510)}`,
    ])
      expect(parseOrigin(s, prod), s).toBeNull();
  });

  it("every accepted value passes the shared OriginSchema", () => {
    for (const s of [
      "HTTPS://X",
      "https://x:443",
      "https://a.b.c:1",
      "https://[::1]",
    ]) {
      const o = parseOrigin(s, prod);
      expect(o, s).not.toBeNull();
      expect(OriginSchema.safeParse(o).success, s).toBe(true);
    }
    expect(
      OriginSchema.safeParse(parseOrigin("http://localhost", dev)).success,
    ).toBe(true);
  });
});
