import { describe, expect, it } from "vitest";
// Platform-owned ESM proxy module; imported directly so its policy is unit-tested.
import {
  allowedTarget,
  createDependencyProxy,
  publicIPv4,
  resolvePublicHost,
} from "../../docker/codex-worker/dependency-proxy.mjs";

describe("controlled dependency proxy policy", () => {
  it("permits only the pinned registries on port 443", () => {
    expect(allowedTarget("registry.npmjs.org:443")).toBe("registry.npmjs.org");
    expect(allowedTarget("pypi.org:443")).toBe("pypi.org");
    expect(allowedTarget("files.pythonhosted.org:443")).toBe("files.pythonhosted.org");
    for (const denied of [
      "registry.npmjs.org:80",
      "registry.npmjs.org:444",
      "evil.test:443",
      "github.com:443",
      "registry.npmjs.org.evil.test:443",
      "sub.registry.npmjs.org:443",
      "REGISTRY.NPMJS.ORG:443",
      "registry.npmjs.org",
      "://registry.npmjs.org:443",
    ])
      expect(allowedTarget(denied)).toBeNull();
    expect(allowedTarget(undefined)).toBeNull();
    expect(allowedTarget("registry.npmjs.org:443\n")).toBeNull();
  });

  it("rejects non-public addresses including fake-IP DNS ranges", () => {
    for (const denied of [
      "0.0.0.0",
      "10.1.2.3",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.1.1",
      "172.16.5.5",
      "192.168.1.1",
      "192.0.2.10",
      "198.18.0.166",
      "198.19.255.1",
      "203.0.113.7",
      "224.0.0.1",
      "::1",
      "not-an-ip",
    ])
      expect(publicIPv4(denied)).toBe(false);
    expect(publicIPv4("104.16.9.34")).toBe(true);
    expect(publicIPv4("151.101.0.223")).toBe(true);
  });

  it("refuses to resolve a host outside the allowlist without any DNS lookup", async () => {
    for (const host of ["evil.test", "github.com", "registry.npmjs.org.evil.test", ""])
      await expect(resolvePublicHost(host, {})).resolves.toBeNull();
  });

  it("treats a non-public pin as a denial instead of falling back", async () => {
    await expect(
      resolvePublicHost("registry.npmjs.org", { "registry.npmjs.org": "198.18.0.166" }),
    ).resolves.toBeNull();
    await expect(
      resolvePublicHost("registry.npmjs.org", { "registry.npmjs.org": "10.0.0.5" }),
    ).resolves.toBeNull();
    await expect(
      resolvePublicHost("registry.npmjs.org", { "registry.npmjs.org": "104.16.9.34" }),
    ).resolves.toBe("104.16.9.34");
  });

  it("refuses invalid pin configurations and closes cleanly", async () => {
    expect(() => createDependencyProxy({ "evil.test": "104.16.9.34" })).toThrow();
    expect(() => createDependencyProxy({ "registry.npmjs.org": "198.18.0.166" })).toThrow();
    expect(() => createDependencyProxy({ "registry.npmjs.org": "8.8.8.8" })).not.toThrow();
    const proxy = createDependencyProxy({});
    proxy.close();
    await new Promise((resolve) => proxy.server.close(resolve));
  });

  it("serves no plaintext path and only handles CONNECT", () => {
    const proxy = createDependencyProxy({});
    const handlers = proxy.server.listeners("connect");
    expect(handlers).toHaveLength(1);
    expect(proxy.server.listeners("request")).toHaveLength(1);
    proxy.close();
  });
});
