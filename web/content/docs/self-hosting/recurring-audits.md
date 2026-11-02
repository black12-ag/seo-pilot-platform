---
title: "Recurring audits"
description: "Schedule bounded plain HTTP audits and compare their recorded evidence."
---

SEO Pilot's development branch includes opt-in plain HTTP schedules and saved
audit evidence. Paid recurring rendering and Lighthouse, along with other
complete-platform modules, remain in development.

## Enable the installation policy

Recurring audits start off. An installation operator must set a finite
`AUDIT_RECURRING_POLICY` before a workspace owner can enable a schedule. For
example, this policy permits at most two scheduled runs and 100 page allowances
per organization per UTC day, with one outstanding run at a time:

```json
{
  "version": 1,
  "maxRunsPerUtcDay": 2,
  "maxPagesPerUtcDay": 100,
  "maxCostMicrosPerUtcDay": 0,
  "maxConcurrentRuns": 1,
  "providers": {}
}
```

For the source-built Docker installation, put that JSON on one line as the value
of `AUDIT_RECURRING_POLICY` in its private environment file, then recreate the
same Compose project. Follow the [source self-hosting guide](https://github.com/black12-ag/seo-pilot-platform/blob/test/docs/SELF_HOSTING_SEO_PILOT.md)
and preserve its project name, image tag and volumes. On Workers, set the same
variable on the application worker and keep the existing five-minute cron.
An absent or invalid policy blocks new scheduled work.

The policy contains limits, not provider credentials. This release supports
plain HTTP with rendering off, Lighthouse set to none, and zero paid cost
ceilings. Unsupported paid options are refused. Hosting and network resources
can still have costs. Existing manually requested audit options are separate.

## Review a project schedule

Open the project's **Site audit** page and its **Recurring audits** section.
An account mode with current workspace memberships, such as password accounts,
is required for background authorization. The current workspace owner manages
the schedule; other authorized workspace members can read its status and
evidence. Public-site and competitor research do not require publishing proof.

1. Choose the target URL, daily or weekly cadence, IANA timezone and local time.
2. Set the maximum pages per run and finite daily run, page and cost ceilings.
3. Select **Review schedule**. Check the target, limits and next three local/UTC
   occurrences, then acknowledge the review.
4. Save the new schedule paused. When ready, set **After review** to
   **Enable for the next occurrence**, review again, then choose
   **Enable reviewed schedule**.

Saving or enabling does not start an immediate audit. The existing cron admits
due work, so the scheduled time is an eligibility time rather than a promise of
an exact start minute. Capacity, current authorization and installation limits
can delay or block a run. A changed policy or project context can require a new
review. The app shows the actual reason.

Times follow the chosen local calendar. A daylight-saving gap uses the first
valid minute after the gap; a repeated minute uses its earlier occurrence once.
After an outage, overdue slots coalesce into one eligible catch-up rather than
a burst. Missing-slot counts remain unavailable when an exact count cannot be
established within the bounded calculation.

## Read results and allowances

History separates launch state, evidence coverage and budget state. A completed
workflow does not certify full website coverage. Open its evidence to see the
requested and effective settings, observation times, bounded discovery scope,
assessed pages, errors, shells and stop reasons. Older results without this
evidence remain unknown.

The usage readout is scoped to the current UTC day and shows its observation
time. Outstanding reservations can span midnight. Page allowance consumed is
distinct from pages successfully observed: interrupted or uncertain work can
consume its reserved upper bound so a later run cannot spend that allowance
again. Unknown outcomes keep conservative capacity until recovery resolves them.

Select an explicit baseline to compare compatible settings and successfully
assessed URL/device cohorts. Unobserved or blocked pages are not treated as
fixed. Incompatible settings, an empty matched cohort, or an audit that did not
finish saving its findings produce an unavailable comparison with a reason.
**Export evidence JSON** downloads the actual structured rows and manifest as
JSON, with integrity checks.

## Pause, changes and recovery

**Pause future audits** stops future and unstarted intent. Already running work
retains its frozen settings. Losing the sponsor's authority, changing the
project website, archiving it or transferring its workspace fences new work;
restoring a project does not resume a schedule automatically.

Normal restarts recover durable attempts using the same audit/workflow identity.
An unknown create or termination reply is not proof that no work happened.
Recovery respects recorded observations, bounded retry limits and engine
retention; it does not blindly create a replacement run. Deleted results remain
identified as deleted in retained attempt history.

The supported legacy importer pauses imported schedules and removes their next
due time. A direct database/volume restore is different: leave the installation
policy unset until an operator has reviewed restored schedules and outstanding
work. Back up before updates and preserve the existing volumes.

Scheduled runs record durable events and do not send first-audit or onboarding
emails. Email delivery and broader automation remain separate development work.

## MCP and SAM

The same services and current permissions back `get_audit_schedule`,
`estimate_audit_schedule`, `save_audit_schedule`, `list_audit_attempts`,
`get_audit_evidence`, `compare_audit_evidence` and `export_audit_evidence`.
SAM binds these tools to its current project. Review the target, cadence and
limits before asking an agent to enable or enlarge a schedule. Reading status,
estimating and refreshing do not launch work or reserve provider credits.
