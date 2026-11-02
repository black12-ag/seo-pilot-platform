import { useState } from "react";
import { revalidateLogic } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CardShell } from "@/client/components/CardShell";
import { ConfirmDialog } from "@/client/components/ConfirmDialog";
import { QueryError } from "@/client/components/QueryState";
import { useAppForm } from "@/client/components/form/useAppForm";
import { Button } from "@/client/components/ui/button";
import { Badge } from "@/client/components/ui/badge";
import { projectsQueryOptions } from "@/client/features/projects/projectQueries";
import {
  checkSiteAuthorityChallenge,
  issueSiteAuthorityChallenge,
  revokeSiteAuthority,
} from "@/serverFunctions/siteAuthority";
import {
  issueAuthorityInputSchema,
  type MutationResult,
  type ProofMethod,
} from "@/types/schemas/siteAuthority";
import { SiteAuthorityChallenge } from "./SiteAuthorityChallenge";
import { siteAuthorityQueryOptions } from "./siteAuthorityQueries";

const formSchema = issueAuthorityInputSchema.pick({
  origin: true,
  method: true,
});
const refusalLabels = {
  stale: "Authority changed. Review the refreshed status before trying again.",
  busy: "A verification check is already running.",
  rate_limited: "Please wait before trying again.",
  expired: "This challenge has expired. Issue a new challenge.",
  exhausted: "This challenge has used all five checks. Issue a new challenge.",
  method_unavailable: "This proof method is not available.",
};

export function SiteAuthoritySettings({ projectId }: { projectId: string }) {
  const query = useQuery(siteAuthorityQueryOptions(projectId));
  const projects = useQuery(projectsQueryOptions());
  const queryClient = useQueryClient();
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [lastResult, setLastResult] = useState<MutationResult | null>(null);
  const [pendingIssue, setPendingIssue] = useState<{
    origin: string;
    method: ProofMethod;
  } | null>(null);
  const authority = query.data?.authority;
  const version = authority?.version ?? 0;
  const researchDomain = projects.data?.find(
    (project) => project.id === projectId,
  )?.domain;
  const mutation = useMutation({
    mutationFn: (
      operation:
        | { action: "issue"; origin: string; method: ProofMethod }
        | { action: "check"; challengeId: string }
        | { action: "revoke" },
    ) => {
      const shared = { projectId, expectedVersion: version };
      if (operation.action === "issue")
        return issueSiteAuthorityChallenge({
          data: {
            ...shared,
            origin: operation.origin,
            method: operation.method,
          },
        });
      if (operation.action === "check")
        return checkSiteAuthorityChallenge({
          data: { ...shared, challengeId: operation.challengeId },
        });
      return revokeSiteAuthority({ data: shared });
    },
    onSuccess: async (result) => {
      setLastResult(result);
      setConfirmRevoke(false);
      setPendingIssue(null);
      queryClient.setQueryData(siteAuthorityQueryOptions(projectId).queryKey, {
        authority: result.authority,
        instructions: result.ok ? result.instructions : undefined,
      });
    },
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: siteAuthorityQueryOptions(projectId).queryKey,
      }),
  });
  const form = useAppForm({
    defaultValues: {
      origin: authority?.origin ?? "",
      method: "http_file" as ProofMethod,
    },
    validationLogic: revalidateLogic(),
    validators: { onDynamic: formSchema },
    onSubmit: async ({ value }) => {
      if (authority?.origin) {
        setPendingIssue(value);
        return;
      }
      await mutation.mutateAsync({ action: "issue", ...value });
    },
  });

  return (
    <section id="site-authority" className="scroll-mt-6">
      <CardShell
        title="Site authority"
        titleInfo={
          authority ? (
            <Badge variant="outline">{authority.status}</Badge>
          ) : undefined
        }
        action={
          <Button
            variant="ghost"
            size="sm"
            pending={query.isFetching}
            onClick={() => void query.refetch()}
          >
            Refresh status
          </Button>
        }
      >
        {query.isError ? (
          <QueryError
            error={query.error}
            fallback="Couldn't load site authority."
            onRetry={() => void query.refetch()}
            isRetrying={query.isFetching}
          />
        ) : !authority ? (
          <p className="text-sm text-muted-foreground">
            Loading site authority…
          </p>
        ) : (
          <div className="max-w-3xl space-y-6 text-sm">
            <p className="text-muted-foreground">
              Verify control of one exact HTTPS origin. Apex, www and other
              subdomains require separate proof. Verification does not connect a
              publisher or enable publishing.
            </p>
            <dl className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted-foreground">
                  Selected exact origin
                </dt>
                <dd className="mt-1 break-all font-mono">
                  {authority.origin ?? "Not selected"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">
                  Research domain (independent)
                </dt>
                <dd className="mt-1 break-all font-mono">
                  {researchDomain ?? "Not set"}
                </dd>
              </div>
              {authority.verifiedAtMs ? (
                <div>
                  <dt className="text-xs text-muted-foreground">Verified</dt>
                  <dd className="mt-1">
                    {new Date(authority.verifiedAtMs).toLocaleString()} ·{" "}
                    {authority.verifiedMethod === "dns_txt"
                      ? "DNS TXT"
                      : "HTTPS file"}
                  </dd>
                </div>
              ) : null}
              {authority.verifiedUntilMs ? (
                <div>
                  <dt className="text-xs text-muted-foreground">
                    Grant expires
                  </dt>
                  <dd className="mt-1">
                    {new Date(authority.verifiedUntilMs).toLocaleString()}
                  </dd>
                </div>
              ) : null}
            </dl>
            {authority.revocationReason ? (
              <p>
                Revocation reason:{" "}
                {authority.revocationReason.replaceAll("_", " ")}.
              </p>
            ) : null}
            {lastResult && !lastResult.ok ? (
              <p role="status" className="rounded-lg border bg-muted/40 p-4">
                {refusalLabels[lastResult.code]}
                {lastResult.retryAtMs
                  ? ` Retry no earlier than ${new Date(lastResult.retryAtMs).toLocaleString()}.`
                  : ""}
              </p>
            ) : null}
            <SiteAuthorityChallenge
              authority={authority}
              instructions={query.data?.instructions}
            />
            {authority.canManage ? (
              <>
                {authority.challenge &&
                ["pending", "checking"].includes(authority.challenge.status) ? (
                  <Button
                    pending={mutation.isPending}
                    onClick={() => {
                      if (authority.challenge)
                        mutation.mutate({
                          action: "check",
                          challengeId: authority.challenge.id,
                        });
                    }}
                  >
                    Check verification
                  </Button>
                ) : null}
                <div className="space-y-4 border-t pt-5">
                  <h3 className="font-medium">
                    {authority.origin
                      ? "Reissue or change origin"
                      : "Make it yours"}
                  </h3>
                  <p className="text-muted-foreground">
                    Issuing a new challenge immediately suspends any current
                    grant and invalidates the old challenge. HTTP challenges
                    last 15 minutes; DNS challenges last 60 minutes. A
                    successful grant lasts 30 days.
                  </p>
                  <form.AppForm>
                    <form.Form className="space-y-4">
                      <form.AppField name="origin">
                        {(field) => (
                          <field.TextField
                            label="Exact HTTPS origin"
                            placeholder="https://example.com"
                            description="No path, credentials, query or non-default port. Preserve www if that is the origin you control."
                            disabled={mutation.isPending}
                          />
                        )}
                      </form.AppField>
                      <form.AppField name="method">
                        {(field) => (
                          <field.SelectField
                            label="Verification method"
                            disabled={mutation.isPending}
                            items={authority.supportedMethods.map((method) => ({
                              value: method,
                              label:
                                method === "http_file"
                                  ? "HTTPS file"
                                  : "DNS TXT record",
                            }))}
                          />
                        )}
                      </form.AppField>
                      <p className="text-xs text-muted-foreground">
                        HTTPS file proves control of the exact response path.
                        DNS TXT proves hostname record control, without proving
                        that HTTPS is reachable. Neither method supplies CMS
                        credentials.
                      </p>
                      <form.SubmitButton disabled={mutation.isPending}>
                        {authority.origin
                          ? "Reissue challenge"
                          : "Issue challenge"}
                      </form.SubmitButton>
                    </form.Form>
                  </form.AppForm>
                </div>
                {authority.origin && authority.status !== "revoked" ? (
                  <div className="flex justify-end border-t pt-4">
                    <Button
                      variant="outline"
                      disabled={mutation.isPending}
                      onClick={() => setConfirmRevoke(true)}
                    >
                      Revoke authority
                    </Button>
                  </div>
                ) : null}
              </>
            ) : (
              <p className="text-muted-foreground">
                Only current organization owners and admins can issue, check or
                revoke authority. Research and public audits remain available
                without verification.
              </p>
            )}
          </div>
        )}
      </CardShell>
      {pendingIssue ? (
        <ConfirmDialog
          title="Replace the current challenge?"
          confirmLabel="Reissue challenge"
          destructive
          pending={mutation.isPending}
          onClose={() => setPendingIssue(null)}
          onConfirm={() =>
            mutation.mutate({ action: "issue", ...pendingIssue })
          }
        >
          The current grant becomes unusable immediately. Only a fresh
          successful proof for the selected exact origin can restore authority.
        </ConfirmDialog>
      ) : null}
      {confirmRevoke ? (
        <ConfirmDialog
          title="Revoke site authority?"
          confirmLabel="Revoke authority"
          destructive
          pending={mutation.isPending}
          onClose={() => setConfirmRevoke(false)}
          onConfirm={() => mutation.mutate({ action: "revoke" })}
        >
          This invalidates the grant and pending checks. A later connection must
          obtain fresh authority before dispatching writes.
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
