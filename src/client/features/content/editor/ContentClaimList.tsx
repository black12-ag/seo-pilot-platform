import { Button } from "@/client/components/ui/button";
import {
  CONTENT_CLAIM_EVIDENCE_LIMIT,
  type ContentClaimInput,
  type SavedContentSource,
} from "@/types/schemas/contentEvidence";
export type Source = {
  id: string;
  title: string;
  text: string;
  kind: SavedContentSource["kind"];
};

export function ClaimList({
  claims,
  sources,
  markdown,
  onChange,
  onAdd,
  onRemove,
}: {
  claims: ContentClaimInput[];
  sources: Source[];
  markdown: string;
  onChange: (claims: ContentClaimInput[]) => void;
  onAdd: (index: number) => void;
  onRemove: () => void;
}) {
  return (
    <ul className="space-y-2">
      {claims.map((claim, index) => (
        <li key={index} className="rounded border p-3 text-sm">
          <p>{claim.text}</p>
          {claim.target.kind === "markdown" &&
          markdown.slice(claim.target.start, claim.target.end) !==
            claim.text ? (
            <div className="text-destructive">
              <p>This claim no longer matches its original location.</p>
              {markdown.indexOf(claim.text) >= 0 &&
              markdown.indexOf(claim.text) ===
                markdown.lastIndexOf(claim.text) ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const start = markdown.indexOf(claim.text);
                    onChange(
                      claims.map((item, i) =>
                        i === index
                          ? {
                              ...item,
                              target: {
                                kind: "markdown",
                                start,
                                end: start + claim.text.length,
                              },
                            }
                          : item,
                      ),
                    );
                  }}
                >
                  Relocate exact claim
                </Button>
              ) : (
                <p>Remove and re-add it to choose the correct text.</p>
              )}
            </div>
          ) : null}
          <p className="text-muted-foreground">
            {claim.kind} · {claim.evidence.length} evidence passages
          </p>
          {claim.evidence.map((entry, evidenceIndex) => (
            <div key={evidenceIndex} className="text-muted-foreground">
              {entry.relation} ·{" "}
              {sources.find((source) => source.id === entry.sourceId)?.title ??
                "Unavailable source"}
              : {entry.excerpt}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  onChange(
                    claims.map((item, i) =>
                      i === index
                        ? {
                            ...item,
                            evidence: item.evidence.filter(
                              (_, j) => j !== evidenceIndex,
                            ),
                          }
                        : item,
                    ),
                  )
                }
              >
                Remove passage
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={claim.evidence.length >= CONTENT_CLAIM_EVIDENCE_LIMIT}
            onClick={() => onAdd(index)}
          >
            Add passage
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              onRemove();
              onChange(claims.filter((_, i) => i !== index));
            }}
          >
            Remove claim
          </Button>
        </li>
      ))}
    </ul>
  );
}
