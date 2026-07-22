import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getOAuthApiKeyMock = vi.fn();

vi.mock("@earendil-works/pi-ai/oauth", () => ({
  getOAuthApiKey: (...args) => getOAuthApiKeyMock(...args),
}));

const { createPiOAuthApiKeyResolver } = await import("../pi-auth.js");

const tempDirs = [];

beforeEach(() => {
  getOAuthApiKeyMock.mockReset();
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("createPiOAuthApiKeyResolver", () => {
  it("returns undefined when the auth file is missing", async () => {
    const dir = await tempDir();
    const resolver = createPiOAuthApiKeyResolver({ path: join(dir, "auth.json") });

    await expect(resolver("openai-codex")).resolves.toBeUndefined();
    expect(getOAuthApiKeyMock).not.toHaveBeenCalled();
  });

  it("returns undefined when the provider is not present", async () => {
    const authPath = await writeAuth({ "github-copilot": oauthCredentials("github-token") });
    const resolver = createPiOAuthApiKeyResolver({ path: authPath });

    await expect(resolver("openai-codex")).resolves.toBeUndefined();
    expect(getOAuthApiKeyMock).not.toHaveBeenCalled();
  });

  it("resolves and persists refreshed OAuth credentials with protected file mode", async () => {
    const authPath = await writeAuth({
      "openai-codex": oauthCredentials("old-token"),
      "github-copilot": oauthCredentials("github-token"),
    });
    getOAuthApiKeyMock.mockResolvedValue({
      apiKey: "new-token",
      newCredentials: {
        access: "new-token",
        refresh: "new-refresh",
        expires: 4_200_000_000_000,
      },
    });
    const resolver = createPiOAuthApiKeyResolver({ path: authPath });

    await expect(resolver("openai-codex")).resolves.toBe("new-token");
    expect(getOAuthApiKeyMock).toHaveBeenCalledWith(
      "openai-codex",
      expect.objectContaining({
        "openai-codex": expect.objectContaining({ access: "old-token" }),
      }),
    );

    const auth = JSON.parse(await readFile(authPath, "utf8"));
    expect(auth).toMatchObject({
      "openai-codex": {
        type: "oauth",
        access: "new-token",
        refresh: "new-refresh",
        expires: 4_200_000_000_000,
      },
      "github-copilot": {
        type: "oauth",
        access: "github-token",
      },
    });
    expect((await stat(authPath)).mode & 0o777).toBe(0o600);
  });

  it("exposes credential-store methods that preserve OAuth credential shape", async () => {
    const authPath = await writeAuth({
      "openai-codex": oauthCredentials("old-token"),
      "github-copilot": oauthCredentials("github-token"),
    });
    const resolver = createPiOAuthApiKeyResolver({ path: authPath });

    await expect(resolver.readCredential("openai-codex")).resolves.toMatchObject({
      type: "oauth",
      access: "old-token",
      refresh: "old-token-refresh",
    });

    const updated = await resolver.modifyCredential("openai-codex", async (current) => ({
      ...current,
      access: "new-token",
      refresh: "new-refresh",
      expires: 4_200_000_000_000,
    }));

    expect(updated).toMatchObject({
      type: "oauth",
      access: "new-token",
      refresh: "new-refresh",
      expires: 4_200_000_000_000,
    });
    const auth = JSON.parse(await readFile(authPath, "utf8"));
    expect(auth["openai-codex"]).toMatchObject({ type: "oauth", access: "new-token" });

    await resolver.deleteCredential("openai-codex");
    const afterDelete = JSON.parse(await readFile(authPath, "utf8"));
    expect(afterDelete["openai-codex"]).toBeUndefined();
    expect(afterDelete["github-copilot"]).toMatchObject({ type: "oauth", access: "github-token" });
  });

  it("persists credentials when refreshes write concurrently", async () => {
    const authPath = await writeAuth({ "openai-codex": oauthCredentials("old-token") });
    getOAuthApiKeyMock.mockResolvedValue({
      apiKey: "new-token",
      newCredentials: {
        access: "new-token",
        refresh: "new-refresh",
        expires: 4_200_000_000_000,
      },
    });
    const resolver = createPiOAuthApiKeyResolver({ path: authPath });

    const results = await Promise.all(Array.from({ length: 8 }, () => resolver("openai-codex")));

    expect(results).toEqual(Array.from({ length: 8 }, () => "new-token"));
    const auth = JSON.parse(await readFile(authPath, "utf8"));
    expect(auth["openai-codex"]).toMatchObject({ access: "new-token" });
  });

  it("serializes concurrent credential writes across providers in the same auth file", async () => {
    const authPath = await writeAuth({
      "openai-codex": oauthCredentials("openai-old"),
      "github-copilot": oauthCredentials("github-old"),
    });
    const firstResolver = createPiOAuthApiKeyResolver({ path: authPath });
    const secondResolver = createPiOAuthApiKeyResolver({ path: authPath });

    await Promise.all([
      firstResolver.modifyCredential("openai-codex", async (current) => {
        await delay(20);
        return { ...current, access: "openai-new" };
      }),
      secondResolver.modifyCredential("github-copilot", async (current) => ({
        ...current,
        access: "github-new",
      })),
    ]);

    const auth = JSON.parse(await readFile(authPath, "utf8"));
    expect(auth["openai-codex"]).toMatchObject({ access: "openai-new" });
    expect(auth["github-copilot"]).toMatchObject({ access: "github-new" });
  });

  it("serializes concurrent credential writes when auth file paths are aliases", async () => {
    const dir = await tempDir();
    const authPath = join(dir, "auth.json");
    await writeFile(authPath, `${JSON.stringify({
      "openai-codex": oauthCredentials("openai-old"),
      "github-copilot": oauthCredentials("github-old"),
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

    const cwd = process.cwd();
    try {
      process.chdir(dir);
      const relativeResolver = createPiOAuthApiKeyResolver({ path: "auth.json" });
      const absoluteResolver = createPiOAuthApiKeyResolver({ path: authPath });

      await Promise.all([
        relativeResolver.modifyCredential("openai-codex", async (current) => {
          await delay(20);
          return { ...current, access: "openai-new" };
        }),
        absoluteResolver.modifyCredential("github-copilot", async (current) => ({
          ...current,
          access: "github-new",
        })),
      ]);
    } finally {
      process.chdir(cwd);
    }

    const auth = JSON.parse(await readFile(authPath, "utf8"));
    expect(auth["openai-codex"]).toMatchObject({ access: "openai-new" });
    expect(auth["github-copilot"]).toMatchObject({ access: "github-new" });
  });

  it("throws when the auth file is not valid JSON", async () => {
    const dir = await tempDir();
    const authPath = join(dir, "auth.json");
    await writeFile(authPath, "{not-json", "utf8");
    const resolver = createPiOAuthApiKeyResolver({ path: authPath });

    await expect(resolver("openai-codex")).rejects.toThrow(/Unable to parse Pi auth file/u);
  });
});

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "mono-agent-pi-auth-"));
  tempDirs.push(dir);
  return dir;
}

async function writeAuth(auth) {
  const dir = await tempDir();
  const authPath = join(dir, "auth.json");
  await writeFile(authPath, `${JSON.stringify(auth, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return authPath;
}

function oauthCredentials(access) {
  return {
    type: "oauth",
    access,
    refresh: `${access}-refresh`,
    expires: 4_100_000_000_000,
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
