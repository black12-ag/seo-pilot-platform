import { Button } from "@/client/components/ui/button";
import type { ContentEditorTab } from "./ContentEditor";

export function ContentEditorNavigation({
  tab,
  onTabChange,
}: {
  tab: ContentEditorTab;
  onTabChange: (tab: ContentEditorTab) => void;
}) {
  return (
    <nav
      aria-label="Content editor sections"
      className="flex flex-wrap gap-2 border-b pb-2"
    >
      {(["write", "sources", "claims", "preview", "brief"] as const).map(
        (item) => (
          <Button
            key={item}
            type="button"
            variant={tab === item ? "secondary" : "ghost"}
            size="sm"
            onClick={() => onTabChange(item)}
          >
            {item[0].toUpperCase() + item.slice(1)}
          </Button>
        ),
      )}
    </nav>
  );
}
