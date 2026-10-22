// Types of side-question.mjs (the shared module itself is plain JavaScript).

export type EngineMessage = { info: Record<string, any>; parts?: Record<string, any>[] };
export type Snapshot = { text: string; busy: boolean; turnStartedAt: number | null; model: { providerID: string | null; modelID: string; variant: string | null } | null };
export type SideModelOptions = { efforts?: string[] | null; webSearch?: { searchContextSize: string } | null };
export type SideAnswer = { ok: boolean; answer?: string; sources?: string[]; busy?: boolean; error?: string | null };

export const SIDE_QUESTION_EVENT: "side_question";
export const SIDE_EFFORT: string;
export const SNAPSHOT_MESSAGES: number;
export const SNAPSHOT_MAX_CHARS: number;
export const MAX_QUESTION_CHARS: number;
export const MAX_ANSWER_CHARS: number;
export const SIDE_INSTRUCTIONS: string;

export function parseSideQuestion(text: unknown): string | null;
export function buildSnapshot(messages: unknown, options?: { maxChars?: number }): Snapshot;
export function sideRequestBody(input: { modelID: string; sessionId: string; question: string; snapshot: string; effort?: string | null; webSearch?: { searchContextSize: string } | null }): Record<string, unknown>;
export function readSideAnswer(raw: unknown): { answer: string; sources: string[]; usage: { input_tokens: number | null; output_tokens: number | null } | null; error: string | null };
export function sideQuestionEvent(input: Record<string, unknown>): Record<string, unknown>;
export function sideQuestionRoute(deps: {
  readMessages: (sessionId: string, limit: number) => Promise<unknown>;
  askModel: (body: Record<string, unknown>, sessionId: string) => Promise<Response>;
  modelOptions?: (modelID: string) => SideModelOptions | Promise<SideModelOptions>;
  recordTrace?: (sessionId: string, type: string, data: Record<string, unknown>) => void;
  now?: () => number;
}): (input: unknown) => Promise<SideAnswer>;
