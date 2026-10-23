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
    const post = async (event, turnId, answer, marker, resetId, activity, requestIds, recoveryId) => {
      const endpoint = event === 'inbox' ? 'inbox' : event.startsWith('compaction-') ? 'lifecycle' : 'control';
      const response = await $.http.fetch(`${runtime.url}/agent/${endpoint}`, {
        method: 'POST', headers: { 'X-Sidecar-Token': token, 'Content-Type': 'application/json', 'X-Sidecar-Protocol': 'sc1' },
        body: JSON.stringify({ ownerKey, event, turnId, protocol: 'sc1', delivery: 'tool-context-v1', ...(answer ? { answer: answer.slice(0, 128 * 1024) } : {}), ...(marker ? { marker } : {}), ...(resetId ? { resetId } : {}), ...(activity ? { activity } : {}), ...(requestIds ? { requestIds } : {}), ...(recoveryId ? { recoveryId } : {}) }),
      });
      if (!response.ok) throw new Error('Sidecar control unavailable');
      const result = JSON.parse(response.text);
      if (['poll', 'inbox'].includes(event) && (result.ownerKey !== ownerKey || result.instanceId !== runtime.instanceId)) throw new Error('Sidecar control identity mismatch');
      return result;
    };
    post.ownerKey = ownerKey; post.ownerAlias = runtime.ownerAlias;
    return post;
}
let activeTurn, timer, polling = false, hasKnownState = false, handlingReset, lastCompletion, delivering = false;
const deliveries = new Map();
async function received($, text, turnId) {
  if (typeof text !== 'string' || !turnId) return text;
  try {
    const post = await connect($);
    if (!post) return text;
    const owns = value => value === post.ownerKey || value === post.ownerAlias;
    const ids = new Set();
    const matches = [...text.matchAll(/\{"type":"(?:sidecar|sc)\.(?:request|recovery)","ownerKey":"([^"\n]+)","requestId":"([^"\n]+)"(?:,"recoveryId":"([^"\n]+)")?/g)];
    for (const match of matches) {
      if (owns(match[1]) && !deliveries.has(match[0])) ids.add(match[2]);
    }
    if (ids.size) {
      const result = await post?.('received', turnId, undefined, undefined, undefined, undefined, [...ids].slice(0, 64));
      for (const match of matches) if (owns(match[1])) {
        const event = result?.notifications?.find(event => event.requestId === match[2]);
        if (event) deliveries.set(match[0], JSON.stringify(event));
      }
      // ponytail: retain recent hydrated deliveries, not an unbounded copy of
      // session history; old completed notifications are harmless on reread.
      while (deliveries.size > 256) deliveries.delete(deliveries.keys().next().value);
    }
    // Native Monitor truncates each stdout line. Rehydrate only this owner's
    // known prepared event, locally, before the model sees the attachment.
    return text.replace(/\{"type":"(?:sidecar|sc)\.(?:request|recovery)"[^\n]*/g, line => {
      const match = matches.find(match => line.startsWith(match[0]));
      const hydrated = match && deliveries.get(match[0]);
      return hydrated ? hydrated + (line.endsWith('</event>') ? '</event>' : '') : line;
    });
  } catch { /* Receipt reporting must not block the native prompt. */ }
  return text;
}
// One in-flight handoff across parallel tools and idle polling. Never replay
// an ambiguous submission; the existing receipt/Reset path owns recovery.
async function deliver($, turnId) {
  if (delivering) return;
  delivering = true;
  let post, event;
  try {
    post = await connect($);
    const result = await post?.('inbox', turnId ?? 'idle');
    event = result?.notification;
    if (!event || event.claimStatus && event.claimStatus !== 'claimed') return;
    if (event.ownerKey !== post.ownerKey && event.ownerKey !== post.ownerAlias) return;
    const text = JSON.stringify(event);
    if (turnId) {
      if (activeTurn !== turnId) throw new Error('Native turn ended before delivery');
      return await received($, text, turnId);
    }
    // This is called only by the background timer, never awaited by an active hook.
    const submitted = await $.prompt.submit({ text });
    if (submitted.drop) throw new Error('Native prompt declined');
  } catch {
    if (event) try { await post?.('delivery-failed', turnId ?? 'idle', undefined, undefined, undefined, undefined, [event.requestId], event.recoveryId); } catch { /* The original reservation remains; never replay it. */ }
  }
  finally { delivering = false; }
}
function monitor($) {
  if (timer) return;
  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      const post = await connect($);
      if (!post) return;
      const result = await post('poll', activeTurn ?? 'idle', undefined, undefined, undefined, hasKnownState ? activeTurn ? 'busy' : 'idle' : 'unknown');
      if (result.reset && handlingReset !== result.reset.id) {
        handlingReset = result.reset.id;
        const turnId = activeTurn;
        if (!hasKnownState) await post('reset-failed', 'unknown', undefined, undefined, handlingReset);
        else if (!turnId) await post('reset-idle', lastCompletion?.turnId ?? 'idle', lastCompletion?.answer, undefined, handlingReset);
        else {
          await post('reset-started', turnId, undefined, undefined, handlingReset);
          if (activeTurn !== turnId) {
            await post(activeTurn ? 'reset-failed' : 'reset-idle', activeTurn ?? lastCompletion?.turnId ?? 'idle', activeTurn ? undefined : lastCompletion?.answer, undefined, handlingReset);
            return;
          }
          try { await $.turn.abort({ turnId }); }
          catch { await post('reset-failed', turnId, undefined, undefined, handlingReset); }
        }
        return;
      }
      if (!activeTurn) {
        if (hasKnownState) await deliver($);
        return;
      }
      if (result.stop?.turnId !== activeTurn) return;
      const turnId = activeTurn;
      try { await $.turn.abort({ turnId }); }
      catch { await post('stop-failed', turnId); }
    } catch { /* No running app, or a disconnected viewer: never interrupt. */ }
    finally { polling = false; }
  };
  // Keep answering explicit Reset checks while idle. A fresh module cannot
  // infer idle from the absence of turn.start (it may have loaded mid-turn).
  timer = $.clock.every(500, () => { void poll(); });
  void poll();
}
export function register(on) {
  activeTurn = undefined; timer = undefined; polling = false; hasKnownState = false; handlingReset = undefined; lastCompletion = undefined; delivering = false; deliveries.clear();
  on('session.start', async ($, e, next) => { monitor($); return next(e); });
  on('session.end', async ($, e, next) => { timer?.cancel(); timer = undefined; activeTurn = undefined; hasKnownState = false; lastCompletion = undefined; return next(e); });
  on('session.compact', async ($, e, next) => {
    if (e.agentId || e.trigger === 'precompute') return next(e);
    // Claude 2.1.293's classic compaction path omits skill-registered hooks.
    let post;
    try { post = await connect($); await post?.('compaction-started'); }
    catch { /* Status reporting must not prevent native compaction. */ }
    try { return await next(e); }
    finally {
      try { await post?.('compaction-completed'); }
      catch { /* Preserve native success, failure, and interruption unchanged. */ }
    }
  });
  on('turn.start', async ($, e, next) => {
    activeTurn = e.turnId; hasKnownState = true; monitor($);
    return next({ ...e, text: await received($, e.text, e.turnId) });
  });
  on('prompt.submit', async ($, e, next) => {
    const result = await next(e);
    if (e.turnId && !e.wait && !result.drop && !e.agentId) return { ...result, text: await received($, result.text, e.turnId) };
    return result;
  });
  on('prompt.attachment', async ($, e, next) => {
    if (e.type === 'queued_command' && e.origin.kind === 'engine' && !e.agentId)
      return next({ ...e, text: await received($, e.text, activeTurn) });
    return next(e);
  });

  on('tool.call', async ($, e, next) => {
    const turnId = activeTurn;
    const result = await next(e);
    if (e.agentId || !turnId || activeTurn !== turnId || result.deny) return result;
    const text = await deliver($, turnId);
    return text ? { ...result, context: [...(result.context ?? []), text] } : result;
  });

  // MessageDisplay's turn_id differs from the native abort ID in Claude 2.1.288.
  // Bind by the exact request marker, never by whichever turn happens to be busy.
  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) { activeTurn = e.turnId; hasKnownState = true; }
    let prefix = '', checked = !!e.agentId;
    for await (const chunk of next(e)) {
      yield chunk;
      if (checked || chunk.kind !== 'text') continue;
      prefix += chunk.text;
      const marker = prefix.match(/^(?:\[\[sc(?:p)?:r[1-9A-Z][0-9A-Z]*\]\]\n|\[\[sidecar(?:-progress)?:[0-9a-f-]{36}\]\]\n\[\[sidecar-reply:[0-9a-f-]{36}\]\]\n)/);
      if (marker) {
        checked = true;
        try { const post = await connect($); await post?.('started', e.turnId, undefined, marker[0]); }
        catch { /* An unavailable app must not affect normal output. */ }
      } else if (prefix.length > 180) checked = true;
    }
  });

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) return next(e);
    lastCompletion = { turnId: e.turnId, answer: e.answer };
    if (!activeTurn || activeTurn === e.turnId) { activeTurn = undefined; hasKnownState = true; }
    try {
      const post = await connect($);
      await post?.(e.isAborted ? 'interrupted' : 'completed', e.turnId, e.answer);
    } catch { /* Closing Sidecar must not interfere with the native turn. */ }
    return next(e);
  });
}
