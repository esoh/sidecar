# Shared Sidecar gateway implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan inline, with one independent whole-branch review at the end.

**Goal:** Give every saved Sidecar agent one browser origin and tunnel, with a global agent browser and sorted per-agent documents, while retaining private owner services.

**Architecture:** Extract the existing HTTP viewer authentication/static serving into shared modules. A separate machine gateway authenticates browsers, resolves persistent owner aliases, and streams viewer requests to verified private servers. Native agent APIs, capture, stores, IDs, and request delivery remain owner-local.

**Tech Stack:** Existing Node HTTP, TypeScript, React, esbuild, Node test runner and Playwright; no new dependency.

**Spec:** `docs/superpowers/specs/2026-10-08-shared-viewer-gateway-design.md` (approved).

## Global Constraints

- Execute in `/Users/seanoh/ws/pg/sidecar/.claude/worktrees/shared-viewer-gateway`, branch `feat/shared-viewer-gateway`, based on compact protocol `10424ad`. Compaction fix `1f7fa7d` is carried into this build independently.
- User preapproved this plan and inline implementation. Local task commits are authorized; publishing, installing, restarting real viewers, and changing live tunnels are outside verification.
- Preserve owner state v5, private native APIs, draft keys, public-origin storage, existing direct local URLs, and shared tunnel ownership. No document/history migration.
- Gateway defaults: local 43120, protected 43121; configurable distinct fixed ports. Remote disabled initially, explicit gateway setting persists. Never inherit owner sharing settings.
- Browser gateway access is viewer-only. Do not forward browser credentials, arbitrary targets, or `/agent/*`; no mutation retries. Local management uses its own capability.
- Remembered login depends on browser/host, not client IP. Rotation revokes streams. Unknown routes and old backends fail explicitly.
- Reuse existing incremental SSE and cached assets; list summaries only, load file bodies on demand.
- Repository has no setup script. Install locked dependencies offline before verification.

## Review Focus

1. Host, Origin, path encoding and forwarded-header attacks, including prefixed agent routes and protected-to-local privilege escalation (Tasks 1–2 security tests).
2. Concurrent gateway startup, owner restart/replaced runtime and port conflicts; no cross-owner request delivery or mutation replay (Tasks 2–3 lifecycle tests).
3. Remembered cookie across restart/client-address change, revoked open SSE, and remote opt-in persistence without widening old sharing (Tasks 1–3 auth tests).
4. Absolute URLs hidden in images, fonts, file popouts, proposals, historical documents, SSE and navigation; same-origin drafts and old-origin storage (Task 4 browser tests).
5. Sort maxima independent of first document, missing timestamps/ties/empty owners, stopped previews and accidental history polling (Tasks 5–7).

## Task 1: Reuse viewer HTTP boundaries

**Files:** add `src/viewer-http.ts`, `src/viewer-assets.ts`; modify `src/server.ts`; extend `test/lan.test.ts` and add `test/viewer-http.test.ts`.

**Interfaces:** `createViewerHost` owns listeners, local/network cookies, host/origin checks, network status/toggles and closure. It calls an authenticated handler with parsed URL and local/agent context. Caller supplies directory, ports, cookie name, capability, page predicate, instance ID and handler. Optional persisted network configuration is used only by the gateway. Shared `bodyOf`, `json`, `sameSecret`, `sendBody` retain current validation/compression. `serveViewerAsset` handles common assets and index HTML without any owner/store.

- [ ] Add a regression exercising a viewer host with fixed protected port, persisted enablement and credentials across restart, remote mutation/origin denial and cookie rotation. The production mutation it detects is losing persistent authentication or trusting a forwarded local identity.
- [ ] Run `node --import tsx --test test/viewer-http.test.ts`; expected missing host API / failed new behavior.
- [ ] Extract existing authentication and assets without weakening validation. Existing owner start/stop and network behavior remain unchanged by default. Support authenticated page paths for `/a/oN/`, and login redirects back to the same relative route.
- [ ] Run `node --import tsx --test test/viewer-http.test.ts test/lan.test.ts test/server.test.ts`; expected all pass (adjust existing server test filename only if absent).
- [ ] Run `pnpm typecheck`; expected clean. Commit `refactor: share viewer HTTP authentication and assets`.

## Task 2: Route verified owners through the gateway

**Files:** add `src/gateway.ts`, `test/gateway.test.ts`; modify `src/server.ts`, `src/library.ts`, `src/agent.ts` as needed.

**Interfaces:** `startGateway({stateRoot, port, networkPort})` returns URL, instance ID, close and network access. `/a/<ownerAlias>/...` resolves only the persistent ID registry; `/agent/*` anywhere is denied to browsers. `/gateway/status|network|stop` requires the gateway capability and local listener. Owner status advertises a gateway protocol version. Resolve backend owner and instance before proxying, keep its viewer cookie server-side, and forward with sanitized headers. Global `/api/library` and saved previews use existing library helpers without an owner service.

- [ ] Write two-owner Codex/Claude integration tests: routed reads, independent thread submission, progress/final incremental SSE, wrong/unknown alias refusal, encoded traversal and prefixed agent endpoint denial. Include an owner restart and old capability refusal.
- [ ] Run `node --import tsx --test test/gateway.test.ts`; expected missing gateway implementation.
- [ ] Implement alias routing and streaming HTTP proxy, no mutation retry. Serve common root assets/library directly. Strip browser authentication/forwarded headers and upstream cookies. Keep Stop/Reset/proposals/file APIs on the selected owner. Proxy network settings to gateway handling rather than owner's local privileges.
- [ ] Add focused tests for stopped-owner preview/image/close, remote access denial and backend stop not affecting sibling streams. Test hostile upstream selection; never let request parameters choose the target.
- [ ] Run `node --import tsx --test test/gateway.test.ts test/library.test.ts`; expected pass. Commit `feat: route saved agents through one viewer gateway`.

## Task 3: Start and manage one stable gateway

**Files:** add `src/gateway-client.ts`, `test/gateway-lifecycle.test.ts`; modify `src/cli.ts`, `src/agent.ts`, `src/tunnel-config.ts`, `test/tunnel-config.test.ts`.

**Interfaces:** machine config exposes `gateway.port` (43120) and `gateway.networkPort` (43121), validated distinct. `ensureGateway(stateRoot)` uses separate `gateway` lock/runtime/token and a detached `gateway-serve` command. `gateway status|stop` are explicit local maintenance. `open` starts only its owner then returns gateway URL; `browse` opens global library without starting an owner. Owner `stop` remains unchanged.

- [ ] Add failing tests for defaults/invalid/conflicting ports, concurrent ensure calls returning one instance, restart preserving enabled state/auth, and browse without native owner startup.
- [ ] Run `node --import tsx --test test/gateway-lifecycle.test.ts test/tunnel-config.test.ts`; expected new behavior failures.
- [ ] Implement lifecycle using existing lock pattern; validate runtime identity, report conflicts clearly and never fall back to random gateway ports. Keep private owner-port behavior. No process discovery beyond own runtime/lock.
- [ ] Run task tests and `pnpm typecheck`; expected pass. Commit `feat: start one persistent machine viewer gateway`.

## Task 4: Keep every viewer URL on its owner route

**Files:** add `web/viewer-path.ts`, `test/viewer-path.test.ts`; modify `web/api.ts`, `web/app.tsx`, `web/FilesPanel.tsx`, `web/MarkdownDocument.tsx`, `web/ProposalReview.tsx`, `web/conversations.tsx`, `web/TextSettings.tsx`, `web/index.html` and `test/browser.spec.ts`.

**Interfaces:** explicit `viewerPath(path)` prefixes viewer API/SSE/navigation to validated current `/a/oN/`, leaving direct legacy viewer URLs unchanged. Gateway HTML marks gateway context. Root library calls remain root-scoped. Shared font/static URLs remain authenticated at the gateway root. Public links retain owner path/query/hash.

- [ ] Add failing route-helper tests and browser scenario loading a prefixed owner: document, stream, images, history, file window and proposal checks remain under selected owner.
- [ ] Run `node --import tsx --test test/viewer-path.test.ts` and targeted Playwright scenario; expected routing failures.
- [ ] Replace every direct API/EventSource/image/file/historical and document-navigation URL construction. Do not change localStorage keys. Gateway base and owner-without-document render library; legacy direct viewer still renders its document.
- [ ] Verify same-origin draft survives navigation and old-origin draft is untouched. Verify only current owner's incremental stream is subscribed.
- [ ] Run helper and targeted browser tests, `pnpm typecheck`; expected pass. Commit `feat: keep viewer requests and links on shared owner routes`.

## Task 5: Agent browser and independent sort controls

**Files:** add `src/library-sort.ts`, `test/library-sort.test.ts`; modify `src/library.ts`, `web/DocumentLibrary.tsx`, `web/app.css`, `test/library.test.ts`, `test/browser.spec.ts`.

**Interfaces:** `LibrarySession` carries optional owner alias; gateway includes readable empty owners and URLs only on its origin. Shared comparison uses each agent's independent max last-opened/activity timestamps. Sort values `opened|activity`; independent persisted keys for agent and document lists, document preference shared across owners. Reuse existing rich menu and agent icon/copy patterns.

- [ ] Add failing tests for independent maxima, missing dates, stable ties, empty-last and both sort modes. Browser test global IDs/copy/count/availability, owner documents, persisted independent sort choices and stopped previews/close confirmation.
- [ ] Run focused library tests and targeted browser scenario; expected missing grouping/sort behavior.
- [ ] Implement compact global agent rows and owner document view, back navigation and empty state. Preserve close/preview behavior; listing/sorting/copying must not write opened timestamps or load full histories.
- [ ] Run `node --import tsx --test test/library-sort.test.ts test/library.test.ts` and targeted browser scenario; expected pass. Commit `feat: browse and sort agents and their documents`.

## Task 6: Gateway tunnel settings and shared guidance

**Files:** modify `src/cli.ts`, `web/TextSettings.tsx`, `test/tunnel-config.test.ts`, `test/gateway-lifecycle.test.ts`, `README.md`, `.agents/skills/sidecar/SKILL.md`; preserve generic Cloudflare helper unchanged.

**Interfaces:** network and tunnel commands now target gateway management, retaining optional owner argument for compatibility but never exposing that owner's private listener. Cloudflare/ngrok use fixed gateway protected target; settings link includes selected owner route. Existing helper coexistence checks and generic public examples remain.

- [ ] Add failing CLI/settings contract tests proving tunnel target is gateway-wide and enablement is explicit; remote browser cannot change network/provider config or read capabilities.
- [ ] Run focused gateway/tunnel tests; expected old owner-target behavior failures.
- [ ] Update command flow, help and settings copy. Document one-time local-origin draft transition, one-time shared login, permanent hostname-based browser trust, local gateway maintenance and old backend upgrade requirement. Update canonical shared skill for both agents, not symlinks.
- [ ] Run focused tests and `pnpm typecheck`; expected pass. Commit `feat: use shared gateway for network access and tunnels`.

## Task 7: Integrated verification and independent review

**Files:** regression additions in `test/gateway.test.ts`, `test/browser.spec.ts`; annotate design with As built and update this plan with evidence.

- [ ] Close any spec coverage gaps with failing regressions before fixes: concurrent startup, restart/reconnect, remote credential rotation, no idle full-history traffic, failed/stopped owners and direct legacy access.
- [ ] Run `pnpm test`, `pnpm typecheck`, `pnpm exec playwright test` and `git diff --check`, capturing full logs. Expected green; record pre-existing failures explicitly and reproduce on base if encountered.
- [ ] Inspect scratch browser UI and gateway network traffic using disposable owners; no real viewers or tunnels.
- [ ] Commit verification/docs, prepare whole-branch review from `10424ad` through HEAD. Run one independent review under requesting-code-review, prioritizing Review Focus above. Fix confirmed important issues with red/green tests and rerun affected checks; leave review-driven changes uncommitted if reviewer is Claude until user approval.
- [ ] Report what is implemented, checks and unverified live rollout. Keep branch local for user review; no merge/install/tunnel mutation in this plan.
