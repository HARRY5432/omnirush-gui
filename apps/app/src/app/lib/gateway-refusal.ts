import type { AnalyticsProperties } from "./analytics";

/**
 * Which omnirush.ai refusal an error card shows, for product analytics:
 * a spent allowance or cap (`limit_shown`) or the request policy
 * (`policy_refusal_shown`). Reads only the error's title and technical
 * details, and returns coarse labels, never the text.
 */
export type GatewayRefusalEvent = { event: "limit_shown" | "policy_refusal_shown"; properties: AnalyticsProperties };

const POLICY = /request_policy_refused|OmniRush can[’']t help with this request/i;
const GRANT_DAY = /today[’']s tokens are used up|used today[’']s model allowance/i;
const GRANT_WEEK = /this week[’']s cap is reached/i;
const GRANT_EMPTY = /you have no tokens left/i;
const GRANT = /daily_grant_exhausted/i;
const SESSION_CAP = /session_quality_cap/i;

export function gatewayRefusalEvent(error: { title?: string | null; technicalDetails?: string | null } | null | undefined): GatewayRefusalEvent | null {
  if (!error) return null;
  const text = `${error.title ?? ""}\n${error.technicalDetails ?? ""}`;
  if (POLICY.test(text)) return { event: "policy_refusal_shown", properties: { reason: "request_policy" } };
  if (GRANT_DAY.test(text)) return { event: "limit_shown", properties: { limit_type: "tokens", scope: "day" } };
  if (GRANT_WEEK.test(text)) return { event: "limit_shown", properties: { limit_type: "tokens", scope: "week" } };
  if (GRANT_EMPTY.test(text)) return { event: "limit_shown", properties: { limit_type: "tokens", scope: "empty" } };
  if (GRANT.test(text)) return { event: "limit_shown", properties: { limit_type: "tokens", scope: "unknown" } };
  if (SESSION_CAP.test(text)) return { event: "limit_shown", properties: { limit_type: "session_cap", scope: "session" } };
  return null;
}
