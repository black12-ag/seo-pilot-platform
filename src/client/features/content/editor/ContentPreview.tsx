import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MARKDOWN_COMPONENTS } from "@/client/components/Markdown";
import { safeHttpUrl } from "@/shared/safe-url";

export function ContentPreview({ markdown }: { markdown: string }) {
  return (
    <ReactMarkdown
      skipHtml
      remarkPlugins={[remarkGfm]}
      components={{
        ...MARKDOWN_COMPONENTS,
        img: ({ src, alt }) => {
          const url = safeHttpUrl(src);
          return url ? (
            <a href={url} target="_blank" rel="noreferrer">
              {alt || "Image"}
            </a>
          ) : (
            <span>{alt || "Image"}</span>
          );
        },
      }}
    >
      {markdown}
    </ReactMarkdown>
  );
}
