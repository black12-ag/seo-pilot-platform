---
title: "Site authority"
description: "Verify control of one exact HTTPS origin with a file or DNS TXT record."
---

Open your project's **Settings → Integrations → Site authority**. Current
workspace owners and admins can issue, check and revoke a challenge; members
can view its status. Public research and audits remain available without this
verification.

Enter the exact origin you control, such as `https://www.example.com`. Preserve
`www` and subdomains. Choose a root origin without a path, credentials, query,
fragment or non-default port. One project holds one selected exact origin.

## Verify

Choose a method and click **Issue challenge**. Copy the current instructions
from the app; each challenge has its own value.

| Method     | What to publish                                                                 | Challenge lifetime |
| ---------- | ------------------------------------------------------------------------------- | ------------------ |
| HTTPS file | Exact supplied content at the supplied HTTPS URL, returning status 200 directly | 15 minutes         |
| DNS TXT    | Exact supplied TXT value at the supplied record name                            | 60 minutes         |

For the file method, serve the plain value with at most one final newline. A
redirect, HTML fallback, login page or different value will fail. Choose the
final origin your server serves. DNS verification checks the exact record and
does not follow aliases; it establishes record control without checking HTTPS
reachability.

Click **Check verification** after publishing the proof. A missing, mismatched,
blocked, oversized or timed-out response stays unverified, with its actual
reason shown. Checks are manual; refreshing status does not perform a proof
request. Each challenge allows five checks with a short cooldown.

## Grant and changes

A successful grant lasts 30 days. The app shows its origin, method and expiry.
Verification establishes control for that exact origin. Connecting a publisher
and approving website changes are separate steps; the full publishing flow is
still in development.

Reissuing or changing origin immediately suspends the existing grant and
invalidates the old challenge. Wait at least 60 seconds between issues; the app
shows any additional retry time. **Revoke authority** invalidates the current
grant and pending checks. A project's website change, archive or workspace
transfer also requires fresh proof. Renaming a project preserves its authority.

When publishing is introduced, its service must check current permissions,
authority, connector scope and approved revision before dispatching changes.
Revocation prevents later authorized dispatches; it cannot recall a write
already accepted by a remote website.

## MCP and SAM

Your installation exposes the same project permissions through
`get_site_authority`, `issue_site_authority_challenge`,
`check_site_authority_challenge` and `revoke_site_authority`. Connect your client
to your own installation's authenticated `/mcp` endpoint. SAM uses those same
tools with its current project bound by the server.

The tools return current instructions and status. They do not upload a file,
edit DNS or connect a publisher automatically.
