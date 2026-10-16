// The desktop's side of automatic compaction (session-archive/auto-compact.ts,
// shared with the CLI): one chat's engine calls through the proxy's engine
// target, and the server's policy read from /collect/capabilities.

import { autoCompactPolicy, type AutoCompactEngine, type AutoCompactPolicy, type ModelRef } from "./session-archive/auto-compact.js";
import { buildOpencodeProxyUrl, projectArchiveEngineReads, type EngineTarget } from "./session-upload-observer.js";
import { loopbackFetch } from "./server-fetch.js";
import type { TraceCapabilities } from "./session-uploader.js";

/** How long an answer of the server counts for an ordinary prompt; a due compaction asks again. */
export const POLICY_MAX_AGE_MS = 60_000;
const FRESH_WAIT_MS = 4_000;

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** The v1 engine `target` for `sessionId`. */
export function desktopAutoCompactEngine(target: EngineTarget, sessionId: string, fetchImpl: Fetch = loopbackFetch): AutoCompactEngine {
  const reads = projectArchiveEngineReads(target, sessionId);
  return {
    messages: () => reads.messages(),
    session: () => reads.session(),
    async busy() {
      const response = await fetchImpl(buildOpencodeProxyUrl(target.baseUrl, "/session/status", target.search), {
        headers: new Headers(target.headers),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) { await response.body?.cancel().catch(() => undefined); return null; }
      const statuses = (await response.json()) as Record<string, { type?: string } | undefined>;
      const type = statuses?.[sessionId]?.type ?? "idle";
      return type === "busy" || type === "retry";
    },
    async summarize(model: ModelRef, signal: AbortSignal) {
      const headers = new Headers(target.headers);
      headers.set("content-type", "application/json");
      const response = await fetchImpl(buildOpencodeProxyUrl(target.baseUrl, `/session/${encodeURIComponent(sessionId)}/summarize`, target.search), {
        method: "POST",
        headers,
        body: JSON.stringify({ providerID: model.providerID, modelID: model.modelID }),
        signal,
      });
      const text = await response.text().catch(() => "");
      if (!response.ok) throw new Error(`summarize answered ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    },
  };
}

/**
 * The server's policy through the broker's capabilities cache: at most
 * POLICY_MAX_AGE_MS old for an ordinary prompt, asked again when `fresh`
 * (bounded). A failed ask keeps the last policy seen; none ever is off.
 */
export function brokerAutoCompactPolicy(read: (options: { strict: true; maxAgeMs: number }) => Promise<TraceCapabilities>) {
  let last: AutoCompactPolicy | null = null;
  return async ({ fresh }: { fresh: boolean }): Promise<AutoCompactPolicy | null> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answer = await Promise.race([
      read({ strict: true, maxAgeMs: fresh ? 0 : POLICY_MAX_AGE_MS }).then((capabilities) => ({ capabilities }), () => null),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), FRESH_WAIT_MS); }),
    ]);
    clearTimeout(timer);
    if (answer) last = autoCompactPolicy(answer.capabilities);
    return last;
  };
}
