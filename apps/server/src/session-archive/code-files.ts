/**
 * Source files in the project archive. The credential denylist the archive
 * shares with the session uploader judges a path by its words: a folder
 * named `keys`, `secrets` or `credentials`, a name like `secret.rs` or
 * `token.php`. For program source that is often a wrong call:
 * `src/config/secret.rs`, `lib/core/secrets/secret_store.dart` or
 * `PhpParser/Token.php` are code the agent reads and edits.
 *
 * The same check applies to a source file whose name or folder only carries
 * such a word (`config/keys.js`, `auth/token.ts`), which the denylist lets
 * through by its extension. Such a file is archived when all of these hold:
 * - it has a program-source extension and no folder above it is a
 *   credential store of its own (`.ssh`, `.aws`, `.gnupg`);
 * - it is not ignored by git (the caller checks that);
 * - it is a regular UTF-8 text file of at most MAX_CODE_CHECK_BYTES;
 * - the client rules (context/redact-policy.ts, source mode) find no
 *   credential in its text.
 * Otherwise it stays out as `credential`. The archive then carries exactly
 * the bytes that were checked. Data, config, docs and script files (`.json`,
 * `.yml`, `.env`, `.md`, `.sh`, `.cmd`, ...) always keep the denylist.
 * Identical in the CLI and the desktop app (PARITY.sha256).
 */
import { createHash } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { open } from "node:fs/promises";

import { redactCredentials } from "../context/redact-policy.js";

/** A denylisted source file larger than this is never read for the check: it stays out. */
export const MAX_CODE_CHECK_BYTES = 1024 * 1024;

/** Program source extensions (lower case, with the dot). */
export const ARCHIVE_CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".m", ".mm",
  ".cs", ".fs", ".vb",
  ".go", ".rs", ".zig", ".nim", ".v",
  ".java", ".kt", ".kts", ".scala", ".groovy", ".clj", ".cljs",
  ".swift", ".dart",
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".vue", ".svelte", ".astro",
  ".py", ".pyi", ".rb", ".php", ".pl", ".pm", ".lua", ".r", ".jl",
  ".ex", ".exs", ".erl", ".hrl", ".hs", ".ml", ".mli", ".elm",
  ".sol", ".proto", ".graphql", ".gql",
]);

/** Words (a path component split on space, `.`, `_`, `-`) that name a credential store; the denylist's word list. */
const CREDENTIAL_WORDS: ReadonlySet<string> = new Set([
  "key", "keys", "secret", "secrets", "token", "tokens", "password", "passwords", "passwd", "credential", "credentials",
  "id_rsa", "id_ed25519", "netrc", "npmrc", "pypirc", "kubeconfig", "wallet", "seed", "mnemonic",
]);
const CREDENTIAL_NAME = /(^|[._-])(?:credentials?|secrets?|private[_-]?keys?)([._-]|$)/i;

/** Folders that are credential stores whatever they hold. */
const CREDENTIAL_STORE_DIRS: ReadonlySet<string> = new Set([".ssh", ".aws", ".gnupg"]);

const READ_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0) | (fsConstants.O_NOCTTY ?? 0);
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Whether a project-relative path (split on `/`) is program source that may
 * be archived although the credential denylist matches its name or a folder
 * above it, subject to the content check (readCleanCodeFile).
 */
export function isArchiveCodeFile(parts: readonly string[]): boolean {
  const name = parts[parts.length - 1]?.toLowerCase() ?? "";
  if (name.startsWith(".env")) return false;
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || !ARCHIVE_CODE_EXTENSIONS.has(name.slice(dot))) return false;
  return !parts.slice(0, -1).some((part) => CREDENTIAL_STORE_DIRS.has(part.toLowerCase()));
}

/**
 * Whether a source file is checked by content before it is archived: its
 * name or a folder above it reads like a credential store (whether or not
 * the denylist itself already leaves it out).
 */
export function needsCodeCheck(parts: readonly string[]): boolean {
  if (!isArchiveCodeFile(parts)) return false;
  return parts.some((part) => {
    const lower = part.toLowerCase();
    if (CREDENTIAL_NAME.test(lower)) return true;
    const words = lower.split(/[\s._-]+/).filter(Boolean);
    return words.some((word, index) => CREDENTIAL_WORDS.has(word) || (index > 0 && CREDENTIAL_WORDS.has(`${words[index - 1]}_${word}`)));
  });
}

export type CleanCodeFile = { bytes: Buffer; sha256: string };

/**
 * The content check of a denylisted source file at `absolute` (`rel` its
 * project-relative portable path): its bytes and their SHA-256 when it is a
 * regular file (`sameFile` confirms it is the one the scan lstat'ed) of at
 * most MAX_CODE_CHECK_BYTES, valid UTF-8 without NUL bytes, in which the
 * client credential rules find nothing; null otherwise (it stays out).
 */
export async function readCleanCodeFile(absolute: string, rel: string, sameFile: (stats: BigIntStats) => boolean): Promise<CleanCodeFile | null> {
  if (!isArchiveCodeFile(rel.split("/"))) return null;
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(absolute, READ_FLAGS);
  } catch {
    return null;
  }
  try {
    const stats = await handle.stat({ bigint: true });
    if (!stats.isFile() || !sameFile(stats) || stats.size > BigInt(MAX_CODE_CHECK_BYTES)) return null;
    const bytes = Buffer.alloc(Number(stats.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) return null;
      offset += bytesRead;
    }
    if (bytes.includes(0)) return null;
    let text: string;
    try {
      text = UTF8.decode(bytes);
    } catch {
      return null;
    }
    if (redactCredentials(text, { context: rel, mode: "source" }).count > 0) return null;
    return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}
