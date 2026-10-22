import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  scanStackMarkers,
  unsupportedMarkers,
  resolveProfileFromText,
  resolveProfileFromMarkers,
} from "@/server/agents/stack-profiles";

const dirs: string[] = [];
async function project(files: Record<string, string>) {
  const dir = await mkdtemp(path.join(tmpdir(), "gs-stack-"));
  dirs.push(dir);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), content);
  }
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("stack markers", () => {
  it("detects the Vue + Spring Boot layout that the old npm-only acceptance ignored", async () => {
    const markers = await scanStackMarkers(await project({ "client/package.json": "{}", "server/pom.xml": "<project/>" }));
    expect(markers.map((m) => `${m.root}:${m.kind}`).sort()).toEqual(["client:node", "server:maven"]);
    expect(resolveProfileFromMarkers(markers)?.id).toBe("vue-spring-mysql");
  });
  it("treats a root package.json as an aggregator when sub-projects exist", async () => {
    const markers = await scanStackMarkers(await project({ "package.json": "{}", "client/package.json": "{}" }));
    expect(markers.map((m) => m.root)).toEqual(["client"]);
  });
  it("flags stacks the platform cannot verify", async () => {
    const markers = await scanStackMarkers(await project({ "backend/build.gradle": "", "api/go.mod": "" }));
    expect(unsupportedMarkers(markers).map((m) => m.kind).sort()).toEqual(["go", "gradle"]);
  });
  it("resolves a profile from the declared tech stack text", () => {
    expect(resolveProfileFromText(["技术栈:Vue 3、Spring Boot 3、MySQL 8"])?.id).toBe("vue-spring-mysql");
    expect(resolveProfileFromText(["FastAPI + Vue"])?.id).toBe("vue-fastapi");
    expect(resolveProfileFromText(["纯文档"])).toBeNull();
  });
});
