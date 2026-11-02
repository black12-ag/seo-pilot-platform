import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ContentPreview } from "./ContentPreview";

it("renders safe links without loading images or rendering raw HTML", () => {
  const html = renderToStaticMarkup(
    createElement(ContentPreview, {
      markdown:
        "<script>alert(1)</script>\n\n![photo](https://example.com/image.png)\n\n[unsafe](javascript:alert(1))",
    }),
  );
  expect(html).not.toContain("<script");
  expect(html).not.toContain("<img");
  expect(html).not.toContain('href="javascript:');
  expect(html).toContain('href="https://example.com/image.png"');
  expect(html).toContain("photo");
});
