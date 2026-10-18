import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { AiProviderId } from "./env";

const providers = ["openai", "anthropic", "deepseek", "glm", "openrouter"] as const;
export function isValidAiBaseURL(value: string): boolean {
  if (!value) return true;
  try {
    if (/[\r\n\0?#]/.test(value) || /^https?:\/\/[^/]*@/i.test(value)) return false;
    const url = new URL(value);
    const loopback =
      url.hostname === "localhost" || url.hostname === "[::1]" || /^127\./.test(url.hostname);
    return (
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.protocol === "https:" || (url.protocol === "http:" && loopback))
    );
  } catch {
    return false;
  }
}
const savedConfigSchema = z
  .object({
    provider: z.enum(providers),
    model: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .regex(/^[^\r\n\0]+$/),
    baseURL: z.string().trim().max(2048).refine(isValidAiBaseURL).default(""),
    apiKey: z
      .string()
      .trim()
      .max(4096)
      .regex(/^[^\r\n\0]*$/)
      .optional(),
  })
  .strict();
const profileOptionsSchema = z
  .object({
    profileId: z.string().uuid().optional(),
    name: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[^\r\n\0]+$/)
      .optional(),
    activate: z.boolean().optional(),
    createNew: z.boolean().optional(),
  })
  .strict()
  .refine((value) => !(value.profileId && value.createNew));
export const aiConfigInputSchema = savedConfigSchema
  .extend(profileOptionsSchema.shape)
  .refine((value) => !(value.profileId && value.createNew));
export const aiConfigActionSchema = z
  .object({
    action: z.enum(["activate", "delete"]),
    profileId: z.string().uuid(),
  })
  .strict();
export type AiConfigInput = z.infer<typeof aiConfigInputSchema>;
export type AiProfileSaveOptions = z.infer<typeof profileOptionsSchema>;
export type SavedAiConfig = {
  provider: AiProviderId;
  model: string;
  baseURL: string;
  apiKey?: string;
};
export type SavedAiProfile = SavedAiConfig & { id: string; name: string };
export type SavedAiProfiles = { activeProfileId: string | null; profiles: SavedAiProfile[] };
const profileSchema = savedConfigSchema.extend({
  id: z.string().uuid(),
  name: profileOptionsSchema.shape.name.unwrap(),
});
const bundleSchema = z
  .object({
    activeProfileId: z.string().uuid().nullable(),
    profiles: z.array(profileSchema).max(100),
  })
  .strict()
  .refine(
    ({ profiles, activeProfileId }) =>
      new Set(profiles.map((p) => p.id)).size === profiles.length &&
      (profiles.length ? profiles.some((p) => p.id === activeProfileId) : activeProfileId === null),
  );
export function compatibleAiProfile(
  config: Pick<SavedAiConfig, "provider" | "baseURL">,
  other: Pick<SavedAiConfig, "provider" | "baseURL">,
) {
  return config.provider === other.provider && config.baseURL === other.baseURL;
}
export function selectAiProfile(
  bundle: SavedAiProfiles,
  config: SavedAiConfig,
  options: AiProfileSaveOptions = {},
) {
  if (options.createNew) return undefined;
  if (options.profileId) {
    const profile = bundle.profiles.find((p) => p.id === options.profileId);
    if (!profile) throw new AiConfigError("profile_not_found");
    return profile;
  }
  return (
    bundle.profiles.find(
      (p) => p.id === bundle.activeProfileId && compatibleAiProfile(config, p),
    ) ?? bundle.profiles.find((p) => compatibleAiProfile(config, p))
  );
}
export class AiConfigError extends Error {
  constructor(
    public readonly code:
      "auth_secret_required" | "config_unavailable" | "api_key_required" | "profile_not_found",
  ) {
    super(code);
    this.name = "AiConfigError";
  }
}

/** Atomic encrypted local persistence. Protect the directory using OS ACLs on Windows. */
export function createAiConfigStore(filePath: string, secret: () => string | undefined) {
  let cached: SavedAiProfiles | null = null;
  let signature: string | undefined;
  const clone = (bundle: SavedAiProfiles): SavedAiProfiles => ({
    activeProfileId: bundle.activeProfileId,
    profiles: bundle.profiles.map((p) => ({ ...p })),
  });
  const empty = (): SavedAiProfiles => ({ activeProfileId: null, profiles: [] });
  function encryptionKey() {
    const value = secret()?.trim();
    if (!value) throw new AiConfigError("auth_secret_required");
    return createHash("sha256").update(value).digest();
  }
  function persist(bundle: SavedAiProfiles) {
    const validated = bundleSchema.parse(bundle);
    const key = encryptionKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(validated), "utf8"), cipher.final()]);
    const temp = `${filePath}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
      writeFileSync(
        temp,
        JSON.stringify({
          version: 2,
          iv: iv.toString("base64"),
          tag: cipher.getAuthTag().toString("base64"),
          data: data.toString("base64"),
        }),
        { mode: 0o600, flag: "wx" },
      );
      chmodSync(temp, 0o600);
      renameSync(temp, filePath);
      cached = null;
      signature = undefined;
    } catch {
      throw new AiConfigError("config_unavailable");
    } finally {
      rmSync(temp, { force: true });
    }
  }
  function readProfiles(): SavedAiProfiles {
    try {
      const stat = statSync(filePath);
      if (stat.size > 1024 * 1024) throw new Error();
      const key = encryptionKey();
      const current = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${key.toString("hex")}`;
      if (signature === current && cached) return clone(cached);
      const envelope = JSON.parse(readFileSync(filePath, "utf8"));
      if (envelope.version !== 1 && envelope.version !== 2) throw new Error();
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.data, "base64")),
        decipher.final(),
      ]);
      const decoded = JSON.parse(plaintext.toString("utf8"));
      if (envelope.version === 1) {
        const config = savedConfigSchema.parse(decoded);
        const profile = { ...config, id: randomUUID(), name: config.provider };
        const migrated = { activeProfileId: profile.id, profiles: [profile] };
        persist(migrated);
        return clone(migrated);
      }
      cached = bundleSchema.parse(decoded);
      signature = current;
      return clone(cached);
    } catch (error) {
      cached = null;
      signature = undefined;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty();
      if (error instanceof AiConfigError) throw error;
      throw new AiConfigError("config_unavailable");
    }
  }
  function read(): SavedAiConfig | null {
    const bundle = readProfiles();
    const profile = bundle.profiles.find((p) => p.id === bundle.activeProfileId);
    if (!profile) return null;
    const { id, name, ...config } = profile;
    void id;
    void name;
    return config;
  }
  function save(config: SavedAiConfig, options: AiProfileSaveOptions = {}) {
    encryptionKey();
    const validated = savedConfigSchema.parse(config);
    const settings = profileOptionsSchema.parse(options);
    const bundle = readProfiles();
    const previous = selectAiProfile(bundle, validated, settings);
    const profile: SavedAiProfile = {
      ...validated,
      apiKey:
        validated.apiKey ||
        (previous && compatibleAiProfile(validated, previous) ? previous.apiKey : undefined),
      id: previous?.id ?? randomUUID(),
      name: settings.name ?? previous?.name ?? validated.provider,
    };
    bundle.profiles = previous
      ? bundle.profiles.map((p) => (p.id === previous.id ? profile : p))
      : [...bundle.profiles, profile];
    if (settings.activate !== false || !bundle.activeProfileId) bundle.activeProfileId = profile.id;
    persist(bundle);
  }
  function activate(profileId: string) {
    const bundle = readProfiles();
    if (!bundle.profiles.some((p) => p.id === profileId))
      throw new AiConfigError("profile_not_found");
    bundle.activeProfileId = profileId;
    persist(bundle);
  }
  function deleteProfile(profileId: string) {
    const bundle = readProfiles();
    if (!bundle.profiles.some((p) => p.id === profileId))
      throw new AiConfigError("profile_not_found");
    bundle.profiles = bundle.profiles.filter((p) => p.id !== profileId);
    if (bundle.activeProfileId === profileId)
      bundle.activeProfileId = bundle.profiles[0]?.id ?? null;
    persist(bundle);
  }
  function reset() {
    try {
      rmSync(filePath, { force: true });
      cached = null;
      signature = undefined;
    } catch {
      throw new AiConfigError("config_unavailable");
    }
  }
  return { read, readActive: read, readProfiles, save, activate, deleteProfile, reset };
}
export const aiConfigStore = createAiConfigStore(
  join(process.cwd(), ".local", "ai-config.json"),
  () => process.env.AUTH_SECRET,
);
