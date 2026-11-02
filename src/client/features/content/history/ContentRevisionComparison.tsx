import type { ContentMetadata } from "@/types/schemas/content";

type Revision = {
  id: string;
  markdown: string;
  metadata: ContentMetadata;
};

function Difference({ before, after }: { before: string; after: string }) {
  // shortcut: separate edits share one changed span; use a full diff for finer review.
  const oldChars = Array.from(before);
  const newChars = Array.from(after);
  let start = 0;
  while (
    start < oldChars.length &&
    start < newChars.length &&
    oldChars[start] === newChars[start]
  ) {
    start++;
  }
  let end = 0;
  while (
    end < oldChars.length - start &&
    end < newChars.length - start &&
    oldChars[oldChars.length - 1 - end] === newChars[newChars.length - 1 - end]
  ) {
    end++;
  }
  const prefix = oldChars.slice(0, start).join("");
  const suffix = end ? oldChars.slice(-end).join("") : "";
  const removed = oldChars.slice(start, oldChars.length - end).join("");
  const added = newChars.slice(start, newChars.length - end).join("");
  return (
    <pre className="whitespace-pre-wrap break-words font-sans text-sm">
      {prefix}
      {removed ? <del className="bg-destructive/10">{removed}</del> : null}
      {added ? <ins className="bg-primary/10">{added}</ins> : null}
      {suffix}
    </pre>
  );
}

export function ContentRevisionComparison({
  before,
  after,
}: {
  before: Revision;
  after: Revision;
}) {
  const fields = [
    ["Body", before.markdown, after.markdown],
    ["Title", before.metadata.title, after.metadata.title],
    ["Slug", before.metadata.slug, after.metadata.slug],
    ["Description", before.metadata.description, after.metadata.description],
    [
      "Schema suggestion",
      before.metadata.schemaSuggestion,
      after.metadata.schemaSuggestion,
    ],
  ] as const;
  return (
    <section className="space-y-4" aria-label="Compare revisions">
      <p className="text-muted-foreground text-sm">
        Comparing {before.id} with {after.id}. Removed text is struck through;
        added text is underlined. Separate edits may appear in one changed span.
      </p>
      {fields.map(([label, oldValue, newValue]) => (
        <div key={label} className="space-y-2 border-t pt-3">
          <h3 className="text-sm font-medium">{label}</h3>
          <Difference before={oldValue} after={newValue} />
        </div>
      ))}
    </section>
  );
}
