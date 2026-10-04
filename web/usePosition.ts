import { useLayoutEffect, type RefObject } from 'react';

// Placement adapted from Plannotator's CommentPopover (MIT); see THIRD_PARTY_NOTICES.md.
export function usePosition(ref: RefObject<HTMLElement | null>, anchor: (() => DOMRect | undefined) | null, width: number, preferAbove = false, bounds?: () => DOMRect | undefined) {
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !anchor) return;
    const update = () => {
      const rect = anchor(); if (!rect) return;
      const viewport = window.visualViewport, area = bounds?.();
      const leftEdge = Math.max(viewport?.offsetLeft ?? 0, area?.left ?? 0) + 8;
      const topEdge = Math.max(viewport?.offsetTop ?? 0, area?.top ?? 0) + 8;
      const rightEdge = Math.min((viewport?.offsetLeft ?? 0) + (viewport?.width ?? innerWidth), area?.right ?? Infinity) - 8;
      const bottomEdge = Math.min((viewport?.offsetTop ?? 0) + (viewport?.height ?? innerHeight), area?.bottom ?? Infinity) - 8;
      const size = Math.max(0, Math.min(width, rightEdge - leftEdge));
      node.style.width = `${size}px`; node.style.maxHeight = `${Math.max(0, bottomEdge - topEdge)}px`;
      const height = node.offsetHeight, gap = preferAbove ? 10 : 8;
      const below = bottomEdge - rect.bottom - gap, above = rect.top - topEdge - gap;
      const placeAbove = preferAbove ? above >= height || above > below : below < height && above > below;
      const top = placeAbove ? rect.top - height - gap : rect.bottom + gap;
      node.style.left = `${Math.max(leftEdge, Math.min(rect.left + rect.width / 2 - size / 2, rightEdge - size))}px`;
      node.dataset.placement = placeAbove ? 'above' : 'below';
      node.style.top = `${Math.max(topEdge, Math.min(top, bottomEdge - height))}px`;
    };
    update();
    const observer = new ResizeObserver(update); observer.observe(node);
    const canvas = document.querySelector('.canvas'); if (canvas) observer.observe(canvas);
    window.addEventListener('scroll', update, true); window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update); window.visualViewport?.addEventListener('scroll', update);
    return () => {
      observer.disconnect(); window.removeEventListener('scroll', update, true); window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update); window.visualViewport?.removeEventListener('scroll', update);
    };
  }, [ref, anchor, width, preferAbove, bounds]);
}
