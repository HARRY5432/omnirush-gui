// Before a sign-out: what is still queued for upload goes first, for a few
// seconds at most (the server's POST /omnirush/capture/flush). What does not
// go by then stays on this computer for the account, and is sent after its
// next sign-in; another account never sends it.
import { createOmniRushServerClient } from "../../../app/lib/omnirush-server";
import { resolveOmniRushConnection } from "../../shell/omnirush-connection";

export type PendingUploadsClient = {
  getPendingUploads(): Promise<{ uploads: number; archives: number }>;
  flushPendingUploads(): Promise<{ before: number; after: number }>;
};

export function sendingPendingLine(count: number): string {
  return `Sending ${count} pending upload${count === 1 ? "" : "s"}…`;
}

export function keptPendingLine(count: number): string {
  return `${count} upload${count === 1 ? " is" : "s are"} kept on this computer and sent after you sign in to this account again.`;
}

/** Sends what is queued (bounded by the server); resolves with how many are still kept. Never throws. */
export async function sendPendingBeforeSignOut(say: (text: string) => void, client?: PendingUploadsClient | null): Promise<number> {
  try {
    let target = client ?? null;
    if (!target) {
      const connection = await resolveOmniRushConnection();
      if (!connection.normalizedBaseUrl || !connection.resolvedToken) return 0;
      target = createOmniRushServerClient({ baseUrl: connection.normalizedBaseUrl, token: connection.resolvedToken, hostToken: connection.resolvedHostToken });
    }
    const pending = await target.getPendingUploads();
    const count = pending.uploads + pending.archives;
    if (count === 0) return 0;
    say(sendingPendingLine(count));
    const result = await target.flushPendingUploads();
    return result.after;
  } catch {
    // An older server without the routes, or unreachable: nothing is deleted at the sign-out either way.
    return 0;
  }
}
