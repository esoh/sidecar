# Proposed edits to the main document

Date: 2026-10-03. Base: PR27, `ad3e4b55569b`.

The user approved the browser layout and then this written design on 2026-10-03. The [implementation plan](../plans/2026-10-03-proposed-document-edits.md) carries the task breakdown and verification gates.

## As built — 2026-10-04

Implemented shared final-reply proposal capture, state v4 with exact migration backups, literal/context matching, guarded file replacement with durable recovery, per-proposal and per-reply decisions, and the document popover/card UI. Both native adapter fixtures accept a proposal while a later reply is streaming, preserving that reply and delivering no extra native request. The included ambiguity fix saves a chosen occurrence in its original version; it never enables an ambiguous source replacement.

Verification on the implementation branch: 163 backend tests and 89 browser tests passed, backend/web TypeScript checks passed, and `git diff --check` passed. A disposable Chrome viewer demonstrated actual acceptance/rejection history, stale-action refusal, and a chosen original passage becoming highlighted, with no browser console errors. Tests cover exact backing-file effects, per-reply bulk scope, overlaps, formatting-only edits, deletion, missing source, retries, hidden/resolved/pinned selections, historical read-only mode, drafts and viewport changes. No real review document was used for testing.

Snapshots use the existing shared writer extracted into `src/snapshots.ts`. Startup tolerates recovery being blocked by an unreadable document: its durable record remains intact, other documents can open, and a decision retries recovery and reports the file error. Same-file operations are serialized inside Sidecar; as specified below, the final identity/content check plus rename is still optimistic coordination with unrelated external writers, not a cross-process transaction.

## Intent and scope

Let the attached agent propose changes without editing the document. The user reviews each diff at its document annotation, then accepts or rejects it. Acceptance applies through Sidecar immediately; it does not send a new agent request and does not depend on the agent being idle.

Version one covers only the registered main Markdown document. It does not edit browsed files, code windows, other owners' library previews, or multiple files. It does not replace the renderer, add an editor, automatically apply suggestions, or add undo/reject-all controls.

The approved layout is the document popover, with a compact proposal record in the reply. **Accept all** applies to pending proposals from that one reply. It does not reach into other replies or threads. The user's approval followed a mockup showing this scope.

This PR also includes the verified selection-ambiguity fix (`c25cd5e`): distinguish multiple matches from changed text, let the user clarify a selection in its original snapshot, preserve confirmed positions only within that exact version, and use quote/context matching across later versions. Both agents receive the shared context guidance. Ship this fix and proposed edits in one PR and one upgrade.

Clarifying a navigation highlight never authorizes or repairs a proposal's source replacement. Proposal acceptance must independently validate the literal source target and its context; an ambiguous source proposal stays non-actionable until the agent supplies an unambiguous proposal.

## User experience

- The main document continues showing its actual saved text while a proposal is pending. A proposal's annotation uses the existing highlight styling and visibility controls.
- Clicking that annotation opens a nonmodal diff popover beside the passage. Clicking a proposal link or **Review change** in the reply locates the passage and opens the same popover. This must not scroll the thread pane. Ordinary annotations keep their existing behavior.
- The popover shows the optional label, state, removed/added wording, and **Reject** / **Accept**. Show changes with deletion/insertion treatment and `−` / `+`, rather than color alone. Render Markdown safely with the existing renderer; provide the exact source difference when formatting itself changes. A formatting-only change must not appear empty.
- Only one proposal popover is open at a time. Position it below the selected range when space permits, otherwise above; keep it within the document viewport. Reposition on scroll/resize. Escape, outside click, and Close dismiss it without making a decision. Keyboard activation works and closing restores focus to the invoking control.
- A reply lists its proposals as compact selection-like cards. Each includes label, short source excerpt, state, and **Review change** / **View change**. These replace the ordinary selection card for that selection rather than duplicating it. Keep the existing per-selection and per-message visibility controls.
- A single **Accept all (N)** sits above that reply's proposals. Accepted/rejected proposals are excluded. After a partial acceptance, report how many applied and how many were left unapplied; retain an explanation on each remaining proposal.
- Accepted and rejected proposals remain in history with their original before/after diff and decision. Outdated proposals say why they cannot apply. Closing a popover, hiding highlights, pinning a message, or resolving a thread does not accept or reject proposals.
- Resolving a thread still hides its highlights. Reopening keeps them hidden. Hidden proposals remain reviewable from their reply; opening a preview must not silently change their saved visibility.
- Pinned messages reuse the same proposal cards and open review in the main document. No separate file-editing mode is added to pinned windows.
- Historic document snapshots are read-only. A proposal whose current target is missing can still show its saved diff and original document when that snapshot exists. Never offer a write action in the historical view; return to current before acceptance.

The mockup's example reset/source-change controls and layout selector are design tools, not product controls.

## One-response protocol for both agents

Extend the existing final-reply `[[sidecar-meta ...]]` header. A highlight may carry a proposal:

```json
{
  "highlights": [
    {
      "exact": "The client retries failed requests three times.",
      "label": "Retry policy",
      "proposal": {
        "before": "The client retries **failed requests** three times.",
        "after": "The client retries **temporary connection failures** up to three times."
      }
    }
  ]
}
```

The answer links to `[the retry policy](#selection-1)` as it does today. No separate propose, name-thread, claim, or completion call is introduced. Metadata itself never writes the backing file; only the authenticated user's acceptance does.

`exact`, `prefix`, and `suffix` keep their existing meaning: rendered-text navigation anchors. `proposal.before` and `proposal.after` are literal Markdown source strings. Optional `proposal.prefix` / `proposal.suffix` are immediate **source** context for disambiguation. Do not use the rendered-text matcher, smart-quote substitution, whitespace normalization, or fuzzy matching to write a file.

Require a nonempty source `before`; allow empty `after` for deletion. Insertion replaces an existing source anchor with that anchor plus the inserted content. Do not add separate insert/move operations. Reject no-op replacements. Retain the existing 20-highlights-per-reply cap; bound each before/after to 16,384 UTF-16 code units and source context to 512 each, within existing request limits.

The agent must know the current source when forming a proposal, reading it when needed. Suggesting changes must not also apply them with Edit/apply_patch. Direct user requests to edit still use the existing direct-edit workflow unless the user asks for a proposal or approval first. Do not silently turn every routine edit into a proposal.

Both Codex and Claude use the canonical `.agents/skills/sidecar/SKILL.md` and the same parser. Document the nested proposal format, source/rendered distinction, selection links, limits, and the fact that accepted changes may occur while the agent is busy. The agent must reread affected source before making a later direct edit; remembered pending status is not authoritative. A normal context read returns current proposal decisions. Acceptance does not automatically submit a follow-up or trigger a new turn.

Proposals become actionable only once the complete final response and its metadata are durably saved. Partial metadata or stopped output cannot create an actionable proposal. Existing progress capture remains prose-only. Complete-reply recovery uses the same protocol and must not duplicate proposals.

## Storage and source identity

Introduce state version 4 with a separate `proposals` map, keyed by server-generated UUID. Each record links to its document, thread, response message, and selection. Store literal before/after and source context; status (`pending`, `accepted`, `rejected`, `outdated`); creation/decision times; initial snapshot version and matched range when available; accepted result version/range when applied; and a machine-readable reason when unavailable or outdated.

Keep proposal state separate from the answer text. Existing message text, IDs, requests, slugs and history remain unchanged. The selection's stable ID is the navigation link; labels never determine identity. There is at most one proposal for a selection. Retry identity comes from the saved reply/selection, not a second generated record on replay.

At final capture, read and snapshot the registered document through the existing reader. Match `before` plus any source context exactly and uniquely in that source. A missing or ambiguous target yields an outdated proposal, never a guessed replacement. Record the shared document version/range when the target matches. Mechanically retain the immediate source context around that confirmed range, using the agent's context when supplied and otherwise up to 32 UTF-16 code units on either side. Later acceptance checks this saved context as well as `before`; offsets alone cannot identify a passage in a different version.

A source read failure preserves the reply and an outdated proposal with reason `source-unavailable`, a null original version/range, and no acceptance or original-document action. If the source was readable but the target was missing/ambiguous, retain the real snapshot version with a null matched range and the corresponding reason. Malformed proposals retain a response diagnostic and cannot produce actionable proposal records. Missing snapshots never become invented historical content.

Existing snapshots remain one content-addressed Markdown file per document version. Do not save a whole document inside each proposal. Before and after snapshots of an accepted write serve every proposal in that write.

State migration adds an empty proposal map to v3; v1/v2 still pass through the existing selection migration. Save the exact pre-migration backup before publishing v4, and preserve all old documents, messages, requests, selections and snapshot bytes. Other owners may continue running older app releases against their own independent stores. One owner store has one writing app process.

Older binaries must not overwrite v4 state. No automatic downgrade or removal of proposal data: recovery uses the retained release/state backups, preserving the newer state separately. Restoring an old backup is never an automatic rollback because it may discard later conversation history.

## Acceptance, rejection and concurrency

The viewer sends proposal IDs and the requested decision, not a file path or replacement text. The server resolves all ownership, document and response routing from saved state. Reuse viewer-cookie authentication, origin checks and existing registered-path restrictions. Library previews remain read-only.

Serialize decisions, close-document actions, and proposal writes for the same registered file. On every acceptance, reread the current file and revalidate pending status, identity and exact source match. Match against current content, allowing unrelated source changes and shifted offsets when the exact target plus context is still unique. Missing/ambiguous/changed target becomes outdated. No automatic rebasing that changes the proposed before/after wording.

For one reply's **Accept all**:

1. Read one current source version and inspect its still-pending proposals.
2. Exclude stale/ambiguous proposals and record their outdated reasons.
3. Exclude every member of overlapping replacement ranges; keep these pending and explain that they must be reviewed individually. Do not choose one arbitrarily. Identical duplicate replacements also conflict in bulk.
4. Apply the remaining disjoint replacements in descending source-offset order to produce one result. Publish one file update and one set of accepted decisions. If none remain, do not write the file.
5. Recheck other pending proposals for that document after the write. Independent changes stay pending; proposals whose target was replaced become outdated.

The file writer must recheck the source bytes/hash and file identity immediately before publishing, preserve permissions and bytes outside the selected ranges (including line endings), reject symlink redirection/nonregular files, and write through a temporary sibling plus atomic replacement. If the final check changes, recompute validation or return a conflict; never publish the earlier result. File errors remain actionable errors with no false success.

This is optimistic coordination with external editors: Sidecar can serialize its own writes, but an ordinary filesystem does not provide compare-and-swap against an unrelated process writing after the final check. Do not claim a cross-process transaction or rely on agent-idle inference. Keep the check-to-publish interval synchronous and minimal, preserve the exact before/after snapshots, and document this limit. The regression gate must exercise external changes before and during preparation, not only stale UI state.

Accept/reject races are decided within the serialized operation. Accepted/rejected decisions are terminal; repeated clicks are idempotent and cannot apply twice. Outdated proposals cannot be accepted but may be rejected to dismiss them. Completing an agent reply cannot override a saved user decision or manufacture a second proposal.

## Crash and write-error recovery

A file write and state update are not one filesystem transaction. Use one durable pending-write record for each document operation, holding operation ID, proposal IDs, decision time, before/after snapshot hashes and result ranges. Save both snapshots and the record before publishing the file. Finish accepted statuses and remove the record only after the file operation succeeds.

On restart or a failed state-save retry, inspect the current backing file before allowing another acceptance for that document:

- It matches the intended after version: finalize the existing accepted decisions without writing again.
- It matches the before version: clear the unfinished write record and retain the proposals for explicit retry. Do not automatically reapply on startup.
- It matches neither: preserve the external content and both snapshots; mark the affected proposals outdated with an interrupted-application reason and retain the operation evidence. Explain that the application result could not be confirmed rather than claiming success or silently retrying.

Rejecting a proposal updates only state. Transport interruption, unrelated native-agent activity, and the Sidecar request queue do not affect saved proposal decisions. Closing a document uses the same operation serialization and removes its proposal records together with its existing conversations/snapshots; it never rolls back the backing file.

## Reuse and implementation boundaries

- `src/reply-metadata.ts`: parse the optional nested proposal without changing selection numbering. Malformed proposal metadata cannot strand a valid answer or enable an edit; surface a non-actionable diagnostic on its response. Preserve valid ordinary highlights.
- `src/store.ts`: v4 validation/migration, proposal routing/state, idempotent decisions, pending-write evidence. Existing serialized persistence remains the state owner.
- A focused source-replacement module: literal matching, overlap classification, preparation and guarded publication. Keep file mutation out of the renderer and transport adapters.
- `src/server.ts`: owner-scoped decision endpoints, document-operation serialization, snapshots, recovery and update events. Existing metadata capture invokes proposal preparation; no native output hook protocol changes are necessary.
- Shared web proposal components: compact record and document popover. Reuse `MessageContent`, main document selection/navigation, snapshots, settings and Markdown sanitization. Use the installed diff/rendering capability where it fits; do not add Plate/Tiptap/CodeMirror as an editor dependency.
- Shared skill and command documentation: same behavior for Codex and Claude. Edit `.agents/skills`, never tool-specific symlinks.

The ordinary Markdown viewer remains the source display. Proposals are data plus review controls, not a second editable document model.

## Verification required before release

Use disposable owners and files, never the user's AMC review documents.

- Metadata: valid nested proposals, ordinary highlights, array/slugs preserved, malformed and oversized entries, partial streams, stopped replies, duplicate final delivery and complete-reply recovery. Cover both Codex and Claude native adapter paths.
- Upgrade: v1/v2/v3 fixtures migrate with exact old history and snapshot preservation; v4 restart retains every decision; malformed state fails without overwriting it.
- Source writes: bold/code/link Markdown, repeated text with and without context, Unicode, LF/CRLF, insertions via replacement, deletion, formatting-only changes, no-op rejection, moved-but-identical target, stale/ambiguous source, missing or nonregular files, symlink replacement and permissions.
- Decisions: same proposal double-click, Accept versus Reject, Accept all versus individual action, overlapping ranges, one stale proposal among independent valid ones, proposals from another response/owner, and an active unrelated agent stream/queue.
- Failure injection: before snapshot/save, after write-record persistence, before file publication, after file publication but before decision persistence. Restart must retain recoverable output, avoid duplicate application and preserve externally changed files.
- Browser: annotation and reply-link entry points, main-document-only navigation, compact history, keyboard/focus dismissal, viewport/scroll positioning, hidden/resolved selections, original-document view, pinned messages, individual decisions and Accept all. Verify the original file is unchanged before acceptance and the real file changes after acceptance, not just the DOM.
- Run the relevant backend/adapter/browser suites, typecheck and diff check. Show the implemented UI in a disposable viewer before asking to release it.

## Design references

The mockup approved in this conversation is the document-popover option with per-reply Accept all. Its scratch source is `/private/tmp/sidecar-proposals-design/.superpowers/brainstorm/35568-1791085741/content/proposal-layouts-v5.html`; product implementation must not depend on that temporary file.

Research references, read on 2026-10-03:

- [Plate suggestions](https://platejs.org/docs/suggestion): inline/block suggestion and discussion interactions.
- [CodeMirror unified merge controls](https://github.com/codemirror/merge/blob/main/src/unified.ts): compact per-change actions. Its acceptance updates an editor baseline and is not Sidecar's file-writing contract.
- [Tiptap review changes](https://tiptap.dev/docs/ai/ai-toolkit/client/agents/review-changes): preview-before-accept semantics, rather than editing first and offering rejection afterward.
