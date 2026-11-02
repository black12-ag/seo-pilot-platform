import { Button } from "@/client/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/client/components/ui/select";
import {
  Table,
  TableBody,
  TableCard,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/client/components/ui/table";
import type { ContentItemPage } from "@/types/schemas/content";
import { contentStateSchema } from "@/types/schemas/content";
import type { z } from "zod";

export function ContentLibrary({
  page,
  onOpen,
  onCreate,
  onNext,
  archived,
  onToggleArchived,
  state,
  onStateChange,
}: {
  page: ContentItemPage;
  onOpen: (contentId: string) => void;
  onCreate: () => void;
  onNext: (cursor: string) => void;
  archived: boolean;
  onToggleArchived: () => void;
  state?: z.infer<typeof contentStateSchema>;
  onStateChange: (
    state: z.infer<typeof contentStateSchema> | undefined,
  ) => void;
}) {
  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">The content studio</h1>
          <p className="text-muted-foreground text-sm">
            Create and review content with its history intact.
          </p>
        </div>
        <Button type="button" onClick={onCreate}>
          New brief
        </Button>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onToggleArchived}
      >
        {archived ? "View active content" : "View archived content"}
      </Button>
      <Select
        value={state ?? "all"}
        onValueChange={(value) => {
          const parsed = contentStateSchema.safeParse(value);
          onStateChange(parsed.success ? parsed.data : undefined);
        }}
      >
        <SelectTrigger aria-label="Filter recorded state" className="w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All recorded states</SelectItem>
          {contentStateSchema.options.map((value) => (
            <SelectItem key={value} value={value}>
              {value.replaceAll("_", " ")}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {page.items.length ? (
        <TableCard>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>Recorded review state</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    {item.state === "privacy_erased"
                      ? "Privacy erased"
                      : item.title || item.topic}
                  </TableCell>
                  <TableCell>
                    {item.state === "privacy_erased"
                      ? "Privacy erased"
                      : item.archivedAtMs
                        ? "Archived"
                        : item.state.replaceAll("_", " ")}
                  </TableCell>
                  <TableCell>
                    {new Date(item.updatedAtMs).toLocaleDateString()}
                  </TableCell>
                  <TableCell>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={item.state === "privacy_erased"}
                      onClick={() => onOpen(item.id)}
                    >
                      Open
                      <span className="sr-only">
                        {" "}
                        {item.title || item.topic}
                      </span>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableCard>
      ) : (
        <p className="rounded border p-6 text-sm text-muted-foreground">
          {archived
            ? "No archived content."
            : "No content yet. Create a brief to start."}
        </p>
      )}
      {page.nextCursor ? (
        <Button
          type="button"
          variant="outline"
          onClick={() => onNext(page.nextCursor!)}
        >
          Next page
        </Button>
      ) : null}
    </section>
  );
}
