import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ContentRevisionComparison } from "./ContentRevisionComparison";

it("shows saved body and metadata changes with both revision identities", () => {
  const metadata = {
    title: "Old title",
    slug: "old",
    description: "",
    schemaSuggestion: "",
  };
  const html = renderToStaticMarkup(
    createElement(ContentRevisionComparison, {
      before: { id: "revision-a", markdown: "Hello 🌍 world", metadata },
      after: {
        id: "revision-b",
        markdown: "Hello 🌎 world",
        metadata: { ...metadata, title: "New title" },
      },
    }),
  );
  expect(html).toContain("revision-a");
  expect(html).toContain("revision-b");
  expect(html).toMatch(/<del[^>]*>🌍<\/del><ins[^>]*>🌎<\/ins>/);
  expect(html).toMatch(/<del[^>]*>Old<\/del><ins[^>]*>New<\/ins> title/);
});
