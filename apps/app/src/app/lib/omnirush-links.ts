import { DEFAULT_DEN_BASE_URL, denOriginComparisonKey, normalizeDenBaseUrl, resolveDenBaseUrls } from "./den";
import { normalizeOmniRushServerUrl } from "./omnirush-server";

export type RemoteWorkspaceDefaults = {
  omnirushHostUrl?: string | null;
  omnirushToken?: string | null;
  directory?: string | null;
  displayName?: string | null;
  autoConnect?: boolean;
};

export type DenAuthDeepLink = {
  grant: string;
  denBaseUrl: string;
};

export type ConnectDeepLink = {
  /** The full deep link, relayed verbatim to the main process for verification. */
  rawUrl: string;
  key: string;
};

function isSupportedDeepLinkProtocol(protocol: string): boolean {
  const normalized = protocol.toLowerCase();
  return normalized === "omnirush:"
    || normalized === "omnirush-dev:"
    || normalized === "https:"
    || normalized === "http:";
}

export function parseRemoteConnectDeepLink(rawUrl: string): RemoteWorkspaceDefaults | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const protocol = url.protocol.toLowerCase();
  if (!isSupportedDeepLinkProtocol(protocol)) {
    return null;
  }

  const routeHost = url.hostname.toLowerCase();
  const routePath = url.pathname.replace(/^\/+/, "").toLowerCase();
  const routeSegments = routePath.split("/").filter(Boolean);
  const routeTail = routeSegments[routeSegments.length - 1] ?? "";
  if (routeHost !== "connect-remote" && routePath !== "connect-remote" && routeTail !== "connect-remote") {
    return null;
  }

  const hostUrlRaw = url.searchParams.get("omnirushHostUrl") ?? url.searchParams.get("omnirushUrl") ?? "";
  const tokenRaw = url.searchParams.get("omnirushToken") ?? url.searchParams.get("accessToken") ?? "";
  const normalizedHostUrl = normalizeOmniRushServerUrl(hostUrlRaw);
  const token = tokenRaw.trim();
  if (!normalizedHostUrl || !token) {
    return null;
  }

  const workerName = url.searchParams.get("workerName")?.trim() ?? "";
  const workerId = url.searchParams.get("workerId")?.trim() ?? "";
  const displayName = workerName || (workerId ? `Worker ${workerId.slice(0, 8)}` : "");
  const autoConnectRaw =
    url.searchParams.get("autoConnect") ??
    url.searchParams.get("bypassModal") ??
    url.searchParams.get("bypassAddWorkerModal") ??
    "";
  const autoConnect = ["1", "true", "yes", "on"].includes(autoConnectRaw.trim().toLowerCase());

  return {
    omnirushHostUrl: normalizedHostUrl,
    omnirushToken: token,
    directory: null,
    displayName: displayName || null,
    autoConnect,
  };
}

export function stripRemoteConnectQuery(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  let changed = false;
  for (const key of [
    "omnirushHostUrl",
    "omnirushUrl",
    "omnirushToken",
    "accessToken",
    "workerId",
    "workerName",
    "autoConnect",
    "bypassModal",
    "bypassAddWorkerModal",
    "source",
  ]) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }

  if (!changed) {
    return null;
  }

  const search = url.searchParams.toString();
  return `${url.pathname}${search ? `?${search}` : ""}${url.hash}`;
}

export function parseDenAuthDeepLink(rawUrl: string): DenAuthDeepLink | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const protocol = url.protocol.toLowerCase();
  if (!isSupportedDeepLinkProtocol(protocol)) {
    return null;
  }

  const routeHost = url.hostname.toLowerCase();
  const routePath = url.pathname.replace(/^\/+/, "").toLowerCase();
  const routeSegments = routePath.split("/").filter(Boolean);
  const routeTail = routeSegments[routeSegments.length - 1] ?? "";
  if (routeHost !== "den-auth" && routePath !== "den-auth" && routeTail !== "den-auth") {
    return null;
  }

  const grant = url.searchParams.get("grant")?.trim() ?? "";
  const denBaseUrl = normalizeDenBaseUrl(url.searchParams.get("denBaseUrl")?.trim() ?? "") ?? DEFAULT_DEN_BASE_URL;
  if (!grant) {
    return null;
  }

  return {
    grant,
    denBaseUrl,
  };
}

export type DenAuthDeepLinkReview =
  | { kind: "blocked"; host: string }
  | { kind: "confirm"; host: string; currentHost: string | null };

function hostOf(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return "";
  }
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

/**
 * A den-auth link signs the app in to the control plane it names, so it may
 * only name one this device is already set up for (`configuredBaseUrls`:
 * build default, desktop bootstrap or confirmed connect link, local gateway,
 * development overrides), and the user always confirms it. `allowLoopback`
 * also accepts local control planes in development builds.
 */
export function reviewDenAuthDeepLink(input: {
  denBaseUrl: string;
  configuredBaseUrls: ReadonlyArray<string | null | undefined>;
  currentBaseUrl: string | null;
  allowLoopback: boolean;
}): DenAuthDeepLinkReview {
  const target = resolveDenBaseUrls(input.denBaseUrl);
  const host = hostOf(target.baseUrl);
  const allowed = new Set<string>();
  for (const configured of input.configuredBaseUrls) {
    if (!normalizeDenBaseUrl(configured)) continue;
    const resolved = resolveDenBaseUrls(configured);
    for (const value of [configured, resolved.baseUrl, resolved.apiBaseUrl]) {
      const origin = denOriginComparisonKey(value);
      if (origin) allowed.add(origin);
    }
  }
  const targetOrigins = [target.baseUrl, target.apiBaseUrl].map((value) => denOriginComparisonKey(value));
  const permitted = targetOrigins.every((origin) => (
    origin !== null && (allowed.has(origin) || (input.allowLoopback && isLoopbackOrigin(origin)))
  ));
  if (!host || !permitted) return { kind: "blocked", host };
  const currentHost = input.currentBaseUrl ? hostOf(resolveDenBaseUrls(input.currentBaseUrl).baseUrl) : "";
  return { kind: "confirm", host, currentHost: currentHost && currentHost !== host ? currentHost : null };
}

/** Development-only extra control planes, comma-separated (VITE_DEN_ALLOWED_ORIGINS). */
export function readDevAllowedDenOrigins(): string[] {
  const raw = typeof import.meta !== "undefined" && typeof import.meta.env?.VITE_DEN_ALLOWED_ORIGINS === "string"
    ? import.meta.env.VITE_DEN_ALLOWED_ORIGINS
    : "";
  return raw.split(",").map((value: string) => value.trim()).filter(Boolean);
}

export function parseConnectDeepLink(rawUrl: string): ConnectDeepLink | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  // Unlike sibling parsers, organization connect credentials only ride the
  // dedicated desktop scheme, never ordinary web URLs.
  const protocol = url.protocol.toLowerCase();
  if (protocol !== "omnirush:" && protocol !== "omnirush-dev:") {
    return null;
  }

  const routeHost = url.hostname.toLowerCase();
  const routePath = url.pathname.replace(/^\/+/, "").toLowerCase();
  const routeSegments = routePath.split("/").filter(Boolean);
  const routeTail = routeSegments[routeSegments.length - 1] ?? "";
  if (routeHost !== "connect" && routePath !== "connect" && routeTail !== "connect") {
    return null;
  }

  const token = url.searchParams.get("token")?.trim() ?? "";
  const code = url.searchParams.get("code")?.trim() ?? "";
  const apiBaseUrl = url.searchParams.get("apiBaseUrl")?.trim() ?? "";
  const signed = Boolean(token) && !code && !apiBaseUrl;
  const exchange = !token && /^[A-Za-z0-9_-]{24,128}$/.test(code) && Boolean(apiBaseUrl);
  if (!signed && !exchange) {
    return null;
  }

  return { rawUrl, key: signed ? `signed:${token}` : `exchange:${apiBaseUrl}:${code}` };
}

/**
 * Host an unsigned exchange connect link asks the app to contact, shown to
 * the user before anything is sent there. Null for other links.
 */
export function connectExchangeHost(rawUrl: string): string | null {
  const link = parseConnectDeepLink(rawUrl);
  if (!link || !link.key.startsWith("exchange:")) return null;
  try {
    return new URL(new URL(rawUrl).searchParams.get("apiBaseUrl")?.trim() ?? "").host || null;
  } catch {
    return null;
  }
}

function normalizeDebugDeepLinkInput(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (!trimmed) return "";

  const directMatch = trimmed.match(/(?:omnirush-dev|omnirush|https?):\/\/[^\s"'<>]+/i);
  if (directMatch) return directMatch[0];

  return trimmed;
}

export function parseDebugDeepLinkInput(rawValue: string):
  | { kind: "remote"; link: RemoteWorkspaceDefaults }
  | { kind: "auth"; link: DenAuthDeepLink }
  | null {
  const normalized = normalizeDebugDeepLinkInput(rawValue);
  if (!normalized) return null;

  const denAuthLink = parseDenAuthDeepLink(normalized);
  if (denAuthLink) {
    return { kind: "auth", link: denAuthLink };
  }

  const remoteConnectLink = parseRemoteConnectDeepLink(normalized);
  if (remoteConnectLink) {
    return { kind: "remote", link: remoteConnectLink };
  }

  return null;
}
