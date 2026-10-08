# Shared Sidecar gateway

Date: 2026-10-08. Approved design; local implementation annotated below.

## Intent and agreed behavior

Use one stable browser entry point and one tunnel for every Sidecar agent on this
computer. Documents, requests, and replies remain attached to their original
Codex or Claude conversation. The base URL lists Sidecar agents and their native
session IDs; selecting an agent opens its document list.

Both lists offer **Last opened** and **Recent conversation activity** through a
compact sort menu. Last opened is the default. Each view remembers its own sort
choice in browser storage. Existing local access stays automatic. LAN and tunnel
access require a shared passphrase, with remembered browsers.

A remembered login is tied to the browser and hostname, not the client's IP or
network. Using the same HTTPS tunnel hostname on home Wi-Fi, another Wi-Fi
network, and cellular should retain the login. LAN-IP and public-hostname cookies
remain separate, as required by browser cookie isolation. The existing owner
server already persists network credentials and does not bind them to a client
IP. Repeated prompts at the same HTTPS address in the same browser therefore
need diagnosis; do not solve them by bypassing authentication or trusting an IP.

## Architecture and URLs

Add one machine-wide gateway while retaining the existing private owner servers.
This is smaller than moving every owner's store, capture, queue, and native-agent
connection into one process. A configuration-only tunnel change would not cover
Sidecar's browser API paths, links, authentication, and document library.

Examples, using generic public names:

- `https://sidecar.example.com/`: all-agent browser.
- `https://sidecar.example.com/a/o4/`: that agent's document list.
- `https://sidecar.example.com/a/o4/?document=UUID`: its existing document viewer.

Use the persistent computer-wide owner aliases already introduced by the compact
protocol. Browser document IDs remain their existing UUIDs. Owner aliases are
routing identifiers, never credentials. Unknown aliases produce an explicit
unavailable view; they must never select the current or first available owner.

Preserve the current separation between automatic local access and protected
remote access. There are two **shared**, stable gateway listener ports: one local
browser port and one protected LAN/tunnel port. Every agent uses these same two
ports; the tunnel always targets the protected one. Owner servers may still use
private loopback ports internally. The user no longer manages per-agent ports.

Add optional machine-local `gateway.port` and `gateway.networkPort` settings,
with defaults 43120 and 43121. Both must be valid, distinct ports. Existing tunnel
configuration remains compatible. A port conflict fails clearly rather than
silently selecting a random port. Public documentation uses generic examples.

## Startup and ownership

`open` and `browse` ensure the gateway exists, reusing the existing owner-lock
pattern in a separate state-root `gateway` directory. Simultaneous agent startup
must produce one gateway. Its runtime record carries process/instance identity
and both gateway URLs; it is not owned by the first agent that starts it.

`open` still starts/registers a document only for the invoking native owner, then
returns a gateway URL. `browse` opens the global library without starting other
agents. Opening a saved stopped session offers the existing read-only preview;
it never creates, resumes, or transfers a native conversation.

The existing owner `stop` command stops only that owner's viewer/capture service.
It does not stop the gateway, other owners, or a shared tunnel connector. Gateway
shutdown is a separate explicit maintenance operation. Gateway restarts do not
change its configured ports or saved browser credentials. Remote access starts
disabled; explicit gateway network enablement persists until disabled. Preserve
that setting during gateway maintenance, with normal config validation.

## Routing and security

Authenticate the browser at the gateway before serving agent lists, previews,
files, APIs, or streams. Reuse the existing local Host/Origin and cookie defenses
for automatic localhost access. Reuse the protected listener's passphrase,
HttpOnly cookie, secure HTTPS cookie, login throttling, and origin checks for
remote access. Persist one gateway credential record. Changing its passphrase
revokes remembered browsers and existing remote streams. Merely switching
networks, restarting an owner, or upgrading the gateway must not rotate it.

The shared remote login grants access to all saved Sidecar owners on this
computer; v1 has no per-owner remote access rules. Enabling this new gateway is
an explicit machine-wide sharing action. Do not silently broaden an old owner's
remote-access setting during installation.

Resolve owner routes only from the existing registry and validated runtime
records. Verify the backend owner/instance before forwarding. Never accept an
arbitrary upstream URL from a browser. Keep owner agent-capability tokens and
backend viewer cookies on the server. Remove browser-supplied credentials and
forwarded headers before establishing the gateway's own upstream request.

The browser may use only viewer routes. Routed or public `/agent/*` paths remain
blocked. Native hooks and CLIs continue to use their original owner's private
loopback APIs. Gateway management uses a separate local authenticated capability;
remote requests cannot gain local privileges through a rewritten Host or Origin.

Update API, SSE, image, font, file, navigation, and download URL construction to
respect the owner base path. Preserve document/selection links and read-only
historical views. Forward errors without falling back to another owner. An owner
restart causes its streams to reconnect to its new verified instance; it must
not interrupt another owner's stream. Do not retry mutations automatically.

## Agent browser and sorting

Reuse the existing library and agent-session components. Root rows show Codex or
Claude, the native session UUID with a copy button, document count, and viewer
availability. Show a friendly name only when already available; do not scan
Herdr or invent a new native-session discovery service. Include saved stopped
owners. Owners with readable state but no documents have an empty document view
and sort after owners with documents. Registry tombstones alone are not entries.

The selected agent's view lists its documents and retains existing close/delete
confirmation, stopped-owner previews, and relative last-opened timestamps. Keep
local backend URLs out of browser-facing links.

Sorting rules are shared across both views:

- **Last opened:** descending `lastOpenedAt`, then descending conversation activity.
- **Recent conversation activity:** descending conversation activity, then
  descending `lastOpenedAt`.
- Activity reuses the library's existing definition: latest saved message time,
  falling back to thread creation time. Listing, copying an ID, or changing a
  sort setting is not document activity.
- An agent's timestamps are the respective maxima across all its documents,
  independent of the document view's selected sorting mode.
- Missing timestamps are older than known ones; stable IDs break remaining ties.
- Actual document opens update last-opened time using the existing mechanism.

The root and agent-document views keep separate sort preferences. One document
sort preference applies across agents. Changing a sort does not change or fetch
full conversation histories.

## Tunnels, traffic, and rollout

The ngrok and Cloudflare workflows target the gateway's fixed protected listener.
Keep ngrok as the existing default. Reuse the generic Cloudflare connector helper
and its coexistence checks; preserve unrelated hostname routes and process
ownership. Adding or restarting owners requires no tunnel reconfiguration.

Forward each open viewer's existing incremental SSE stream without buffering or
replacing it with repeated full-state requests. The library loads summaries;
files and document content remain on demand. Do not subscribe every browser to
all owners' full histories or stream output. Reuse existing hashed asset caching.

This work builds on the installed but unmerged compact-protocol branch at
`10424ad`. Keep it a separate change. Owner state stays version 5; document IDs,
backing files, snapshots, request bookkeeping, and aliases need no rewrite.
Existing direct local URLs remain usable during rollout. Old running owner
servers are not forcibly restarted: show a clear upgrade requirement if an owner
cannot serve the gateway contract. Keep draft and preference keys unchanged,
which preserves them when the public origin stays the same. Browser storage at
an old local port cannot automatically appear at the new gateway origin. Keep
those old URLs usable and their storage untouched; explain that local users
should finish or copy outstanding drafts before switching. Automatic cross-origin
draft migration is outside this change. A one-time gateway login replaces the
old owner-specific login; later network changes must not prompt again.

Do not migrate live tunnel ingress, install the gateway, restart real viewers,
or alter real documents as part of design/implementation verification. The later
user-authorized rollout backs up state and moves the tunnel to the gateway once,
then verifies both native agents through the shared hostname.

## Verification required before release

- Concurrent startup, stable ports, conflict handling, owner stop, and gateway
  restart with preserved credentials and state.
- Two independent owners behind one origin: documents, comments, streamed final
  and progress replies, edits, proposals, Stop/Reset, and file/historical views
  always route to the selected owner. Cover Codex and Claude.
- Unauthenticated LAN/public access, Host/Origin spoofing, route traversal,
  arbitrary upstream selection, and agent-only route attempts are rejected.
- Remembered login survives a simulated client-address change and owner/gateway
  restart; passphrase rotation revokes it.
- Both sort modes in both views, independent preferences, maxima across multiple
  documents, missing timestamps, ties, empty/stopped owners, and copyable IDs.
- Browser checks for prefixed assets/links, cross-owner navigation, reconnects,
  retained drafts at the same origin, old-origin draft preservation, and the
  absence of repeated full-history idle traffic.

## As built — 2026-10-08

Implemented on `feat/shared-viewer-gateway`, based on compact protocol `10424ad`.
The private owner services retain their state and native transport; the gateway
uses shared HTTP authentication/assets, verified owner routes and streaming proxy
responses. The CLI, browser paths, agent/document sorting, gateway network settings,
README and shared Codex/Claude skill use the same gateway contract. No dependency
or state-format migration was added. Existing direct owner URLs remain supported.

The build also contains the separately verified Claude foreground-compaction
module fix: native `session.compact` middleware reports start and clears status on
completion, failure or interruption, while ignoring background/subagent work.

Local verification used disposable Codex/Claude owner services and native-control
fixtures, not real agent sessions. Backend/script checks passed all 274 tests with
four workers; an initial unbounded run stalled in a Reset test under concurrent
browser load, while isolated Reset passed all 10 tests. The browser run passed
122 scenarios; its remaining settings fixture also failed on the unchanged base
because it read the machine's Cloudflare preference instead of ngrok defaults.
Isolating that fixture passed its rerun. Gateway checks cover prefixed rendering,
files/images/history/proposals, draft storage, idle traffic, library sorting and
stopped previews; HTTP checks cover native-route denial, owner identity, Stop/Reset
routing, credential persistence and revocation of an open stream. Type checks pass.

No installation, native plugin reload, real viewer restart, live tunnel change,
phone test or live Claude compaction was performed. Those remain rollout checks,
including one-time shared login and gateway ingress migration after authorization.
