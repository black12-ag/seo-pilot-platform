import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import {
  captureContentSource,
  captureContentUrls,
  getContentSource,
} from "@/serverFunctions/content";
import type {
  ContentSourceInput,
  SavedContentSource,
} from "@/types/schemas/contentEvidence";
import type { CaptureContentUrlsInput } from "@/types/schemas/contentSourceIntake";

export function useContentSourceCapture(projectId: string) {
  const client = useQueryClient();
  const [captured, setCaptured] = useState<SavedContentSource[]>([]);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const attempt = useRef<{ key: string; mutationId: string } | null>(null);
  async function capture(source: ContentSourceInput) {
    const key = JSON.stringify(source);
    if (attempt.current?.key !== key)
      attempt.current = { key, mutationId: crypto.randomUUID() };
    const result = await captureContentSource({
      data: { projectId, mutationId: attempt.current.mutationId, source },
    });
    setCaptured((current) => [
      ...current.filter((item) => item.id !== result.source.id),
      result.source,
    ]);
    attempt.current = null;
    void client.invalidateQueries({ queryKey: ["content-sources", projectId] });
  }
  async function captureUrls(requests: CaptureContentUrlsInput["requests"]) {
    const result = await captureContentUrls({ data: { projectId, requests } });
    const available = result.outcomes.filter(
      (entry) =>
        entry.state === "captured" &&
        entry.available &&
        (entry.extractionStatus === "usable" ||
          entry.extractionStatus === "partial"),
    );
    const fetched = await Promise.allSettled(
      available.map((entry) =>
        getContentSource({ data: { projectId, sourceId: entry.sourceId } }),
      ),
    );
    setCaptured((current) => {
      const loaded = fetched.flatMap((item) =>
        item.status === "fulfilled" ? [item.value] : [],
      );
      return [
        ...current.filter(
          (item) => !loaded.some((source) => source.id === item.id),
        ),
        ...loaded,
      ];
    });
    setSourceError(
      fetched.some((item) => item.status === "rejected")
        ? "Some captured sources could not be loaded. Your draft is unchanged."
        : null,
    );
    void client.invalidateQueries({ queryKey: ["content-sources", projectId] });
    return result;
  }
  return {
    captured,
    setCaptured,
    sourceError,
    setSourceError,
    capture,
    captureUrls,
  };
}
