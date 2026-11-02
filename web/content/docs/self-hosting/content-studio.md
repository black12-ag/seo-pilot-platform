---
title: "Manual content studio"
description: "Create, review and export cited Markdown revisions in SEO Pilot."
---

SEO Pilot's development branch includes a manual content studio. It is not yet
a production release.
Public URL source capture, paid generation and publishing are later parts of the
planned platform and are unavailable here. The full platform is still in
development.

## Create a brief and draft

Open a project and select **Content**, then **New brief**. Enter the target,
objective, audience, output kind, topic, language and country. You can set a
stricter maximum source age in the brief. Save the brief, then write the body
and metadata in the editor.

Add attributed pasted text or select an existing audit observation from the same
project. Select the sources for the revision, then attach exact passages to
claims in the Markdown or metadata. Mark each passage as supporting,
contradicting or background evidence. Record open questions and omissions where
facts are missing. Sources and claims are evidence for a reviewer; a citation or
an automatic check does not establish that a claim is true.

Audit evidence is a typed record of what the audit observed, not a quotation from
the page body. Its JSON can support general claims about those recorded
observations. It cannot be marked as supporting a product, security, financial
or legal claim; it can still be attached as background or contradictory evidence.
For sensitive claims, use an appropriate attributed source and have a person
assess it.

Save explicitly to create an immutable revision. If another edit wins first,
the save reports a conflict so you can preserve and reconcile your draft. When
project context changes, compare it with the saved snapshot and explicitly
refresh the context before saving a new revision. The preview does not render
raw HTML or automatically fetch remote images; safe image URLs appear as links.

The limits per revision are 10 sources, 200 KB of Markdown (204,800 UTF-8
bytes), and 100 claims, with up to 10 evidence passages per claim. Each pasted
or audit source is limited to 100 KB (102,400 UTF-8 bytes). Oversized input is
refused rather than silently shortened.

## Review sources and revisions

The capture date records when a source was saved. A publisher date is separate
and remains unknown when it was not supplied. The default source-age limit is
30 days; for product, security and financial claims it is 7 days. A brief can
choose a tighter limit from 1 to 30 days, but cannot relax the sensitive-claim
default. A stale source needs attention before approval or current eligibility.

Open revision history to inspect earlier saved versions and compare their
Markdown and metadata. **Restore as new** creates another revision; it does not
rewrite history. An archived item remains available for history, while
privacy-erased content cannot be read or exported.

## Request a human review

Workspace members can draft and request a review. Assign a current member and
submit the exact saved revision and its checks. A signed-in web owner or admin
can approve, request changes or reject; approval requires assessment of the
claims and the remaining text. A reviewer may also withdraw an approval. A
machine can draft, request and read review, but cannot make a human decision.

Review authority must be verifiable against a current membership row. In modes
where that identity cannot be established, review eligibility is reported as
unverifiable; manual editing, history and export remain available. Approval is
for the saved revision, and its current eligibility changes if the head,
project context, source availability or freshness, or reviewer's membership or
role changes. Withdrawal, archive, workspace transfer and privacy erasure also
invalidate current eligibility. A recorded approval in history is not a
permanent authorization to publish.

## Export

Download the selected saved revision as complete Markdown or JSON. The export
contains the saved body and metadata, available sources and claims, checks,
review record and current eligibility. Its manifest describes the canonical
payload hash; the complete download has a separate byte count and hash. Export
does not require approval or a model key, and does not publish content. Manual
editing and revision history also work without model keys.

## MCP and SAM

Your installation's authenticated `/mcp` endpoint exposes `list_content`,
`get_content_revision`, `create_content_brief`, `capture_content_source`,
`save_content_revision`, `archive_content`, `export_content_revision`,
`request_content_review` and `get_content_review`. SAM uses the same services
with its current project. Machine clients can request a review and follow the
human review link, but cannot approve it. Tool previews can be limited; use the
authenticated download for the complete artifact. See the [MCP setup guide](/docs/mcp)
and use your own installation's endpoint when self-hosting.
