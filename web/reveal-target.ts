// Closed details retain their text nodes and quote anchors. Open them before
// measuring or scrolling, except when the target is their visible summary.
function openDetails(details: HTMLDetailsElement) {
  if (!details.classList.contains('document-section')) { details.open = true; return; }
  // Native ::details-content transitions are not exposed by getAnimations or
  // transitionend in Chromium. Navigation therefore finishes expansion now;
  // only manual toggles animate, with no timeout or mid-animation scroll.
  details.setAttribute('data-revealing', '');
  details.open = true;
  details.getBoundingClientRect();
  details.removeAttribute('data-revealing');
}

export function revealTarget(target: Node) {
  let element = target instanceof Element ? target : target.parentElement;
  while (element) {
    if (element instanceof HTMLDetailsElement) {
      const summary = Array.from(element.children).find(child => child.tagName === 'SUMMARY');
      if (!summary?.contains(target)) openDetails(element);
    }
    element = element.parentElement;
  }
}

export function revealRange(range: Range) {
  revealTarget(range.startContainer);
  revealTarget(range.endContainer);
  const root = range.commonAncestorContainer;
  if (!(root instanceof Element)) return;
  // A multi-block selection may span folded content between its endpoints.
  for (const details of root.querySelectorAll('details:not([open])')) {
    if (!(details instanceof HTMLDetailsElement)) continue;
    if (Array.from(details.childNodes).some(child => !(child instanceof Element && child.tagName === 'SUMMARY') && range.intersectsNode(child))) openDetails(details);
  }
}
