import { describe, expect, it } from "vitest";
import { load } from "cheerio";
import { Route } from "./welcome";

describe("public welcome document", () => {
  it("serves semantic content and honest metadata without a session or JavaScript", async () => {
    const handlers = Route.options.server?.handlers;
    if (typeof handlers !== "object" || typeof handlers.GET !== "function") {
      throw new Error("Welcome must expose a GET server handler");
    }
    const response = await handlers.GET({
      request: new Request("http://localhost/welcome"),
      context: undefined,
      params: {},
      pathname: "/welcome",
      next: () => {
        throw new Error("Public document must not delegate");
      },
    });
    if (!(response instanceof Response))
      throw new Error("Expected a document response");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    const html = await response.text();
    expect(html).toMatch(/^<!doctype html>/);
    const $ = load(html);
    expect($("html").attr("lang")).toBe("en");
    expect($("title").text()).toContain("SEO Pilot");
    expect($("title").text()).toContain("in progress");
    expect($("meta[name=description]").attr("content")).toContain(
      "in development",
    );
    expect($("meta[name=viewport]").attr("content")).toContain(
      "width=device-width",
    );
    expect($("h1")).toHaveLength(1);
    expect($("h1").text()).toBe("A little more visible.Every day.");
    expect($("main").text()).toContain(
      "The full integrated SEO Pilot product is planned",
    );
    expect($("main").text()).toContain("Hosting and provider usage cost extra");
    expect($("figure").text()).toContain("not live data");
    expect($("script, iframe, form")).toHaveLength(0);
  });

  it("uses working public destinations and local anchors without prototype records", async () => {
    const handlers = Route.options.server?.handlers;
    if (typeof handlers !== "object" || typeof handlers.GET !== "function") {
      throw new Error("Welcome must expose a GET server handler");
    }
    const response = await handlers.GET({
      request: new Request("http://localhost/welcome"),
      context: undefined,
      params: {},
      pathname: "/welcome",
      next: () => {
        throw new Error("Public document must not delegate");
      },
    });
    if (!(response instanceof Response))
      throw new Error("Expected a document response");
    const html = await response.text();
    const $ = load(html);
    expect(
      $("a").filter((_, link) => $(link).attr("href") === "/").length,
    ).toBeGreaterThan(0);
    expect(
      $("a[href='https://github.com/black12-ag/seo-pilot-platform']").length,
    ).toBeGreaterThan(0);
    expect(
      $("a[href$='/web/content/docs/self-hosting/docker.md']").length,
    ).toBeGreaterThan(0);
    $("a").each((_, link) => {
      const href = $(link).attr("href");
      expect(href).toMatch(/^(https:\/\/github\.com\/|\/(?:welcome)?$|#)/);
      if (href?.startsWith("#")) expect($(href)).toHaveLength(1);
    });
    expect(html).not.toMatch(
      /figma\.com|mobbin\.com|ethio-viral\.com|2,841|12\.4%/,
    );
  });
});
