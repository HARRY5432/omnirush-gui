import { describe, expect, test } from "bun:test";
import { connectExchangeHost, parseConnectDeepLink, reviewDenAuthDeepLink } from "../src/app/lib/omnirush-links";

const TOKEN = "eyJhbGciOiJFZERTQSJ9.eyJmYWtlIjoxfQ.c2ln";

describe("parseConnectDeepLink", () => {
  test("parses production and dev desktop connect links", () => {
    const rawUrl = `omnirush://connect?token=${TOKEN}`;
    expect(parseConnectDeepLink(rawUrl)).toEqual({ rawUrl, key: `signed:${TOKEN}` });
    expect(parseConnectDeepLink(`omnirush-dev://connect?token=${TOKEN}`)?.key).toBe(`signed:${TOKEN}`);
    expect(parseConnectDeepLink(`omnirush:///connect?token=${TOKEN}`)?.key).toBe(`signed:${TOKEN}`);
  });

  test("parses keyless exchange links without accepting ambiguous transports", () => {
    const code = "abcdefghijklmnopqrstuvwxyz123456";
    const apiBaseUrl = "https://den.example.com/api/den";
    const rawUrl = `omnirush://connect?code=${code}&apiBaseUrl=${encodeURIComponent(apiBaseUrl)}`;
    expect(parseConnectDeepLink(rawUrl)).toEqual({
      rawUrl,
      key: `exchange:${apiBaseUrl}:${code}`,
    });
    expect(parseConnectDeepLink(`${rawUrl}&token=${TOKEN}`)).toBeNull();
  });

  test("does not activate from web URLs or unrelated desktop routes", () => {
    expect(parseConnectDeepLink(`https://omnirush.example.com/connect?token=${TOKEN}`)).toBeNull();
    expect(parseConnectDeepLink(`omnirush://den-auth?grant=${TOKEN}`)).toBeNull();
    expect(parseConnectDeepLink("omnirush://connect")).toBeNull();
    expect(parseConnectDeepLink("not a url")).toBeNull();
  });
});

describe("connectExchangeHost", () => {
  test("names the server an unsigned exchange link would contact", () => {
    const code = "abcdefghijklmnopqrstuvwxyz123456";
    const link = (apiBaseUrl: string) => `omnirush://connect?code=${code}&apiBaseUrl=${encodeURIComponent(apiBaseUrl)}`;
    expect(connectExchangeHost(link("https://den.example.com/api/den"))).toBe("den.example.com");
    expect(connectExchangeHost(link("https://evil.example@den.example.com/"))).toBe("den.example.com");
    expect(connectExchangeHost(link("https://ехаmple.com/"))).toStartWith("xn--");
    expect(connectExchangeHost(`omnirush://connect?token=${TOKEN}`)).toBeNull();
  });
});

describe("reviewDenAuthDeepLink", () => {
  const configured = ["https://den.example.com"];
  test("always asks, and only for a server this device is set up for", () => {
    expect(reviewDenAuthDeepLink({ denBaseUrl: "https://den.example.com", configuredBaseUrls: configured, currentBaseUrl: "https://den.example.com", allowLoopback: false }))
      .toEqual({ kind: "confirm", host: "den.example.com", currentHost: null });
    expect(reviewDenAuthDeepLink({ denBaseUrl: "https://den.attacker.example", configuredBaseUrls: configured, currentBaseUrl: "https://den.example.com", allowLoopback: false }))
      .toEqual({ kind: "blocked", host: "den.attacker.example" });
    expect(reviewDenAuthDeepLink({ denBaseUrl: "", configuredBaseUrls: [], currentBaseUrl: null, allowLoopback: false }).kind).toBe("blocked");
  });

  test("a second configured server is a switch the user sees", () => {
    expect(reviewDenAuthDeepLink({ denBaseUrl: "https://other.example.com", configuredBaseUrls: [...configured, "https://other.example.com"], currentBaseUrl: "https://den.example.com", allowLoopback: false }))
      .toEqual({ kind: "confirm", host: "other.example.com", currentHost: "den.example.com" });
  });

  test("local control planes count only in development builds", () => {
    const input = { denBaseUrl: "http://localhost:3005", configuredBaseUrls: [], currentBaseUrl: null };
    expect(reviewDenAuthDeepLink({ ...input, allowLoopback: false }).kind).toBe("blocked");
    expect(reviewDenAuthDeepLink({ ...input, allowLoopback: true }).kind).toBe("confirm");
  });
});
