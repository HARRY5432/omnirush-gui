// The notice about a project's own config the engine left out because it could
// run code (its plugins, language server and formatter commands, model
// provider settings). The engine decides what is skipped (OMNIRUSH_PROJECT_CODE=0);
// this file only words the notice and remembers, per project folder, that it
// was shown, so it appears at most once per project.

export type ProjectCodeIgnoredItem = {
  kind: "plugin" | "lsp" | "formatter" | "provider";
  name: string;
  source: string | null;
};

export const PROJECT_CODE_NOTICE_TEXT = "Project plugins and provider settings are off for safety. Your own settings still apply.";
export const PROJECT_CODE_NOTICE_WHY = "A project's own plugins, tools, commands and providers could run code just by opening it. Built-in language servers and formatters still work.";
export const PROJECT_CODE_NOTICE_STORAGE_KEY = "omnirush.project-code-notice.v1";
const MAX_PROJECTS_REMEMBERED = 500;
const MAX_DETAIL_LINES = 12;

type KeyValueStore = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): KeyValueStore | null {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

function pluginName(name: string): string {
  const plain = name.replace(/^file:\/\//, "").replace(/[\\/]+$/, "");
  const base = plain.split(/[\\/]/).pop();
  return base || plain;
}

/** One line per skipped item, for the notice's Details. */
export function projectCodeNoticeDetails(items: ReadonlyArray<ProjectCodeIgnoredItem> | null | undefined): string[] {
  const list = Array.isArray(items) ? items : [];
  const lines: string[] = [];
  const add = (line: string) => {
    if (!lines.includes(line)) lines.push(line);
  };
  for (const item of list) {
    if (item.kind === "plugin") add(`Plugin: ${pluginName(item.name)}`);
    else if (item.kind === "lsp") add(`Language server: ${item.name}`);
    else if (item.kind === "formatter") add(`Formatter: ${item.name}`);
  }
  if (list.some((item) => item.kind === "provider")) add("Model provider settings");
  if (lines.length <= MAX_DETAIL_LINES) return lines;
  return [...lines.slice(0, MAX_DETAIL_LINES), `and ${lines.length - MAX_DETAIL_LINES} more`];
}

function projectKey(project: string): string {
  return project.trim().replace(/[\\/]+$/, "");
}

function readShown(storage: KeyValueStore | null): string[] {
  try {
    const raw = storage?.getItem(PROJECT_CODE_NOTICE_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** True once the notice was shown (or dismissed) for this project folder. */
export function projectCodeNoticeShown(project: string, storage: KeyValueStore | null = defaultStorage()): boolean {
  const key = projectKey(project);
  return Boolean(key) && readShown(storage).includes(key);
}

/** Remember that this project folder has had its notice. */
export function markProjectCodeNoticeShown(project: string, storage: KeyValueStore | null = defaultStorage()): void {
  const key = projectKey(project);
  if (!key) return;
  const shown = readShown(storage).filter((x) => x !== key);
  shown.push(key);
  try {
    storage?.setItem(PROJECT_CODE_NOTICE_STORAGE_KEY, JSON.stringify(shown.slice(-MAX_PROJECTS_REMEMBERED)));
  } catch {
    // Storage full or unavailable: the notice may show again, nothing worse.
  }
}

// Shown this app run, for when local storage is unavailable.
const shownThisRun = new Set<string>();

/**
 * The notice to show for a project, once: null when nothing was skipped or the
 * project already had it. Showing it marks the project as done.
 */
export function takeProjectCodeNotice(
  project: string,
  policy: { ignored?: ReadonlyArray<ProjectCodeIgnoredItem> | null; ignoredNotice?: string | null } | null | undefined,
  storage: KeyValueStore | null = defaultStorage(),
): { id: string; text: string; details: string[] } | null {
  const key = projectKey(project);
  if (!key || !policy) return null;
  let details = projectCodeNoticeDetails(policy.ignored);
  // An older server sends only the long sentence: keep it as the details.
  if (!details.length && policy.ignoredNotice?.trim()) details = [policy.ignoredNotice.trim()];
  if (!details.length) return null;
  if (shownThisRun.has(key) || projectCodeNoticeShown(key, storage)) return null;
  shownThisRun.add(key);
  markProjectCodeNoticeShown(key, storage);
  return { id: `project-code-ignored:${key}`, text: PROJECT_CODE_NOTICE_TEXT, details };
}
