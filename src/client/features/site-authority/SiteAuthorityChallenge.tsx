import { CopyButton } from "@/client/components/CopyButton";
import type {
  AuthorityInstructions,
  AuthorityView,
} from "@/types/schemas/siteAuthority";

const failures = {
  not_found:
    "The verification file was not found. Publish it at the exact address below.",
  mismatch: "The proof value did not match. Copy the current value exactly.",
  redirect:
    "The verification address redirected. It must return the file itself with HTTPS 200.",
  blocked_target: "The target was blocked by the public network policy.",
  unreachable:
    "The verification address could not be reached safely. No authority was granted.",
  timeout: "The verification request timed out. No authority was granted.",
  body_too_large:
    "The response exceeded the verification size limit. Serve only the exact proof value.",
  invalid_response: "The server did not return a valid verification response.",
  dns_unavailable:
    "The DNS resolver could not complete this check. No authority was granted.",
  dns_not_found:
    "No matching verification TXT record was found at the exact record name.",
};

export function SiteAuthorityChallenge({
  authority,
  instructions,
}: {
  authority: AuthorityView;
  instructions?: AuthorityInstructions;
}) {
  const challenge = authority.challenge;
  if (!challenge) return null;
  const entries =
    instructions?.method === "http_file"
      ? [
          { label: "File URL", value: instructions.url },
          { label: "File content", value: instructions.content },
        ]
      : instructions?.method === "dns_txt"
        ? [
            { label: "TXT record name", value: instructions.name },
            { label: "TXT value", value: instructions.value },
          ]
        : [];
  return (
    <div className="space-y-4">
      <div
        className="rounded-lg border bg-muted/40 p-4 text-sm"
        aria-live="polite"
      >
        <p className="font-medium">
          Challenge: {challenge.status} · {challenge.attemptsUsed}/5 checks used
        </p>
        <p className="mt-1 text-muted-foreground">
          Issued {new Date(challenge.issuedAtMs).toLocaleString()} · expires{" "}
          {new Date(challenge.expiresAtMs).toLocaleString()}
        </p>
        {challenge.lastFailure ? (
          <p className="mt-2">{failures[challenge.lastFailure]}</p>
        ) : null}
        {challenge.attemptsUsed > 0 && challenge.status !== "verified" ? (
          <p className="mt-2 text-muted-foreground">
            Next check no earlier than{" "}
            {new Date(challenge.nextCheckAtMs).toLocaleString()}.
          </p>
        ) : null}
      </div>
      {instructions ? (
        <>
          <p className="text-sm text-muted-foreground">
            {instructions.method === "http_file"
              ? "Serve this exact content at this HTTPS URL with status 200 and no redirects. A final newline is allowed; HTML pages do not verify."
              : "Add a TXT record at this exact name. Copy the value as the record content. DNS aliases are not followed; allow time for DNS changes to become visible."}
          </p>
          <div className="space-y-4 rounded-lg bg-foreground p-5 text-background">
            {entries.map(({ label, value }) => (
              <div key={label} className="min-w-0 space-y-1">
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span>{label}</span>
                  <CopyButton
                    value={value}
                    label={`Copy ${label.toLowerCase()}`}
                    successMessage={`${label} copied`}
                    size="icon-xs"
                    variant="ghost"
                  />
                </div>
                <code className="block break-all text-xs leading-relaxed">
                  {value}
                </code>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
