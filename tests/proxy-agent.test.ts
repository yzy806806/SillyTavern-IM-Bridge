import { describe, expect, it } from "vitest";
import { buildBotFetchAgent, maskProxyUrl, normalizeProxyUrl, ProxyConfigError } from "../src/infra/proxy/proxy-agent";
import type { AccountProxyConfig } from "../src/core/models/account";

describe("normalizeProxyUrl", () => {
  it("accepts valid socks5/http/https urls", () => {
    expect(normalizeProxyUrl("socks5://127.0.0.1:1080")).toBe("socks5://127.0.0.1:1080");
    expect(normalizeProxyUrl("socks5://user:pass@10.0.0.1:1080")).toBe("socks5://user:pass@10.0.0.1:1080");
    expect(normalizeProxyUrl("http://proxy.lan:8080")).toBe("http://proxy.lan:8080");
    expect(normalizeProxyUrl("https://proxy.lan:443")).toBe("https://proxy.lan:443");
  });

  it("rejects empty/invalid/scheme-missing urls", () => {
    expect(() => normalizeProxyUrl("")).toThrow(ProxyConfigError);
    expect(() => normalizeProxyUrl("not-a-url")).toThrow(ProxyConfigError);
    expect(() => normalizeProxyUrl("ftp://x:21")).toThrow(ProxyConfigError);
    expect(() => normalizeProxyUrl("socks5://host")).toThrow(ProxyConfigError); // no port
    expect(() => normalizeProxyUrl("socks5://host:99999")).toThrow(ProxyConfigError);
  });
});

describe("maskProxyUrl", () => {
  it("masks password but keeps host/port", () => {
    const m = maskProxyUrl("socks5://alice:secret123@10.0.0.1:1080")!;
    expect(m).not.toContain("secret123");
    expect(m).toContain("10.0.0.1:1080");
    expect(m).toContain("alice");
  });

  it("returns null for null and **** for garbage", () => {
    expect(maskProxyUrl(null)).toBeNull();
    expect(maskProxyUrl(undefined)).toBeNull();
    expect(maskProxyUrl("junk:::")).toBe("****");
  });
});

describe("buildBotFetchAgent", () => {
  it("returns undefined when disabled or empty", () => {
    expect(buildBotFetchAgent(null)).toBeUndefined();
    expect(buildBotFetchAgent(undefined)).toBeUndefined();
    expect(buildBotFetchAgent({ enabled: false, url: "socks5://1.2.3.4:1080" } as AccountProxyConfig)).toBeUndefined();
    expect(buildBotFetchAgent({ enabled: true, url: null } as AccountProxyConfig)).toBeUndefined();
  });

  it("throws ProxyConfigError for invalid url when enabled", () => {
    expect(() => buildBotFetchAgent({ enabled: true, url: "ftp://x:21" } as AccountProxyConfig)).toThrow(ProxyConfigError);
  });

  it("builds a socks agent from socks5 url (module resolved at runtime)", () => {
    const agent = buildBotFetchAgent({ enabled: true, url: "socks5://127.0.0.1:1080" } as AccountProxyConfig);
    // socks-proxy-agent is in devDeps of this repo (via ST lock) or provided by runtime; if missing this test would throw.
    expect(agent).toBeDefined();
  });

  it("builds a selector function for http proxies", () => {
    const agent = buildBotFetchAgent({ enabled: true, url: "http://127.0.0.1:8080" } as AccountProxyConfig);
    expect(typeof agent).toBe("function");
  });
});
