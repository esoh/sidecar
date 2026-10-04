// Closed details retain their text nodes and quote anchors. Open them before
// measuring or scrolling, except when the target is their visible summary.
export function revealTarget(target: Node) {
  let element = target instanceof Element ? target : target.parentElement;
  while (element) {
    if (element instanceof HTMLDetailsElement && !element.open) {
      const summary = Array.from(element.children).find(child => child.tagName === 'SUMMARY');
      if (!summary?.contains(target)) element.open = true;
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
    if (Array.from(details.childNodes).some(child => !(child instanceof Element && child.tagName === 'SUMMARY') && range.intersectsNode(child))) details.open = true;
  }
}
