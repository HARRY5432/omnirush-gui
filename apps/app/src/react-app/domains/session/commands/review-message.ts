// Reading the engine's review layout (its `review` command template):
//   Reviewed: <what> (<N> files)
//   ### Critical | ### High | ### Medium | ### Low
//   N. path/to/file.ext:LINE - short title
//      one to three lines
//   ...
//   Reply **fix these** to fix them all (or for example **fix 1, 3**), or run /fix.
// and the user messages the `review` / `fix` commands expand into.

export type ReviewSeverity = "critical" | "high" | "medium" | "low";

export type ReviewIssue = {
  number: number;
  severity: ReviewSeverity;
  path: string;
  line: number | null;
  title: string;
};

export type ReviewSummary = {
  reviewed: string | null;
  issues: ReviewIssue[];
  counts: Record<ReviewSeverity, number>;
  /** The reply offers "fix these" (at least one issue). */
  fixable: boolean;
  clean: boolean;
};

export const REVIEW_SEVERITIES: ReviewSeverity[] = ["critical", "high", "medium", "low"];

const HEADING_RE = /^#{2,4}\s*(Critical|High|Medium|Low)\s*$/i;
const ITEM_RE = /^\s*(\d+)\.\s+`?([^\s`:][^`:]*?)(?::(\d+))?`?\s+[-–—]\s+(.+?)\s*$/;
const FIX_LINE_RE = /reply\s+\*\*fix these\*\*/i;
const REVIEWED_RE = /^\s*Reviewed:\s*(.+?)\s*$/im;

/** The review in an assistant reply, or null when the reply is not one. */
export function parseReviewReply(text: string | null | undefined): ReviewSummary | null {
  if (!text) return null;
  const reviewed = REVIEWED_RE.exec(text)?.[1] ?? null;
  const fixable = FIX_LINE_RE.test(text);
  const clean = /^\s*No issues found\.\s*$/im.test(text);
  const issues: ReviewIssue[] = [];
  let severity: ReviewSeverity | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const heading = HEADING_RE.exec(raw.trim());
    if (heading?.[1]) {
      severity = heading[1].toLowerCase() as ReviewSeverity;
      continue;
    }
    if (!severity) continue;
    const item = ITEM_RE.exec(raw);
    if (!item?.[1] || !item[2] || !item[4]) continue;
    issues.push({
      number: Number(item[1]),
      severity,
      path: item[2].trim(),
      line: item[3] ? Number(item[3]) : null,
      title: item[4].replace(/\*\*/g, "").trim(),
    });
  }
  if (!reviewed && !fixable && issues.length === 0) return null;
  if (!fixable && issues.length === 0 && !clean) return null;
  const counts: Record<ReviewSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const issue of issues) counts[issue.severity] += 1;
  return { reviewed, issues, counts, fixable: fixable || issues.length > 0, clean: clean && issues.length === 0 };
}

const REVIEW_TEMPLATE_START = "You are a code reviewer.";
const FIX_TEMPLATE_START = "Fix the issues from the code review above.";

/**
 * The short label of a user message the `review` or `fix` command expanded
 * into ("/review", "/review main", "/fix 1, 3"), or null for any other text.
 */
export function commandTemplateLabel(text: string | null | undefined): string | null {
  const value = text?.trimStart() ?? "";
  if (value.startsWith(REVIEW_TEMPLATE_START)) {
    const input = /^Input:[ \t]*(.*)$/m.exec(value)?.[1]?.trim() ?? "";
    return input ? `/review ${input}` : "/review";
  }
  if (value.startsWith(FIX_TEMPLATE_START)) {
    const rest = value.slice(FIX_TEMPLATE_START.length).split(/\r?\n/)[0]?.trim() ?? "";
    return rest ? `/fix ${rest}` : "/fix";
  }
  return null;
}

/**
 * The review a turn's reply holds, only when the turn was the review command
 * (its user message is the review template) and the reply opens with the
 * template's `Reviewed:` line; null for any other reply, however it is laid out.
 */
export function reviewForTurn(userText: string | null | undefined, replyText: string | null | undefined): ReviewSummary | null {
  const typed = (userText ?? "").trimStart();
  if (!commandTemplateLabel(userText)?.startsWith("/review") && !/^\/review(\s|$)/.test(typed)) return null;
  const firstLine = (replyText ?? "").split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
  if (!firstLine.startsWith("Reviewed:")) return null;
  return parseReviewReply(replyText);
}

const SEVERITY_LABEL: Record<ReviewSeverity, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };

export function severityLabel(severity: ReviewSeverity): string {
  return SEVERITY_LABEL[severity];
}
