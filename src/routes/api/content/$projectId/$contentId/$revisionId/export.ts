import { createFileRoute } from "@tanstack/react-router";
import { withPgClient } from "@/db";
import { resolveUserContextFromHeaders } from "@/middleware/ensure-user/resolve";
import { ContentExportService } from "@/server/features/content/services/contentExport";
import { asAppError } from "@/server/lib/errors";
import { exportContentRevisionInputSchema } from "@/types/schemas/content";

const privateHeaders = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};

export const Route = createFileRoute(
  "/api/content/$projectId/$contentId/$revisionId/export",
)({
  server: {
    handlers: {
      GET: ({ params, request }) =>
        withPgClient(async () => {
          const formats = new URL(request.url).searchParams.getAll("format");
          const parsed = exportContentRevisionInputSchema.safeParse({
            ...params,
            format: formats.length === 1 ? formats[0] : undefined,
          });
          if (!parsed.success)
            return new Response("Invalid export request.", {
              status: 400,
              headers: privateHeaders,
            });
          try {
            const context = await resolveUserContextFromHeaders(
              request.headers,
            );
            const artifact = await ContentExportService.exportRevision(
              {
                userId: context.userId,
                organizationId: context.organizationId,
                role: context.role,
                surface: "web",
              },
              parsed.data,
            );
            const extension = parsed.data.format === "json" ? ".json" : ".md";
            const filename =
              artifact.filename
                .replace(/[^a-zA-Z0-9_.-]/g, "_")
                .replace(/\.(json|md)$/, "")
                .slice(0, 170) + extension;
            return new Response(artifact.content, {
              headers: {
                ...privateHeaders,
                "Content-Type": artifact.contentType,
                "Content-Disposition": `attachment; filename="${filename}"`,
                "Content-Length": String(artifact.bytes),
                "X-Content-SHA256": artifact.sha256,
                "X-Content-Bytes": String(artifact.bytes),
                "X-Content-Manifest-Scope": artifact.manifest.scope,
              },
            });
          } catch (error) {
            const appError = asAppError(error);
            const code = appError?.code;
            const erased =
              code === "CONFLICT" && appError?.message === "revision_erased";
            const status = erased
              ? 410
              : code === "UNAUTHENTICATED"
                ? 401
                : code === "FORBIDDEN" || code === "NOT_FOUND"
                  ? 404
                  : code === "CONFLICT"
                    ? 409
                    : 500;
            return new Response(
              erased
                ? "This revision was privacy erased and cannot be exported."
                : status === 500
                  ? "Export unavailable."
                  : "Export is unavailable or you do not have access.",
              { status, headers: privateHeaders },
            );
          }
        }).catch(
          () =>
            new Response("Export unavailable.", {
              status: 500,
              headers: privateHeaders,
            }),
        ),
    },
  },
});
