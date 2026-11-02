import { useRef, useState } from "react";
import { Button } from "@/client/components/ui/button";
import { Checkbox } from "@/client/components/ui/checkbox";
import { Label } from "@/client/components/ui/label";
import { Textarea } from "@/client/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/client/components/ui/select";
import type { SavedContentRevision } from "@/types/schemas/content";
import type {
  SavedContentReview,
  DecideContentReviewInput,
  WithdrawContentApprovalInput,
} from "@/types/schemas/contentReview";
import type {
  SavedContentSource,
  SavedContentCheckSet,
} from "@/types/schemas/contentEvidence";
import { ContentPreview } from "../editor/ContentPreview";

type Assessment =
  DecideContentReviewInput["claimAssessments"][number]["assessment"];
const assessmentOptions: Assessment[] = [
  "supported",
  "unsupported",
  "contradicted",
  "not_applicable",
];

export function ContentReviewPage({
  review,
  revision,
  sources,
  checks,
  headVersion,
  canReview,
  onDecide,
  onWithdraw,
}: {
  review: SavedContentReview;
  revision: SavedContentRevision;
  sources: SavedContentSource[];
  checks: SavedContentCheckSet | null;
  headVersion: number;
  canReview: boolean;
  onDecide: (input: DecideContentReviewInput) => Promise<void>;
  onWithdraw: (input: WithdrawContentApprovalInput) => Promise<void>;
}) {
  const [assessments, setAssessments] = useState<Record<string, Assessment>>(
    {},
  );
  const [assessmentReasons, setAssessmentReasons] = useState<
    Record<string, string>
  >({});
  const [assessed, setAssessed] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const attempt = useRef<{ key: string; mutationId: string } | null>(null);
  function mutationId(key: string) {
    if (attempt.current?.key !== key)
      attempt.current = { key, mutationId: crypto.randomUUID() };
    return attempt.current.mutationId;
  }
  async function decide(decision: DecideContentReviewInput["decision"]) {
    if (
      decision === "approve" &&
      (!assessed || revision.claims.some((claim) => !assessments[claim.id]))
    ) {
      setError("Assess each claim and the remaining text before approving.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onDecide({
        projectId: review.projectId,
        contentId: review.contentId,
        requestId: review.id,
        mutationId: mutationId(
          JSON.stringify([
            decision,
            review.version,
            headVersion,
            assessments,
            assessmentReasons,
            assessed,
            reason,
          ]),
        ),
        expectedRequestVersion: review.version,
        expectedHeadVersion: headVersion,
        decision,
        claimAssessments: revision.claims
          .filter((claim) => assessments[claim.id])
          .map((claim) => ({
            claimId: claim.id,
            assessment: assessments[claim.id],
            reason: assessmentReasons[claim.id] ?? "",
          })),
        assessedRemainingText: assessed,
        reason,
      });
      attempt.current = null;
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not record the decision.",
      );
    } finally {
      setPending(false);
    }
  }
  async function withdraw() {
    setPending(true);
    setError(null);
    try {
      await onWithdraw({
        projectId: review.projectId,
        contentId: review.contentId,
        requestId: review.id,
        mutationId: mutationId(
          JSON.stringify(["withdraw", review.version, headVersion, reason]),
        ),
        expectedRequestVersion: review.version,
        expectedHeadVersion: headVersion,
        reason,
      });
      attempt.current = null;
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not withdraw approval.",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold">Review saved content</h1>
        <p className="text-muted-foreground text-sm">
          Revision {revision.id} · request {review.id} · checks{" "}
          {review.checkSetId} · {review.state}
          {review.requestedByUserId &&
          review.requestedByUserId === review.assigneeUserId
            ? " · Self review"
            : ""}
        </p>
      </div>
      <ReviewEvents events={review.events} />
      <section className="space-y-2 rounded border p-4">
        <h2 className="font-medium">Checks for this review</h2>
        {checks &&
        checks.id === review.checkSetId &&
        checks.revisionId === revision.id &&
        review.revisionId === revision.id ? (
          <ul className="space-y-2 text-sm">
            {checks.checks.map((check) => (
              <li key={check.id}>
                {check.severity} · {check.status} · {check.explanation}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm">
            The requested check set is unavailable. Approval cannot be assessed
            here.
          </p>
        )}
        <p className="text-muted-foreground text-sm">
          Checks do not establish factual truth; approval requires a human
          assessment.
        </p>
      </section>
      {error ? (
        <p
          role="alert"
          className="rounded border border-destructive p-3 text-sm"
        >
          {error}
        </p>
      ) : null}
      {headVersion !== revision.version ? (
        <p className="text-sm">
          The content head has changed since this review was requested. This
          revision cannot be approved as the current head.
        </p>
      ) : null}
      <div className="rounded border p-4">
        <h2 className="font-medium">{revision.metadata.title}</h2>
        <dl className="text-muted-foreground space-y-1 text-sm">
          <div>
            <dt>Slug</dt>
            <dd>{revision.metadata.slug || "Not set"}</dd>
          </div>
          <div>
            <dt>Description</dt>
            <dd>{revision.metadata.description || "Not set"}</dd>
          </div>
          <div>
            <dt>Schema suggestion</dt>
            <dd className="whitespace-pre-wrap">
              {revision.metadata.schemaSuggestion || "Not set"}
            </dd>
          </div>
        </dl>
        <ContentPreview markdown={revision.markdown} />
      </div>
      <section className="space-y-3">
        <h2 className="font-medium">Sources and claims</h2>
        <ReviewSources sources={sources} />
        {revision.claims.map((claim) => (
          <div key={claim.id} className="space-y-2 rounded border p-3 text-sm">
            <p>{claim.text}</p>
            {claim.evidence.map((entry) => (
              <p key={entry.id} className="text-muted-foreground">
                {entry.relation} ·{" "}
                {sources.find((source) => source.id === entry.sourceId)
                  ?.title ?? "Unavailable source"}
                : {entry.excerpt}
              </p>
            ))}
            <Label htmlFor={`assessment-${claim.id}`}>Assessment</Label>
            <Select
              value={assessments[claim.id] ?? ""}
              onValueChange={(value) => {
                if (value)
                  setAssessments((current) => ({
                    ...current,
                    [claim.id]: value,
                  }));
              }}
            >
              <SelectTrigger id={`assessment-${claim.id}`}>
                <SelectValue placeholder="Choose an assessment" />
              </SelectTrigger>
              <SelectContent>
                {assessmentOptions.map((value) => (
                  <SelectItem key={value} value={value}>
                    {value.replaceAll("_", " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Label htmlFor={`assessment-reason-${claim.id}`}>
              Assessment note (optional)
            </Label>
            <Textarea
              id={`assessment-reason-${claim.id}`}
              value={assessmentReasons[claim.id] ?? ""}
              onChange={(event) =>
                setAssessmentReasons((current) => ({
                  ...current,
                  [claim.id]: event.target.value,
                }))
              }
            />
          </div>
        ))}
        {revision.openQuestions.length ? (
          <p>Open questions: {revision.openQuestions.join("; ")}</p>
        ) : null}
        {revision.omissions.length ? (
          <p>Omissions: {revision.omissions.join("; ")}</p>
        ) : null}
      </section>
      <div className="flex items-start gap-2">
        <Checkbox
          id="assessed-remaining"
          checked={assessed}
          onCheckedChange={(value) => setAssessed(value)}
        />
        <Label htmlFor="assessed-remaining">
          I assessed the remaining text and its factual coverage.
        </Label>
      </div>
      <div className="space-y-2">
        <Label htmlFor="review-reason">Reason or feedback</Label>
        <Textarea
          id="review-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        {review.state === "pending" ? (
          <>
            <Button
              type="button"
              disabled={
                pending ||
                !checks ||
                checks.id !== review.checkSetId ||
                checks.revisionId !== revision.id ||
                review.revisionId !== revision.id ||
                headVersion !== revision.version ||
                !canReview
              }
              onClick={() => decide("approve")}
            >
              Approve
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={pending || !canReview}
              onClick={() => decide("request_changes")}
            >
              Request changes
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={pending || !canReview}
              onClick={() => decide("reject")}
            >
              Reject
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={pending}
              onClick={() => decide("cancel")}
            >
              Cancel request
            </Button>
          </>
        ) : null}
        {review.state === "approved" ? (
          <Button
            type="button"
            variant="outline"
            disabled={pending || !canReview}
            onClick={withdraw}
          >
            Withdraw approval
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function ReviewSources({ sources }: { sources: SavedContentSource[] }) {
  return sources.map((source) => (
    <details key={source.id} className="rounded border p-3 text-sm">
      <summary className="cursor-pointer">
        {source.title} ·{" "}
        {source.kind === "audit"
          ? "typed audit observation, not a page quotation"
          : "attributed text"}{" "}
        · {source.extractionStatus} · captured{" "}
        {new Date(source.capturedAtMs).toLocaleDateString()}
      </summary>
      <p className="text-muted-foreground">
        Publisher date: {source.publisherDate ?? "unknown"} · language:{" "}
        {source.language ?? "unknown"} · market: {source.market ?? "unknown"} ·
        method: {source.extractionMethod} {source.extractionVersion}
        {source.extractionReason ? ` · ${source.extractionReason}` : ""}
      </p>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-sans">
        {source.sourceText}
      </pre>
    </details>
  ));
}

function ReviewEvents({ events }: { events: SavedContentReview["events"] }) {
  return (
    <section className="space-y-2">
      <h2 className="font-medium">Review history</h2>
      {events.length ? (
        events.map((event) => (
          <div key={event.id} className="rounded border p-3 text-sm">
            <p>
              {event.decision.replaceAll("_", " ")} ·{" "}
              {event.reviewerUserId ?? "Unknown reviewer"} ·{" "}
              {new Date(event.createdAtMs).toLocaleString()}
            </p>
            {event.reason ? <p>{event.reason}</p> : null}
            {event.claimAssessments.map((assessment) => (
              <p key={assessment.claimId}>
                {assessment.claimId}:{" "}
                {assessment.assessment.replaceAll("_", " ")}
                {assessment.reason ? ` · ${assessment.reason}` : ""}
              </p>
            ))}
          </div>
        ))
      ) : (
        <p className="text-muted-foreground text-sm">No decisions recorded.</p>
      )}
    </section>
  );
}
