import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkLocalDependencies,
  dependencyInstallEnvironment,
  DEPENDENCY_INSTALL_ARGS,
  prepareProjectDependencies,
} from "../../src/server/agents/dependency-preparation";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function fixture(
  dependencies: Record<string, string> = {},
  devDependencies: Record<string, string> = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dependency-preparation-"));
  roots.push(root);
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ dependencies, devDependencies }),
  );
  return root;
}
async function pkg(root: string, name: string, options: { esm?: boolean; bin?: boolean } = {}) {
  const dir = path.join(root, "node_modules", name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({
      name,
      version: "1.0.0",
      ...(options.esm ? { exports: { ".": { import: "./index.js" } } } : { main: "index.js" }),
      ...(options.bin ? { bin: { [name]: "cli.js" } } : {}),
    }),
  );
  // An execution would throw; readiness must never evaluate this module.
  await fs.writeFile(
    path.join(dir, "index.js"),
    'throw new Error("DO NOT EXECUTE GENERATED CODE")',
  );
  if (options.bin)
    await fs.writeFile(path.join(dir, "cli.js"), 'throw new Error("DO NOT EXECUTE")');
}

describe("local dependency preparation", () => {
  it("requires all declared runtime and dev dependencies, not just a node_modules directory", async () => {
    const root = await fixture(
      { vue: "^3" },
      { vite: "^6", vitest: "^3", "@vitejs/plugin-vue": "^5" },
    );
    await pkg(root, "vue");
    expect(await checkLocalDependencies(root)).toMatchObject({
      ready: false,
      missing: ["@vitejs/plugin-vue", "vite", "vitest"],
    });
  });
  it("does not accept ancestor host modules", async () => {
    const host = await fixture();
    await pkg(host, "vite");
    const client = path.join(host, "client");
    await fs.mkdir(client);
    await fs.writeFile(
      path.join(client, "package.json"),
      JSON.stringify({ devDependencies: { vite: "^6" } }),
    );
    expect(await checkLocalDependencies(client)).toMatchObject({ ready: false, missing: ["vite"] });
  });
  it("rejects a local link pointing into the host dependency store", async () => {
    const host = await fixture();
    await pkg(host, "vite");
    const root = await fixture({}, { vite: "^6" });
    await fs.mkdir(path.join(root, "node_modules"));
    await fs.symlink(
      path.join(host, "node_modules", "vite"),
      path.join(root, "node_modules", "vite"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect((await checkLocalDependencies(root)).ready).toBe(false);
  });
  it("supports project-local pnpm links and import-only exports without executing them", async () => {
    const root = await fixture({}, { "@vitejs/plugin-vue": "^5" });
    const store = path.join(root, "node_modules", ".pnpm", "plugin@5");
    await pkg(store, "@vitejs/plugin-vue", { esm: true });
    await fs.mkdir(path.join(root, "node_modules", "@vitejs"), { recursive: true });
    await fs.symlink(
      path.join(store, "node_modules", "@vitejs/plugin-vue"),
      path.join(root, "node_modules", "@vitejs/plugin-vue"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect((await checkLocalDependencies(root)).ready).toBe(true);
  });
  it("requires the bin target and local executable shim", async () => {
    const root = await fixture({}, { vite: "^6" });
    await pkg(root, "vite", { bin: true });
    expect((await checkLocalDependencies(root)).ready).toBe(false);
    const bins = path.join(root, "node_modules", ".bin");
    await fs.mkdir(bins);
    await fs.writeFile(
      path.join(bins, process.platform === "win32" ? "vite.cmd" : "vite"),
      "local shim",
    );
    expect((await checkLocalDependencies(root)).ready).toBe(true);
    await fs.rm(path.join(root, "node_modules", "vite", "cli.js"));
    expect((await checkLocalDependencies(root)).ready).toBe(false);
  });
  it("forces development install despite inherited production/omit flags", () => {
    const env = dependencyInstallEnvironment({
      NODE_ENV: "production",
      NPM_CONFIG_OMIT: "dev",
      npm_config_production: "true",
      OTHER: "preserved",
    });
    expect(env).toMatchObject({
      NODE_ENV: "development",
      npm_config_omit: "",
      npm_config_production: "false",
      npm_config_include: "dev",
      npm_config_ignore_scripts: "true",
      OTHER: "preserved",
    });
    expect(env.NPM_CONFIG_OMIT).toBeUndefined();
  });
  it("performs one allowlisted local install and probes again; no arbitrary output leakage", async () => {
    const root = await fixture({}, { vite: "^6" });
    const executor = vi.fn(async (request) => {
      expect(request.cwd).toBe(await fs.realpath(root));
      expect(request.args).toEqual(DEPENDENCY_INSTALL_ARGS);
      expect(request.env.NODE_ENV).toBe("development");
      expect(request.timeoutMs).toBeGreaterThan(0);
      expect(request.maxBuffer).toBeGreaterThan(0);
      await pkg(root, "vite");
      return { exitCode: 0, output: "secret registry token" };
    });
    const result = await prepareProjectDependencies(root, { executor });
    expect(result.ready).toBe(true);
    expect(result.output).not.toContain("secret");
    expect(executor).toHaveBeenCalledTimes(1);
  });
  it("does not equate a successful install with readiness", async () => {
    const root = await fixture({}, { vite: "^6" });
    const result = await prepareProjectDependencies(root, {
      executor: async () => ({ exitCode: 0 }),
    });
    expect(result.ready).toBe(false);
    expect(result.output).toContain("vite");
  });
  it("skips installs when already ready, and cancellation never invokes the executor", async () => {
    const root = await fixture();
    const executor = vi.fn();
    expect((await prepareProjectDependencies(root, { executor })).ready).toBe(true);
    expect(executor).not.toHaveBeenCalled();
    const missing = await fixture({}, { vite: "^6" });
    const controller = new AbortController();
    controller.abort();
    expect(
      (await prepareProjectDependencies(missing, { executor, signal: controller.signal })).ready,
    ).toBe(false);
    expect(executor).not.toHaveBeenCalled();
  });
  it("blocks malformed manifests without installing", async () => {
    const root = await fixture();
    await fs.writeFile(path.join(root, "package.json"), "{invalid");
    const executor = vi.fn();
    expect((await prepareProjectDependencies(root, { executor })).ready).toBe(false);
    expect(executor).not.toHaveBeenCalled();
  });
});
