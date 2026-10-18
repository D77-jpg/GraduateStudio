import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  backendEnvironment,
  detectBackend,
  externalApiTarget,
  readRuntimeEnv,
  waitForRuntimeHttp,
} from "@/server/runtime/companion-backend";
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-unit-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "backend"));
  fs.mkdirSync(path.join(root, "client"));
  return root;
}
describe("companion backend planning and HTTP readiness", () => {
  it("isolates preview DB configuration from platform and acceptance credentials", () => {
    const root = fixture();
    fs.writeFileSync(
      path.join(root, ".env"),
      "DB_HOST=db\nDB_NAME=business\nJWT_SECRET='project-secret-value'\nNODE_OPTIONS=bad\nTEST_DB_NAME=wrong_test\n",
    );
    fs.writeFileSync(path.join(root, "backend", ".env"), "DB_PORT=3306\n");
    fs.writeFileSync(path.join(root, ".env.test.local"), "TEST_DB_HOST=acceptance\n");
    const env = backendEnvironment(root, {
      NODE_ENV: "test",
      PATH: "keep",
      DATABASE_URL: "platform",
      DB_HOST: "platform",
      TEST_DB_NAME: "acceptance_test",
      JWT_SECRET: "platform",
    });
    expect(env).toMatchObject({
      DB_HOST: "db",
      DB_PORT: "3306",
      DB_NAME: "business",
      PATH: "keep",
      JWT_SECRET: "project-secret-value",
      NODE_ENV: "development",
    });
    expect(env.TEST_DB_NAME).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
  });
  it("detects Express and prefers start over watch dev without running migrations", () => {
    const root = fixture();
    expect(detectBackend(root)).toBeNull();
    fs.writeFileSync(
      path.join(root, "backend", "package.json"),
      JSON.stringify({
        dependencies: { express: "4" },
        scripts: { start: "node server.js", dev: "node --watch server.js", migrate: "destructive" },
      }),
    );
    expect(detectBackend(root)?.script).toBe("start");
  });
  it("uses explicit project external target and rejects credential URLs", () => {
    const root = fixture();
    fs.writeFileSync(path.join(root, ".env"), "VITE_DEV_API_TARGET=http://localhost:3000\n");
    fs.writeFileSync(
      path.join(root, "client", ".env.local"),
      "VITE_DEV_API_TARGET=http://127.0.0.1:8181\n",
    );
    expect(externalApiTarget(root)).toBe("http://127.0.0.1:8181");
    fs.writeFileSync(
      path.join(root, "client", ".env.local"),
      "VITE_DEV_API_TARGET=http://user:secret@localhost\n",
    );
    expect(() => externalApiTarget(root)).toThrow("without credentials");
  });
  it("parses comments and literal substitutions without shell evaluation", () => {
    const root = fixture();
    fs.writeFileSync(
      path.join(root, ".env"),
      'A="${SECRET} # literal" # comment\nB=value # comment\n',
    );
    expect(readRuntimeEnv(root)).toEqual({ A: "${SECRET} # literal", B: "value" });
  });
  it("rejects TCP-only/404, HTML, and unhealthy API responses", async () => {
    for (const response of [
      new Response("missing", { status: 404 }),
      new Response("<html>vite</html>"),
      new Response('{"status":"down"}'),
    ]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
      expect(
        (await waitForRuntimeHttp("http://localhost/api/health", 1, () => false, true)).ready,
      ).toBe(false);
    }
  });
  it("accepts HTTP frontend and structured backend health but not DB certification", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"data":{"status":"ok"}}')));
    expect(await waitForRuntimeHttp("http://localhost/api/health", 100, () => false, true)).toEqual(
      { ready: true, error: null },
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("frontend")));
    expect((await waitForRuntimeHttp("http://localhost/", 100)).ready).toBe(true);
  });
  it("cancels startup before requesting and bounds health response size", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("x".repeat(16385)));
    vi.stubGlobal("fetch", fetch);
    expect((await waitForRuntimeHttp("http://localhost/", 100, () => true)).ready).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect((await waitForRuntimeHttp("http://localhost/", 1, () => false, true)).ready).toBe(false);
  });
});
