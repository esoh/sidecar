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
  scrollTimer = setTimeout(function () { send({ type: 'scroll', x: scrollX, y: scrollY }); }, 100);
}, { passive: true });
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
function reveal(message) {
  var ok = false;
  try {
    // A selector that now matches several elements is ambiguous: report it as changed rather than guess.
    var matches = document.querySelectorAll(message.selector), element = matches.length === 1 ? matches[0] : null;
    if (element && !isOwn(element)) {
      if (message.isElement) {
        // A user pick must keep its full markup; an agent target (no fingerprint) must still contain its text once.
        if (typeof message.fingerprint === 'string' ? fingerprint(element) === message.fingerprint : !!message.exact && !!textMatch(element, message.exact)) { element.scrollIntoView({ block: 'center' }); flash(element); ok = true; }
      } else {
        // 'body' marks an agent's page-text reference (pageTextSelector); a user selection never records it.
        var range = textMatch(element, message.exact, message.selector === 'body');
        if (range) {
          var selection = getSelection();
          selection.removeAllRanges(); selection.addRange(range); revealed = range.cloneRange();
          var start = elementOf(range.startContainer);
          if (start) start.scrollIntoView({ block: 'center' });
          ok = true;
        }
      }
    }
  } catch (e) { ok = false; }
  send({ type: 'revealed', ok: ok });
}
window.addEventListener('message', function (event) {
  var data = event.data;
  if (event.source !== window.parent || !data || data.sidecar !== MARK) return;
  if (data.type === 'picker' && typeof data.on === 'boolean') setPicker(data.on);
  else if (data.type === 'reveal' && typeof data.selector === 'string' && typeof data.exact === 'string') reveal(data);
  else if (data.type === 'unselect') { var current = getSelection(); if (current) current.removeAllRanges(); }
  else if (data.type === 'scroll' && typeof data.x === 'number' && typeof data.y === 'number') window.scrollTo(data.x, data.y);
});
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { send({ type: 'ready' }); });
else send({ type: 'ready' });
})();`;
