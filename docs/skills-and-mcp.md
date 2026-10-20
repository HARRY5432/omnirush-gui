# Skills and MCP servers in the omnirush.ai desktop app

This document describes how a user adds a skill and an MCP server in the desktop app, where the files live, how they reach the bundled engine (the OpenCode sidecar that serves the omnirush.ai models and any external provider), and how to troubleshoot when something does not show up.

The same flows apply to every model: the omnirush.ai models (GPT 6 Astra, GPT-5.6 Sol and any other model the account's catalog lists, such as Meta Muse, via the local gateway broker) and external providers (OpenAI, Anthropic, and others) all run in the same engine and see the same skills and MCP tools.

## Moving parts

| Piece | Where | Role |
| --- | --- | --- |
| Desktop shell | `apps/desktop/electron/main.mjs` | Starts the local server (embedded) with the bundled engine sidecar, holds the omnirush.ai account credentials. |
| Local server | `apps/server/src/server.ts` and friends | HTTP API the app talks to (`/workspace/:id/skills`, `/workspace/:id/mcp`), owns the runtime DB and the engine-visible config file. |
| Engine sidecar | `apps/desktop/resources/sidecars/opencode-*` (`opencode serve`) | Loads skills from disk, connects MCP servers, exposes the `skill` tool and MCP tools to the model. |
| Settings UI | `apps/app/src/react-app/domains/settings/pages/extensions-view.tsx`, `mcp-view.tsx`, `library-add-*.tsx` | The Library: lists skills and MCP servers, adds and removes them. |

## Skills

### What a skill is

A skill is a folder with a `SKILL.md` file. The file has YAML frontmatter with a `name` (kebab-case, 1-64 characters) and a `description` (1-1024 characters, tells the model when to use it) followed by the instructions in Markdown:

```markdown
---
name: release-notes
description: Draft release notes from the git log for this workspace.
---
# Release notes

## When to use
- When the user asks for release notes or a changelog.

## Steps
1. Run git log since the last tag.
2. Group commits by area.
3. Write concise bullets.
```

The engine registers the skill under the frontmatter `name`. The description is what the model sees in its skill catalog; the body is loaded on demand through the engine's native `skill` tool.

### Where skills live

The engine scans these locations (project first, then global):

| Scope | Path | Notes |
| --- | --- | --- |
| Workspace | `<workspace>/.opencode/skills/<name>/SKILL.md` | What the desktop app writes. |
| Workspace | `<workspace>/.opencode/skill/<name>/SKILL.md` | OpenCode's documented singular spelling; the app lists these too. |
| Workspace | `<workspace>/.claude/skills/<name>/SKILL.md` | Claude Code compatible layout. |
| Global | `~/.config/opencode/skills/` or `~/.config/opencode/skill/` | Honours `OPENCODE_CONFIG_DIR` and `XDG_CONFIG_HOME`. |
| Global | `~/.claude/skills/`, `~/.agents/skills/` | External skills, auto-loaded by the engine. |

Nested layouts such as `.opencode/skills/<plugin>/<name>/SKILL.md` (what marketplace plugin bundles install) are listed and can be removed from the app as well.

The workspace root is the folder that contains `.git`; the server walks up from the selected folder to find it, which matches how the engine resolves the project.

### Adding a skill in the desktop app

1. Open Settings, then Library (the Extensions tab). Choose the Skills filter.
2. Click Add, choose Skill.
   - Signed in to an omnirush.ai Cloud organization: the Cloud authoring modal opens and the skill is stored in the organization Library (a private plugin). It reaches the engine through omnirush.ai Connect.
   - Signed in with an omnirush.ai account only (or not signed in to Cloud): the workspace skill modal opens. Enter the name, the description and the Markdown body. The app sends `POST /workspace/:id/skills` to the local server, which validates the name and description, adds the frontmatter, writes `.opencode/skills/<name>/SKILL.md`, records an audit entry and emits a `skills` reload event.
3. The Library refreshes and shows the new skill card with its path. Open it to read the content or reveal the file in Finder.
4. Reload the engine when the app prompts for it (see Troubleshooting for why this matters).

To remove a skill, open its card and choose Remove. The server deletes the skill folder (`DELETE /workspace/:id/skills/:name`) and emits a `skills` reload event. Skills that come from omnirush.ai Connect cannot be removed locally.

You can also drop a `SKILL.md` folder into `.opencode/skills/` by hand; the server's reload watcher notices `SKILL.md` changes under `.opencode/skills` and marks a reload as required.

### How skills reach the engine

Skills are files, not config. The engine reads them from disk when it builds its project instance:

- The engine-visible config file (`runtime-opencode-config.json` in the server state directory, passed as `OPENCODE_CONFIG`) does not contain skills. It contains the omnirush.ai provider block, the plugins, the `omnirush` agent definition (which denies the engine's own `customize-opencode` and creator skills).
- The engine scans the skill directories when it creates the instance for the workspace directory. `GET /skill` on the engine (proxied by the server for the v2 preview as `/api/skill`) returns the catalog with `name`, `description`, `location` and `content`.
- The catalog is cached for the life of the instance. A new, changed or removed skill becomes visible after the instance is rebuilt (`POST /instance/dispose` on the engine), which the app calls the engine reload.

The server's list (`GET /workspace/:id/skills?includeGlobal=true`) reads the same directories directly from disk, so it always shows the current files even before the engine has reloaded.

## MCP servers

MCP servers follow the account's list of supported servers: local servers that work on the project's own files and can be started again the same way, so a session that used them can be repeated. Examples on the default list: filesystem, git, SQLite, memory, sequential thinking, time, and Playwright on local pages. Remote and account-linked servers (Notion, Linear, GitHub, Slack, omnirush.ai Connect, managed OAuth sign-ins, MCP apps) are not supported: their answers come from an outside service or account.

### The list

- The backend sends the list in `GET /omnirush/collect/capabilities` as `mcp: {enabled, allow, deny, message}`. The server remembers the last one it saw in `<server state>/mcp/policy.json` (read at every start and refreshed while the app runs; a failed read keeps the last one; an answer without the block, or none ever seen, is MCP off).
- `apps/server/src/mcp-allow/mcp-allow.mjs` applies it. The same file ships in the OmniRush CLI (`src/mcp/`); `PARITY.sha256` lists both copies.
- An entry is allowed only when it starts a package on the list through `npx`/`bunx`/`pnpm dlx`/`yarn dlx`/`npm exec` (npm) or `uvx`/`uv tool run` (PyPI), at a version in the entry's range (left out: the entry's pinned version), and every file or folder it works on is inside the project. Allowed servers are renamed to the entry's id, so their tools are always `<id>_<tool>`.

### Adding an MCP server in the desktop app

1. Open Settings, then MCP. The supported servers are listed with what they do and the command each adds (for example `npx -y @modelcontextprotocol/server-filesystem .` or `npx -y mcp-server-sqlite-npx data.db`). Click Add; or use Add, MCP server, with your own command line.
2. The app sends `POST /workspace/:id/mcp` with `{ name, config }`. The server checks the entry against the list and refuses it with the reason when it is not supported; otherwise it stores it in the workspace row of the runtime DB and in `<server state>/mcp/workspaces/<project>.json` for the engine, records an audit entry and emits an `mcp` reload event (the app reloads the project's engine).
3. Each configured server shows On (its package and version, and "runs in the sandbox" when the project's Linux sandbox is on) or Blocked with the reason.

To remove a server added in the app, choose Remove (`DELETE /workspace/:id/mcp/:name`).

### Where MCP config lives

- Servers added in the app: the workspace row of the runtime DB. They are never written into the project's `opencode.json`.
- Entries in `<workspace>/opencode.json`, `<workspace>/.opencode/opencode.json` or `~/.config/opencode/opencode.json`: read by the engine directly; the list applies to them too. The app lists them as project or global entries (read-only).
- The engine-global row never stores MCP entries; the engine-visible config file has no `mcp` key.

### How MCP servers reach the engine

- The server gives the engine `OMNIRUSH_MCP_POLICY_FILE`, `OMNIRUSH_MCP_REPORT_DIR` and `OMNIRUSH_MCP_WORKSPACE_DIR`. The engine plugin `omnirush-mcp-policy` (always loaded, last in the plugin list) adds the project's app-added servers to its config, then replaces `mcp` with the allowed servers only, keyed by id, pinned, paths checked, and run through the sandbox shell when the project's sandbox is on. It writes a report per project (`<server state>/mcp/reports/`) with one decision per entry; `GET /workspace/:id/mcp` returns it.
- Nothing is pushed into a running engine: an added server starts when the project's engine instance reloads. The engine's own routes that would add a server at runtime or run its OAuth flow are refused; listing and connect/disconnect pass.
- Playwright opens pages on this machine only (localhost); other pages are refused before the tool runs.
- MCP tools reach the model as `<id>_<tool>` and are asked about like other tools (no allow rules are added for them).
- The preview engine (v2) cannot apply the list: MCP stays off there (its servers are removed before each request, and a prompt in a project with MCP servers is refused with a message).
- Uploads: a session in a project with at least one server on gets `environment.mcp_servers: [{id, package, version, runtime, sandbox}]`; other sessions upload exactly as before.

### Coexistence with the omnirush.ai provider

The engine-visible config file is rendered from the engine-global runtime row plus static built-ins:

- `provider.omnirush` (the omnirush.ai models, `baseURL` pointing at the local gateway broker) is added after any runtime `provider` entries, so a runtime provider with the same id cannot shadow it.
- `disabled_providers` is copied through untouched.
- `model` defaults to the account catalog's default model (`omnirush/gpt-6-astra`) when the account is signed in. The `omnirush` provider's models come from the catalog the server syncs from `GET /omnirush/v1/models` (ids, names, efforts, limits and input types only); its package, base URL and credentials never do.

Adding skills or MCP servers never modifies the provider block.

## Verified end to end

The flows above were exercised against the bundled sidecar (`opencode` 1.18.18, `opencode serve`) in an isolated `HOME` with the server started through the embedded API and a loopback stub as the gateway:

- `POST /workspace/:id/skills` wrote `.opencode/skills/release-notes/SKILL.md`; `GET /workspace/:id/skills` and `GET /workspace/:id/skills/release-notes` returned it with the trigger extracted from the "When to use" section. After an engine instance rebuild, the engine's `GET /skill` listed it with the exact body; the generated config file kept `provider.omnirush`, `model`, the 11 plugins and no `mcp` key unchanged.
- `POST /workspace/:id/mcp` with a supported server stores it for the engine plugin; after the project's engine reloads, the plugin's report lists it as allowed (pinned version), and entries off the list as blocked with the reason (`engine-plugin-bridge.e2e.test.ts`, `omnirush-ui-mcp-guard.e2e.test.ts`).

## Troubleshooting

**A new or edited skill is listed in the Library but the model does not use it.**
The engine caches its skill catalog per project instance and needs an instance rebuild after skill changes. In the bundled desktop configuration the Reload action goes through the engine pool, which skips the reload when nothing in the engine config file changed; skill files are not part of that fingerprint, so a reload requested only for a skill change is currently a no-op (the server needs to pass the pool's `manual` flag for user-initiated reloads). Until that lands, use Restart OpenCode in Settings, Advanced, or quit and reopen the app. The v2 engine preview watches skill files natively and does not need this.

**The skill is not listed at all.**
- Check the file name: it must be exactly `SKILL.md` inside its own folder.
- Check the frontmatter: `name` must be kebab-case and `description` must be present. Invalid YAML is listed with an `ERROR: Invalid skill frontmatter` description so you can fix it.
- The app lists `.opencode/skills`, `.opencode/skill` and `.claude/skills` under the git root, plus the global folders when the workspace is local. A skill placed above the git root is not a workspace skill.
- Two skills with the same name: the first one found wins (workspace before global).

**An MCP server shows Blocked.**
The reason says why: not on the supported list, a version outside the supported range, a file or folder outside the project, a remote server, or a command the app cannot name (start it with `npx` or `uvx` and the package name). Edit the entry, or use one of the supported servers in Settings, MCP.

**An MCP server I just added does not show On yet.**
It starts when the project's engine reloads (the app reloads it after an add). The status says "Checked when the project's next chat starts" until then.

**The app reports "Configuration is invalid at … V2 permissions are not supported by OmniRush V1", or a workspace answers `opencode_config_invalid`.**
The bundled engine is OpenCode V1 (pinned in `constants.json`). Since engine 1.18.32 a `permissions` key in a user-owned `opencode.json(c)` — top level, or under `agent`, `agents` or `mode.<name>` — is rejected instead of ignored. The server checks those files before spawning the engine: a `permissions` key in the global file (`~/.config/opencode/opencode.json(c)`, `config.json`, or the `OPENCODE_CONFIG_DIR` directory) stops startup with the message above naming the file; a `permissions` key in `<workspace>/.opencode/opencode.json(c)` or `<workspace>/opencode.json(c)` is logged as a warning, the engine still starts, server routes that read the engine for that workspace return `422 opencode_config_invalid` with the engine's message and the file path in `details`, and the native engine proxy passes the engine's own `400 ConfigInvalidError` body through unchanged. Other V2-only keys (`plugins`, `providers`, `websearch`, `warming`, …) are dropped with a "configuration compatibility diagnostic" warning in the engine log and do not block anything. Fix: rename `permissions` to `permission` (V1 rules) or remove it, then restart OmniRush.ai.

**Which engine does the app run?**
OmniRush.ai's own build of opencode 1.18.32, the engine the OmniRush CLI ships (release `engine-1.18.32-r2` of omnirush-ai/omnirush-cli, copied to the public pre-release `engine-1.18.32-r2` of this repo, which is never marked latest; sha256-pinned per platform in `apps/desktop/scripts/engine-release.json`; `prepare-sidecar.mjs` downloads it without a token, or takes a local copy from `OMNIRUSH_ENGINE_ARCHIVE`). The server starts it directly (`managed-opencode.ts`) and OmniRush.ai's engine plugins load from the `plugin` list of the runtime config. Desktop 2.2.0 – 3.x ran the opencode 2.x engine behind an adapter; that adapter is gone.

**My sessions from desktop 2.2.0 – 3.x: are they still there?**
Yes. The 2.x engine kept them (and the 1.x sessions of earlier releases, which it moved in on its first start) in `~/.local/share/opencode/opencode.db`, in tables the 1.x engine cannot read. The first start of this release copies every session from there into the engine's own store, once (`apps/server/src/engine2/import.ts`):
- the 2.x store is opened read-only and never changed, so an older OmniRush.ai still opens it;
- each session becomes the 1.x export document (`apps/server/src/engine2/shapes.ts`: messages, tool calls and their results exactly as the 2.x engine recorded them, sub-agent sessions with their parents) and the engine writes it itself with `opencode import`, run in the session's folder with no plugins, no project or user config and no network; ids are kept, so a session is never written twice;
- the import runs in the background after the engine started; sessions appear in the session lists as they are written;
- an imported session keeps its earlier turns exactly as the 2.x engine recorded them; when it is continued, its uploads carry `environment.imported_from` (for example `opencode 2.0.18`), and the session record keeps its 2.x `version`;
- progress is recorded in `<userData>/engine-data/omnirush/desktop-engine2-import.json`: a session whose folder no longer exists is skipped and imported once the folder is back, a session the engine refuses is tried again on the next starts (three times at most) and the reason is kept there;
- `OMNIRUSH_ENGINE2_IMPORT=0` turns the import off; a run with an explicit `OPENCODE_DB` skips it.
Provider and MCP sign-ins the engine kept as files in `~/.local/share/opencode/` (`auth.json`, `mcp-auth.json`) are copied into the engine's data directory (`<userData>/engine-data/omnirush/`) once, never over a file already there. The 2.x engine kept newer sign-ins inside its database; those are not copied and have to be signed in again.

**Where are the files?**
- Server state directory: `~/.config/omnirush/` (or the directory of `OMNIRUSH_SERVER_CONFIG`), containing `runtime.sqlite` (runtime DB), `runtime-opencode-config.json` (engine-visible config) and `mcp/` (the remembered MCP list, the plugin's reports and the app-added servers).
- Engine data: `<userData>/engine-data/omnirush/` (the `opencode.db` session database, snapshots, sign-ins, logs under `log/`), the app's own: the OmniRush CLI's engine keeps its data in `~/.local/share/omnirush/` and never sees the app's sessions. The engine runs with `XDG_DATA_HOME=<userData>/engine-data`; commands the agent runs get the user's own `XDG_DATA_HOME` back. `OMNIRUSH_ENGINE_DATA_HOME` overrides the location. The engine also reads the global opencode config directory (`~/.config/opencode/`, or `OPENCODE_CONFIG_DIR`) for the app's global skills and config.
- The 2.x engine's store of desktop 2.2.0 – 3.x: `~/.local/share/opencode/opencode.db` (read once by the import above, never written).
- Audit log: `<workspace>/.opencode/` audit entries record every skill and MCP change with the actor.

## API summary

| Action | Request |
| --- | --- |
| List skills | `GET /workspace/:id/skills?includeGlobal=true` |
| Read a skill | `GET /workspace/:id/skills/:name` |
| Add or update a skill | `POST /workspace/:id/skills` `{ name, description, content }` |
| Remove a skill | `DELETE /workspace/:id/skills/:name` |
| List MCP servers | `GET /workspace/:id/mcp` (items with each one's `decision`, and `mcpPolicy`: `enabled`, `message`, `supported` presets, `decisions`) |
| Add an MCP server | `POST /workspace/:id/mcp` `{ name, config }` (refused with the reason when not supported) |
| Pause or resume | `POST /workspace/:id/mcp/:name/enabled` `{ enabled }` |
| Remove a server | `DELETE /workspace/:id/mcp/:name` |
| Reload the engine | `POST /workspace/:id/engine/reload` |

All write routes require a client token with collaborator scope and go through the approval service (`auto` in the desktop app).
