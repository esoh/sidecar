// Cmd+Backslash on a Mac, Ctrl+Backslash elsewhere: shows or hides the conversation sidebar from any focus.
// The viewer's own check is isConversationShortcut in web/shortcuts.ts; keep the two in step.
// Injected into every HTML frame, even with Run scripts off (then the only script its CSP nonce allows).
// Plain browser JS: no backticks, no "${", and no closing script tag.
export const shortcutHelper = String.raw`(function () {
'use strict';
var isMac = /Mac|iPhone|iPad/.test(navigator.platform);
window.addEventListener('keydown', function (event) {
  if (event.code !== 'Backslash' || event.repeat || event.isComposing || event.shiftKey || event.altKey || (isMac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey)) return;
  event.preventDefault(); event.stopImmediatePropagation();
  window.parent.postMessage({ sidecar: 'html-shortcut', type: 'toggle-conversations' }, '*');
}, true);
// The page's own "which step is showing" (location.hash, also for CSS :target pages): the viewer keeps it in its URL across refreshes.
// "Missing" is judged once per load (after load, so the page has built its DOM): plain fragments only; #/route and #!route are the page's own.
function missingTarget(hash) {
  if (hash.length < 2 || hash.indexOf('#/') === 0 || hash.indexOf('#!') === 0) return false;
  try {
    var id = decodeURIComponent(hash.slice(1));
    if (id.toLowerCase() === 'top' || document.getElementById(id)) return false;
    var named = document.getElementsByName(id);
    for (var i = 0; i < named.length; i++) if (named[i].localName === 'a') return false;
    return true;
  } catch (e) { return false; }
}
function reportHash(first) { window.parent.postMessage({ sidecar: 'html-bridge', type: 'hash', hash: location.hash, missing: first === true && missingTarget(location.hash) }, '*'); }
if (document.readyState === 'complete') reportHash(true); else window.addEventListener('load', function () { reportHash(true); });
window.addEventListener('hashchange', function () { reportHash(false); });
})();`;
// Inline script appended to scripted full-page HTML so the parent viewer can attach selections and picked elements.
// Plain browser JS: no backticks, no "${", and no closing script tag.
export const htmlBridge = String.raw`(function () {
'use strict';
var MARK = 'html-bridge', own = 'data-sidecar-bridge';
function send(message) { message.sidecar = MARK; window.parent.postMessage(message, '*'); }
function isOwn(node) { return !!(node && node.nodeType === 1 && node.closest('[' + own + ']')); }
function unique(selector) { try { return document.querySelectorAll(selector).length === 1; } catch (e) { return false; } }
function selectorOf(element) {
  var parts = [];
  for (var node = element; node && node.nodeType === 1; node = node.parentElement) {
    if (node.id) {
      var byId = '#' + CSS.escape(node.id);
      if (unique(byId)) { parts.unshift(byId); break; }
    }
    var part = node.localName;
    if (node === document.documentElement) { parts.unshift(part); break; }
    var same = 0, index = 0, siblings = node.parentElement ? node.parentElement.children : [];
    for (var i = 0; i < siblings.length; i++) {
      if (siblings[i].localName === node.localName && siblings[i].namespaceURI === node.namespaceURI) { same++; if (siblings[i] === node) index = same; }
    }
    if (same > 1) part += ':nth-of-type(' + index + ')';
    parts.unshift(part);
  }
  return parts.join(' > ');
}
// Markup without Sidecar's own script/style/overlay, so excerpts and fingerprints describe only the page.
function markup(element) {
  if (!element.querySelector('[' + own + ']')) return element.outerHTML;
  var copy = element.cloneNode(true), nodes = copy.querySelectorAll('[' + own + ']');
  for (var i = 0; i < nodes.length; i++) nodes[i].remove();
  return copy.outerHTML;
}
// Change detection, not security: length plus FNV-1a over the full markup.
function fingerprint(element) {
  var text = markup(element), hash = 0x811c9dc5;
  for (var i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return text.length + ':' + ('0000000' + hash.toString(16)).slice(-8);
}
// Visible text of a node without Sidecar's own nodes, for matching an anchor again after the page was edited.
function plainText(node) {
  var source = node;
  if (node.querySelector('[' + own + ']')) { source = node.cloneNode(true); var own_ = source.querySelectorAll('[' + own + ']'); for (var i = 0; i < own_.length; i++) own_[i].remove(); }
  return source.textContent.replace(/\s+/g, ' ').trim().slice(0, 60);
}
// An element and its ancestors (below body), so a removed element can fall back to the nearest surviving parent.
function chainOf(element) {
  var chain = [];
  for (var node = element; node && node.nodeType === 1 && node !== document.body && node !== document.documentElement && chain.length < 12; node = node.parentElement)
    chain.push({ selector: selectorOf(node), tag: node.localName, text: plainText(node), hasId: !!node.id });
  return chain;
}
// Scrolls to the first chain entry that still names exactly one same-tag element (an id, or the same text): the deepest
// at its remembered offset, a parent at the viewport top. Returns whether one survived.
function restoreChain(chain, offset) {
  for (var i = 0; i < chain.length; i++) {
    var entry = chain[i], found = null;
    if (!entry || typeof entry.selector !== 'string' || typeof entry.tag !== 'string') continue;
    try { found = document.querySelectorAll(entry.selector); } catch (e) { continue; }
    var node = found.length === 1 ? found[0] : null;
    if (!node || isOwn(node) || node.localName !== entry.tag || !(entry.hasId === true || plainText(node) === entry.text)) continue;
    window.scrollBy(0, node.getBoundingClientRect().top - (i === 0 && typeof offset === 'number' && isFinite(offset) ? offset : 0));
    return true;
  }
  return false;
}
function elementOf(node) { return node && node.nodeType === 1 ? node : node && node.parentElement; }
var timer = 0, revealed = null;
function sameRange(a, b) { return a.compareBoundaryPoints(Range.START_TO_START, b) === 0 && a.compareBoundaryPoints(Range.END_TO_END, b) === 0; }
// Reports a selection the user just finished with the pointer or keyboard (with its frame rectangle, for the
// viewer's quick menu), or an empty one when the gesture left nothing selected. A range Sidecar itself revealed
// is not reported, so navigating a saved target never offers or attaches it.
function reportSelection() {
  var selection = getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) { send({ type: 'selection', exact: '', selector: 'html' }); return; }
  // Range text (raw node data), not Selection text (rendered), so reveal can match it again.
  var range = selection.getRangeAt(0), text = range.toString(), element = elementOf(range.commonAncestorContainer);
  if (!text.trim() || !element || isOwn(element) || revealed && sameRange(range, revealed)) return;
  var box = range.getBoundingClientRect();
  send({ type: 'selection', exact: text.slice(0, 16000), selector: selectorOf(element), rect: { left: box.left, top: box.top, right: box.right, bottom: box.bottom } });
}
// Deferred so a click that collapses the selection is seen collapsed.
function finished() { clearTimeout(timer); timer = setTimeout(reportSelection, 0); }
document.addEventListener('mouseup', finished);
document.addEventListener('touchend', finished);
document.addEventListener('keyup', function (event) { if (event.key === 'Shift' || event.key.indexOf('Arrow') === 0) finished(); });
// A new gesture may select the revealed words on purpose; only a release with no gesture of its own stays ignored.
function started() { revealed = null; }
document.addEventListener('mousedown', started);
document.addEventListener('touchstart', started, { passive: true });
document.addEventListener('keydown', function (event) { if (event.key === 'Shift' || event.key.indexOf('Arrow') === 0) started(); });

var style, overlay, picking = false, hovered = null, flashTimer = 0;
function ensureOverlay() {
  if (overlay) return;
  overlay = document.createElement('div');
  overlay.setAttribute(own, '');
  overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;display:none;box-sizing:border-box;outline:2px solid #6d4aff;background:rgba(109,74,255,.18)';
  (document.body || document.documentElement).appendChild(overlay);
}
function place(element) {
  ensureOverlay();
  if (!element) { overlay.style.display = 'none'; return; }
  var rect = element.getBoundingClientRect();
  var box = overlay.style;
  box.display = 'block'; box.left = rect.left + 'px'; box.top = rect.top + 'px'; box.width = rect.width + 'px'; box.height = rect.height + 'px';
}
function moved(event) {
  if (!picking) return;
  var element = elementOf(event.target);
  hovered = element && !isOwn(element) ? element : null;
  place(hovered);
}
function refresh() { if (picking && hovered) place(hovered); }
var swallowed = ['click', 'dblclick', 'auxclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchmove', 'touchend', 'touchcancel'];
var prevented = ['click', 'dblclick', 'auxclick', 'mousedown'];
function swallow(event) {
  if (!picking) return;
  event.stopImmediatePropagation();
  if (prevented.indexOf(event.type) !== -1) event.preventDefault();
  if (event.type === 'click') {
    var element = elementOf(event.target);
    if (element && !isOwn(element)) {
      send({ type: 'pick', exact: markup(element).slice(0, 4000), selector: selectorOf(element), fingerprint: fingerprint(element) });
      setPicker(false);
    }
  }
}
function escape(event) {
  if (!picking || event.key !== 'Escape') return;
  event.stopImmediatePropagation();
  setPicker(false);
  send({ type: 'picker', on: false });
}
// Registered once, before any page script (the server injects this first), so the first window capture
// listeners are ours; they act only while picking. Touch guards are passive so scrolling keeps working.
swallowed.forEach(function (type) { window.addEventListener(type, swallow, type.indexOf('touch') === 0 ? { capture: true, passive: true } : true); });
window.addEventListener('pointermove', moved, true);
window.addEventListener('scroll', refresh, true);
window.addEventListener('resize', refresh, true);
window.addEventListener('keydown', escape, true);
// The viewer remembers the reading position so an agent's revision reload can return to it.
var scrollTimer = 0;
window.addEventListener('scroll', function () {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(function () {
    var top = null;
    try { top = document.elementFromPoint(innerWidth / 2, 1); } catch (e) { top = null; }
    if (!top || isOwn(top)) top = document.body;
    send({ type: 'scroll', x: scrollX, y: scrollY, anchor: top ? { chain: chainOf(top), offset: top.getBoundingClientRect().top } : undefined });
  }, 100);
}, { passive: true });
// The hash target's own chain, so the viewer can send us to its nearest surviving parent if an edit removes it.
function reportHashAnchor() {
  var id = '', target = null;
  try { id = decodeURIComponent(location.hash.slice(1)); } catch (e) { return; }
  if (!id) return;
  target = document.getElementById(id);
  if (!target) { var named = document.getElementsByName(id); for (var i = 0; i < named.length; i++) if (named[i].localName === 'a') target = named[i]; }
  if (target && !isOwn(target)) send({ type: 'hash-anchor', hash: location.hash, chain: chainOf(target) });
}
if (document.readyState === 'complete') reportHashAnchor(); else window.addEventListener('load', reportHashAnchor);
window.addEventListener('hashchange', reportHashAnchor);
// Local file links open Sidecar file windows instead of navigating this frame. Registered after the picker
// guards, so a pick wins. Same-page anchors, URL schemes and scheme-relative URLs keep their normal behavior;
// the viewer re-validates every href and only opens files inside the document's workspace.
function isLocalHref(href) {
  var value = href.trim();
  return !!value && value.length <= 4096 && !/[\x00-\x1f]/.test(value) && value.charAt(0) !== '#' && value.slice(0, 2) !== '//'
    // Same rule as the viewer: a dotted bare file name with a line suffix (README.md:2-4) is not a scheme.
    && (!/^[a-z][a-z0-9+.-]*:/i.test(value) || /^file:\/\/\//i.test(value) || /^[^:/?#]*\.[^:/?#]*:\d+(?:-\d+)?(?:#.*)?$/.test(value));
}
window.addEventListener('click', function (event) {
  var element = elementOf(event.target), link = !picking && element ? element.closest('a[href]') : null;
  var href = link ? link.getAttribute('href') || '' : '';
  if (!link || !isLocalHref(href)) return;
  event.preventDefault();
  send({ type: 'open-file', href: href });
}, true);
function setPicker(on) {
  if (on === picking) return;
  picking = on;
  if (on) {
    style = document.createElement('style');
    style.setAttribute(own, '');
    style.textContent = '* { cursor: crosshair !important; }';
    document.head.appendChild(style);
  } else {
    if (style) style.remove();
    style = null; hovered = null;
    if (overlay) overlay.style.display = 'none';
  }
}
function flash(element) {
  place(element);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(function () { if (!picking && overlay) overlay.style.display = 'none'; }, 1500);
}
// isContentOnly skips text that is not page content (head, script, style...): a page-text reference must match
// visible words once. A user selection keeps all text, since its range text includes any inline script it spans.
function textMatch(root, exact, isContentOnly) {
  var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), nodes = [], full = '';
  for (var node = walker.nextNode(); node; node = walker.nextNode()) {
    if (isOwn(node.parentElement) || isContentOnly && node.parentElement && node.parentElement.closest('head, script, style, template, noscript')) continue;
    nodes.push({ node: node, start: full.length }); full += node.data;
  }
  var at = full.indexOf(exact);
  if (at === -1 || at !== full.lastIndexOf(exact)) return null;
  var range = document.createRange(), end = at + exact.length, started = false;
  for (var i = 0; i < nodes.length; i++) {
    var entry = nodes[i], length = entry.node.data.length;
    if (!started && at < entry.start + length) { range.setStart(entry.node, at - entry.start); started = true; }
    if (started && end <= entry.start + length) { range.setEnd(entry.node, end - entry.start); return range; }
  }
  return null;
}
// Side-effect-free match of a saved target: the element (isElement) or text Range it still names, else null.
function locate(message) {
  try {
    // A selector that now matches several elements is ambiguous: report it as changed rather than guess.
    var matches = document.querySelectorAll(message.selector), element = matches.length === 1 ? matches[0] : null;
    if (!element || isOwn(element)) return null;
    // A user pick must keep its full markup; an agent target (no fingerprint) must still contain its text once.
    if (message.isElement) return (typeof message.fingerprint === 'string' ? fingerprint(element) === message.fingerprint : !!message.exact && !!textMatch(element, message.exact)) ? element : null;
    // 'body' marks an agent's page-text reference (pageTextSelector); a user selection never records it.
    return textMatch(element, message.exact, message.selector === 'body');
  } catch (e) { return null; }
}
function reveal(message) {
  var found = locate(message), ok = !!found;
  try {
    if (found && message.isElement) { found.scrollIntoView({ block: 'center' }); flash(found); }
    else if (found) {
      var selection = getSelection();
      selection.removeAllRanges(); selection.addRange(found); revealed = found.cloneRange();
      var start = elementOf(found.startContainer);
      if (start) start.scrollIntoView({ block: 'center' });
    }
  } catch (e) { ok = false; }
  send({ type: 'revealed', ok: ok });
}
// Answers whether saved targets still match, without scrolling or selecting anything.
function check(data) {
  var results = [];
  for (var i = 0; i < data.items.length && i < 500; i++) {
    var item = data.items[i];
    results.push(!!item && typeof item.selector === 'string' && typeof item.exact === 'string' && !!locate({ selector: item.selector, exact: item.exact, isElement: item.isElement === true, fingerprint: item.fingerprint }));
  }
  send({ type: 'checked', id: data.id, results: results });
}
window.addEventListener('message', function (event) {
  var data = event.data;
  if (event.source !== window.parent || !data || data.sidecar !== MARK) return;
  if (data.type === 'picker' && typeof data.on === 'boolean') setPicker(data.on);
  else if (data.type === 'reveal' && typeof data.selector === 'string' && typeof data.exact === 'string') reveal(data);
  else if (data.type === 'check' && typeof data.id === 'number' && Array.isArray(data.items)) check(data);
  else if (data.type === 'unselect') { var current = getSelection(); if (current) current.removeAllRanges(); }
  else if (data.type === 'scroll' && typeof data.x === 'number' && typeof data.y === 'number') {
    window.scrollTo(data.x, data.y);
    if (data.anchor && Array.isArray(data.anchor.chain)) restoreChain(data.anchor.chain, data.anchor.offset);
  }
  else if (data.type === 'nearest' && Array.isArray(data.chain)) send({ type: 'nearest', ok: restoreChain(data.chain) });
});
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { send({ type: 'ready' }); });
else send({ type: 'ready' });
})();`;
