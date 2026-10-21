import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createManagedOpencodeV2Server } from "./managed-opencode-v2.js";

const posix = process.platform === "win32" ? test.skip : test;

posix("the v2 engine gets its own empty config home, not the user's global opencode config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "v2-env-"));
  try {
    const record = join(dir, "env.txt");
    const bin = join(dir, "fake-v2");
    await writeFile(bin, `#!/bin/sh\nenv > "${record}"\nexit 3\n`);
    await chmod(bin, 0o755);
    const userConfig = join(dir, "user-config");
    await createManagedOpencodeV2Server({ bin, rootDir: join(dir, "state"), bootTimeoutMs: 5_000, env: { XDG_CONFIG_HOME: userConfig } })
      .then((server) => server.close(), () => undefined);
    const env = await readFile(record, "utf8");
    const configHome = /^XDG_CONFIG_HOME=(.*)$/m.exec(env)?.[1];
    expect(configHome).toBe(join(dir, "state", "xdg-config"));
    expect(env).not.toContain(userConfig);
    expect(env).toMatch(/^OPENCODE_DISABLE_PROJECT_CONFIG=1$/m);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
