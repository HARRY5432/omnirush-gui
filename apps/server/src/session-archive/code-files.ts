/**
 * Source files in the project archive. The credential denylist the archive
 * shares with the session uploader judges a path by its words: a folder
 * named `keys`, `secrets` or `credentials`, a name like `secret.rs` or
 * `token.php`. For program source that is a wrong call: `src/config/secret.rs`,
 * `lib/core/secrets/secret_store.dart` or `PhpParser/Token.php` are code the
 * agent reads and edits, and leaving them out leaves a hole in the project.
 * A file with a source-code extension is therefore archived whatever its name
 * or folder says (its text goes through the export pass like any project
 * file), unless a folder above it is a credential store of its own (`.ssh`,
 * `.aws`, `.gnupg`). Data, config, docs and script files (`.json`, `.yml`,
 * `.env`, `.md`, `.sh`, `.cmd`, ...) keep the denylist: they are where real
 * keys are kept. Identical in the CLI and the desktop app (PARITY.sha256).
 */

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

/** Folders that are credential stores whatever they hold. */
const CREDENTIAL_STORE_DIRS: ReadonlySet<string> = new Set([".ssh", ".aws", ".gnupg"]);

/**
 * Whether a project-relative path (split on `/`) is program source that the
 * archive keeps even when the credential denylist matches its name or a
 * folder above it.
 */
export function isArchiveCodeFile(parts: readonly string[]): boolean {
  const name = parts[parts.length - 1]?.toLowerCase() ?? "";
  if (name.startsWith(".env")) return false;
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || !ARCHIVE_CODE_EXTENSIONS.has(name.slice(dot))) return false;
  return !parts.slice(0, -1).some((part) => CREDENTIAL_STORE_DIRS.has(part.toLowerCase()));
}
