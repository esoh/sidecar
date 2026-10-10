# Scripted HTML windows and independent content zoom

On 2026-10-09 Sean requested opt-in execution of self-contained HTML diagrams, initially relayed by the 1e5a agent. Sean then approved execution for trusted HTML with the explicit self-navigation limitation and requested independent zoom for all floating-window content.

## As built

- HTML previews remain static by default. **Run scripts** permits inline scripts/event handlers in that file window, retains the choice when docked, and resets when closed.
- An authenticated file endpoint reuses workspace/root, file-type, size and symlink checks. Its response has its own CSP and sandbox header, leaving the main viewer policy unchanged. Gateway forwarding preserves the policy and no-referrer header.
- Frames have an opaque origin: no parent DOM, cookie or storage access. Fetches, external resources, nested frames and forms are blocked. Inline styles and embedded data images/fonts are allowed.
- This is **not a strict offline sandbox**. Scripts can navigate their own frame externally. The UI tooltip and README require trusted HTML; agent registration alone never enables scripts.
- Local HTML links retain fragments and reuse the same window, including fragment text containing another hash. Other document/code links retain their existing behavior.
- File, pinned-message and Changed files windows have independent 25–200% content zoom. The header stays unscaled; the percentage resets to 100%. Dock tabs retain independent values; closing resets the value. Existing proposal size controls remain unchanged.

## Verification

The new endpoint and browser cases were first observed failing before implementation. Focused tests cover authentication/type/path rejection, default-off execution, working inline handlers, isolation, external resource blocking, standalone-preview sandboxing, fragment routing, dock state, reset/bounds and independence from conversation/document size.

- Type checks passed.
- All 141 browser cases passed after the HTML change. After adding zoom, all 36 affected window/dock/pin/file/HTML cases passed, including the two new zoom cases.
- Backend suite: 302 passed, one existing timeout cancellation in `simultaneous stream startup shares one observer and closes it with the app`. The timeout was independently reproduced on the unchanged PR46 release (`c012002a9169`).
- A disposable copy of the supplied transfer-warning diagram rendered, selected `#basic`, switched Chained/Hold tabs and zoomed to 50% without page errors. The source file was not modified.
- Direct private viewers, the shared gateway and authenticated plain-HTTP network access were exercised. No live public tunnel or native-agent integration was changed or exercised for this feature.

Tests and the example check used disposable servers/state and headless browsers, all closed afterward. No install or rollout is included in this verification.
