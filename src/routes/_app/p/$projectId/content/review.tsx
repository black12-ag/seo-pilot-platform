import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { z } from "zod";
import { useAppForm } from "@/client/components/form/useAppForm";
import { Button } from "@/client/components/ui/button";
import { ContentReviewPage } from "@/client/features/content/review/ContentReviewPage";
import { contentRevisionQuery } from "@/client/features/content/contentQueries";
import { organizationContextQueryOptions } from "@/client/features/team/organizationQueries";
import { hasOrgPermission } from "@/lib/org-permissions";
import { usesBetterAuthClient } from "@/lib/auth-mode";
import { getTeam } from "@/serverFunctions/organization";
import {
  getContentReview,
  getContentEligibility,
  requestContentReview,
  decideContentReview,
  withdrawContentApproval,
} from "@/serverFunctions/content-review";
import {
  getContentRevisionStatus,
  type getContentRevision,
} from "@/serverFunctions/content";

type Head = Awaited<ReturnType<typeof getContentRevision>>;
const searchSchema = z.object({
  contentId: z.string().min(1).max(255),
  requestId: z.string().min(1).max(255).optional(),
});
export const Route = createFileRoute("/_app/p/$projectId/content/review")({
  validateSearch: searchSchema,
  component: ReviewRoute,
});

function ReviewRoute() {
  const { projectId } = Route.useParams();
  const { contentId, requestId } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <ReviewContent
      key={`${projectId}/${contentId}/${requestId ?? "latest"}`}
      projectId={projectId}
      contentId={contentId}
      requestId={requestId}
      onRequested={(id) => {
        void navigate({ search: { contentId, requestId: id } });
      }}
    />
  );
}

function ReviewContent({
  projectId,
  contentId,
  requestId,
  onRequested,
}: {
  projectId: string;
  contentId: string;
  requestId?: string;
  onRequested: (id: string) => void;
}) {
  const client = useQueryClient();
  const [requesting, setRequesting] = useState(false);
  const head = useQuery(contentRevisionQuery(projectId, contentId));
  const headStatus = useQuery({
    queryKey: ["content", projectId, contentId, "status", "head"],
    queryFn: () => getContentRevisionStatus({ data: { projectId, contentId } }),
    enabled: head.isError,
  });
  const review = useQuery({
    queryKey: [
      "content",
      projectId,
      contentId,
      "review",
      requestId ?? "latest",
    ],
    queryFn: () =>
      getContentReview({ data: { projectId, contentId, requestId } }),
    staleTime: 0,
  });
  const organization = useQuery(organizationContextQueryOptions());
  const selected = useQuery({
    ...contentRevisionQuery(projectId, contentId, review.data?.revisionId),
    enabled: Boolean(review.data?.revisionId),
  });
  const selectedStatus = useQuery({
    queryKey: [
      "content",
      projectId,
      contentId,
      "status",
      review.data?.revisionId,
    ],
    queryFn: () =>
      getContentRevisionStatus({
        data: { projectId, contentId, revisionId: review.data?.revisionId },
      }),
    enabled: Boolean(review.data?.revisionId && selected.isError),
  });
  const eligibility = useQuery({
    queryKey: [
      "content",
      projectId,
      contentId,
      "eligibility",
      review.data?.revisionId,
      head.data?.revision.version,
    ],
    queryFn: () => {
      if (!review.data || !head.data)
        throw new Error("Review inputs unavailable");
      return getContentEligibility({
        data: {
          projectId,
          contentId,
          revisionId: review.data.revisionId,
          expectedHeadVersion: head.data.revision.version,
        },
      });
    },
    enabled: Boolean(review.data?.revisionId && head.data),
    staleTime: 0,
  });
  if (head.isPending || review.isPending)
    return <main className="p-6">Loading review…</main>;
  if (!head.data || review.isError)
    return (
      <main className="p-6" role="alert">
        {headStatus.data?.state === "privacy_erased"
          ? "This content was privacy erased and cannot be reviewed."
          : "Could not load this content review."}
      </main>
    );
  const openRequest = !review.data || requesting;
  if (openRequest)
    return (
      <main className="mx-auto max-w-4xl space-y-4 p-6">
        <h1 className="text-2xl font-semibold">Request a human review</h1>
        <ReviewRequest
          projectId={projectId}
          head={head.data}
          onRequested={onRequested}
        />
        {review.data ? (
          <Button
            variant="ghost"
            type="button"
            onClick={() => setRequesting(false)}
          >
            Back to review
          </Button>
        ) : null}
      </main>
    );
  if (!selected.data)
    return (
      <main className="p-6">
        {selected.isError
          ? selectedStatus.data?.state === "privacy_erased"
            ? "The reviewed revision was privacy erased and its body is unavailable."
            : "The reviewed revision is unavailable."
          : "Loading reviewed revision…"}
      </main>
    );
  const currentReview = review.data;
  if (!currentReview) return null;
  const read = selected.data;
  const availableSources = read.sources.flatMap((entry) =>
    entry.state === "available" ? [entry.source] : [],
  );
  const canReview =
    reviewAccess(organization.data?.role, head.data, read) &&
    !review.isRefetchError &&
    !head.isRefetchError &&
    !selected.isRefetchError;
  async function refresh() {
    await client.invalidateQueries({
      queryKey: ["content", projectId, contentId],
    });
  }
  return (
    <main className="mx-auto max-w-5xl space-y-4 p-4 md:p-6">
      {review.isRefetchError ||
      head.isRefetchError ||
      selected.isRefetchError ? (
        <p role="alert">
          Could not refresh the review. Approval and assessments are disabled
          until current data is available.
        </p>
      ) : null}
      {currentReview.state !== "pending" ? (
        <Button
          variant="outline"
          type="button"
          onClick={() => setRequesting(true)}
        >
          Request another review
        </Button>
      ) : null}
      {read.sources.some((entry) => entry.state === "unavailable") ? (
        <p role="alert">A source is unavailable; approval cannot proceed.</p>
      ) : null}
      <p className="text-sm">
        Current content approval:{" "}
        {eligibility.isPending
          ? "checking"
          : eligibility.isError
            ? "unavailable"
            : eligibility.data?.eligible
              ? "valid for further publisher checks"
              : `not currently eligible (${eligibility.data?.reason ?? "unknown"})`}
        .
      </p>
      <ContentReviewPage
        key={JSON.stringify([
          projectId,
          contentId,
          read.revision.id,
          currentReview.id,
          currentReview.version,
          read.checks.id,
          read.checks.checkSetHash,
          head.data.revision.version,
        ])}
        review={currentReview}
        revision={read.revision}
        sources={availableSources}
        checks={read.checks}
        headVersion={head.data.revision.version}
        canReview={canReview}
        onDecide={async (data) => {
          await decideContentReview({ data });
          await refresh();
        }}
        onWithdraw={async (data) => {
          await withdrawContentApproval({ data });
          await refresh();
        }}
      />
    </main>
  );
}

function reviewAccess(role: string | undefined, head: Head, read: Head) {
  return (
    Boolean(role && hasOrgPermission(role, { content: ["review"] })) &&
    head.item.archivedAtMs === null &&
    read.currentContextVersion === read.revision.contextVersion &&
    read.sources.every((entry) => entry.state === "available")
  );
}

function ReviewRequest({
  projectId,
  head,
  onRequested,
}: {
  projectId: string;
  head: Head;
  onRequested: (id: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef<{ key: string; mutationId: string } | null>(null);
  const organization = useQuery(organizationContextQueryOptions());
  const team = useQuery({
    queryKey: ["organization-team", organization.data?.organizationId],
    queryFn: () => getTeam(),
    enabled:
      usesBetterAuthClient() && Boolean(organization.data?.organizationId),
  });
  const form = useAppForm({
    defaultValues: { assigneeUserId: "" },
    validators: { onSubmit: z.object({ assigneeUserId: z.string().min(1) }) },
    onSubmit: async ({ value }) => {
      const input = {
        projectId,
        contentId: head.revision.contentId,
        revisionId: head.revision.id,
        expectedHeadVersion: head.revision.version,
        expectedContextVersion: head.revision.contextVersion,
        checkSetId: head.checks.id,
        assigneeUserId: value.assigneeUserId,
      };
      const key = JSON.stringify(input);
      if (attempt.current?.key !== key)
        attempt.current = { key, mutationId: crypto.randomUUID() };
      setError(null);
      try {
        const review = await requestContentReview({
          data: { ...input, mutationId: attempt.current.mutationId },
        });
        attempt.current = null;
        onRequested(review.id);
      } catch (cause) {
        setError(
          cause instanceof Error ? cause.message : "Could not request review.",
        );
      }
    },
  });
  const blocked =
    head.item.archivedAtMs !== null ||
    head.currentContextVersion !== head.revision.contextVersion ||
    head.sources.some((entry) => entry.state === "unavailable");
  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        Review is pinned to saved revision {head.revision.id} and check set{" "}
        {head.checks.id}. It does not publish content.
      </p>
      {blocked ? (
        <p role="alert">
          The content is archived or its saved context or source evidence is no
          longer current. Review the content before requesting review.
        </p>
      ) : null}
      {team.isError || (!usesBetterAuthClient() && !team.data) ? (
        <p role="alert">
          A current workspace member list is unavailable in this authentication
          mode.
        </p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      <form.AppForm>
        <form.Form className="space-y-3">
          <form.AppField name="assigneeUserId">
            {(field) => (
              <field.SelectField
                label="Reviewer"
                disabled={!team.data?.members.length}
                items={(team.data?.members ?? []).map((member) => ({
                  value: member.userId,
                  label: member.user.name || member.user.email,
                }))}
              />
            )}
          </form.AppField>
          <form.SubmitButton disabled={blocked || !team.data?.members.length}>
            Request review
          </form.SubmitButton>
        </form.Form>
      </form.AppForm>
    </div>
  );
}
