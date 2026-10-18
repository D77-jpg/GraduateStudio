import { describe, it, expect } from "vitest";
import { frontendRuntimeEnvironment } from "@/server/runtime/runtime-environment";
describe("preview process environment", () => {
  it("keeps OS execution paths but removes platform secrets and npm omission controls", () => {
    const env = frontendRuntimeEnvironment({
      Path: "local",
      SystemRoot: "windows",
      DATABASE_URL: "platform",
      AUTH_SECRET: "secret",
      OPENAI_API_KEY: "secret",
      NODE_OPTIONS: "--require secret",
      npm_config_omit: "dev",
      NODE_ENV: "production",
    });
    expect(env).toEqual({ NODE_ENV: "development", Path: "local", SystemRoot: "windows" });
  });
});
