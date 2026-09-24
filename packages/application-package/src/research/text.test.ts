import { describe, it, expect } from "vitest";
import { hasUnsafeText } from "@ai-career/ingestion/text";
import { capText, isHttpUrl, normalizeHttpUrl } from "./text";

describe("capText", () => {
  it("returns text unchanged when within the limit", () => {
    expect(capText("hello", 5)).toBe("hello");
  });

  it("cuts to the limit", () => {
    expect(capText("hello world", 5)).toBe("hello");
  });

  it("never splits a surrogate pair: drops the high surrogate that would be left alone", () => {
    const text = "a".repeat(4) + "😀" + "tail"; // the emoji occupies indexes 4-5
    const capped = capText(text, 5);
    expect(capped).toBe("aaaa");
    expect(hasUnsafeText(capped)).toBe(false);
  });

  it("keeps a whole surrogate pair that ends exactly at the limit", () => {
    expect(capText("aaa😀tail", 5)).toBe("aaa😀");
  });
});

describe("isHttpUrl", () => {
  it("accepts http and https URLs", () => {
    expect(isHttpUrl("https://acme.example/about")).toBe(true);
    expect(isHttpUrl("http://acme.example")).toBe(true);
  });

  it("rejects other schemes and non-URLs", () => {
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl("data:text/html,<b>x</b>")).toBe(false);
    expect(isHttpUrl("ftp://acme.example")).toBe(false);
    expect(isHttpUrl("not a url")).toBe(false);
    expect(isHttpUrl("")).toBe(false);
  });

  it("rejects http(s) URLs carrying embedded credentials", () => {
    expect(isHttpUrl("https://user:pw@host")).toBe(false);
    expect(isHttpUrl("http://user@host/path")).toBe(false);
  });
});

describe("normalizeHttpUrl", () => {
  it("returns the canonical href for an ordinary http/https URL", () => {
    expect(normalizeHttpUrl("https://acme.example/about")).toBe("https://acme.example/about");
    expect(normalizeHttpUrl("http://acme.example")).toBe("http://acme.example/");
  });

  it("canonicalizes non-canonical http(s) forms instead of storing them raw", () => {
    expect(normalizeHttpUrl("http:/x")).toBe("http://x/");
    expect(normalizeHttpUrl("https:evil.com")).toBe("https://evil.com/");
    expect(normalizeHttpUrl("http:\\\\evil.com")).toBe("http://evil.com/");
  });

  it("rejects a URL carrying embedded credentials", () => {
    expect(normalizeHttpUrl("https://user:pw@host")).toBeNull();
    expect(normalizeHttpUrl("http://user@host/path")).toBeNull();
  });

  it("rejects other schemes and non-URLs", () => {
    expect(normalizeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeHttpUrl("data:text/html,<b>x</b>")).toBeNull();
    expect(normalizeHttpUrl("ftp://acme.example")).toBeNull();
    expect(normalizeHttpUrl("not a url")).toBeNull();
    expect(normalizeHttpUrl("")).toBeNull();
  });
});
