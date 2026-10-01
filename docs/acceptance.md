# Sidecar acceptance — 2026-10-01

The core barebones walkthrough passed with both original native conversations. Native compaction-hook delivery remains separately unverified. This public record omits private session identifiers and machine-specific probe paths.

## Environment

- Node 23.1.0, pnpm 11.0.3, Playwright 1.63.0.
- Codex CLI 0.159.3 and Claude Code 2.1.286, with native Claude Monitor available.
- Live browser requests were answered by their original terminal conversations. No replacement model process handled them.

## Local gates

`pnpm test`: 24 passed. `pnpm typecheck`: exit 0. `pnpm exec playwright test`: 5 passed. `git diff --check`: clean.

Checks cover persistence, submission/reply deduplication, owner/document routing, credentials and origins, Markdown escaping, registered-file boundaries, concurrent opens, stale locks, reconnect replay, shutdown, UTF-16 selections, ambiguous passages, titles, late replies after resolution, and draft preservation. Automated browser checks use a fake HTTP responder solely for UI regression coverage; native compatibility comes from the separate live walkthrough.

## Live walkthrough

| Check | Codex | Claude |
| --- | --- | --- |
| Two documents, same original owner | Opened, including generated stdin document | Opened by original Claude using the shared skill |
| General question recalling prior context | Original conversation correctly answered Sidebar; browser displayed the answer | Correct original probe phrase, absent from request/document |
| Follow-up | Answered Codex and Claude Code from earlier context, in the existing browser thread | Answer appeared in the same thread |
| Resolve while reply pending; reopen | Reply preserved resolution; reopened in browser | Late reply retained resolved state; reopened in browser |
| Selected passage and authorized revision | Original Codex changed only Draft probe to Revised probe; body verified byte-identical and browser refreshed | Heading changed from Draft probe to Revised probe; body verified byte-identical |
| Independent editable browser titles | Codex acceptance A / B observed | Claude acceptance A / B observed; source headings unaffected |
| Busy delivery and terminal coexistence | Queued during implementation; delivered on later native turns while terminal work continued | Request submitted during 20-second terminal sleep; delivered after the tool completed |
| Idle wake-up | Submitted only after two Herdr idle observations; woke original conversation and answered in the existing browser thread | First context question woke original idle conversation |
| Watcher expiry/re-arm | Native queue has no Monitor lease | 35-second expiry woke idle Claude; status checked and 1800-second watcher re-armed automatically |
| Stop/reopen with pending work | Both queued requests and titles retained; first request completed once, repeated claim returned completed | Queued follow-up survived stop/reopen, answered once; prior heading edit was not repeated |
| Exact-owner resume in disposable conversation | Native exec resume preserved UUID and recalled earlier phrase | Native print resume preserved UUID and recalled earlier phrase |

Each live owner finished four requests with exactly one agent reply per request. The actual repeated Codex notification returned an already-completed claim and produced no duplicate reply or edit. Both heading revisions preserved the body byte-for-byte; the browser displayed the updated source and retained the original passage quote with a changed-passage notice.

Codex's idle test submitted only after two stable idle observations and then woke the original conversation. Claude's busy test submitted during a 20-second terminal operation and was delivered after that operation finished. Claude re-armed after a 35-second Monitor expiry and again after app restart. A queued follow-up survived restart without repeating the preceding file edit.

Disposable native resume checks created and then resumed a separate conversation for each client using its exact native UUID. Both retained that UUID and recalled a unique phrase absent from the resume prompt. These tool-free checks establish native identity/context continuity; they did not replace the live Sidecar responders.

## Compaction and limits

Synthetic PreCompact/PostCompact input passed for both adapters. Foreign-owner signals were rejected; stopped or missing apps remained stopped; restart cleared transient compaction state. Codex Interrupt is labeled interrupted, never compaction-cancelled. Native hook delivery was not observed, existing user conversations were not deliberately compacted, and no global hook settings changed.

No interactive permission wait occurred under the installed permission modes. Other providers and permission modes were not exercised. Claude renewal was checked across expiry and restart, not a multi-hour soak.

## Cleanup and review

Both scratch apps were stopped through the CLI; their locks were absent and listening ports closed. Claude's watcher exited successfully, checked stopped status, and did not re-arm. Original conversations remained available. Disposable resume processes and the idle-submission helper exited.

One independent whole-branch review reproduced three interleavings, all corrected with failing-then-passing regressions: file refresh losing an unsent passage selection, read-through cache refresh suppressing updates to other viewers, and a delayed title save overwriting newer typing. Final gates passed after the fixes; no review finding remains deferred. Reviewer scratch apps and browsers were cleaned up.

Chrome automation initially reported `ERR_BLOCKED_BY_CLIENT`; manually navigating to the same local address succeeded, and subsequent interactions worked. The product's macOS opener also succeeded. No browser security settings changed. Redline was inspected only as an untrusted reference; no source was copied or runtime dependency added.
