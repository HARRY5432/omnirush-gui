// Types of mcp-allow.mjs (the same pair of files in omnirush-cli src/mcp/ and
// omnirush-gui apps/server/src/mcp-allow/; PARITY.sha256).

export const MCP_POLICY_FILE_VERSION: 1;
export const MCP_REASONS: Record<McpDecisionCode, string>;

export type McpRuntime = "npm" | "pypi";
export type McpDecisionCode =
  | "allowed" | "disabled" | "remote" | "unknown_command" | "not_allowed" | "denied"
  | "version" | "outside_project" | "missing_flag" | "missing_arg" | "flag" | "duplicate" | "invalid";

export type McpRules = {
  path_args?: "positional";
  min_args?: number;
  default_args?: string[];
  path_flags?: string[];
  require_flags?: string[];
  add_flags?: string[];
  forbid_flags?: string[];
  path_env?: Record<string, string>;
  local_urls?: boolean;
  path_inputs?: string[];
};

export type McpAllowEntry = {
  id: string;
  runtime: McpRuntime;
  package: string;
  bins: string[];
  versions: string;
  pin: string | null;
  title: string;
  why: string | null;
  rules: McpRules;
};

export type McpPolicy = {
  enabled: boolean;
  allow: McpAllowEntry[];
  deny: Array<{ match: string; reason: string | null }>;
  message: string | null;
};

export type McpDecision = {
  name: string;
  status: "allowed" | "blocked";
  code: McpDecisionCode;
  reason?: string;
  id?: string;
  package?: string;
  runtime?: McpRuntime;
  title?: string;
  version?: string;
  sandbox?: boolean;
  renamed_to?: string;
  url_host?: string | null;
  notes?: string[];
};

export type McpBox = { shell: string; key: string; croot?: string | null };

export type McpReport = { v: 1; root: string; at: number; enabled: boolean; decisions: McpDecision[] };

export type McpLaunch = {
  runtime: McpRuntime;
  name: string;
  version: string | null;
  bin: string | null;
  specIndex: number;
  rest: string[];
  restIndex: number;
};

export function versionParts(value: unknown): number[] | null;
export function versionInRange(version: unknown, range: unknown): boolean;
export function validRange(range: unknown): boolean;
export function normalizePolicy(block: unknown): McpPolicy | null;
export function splitSpec(spec: string, runtime: McpRuntime): { name: string; version: string | null } | null;
export function parseLaunch(command: unknown): McpLaunch | null;
export function insideRoot(root: string, p: string, platform?: string): boolean;
export function shellQuote(word: string): string;
export function evaluateMcp(
  mcpMap: unknown,
  policy: McpPolicy | null,
  ctx?: { root?: string; platform?: string; box?: McpBox | null },
): { mcp: Record<string, Record<string, unknown>>; decisions: McpDecision[] };
export function toolPrefix(name: string): string;
export function toolRefusal(
  state: { localOnly?: string[]; pathInputs?: Array<{ id: string; keys: string[] }>; roots?: Array<{ root: string; platform: string }> },
  tool: unknown,
  args: unknown,
): string | null;
export function readPolicyFile(file: string | null | undefined): McpPolicy | null;
export function writePolicyFile(file: string, block: unknown, now?: number): string;
export function reportPath(dir: string, root: string): string;
export function readReport(dir: string, root: string): McpReport | null;
export function describeDecision(d: McpDecision): string;
export function createMcpPolicyHooks(options?: {
  directory?: string;
  policyFile?: string | null;
  reportDir?: string | null;
  box?: McpBox | null | ((root: string) => McpBox | null);
  platform?: string;
  now?: () => number;
}): {
  config: (input: unknown, output?: unknown) => Promise<void>;
  "tool.execute.before": (input: { tool?: unknown; args?: unknown }, output?: { args?: unknown }) => Promise<void>;
};
