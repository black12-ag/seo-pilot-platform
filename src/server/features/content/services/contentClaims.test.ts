import { describe, expect, it } from "vitest";
import { validateContentClaims } from "./contentClaims";
import type { ContentClaimInput } from "@/types/schemas/contentEvidence";

const metadata = {
  title: "ሰላም",
  slug: "",
  description: "",
  schemaSuggestion: "",
};
const claim: ContentClaimInput = {
  target: { kind: "markdown", start: 0, end: 5 },
  text: "ሰላም😀",
  kind: "general",
  factual: true,
  evidence: [
    {
      sourceId: "source",
      start: 0,
      end: 2,
      excerpt: "e\u0301",
      relation: "supports",
    },
  ],
};

describe("content claim validation", () => {
  it("validates exact JS offsets and derives stable excerpt identity", async () => {
    const result = await validateContentClaims(
      "ሰላም😀",
      metadata,
      [claim],
      new Map([["source", "e\u0301😀"]]),
    );
    expect(result[0].evidence[0]).toMatchObject({
      excerptHash:
        "bf12767b0f2a56b2190075bae8169f656e3ce8d6357d4aff184bc6c7ea48f9f6",
    });
    const again = await validateContentClaims(
      "ሰላም😀",
      metadata,
      [claim],
      new Map([["source", "e\u0301😀"]]),
    );
    expect(result[0].evidence[0].passageId).toBe(
      again[0].evidence[0].passageId,
    );
  });

  it("rejects a range splitting a surrogate pair even if its text matches", async () => {
    const broken = {
      ...claim,
      target: { kind: "markdown" as const, start: 3, end: 4 },
      text: "\ud83d",
      evidence: [],
    };
    await expect(
      validateContentClaims("ሰላም😀", metadata, [broken], new Map()),
    ).rejects.toThrow();
  });

  it("rejects missing sources and mismatched excerpts", async () => {
    await expect(
      validateContentClaims("ሰላም😀", metadata, [claim], new Map()),
    ).rejects.toThrow();
    await expect(
      validateContentClaims(
        "ሰላም😀",
        metadata,
        [claim],
        new Map([["source", "zz😀"]]),
      ),
    ).rejects.toThrow();
  });

  it("requires a metadata claim to match its selected field exactly", async () => {
    const fieldClaim = {
      ...claim,
      target: { kind: "metadata" as const, field: "title" as const },
      text: "ሰላም",
      evidence: [],
    };
    await expect(
      validateContentClaims("", metadata, [fieldClaim], new Map()),
    ).resolves.toHaveLength(1);
    await expect(
      validateContentClaims(
        "",
        metadata,
        [{ ...fieldClaim, text: "ሰላ" }],
        new Map(),
      ),
    ).rejects.toThrow();
  });
});
