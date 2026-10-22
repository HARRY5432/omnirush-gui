/**
 * /btw side questions: POST /workspace/:id/btw { sessionId, question }.
 *
 * Reads the chat from the engine (a plain read: no prompt, steer or queue,
 * never through the engine proxy's capture), asks the model once through the
 * gateway broker exactly like the engine's own calls (the same bearer,
 * client headers and session header, so the gateway meters the usage and
 * counts it to that chat), and records one `side_question` trace event for a
 * chat the uploader tracks. The rules are shared with omnirush-cli:
 * btw/side-question.mjs (PARITY.sha256).
 */
import { sideQuestionRoute, type SideAnswer } from "./btw/side-question.mjs";
import { loopbackFetch } from "./server-fetch.js";
import { buildOpencodeProxyUrl, type EngineTarget } from "./session-upload-observer.js";
import { modelHasWebSearch, type WebSearchSwitch } from "./web-search.js";
import type { OmniRushModelCatalog } from "./omnirush-model-catalog.js";

type Capture = { uploadEnabled: boolean; hasSession(sessionId: string): boolean; recordTrace(sessionId: string, type: string, data: unknown): void };

export type SideQuestionDeps = {
  /** The engine holding the chat, or null (no engine, no such chat). */
  engine: EngineTarget | null;
  /** One model call (a Responses body) for the chat `sessionId`. */
  ask: (body: Record<string, unknown>, sessionId: string) => Promise<Response>;
  catalog: () => Promise<OmniRushModelCatalog>;
  webSearch: () => WebSearchSwitch | null;
  capture?: Capture | null;
  fetchImpl?: typeof fetch;
};

/** The broker's model call for a side question: the engine's own credential, so the same path as the chat's requests. */
export function brokerSideCall(broker: { handle(request: Request, path: string): Promise<Response> }, engineToken: string) {
  return (body: Record<string, unknown>, sessionId: string) => broker.handle(new Request("http://127.0.0.1/omnirush-gateway/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${engineToken}`, "content-type": "application/json", "x-omnirush-session-id": sessionId },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  }), "responses");
}

export async function askSideQuestion(deps: SideQuestionDeps, input: unknown): Promise<SideAnswer> {
  const fetchImpl = deps.fetchImpl ?? loopbackFetch;
  const route = sideQuestionRoute({
    readMessages: async (sessionId, limit) => {
      if (!deps.engine) return [];
      const search = deps.engine.search ? `${deps.engine.search}&limit=${limit}` : `?limit=${limit}`;
      const response = await fetchImpl(buildOpencodeProxyUrl(deps.engine.baseUrl, `/session/${encodeURIComponent(sessionId)}/message`, search), {
        headers: new Headers(deps.engine.headers),
        signal: AbortSignal.timeout(10_000),
      });
      return response.ok ? await response.json() : [];
    },
    askModel: deps.ask,
    modelOptions: async (modelID) => {
      const model = (await deps.catalog().catch(() => [])).find((entry) => entry.id === modelID);
      const search = deps.webSearch();
      return {
        efforts: model?.reasoning_levels?.length ? [...model.reasoning_levels] : null,
        webSearch: model && search && modelHasWebSearch(model, search) ? { searchContextSize: search.searchContextSize } : null,
      };
    },
    recordTrace: (sessionId, type, data) => {
      if (deps.capture?.uploadEnabled && deps.capture.hasSession(sessionId)) deps.capture.recordTrace(sessionId, type, data);
    },
  });
  const record = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  return route({ session: record.sessionId, question: record.question });
}
