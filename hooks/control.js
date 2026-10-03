// Claude's native module API runs inside the existing conversation. Classic
// Stop hooks do not fire on interruption and cannot safely abort a live turn.
async function connect($) {
    const sessionId = (await $.session.id()).toLowerCase();
    if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(sessionId)) return;
    const ownerKey = `claude-${sessionId}`;
    const root = await $.env.get('SIDECAR_STATE_DIR') ?? `${await $.env.get('HOME')}/.local/state/sidecar`;
    const directory = `${root}/${ownerKey}`;
    const runtime = JSON.parse(await $.fs.read(`${directory}/runtime.json`));
    if (runtime.ownerKey !== ownerKey || !/^http:\/\/127\.0\.0\.1:\d+$/.test(runtime.url) || typeof runtime.instanceId !== 'string') return;
    const token = (await $.fs.read(`${directory}/agent-token`)).trim();
    if (!/^[0-9a-f]{64}$/.test(token)) return;
    return async (event, turnId, answer, marker) => {
      const response = await $.http.fetch(`${runtime.url}/agent/control`, {
        method: 'POST', headers: { 'X-Sidecar-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ownerKey, event, turnId, ...(answer ? { answer: answer.slice(0, 128 * 1024) } : {}), ...(marker ? { marker } : {}) }),
      });
      if (!response.ok) throw new Error('Sidecar control unavailable');
      const result = JSON.parse(response.text);
      if (event === 'poll' && (result.ownerKey !== ownerKey || result.instanceId !== runtime.instanceId)) throw new Error('Sidecar control identity mismatch');
      return result;
    };
}
export function register(on) {
  let activeTurn, timer, polling = false;
  on('turn.start', async ($, e, next) => {
    timer?.cancel(); activeTurn = e.turnId;
    const poll = async () => {
      if (polling || activeTurn !== e.turnId) return;
      polling = true;
      try {
        const post = await connect($);
        if (!post || activeTurn !== e.turnId) return;
        const result = await post('poll', e.turnId);
        if (result.stop?.turnId !== e.turnId || activeTurn !== e.turnId) return;
        try { await $.turn.abort({ turnId: e.turnId }); }
        catch { await post('stop-failed', e.turnId); }
      } catch { /* No running app, or a disconnected viewer: never interrupt. */ }
      finally { polling = false; }
    };
    // Active-turn polling also finds an app opened halfway through this turn.
    timer = $.clock.every(500, () => { void poll(); });
    void poll();
    return next(e);
  });

  // MessageDisplay's turn_id differs from the native abort ID in Claude 2.1.288.
  // Bind by the exact request marker, never by whichever turn happens to be busy.
  on('turn.step', async function* ($, e, next) {
    let prefix = '', checked = !!e.agentId;
    for await (const chunk of next(e)) {
      yield chunk;
      if (checked || chunk.kind !== 'text') continue;
      prefix += chunk.text;
      const marker = prefix.match(/^\[\[sidecar(?:-progress)?:[0-9a-f-]{36}\]\]\n/);
      if (marker) {
        checked = true;
        try { const post = await connect($); await post?.('started', e.turnId, undefined, marker[0]); }
        catch { /* An unavailable app must not affect normal output. */ }
      } else if (prefix.length > 100 || prefix.includes('\n')) checked = true;
    }
  });

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) return next(e);
    if (activeTurn === e.turnId) { timer?.cancel(); activeTurn = undefined; }
    try {
      const post = await connect($);
      await post?.(e.isAborted ? 'interrupted' : 'completed', e.turnId, e.answer);
    } catch { /* Closing Sidecar must not interfere with the native turn. */ }
    return next(e);
  });
}
