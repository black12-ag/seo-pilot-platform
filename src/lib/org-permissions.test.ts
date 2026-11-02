import { describe, expect, it } from "vitest";
import { hasOrgPermission } from "./org-permissions";

describe("content review permission", () => {
  it.each([
    ["owner", true],
    ["admin", true],
    ["member", false],
    ["unknown", false],
    ["member, admin", true],
    ["member, unknown", false],
  ])("authorizes %s: %s", (role, allowed) => {
    expect(hasOrgPermission(role, { content: ["review"] })).toBe(allowed);
  });

  it("preserves Better Auth organization permissions", () => {
    expect(hasOrgPermission("owner", { organization: ["update"] })).toBe(true);
    expect(hasOrgPermission("member", { organization: ["update"] })).toBe(
      false,
    );
  });
});
