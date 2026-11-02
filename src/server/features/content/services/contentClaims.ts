import { sha256Hex } from "@/server/lib/audit/ids";
import { AppError } from "@/server/lib/errors";
import type { ContentMetadata } from "@/types/schemas/content";
import type { ContentClaimInput } from "@/types/schemas/contentEvidence";

function matchesRange(
  text: string,
  start: number,
  end: number,
  expected: string,
) {
  const splitsPair = (offset: number) =>
    offset > 0 &&
    offset < text.length &&
    text.charCodeAt(offset - 1) >= 0xd800 &&
    text.charCodeAt(offset - 1) <= 0xdbff &&
    text.charCodeAt(offset) >= 0xdc00 &&
    text.charCodeAt(offset) <= 0xdfff;
  return (
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 0 &&
    end > start &&
    end <= text.length &&
    !splitsPair(start) &&
    !splitsPair(end) &&
    text.slice(start, end) === expected
  );
}

export async function validateContentClaims(
  markdown: string,
  metadata: ContentMetadata,
  claims: ContentClaimInput[],
  sources: ReadonlyMap<string, string>,
) {
  return Promise.all(
    claims.map(async (claim) => {
      const valid =
        claim.target.kind === "markdown"
          ? matchesRange(
              markdown,
              claim.target.start,
              claim.target.end,
              claim.text,
            )
          : metadata[claim.target.field] === claim.text;
      if (!valid)
        throw new AppError("VALIDATION_ERROR", "claim_range_mismatch");
      const evidence = await Promise.all(
        claim.evidence.map(async (entry) => {
          const source = sources.get(entry.sourceId);
          if (
            source === undefined ||
            !matchesRange(source, entry.start, entry.end, entry.excerpt)
          ) {
            throw new AppError("VALIDATION_ERROR", "source_excerpt_mismatch");
          }
          const excerptHash = await sha256Hex(entry.excerpt);
          const passageId = await sha256Hex(
            JSON.stringify([
              entry.sourceId,
              entry.start,
              entry.end,
              excerptHash,
            ]),
          );
          return { ...entry, excerptHash, passageId };
        }),
      );
      return { ...claim, textHash: await sha256Hex(claim.text), evidence };
    }),
  );
}
