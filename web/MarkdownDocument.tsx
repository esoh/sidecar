import { Fragment, createContext, memo, useContext, useMemo, useState, useEffect, useRef, type ReactNode } from 'react';
import { BlockRenderer } from '@plannotator/ui/components/BlockRenderer';
import { isCodeFilePath } from '@plannotator/core/code-file';
import { MermaidBlock } from '@plannotator/ui/components/MermaidBlock';
import { GraphvizBlock } from '@plannotator/ui/components/GraphvizBlock';
import { computeListIndices, groupBlocks, parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';
import '@plannotator/ui/utils/math-eager';
import { setImageSrcResolver } from '@plannotator/ui/components/ImageThumbnail';
import { sanitizeBlockHtml } from '@plannotator/ui/utils/sanitizeHtml';
import { buildHeadingSlugMap } from '@plannotator/ui/utils/slugify';
import { hasLinkedDocExtension } from '@plannotator/ui/utils/markdownExtensions';
import { createPortal } from 'react-dom';
import type { Block } from '@plannotator/ui/types';
import { revealTarget } from './reveal-target.ts';
import { splitLineSuffix } from './links.ts';

type BlockGroup = ReturnType<typeof groupBlocks>[number];
type SectionGroup = { type: 'section'; block: Block; children: DocumentGroup[] };
type DocumentGroup = BlockGroup | SectionGroup;
function isSectionSeparator(group: DocumentGroup): boolean {
  if (group.type !== 'single') return false;
  if (group.block.type === 'hr') return true;
  if (group.block.type !== 'html') return false;
  const template = document.createElement('template');
  template.innerHTML = group.block.content;
  return !template.content.textContent?.trim() &&
    Array.from(template.content.querySelectorAll('*')).every(element => ['DIV', 'BR'].includes(element.tagName));
}
function groupSections(groups: BlockGroup[]): DocumentGroup[] {
  const roots: DocumentGroup[] = [], parents: SectionGroup[] = [];
  for (const group of groups) {
    if (group.type === 'single' && group.block.type === 'heading') {
      const previous = parents.at(-1);
      let boundary: DocumentGroup[] = [];
      if (previous && (previous.block.level ?? 1) >= (group.block.level ?? 1)) {
        let start = previous.children.length;
        while (start > 0 && isSectionSeparator(previous.children[start - 1])) start--;
        // Only a trailing divider run belongs between the sections being closed
        // and opened. Internal rules and spacer-only tails stay in their section.
        if (previous.children.slice(start).some(item => item.type === 'single' && item.block.type === 'hr'))
          boundary = previous.children.splice(start);
      }
      while (parents.length && (parents.at(-1)?.block.level ?? 1) >= (group.block.level ?? 1)) parents.pop();
      const section: SectionGroup = { type: 'section', block: group.block, children: [] };
      (parents.at(-1)?.children ?? roots).push(...boundary, section);
      parents.push(section);
    } else (parents.at(-1)?.children ?? roots).push(group);
  }
  return roots;
}

setImageSrcResolver((path, documentId) =>
  /^(https:|data:image\/)/i.test(path)
    ? path
    : `/api/image?${documentId?.includes('/') ? `owner=${encodeURIComponent(documentId.split('/')[0])}&document=${encodeURIComponent(documentId.split('/')[1])}` : `document=${encodeURIComponent(documentId ?? '')}`}&path=${encodeURIComponent(path)}`,
);

// Plannotator's renderer reports local document and code links through these callbacks.
export type OpenWorkspaceLink = (kind: 'doc' | 'code', target: string, baseDir?: string) => void;
export const WorkspaceLinks = createContext<OpenWorkspaceLink | null>(null);

// Plannotator's RenderedMarkdown composition, with its Viewer's diagram blocks.
// Sidecar owns conversations; the upstream components own rendering and controls.
export const MarkdownDocument = memo(function MarkdownDocument({
  markdown,
  documentId,
  anchorPrefix = '',
  libraryOwner,
  onSelectionLink,
  linkBase,
  canCollapseHeadings = false,
}: {
  markdown: string;
  documentId: string;
  anchorPrefix?: string;
  libraryOwner?: string;
  onSelectionLink?: (slug: string) => boolean;
  /** Absolute folder that relative links resolve from; replies resolve from the workspace root. */
  linkBase?: string;
  canCollapseHeadings?: boolean;
}) {
  const openLink = useContext(WorkspaceLinks);
  const blocks = useMemo(
    () =>
      parseMarkdownToBlocks(markdown).map((block) => {
        if (block.type !== 'html' || !/srcset/i.test(block.content)) return block;
        // ponytail: use the fallback img until responsive-image URL rewriting is needed.
        // Upstream rewrites img[src], but leaves srcset pointing at the app's root.
        const template = document.createElement('template');
        template.innerHTML = sanitizeBlockHtml(block.content);
        template.content.querySelectorAll('[srcset]').forEach((node) => node.removeAttribute('srcset'));
        return { ...block, content: template.innerHTML };
      }),
    [markdown],
  );
  const groups = useMemo(() => canCollapseHeadings ? groupSections(groupBlocks(blocks)) : groupBlocks(blocks), [blocks, canCollapseHeadings]);
  const headings = useMemo(() => buildHeadingSlugMap(blocks), [blocks]);
  const foldIds = useMemo(() => {
    const ids = new Map(headings), counts = new Map<string, number>();
    for (const block of blocks) {
      if (block.type !== 'heading' || ids.has(block.id)) continue;
      // Emoji/punctuation-only headings have no URL slug. Their parser IDs are
      // positional, so use the heading text and occurrence for saved folds.
      const base = JSON.stringify([block.level, block.content]);
      const occurrence = counts.get(base) ?? 0;
      counts.set(base, occurrence + 1);
      ids.set(block.id, `${base}:${occurrence}`);
    }
    return ids;
  }, [blocks, headings]);
  const foldKey = `sidecar-folds:${documentId}`;
  const folded = useMemo(() => {
    if (!canCollapseHeadings) return new Set<string>();
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(foldKey) ?? '[]');
      if (Array.isArray(saved) && saved.every((value): value is string => typeof value === 'string')) return new Set<string>(saved);
    } catch { /* Folding remains usable without browser storage. */ }
    return new Set<string>();
  }, [foldKey, canCollapseHeadings]);
  const [image, setImage] = useState<{ src: string; alt: string } | null>(null);
  function renderBlock(block: Block, orderedIndex?: number | null) {
    const language = block.language?.trim().split(/\s+/, 1)[0]?.toLowerCase();
    if (block.type === 'code' && language === 'mermaid') return <MermaidBlock block={block} readOnly />;
    if (block.type === 'code' && ['dot', 'graphviz', 'gv'].includes(language ?? ''))
      return <GraphvizBlock block={block} readOnly />;
    return (
      <BlockRenderer
        block={block}
        orderedIndex={orderedIndex}
        imageBaseDir={libraryOwner ? `${libraryOwner}/${documentId}` : documentId}
        onOpenLinkedDoc={openLink ? (path) => openLink('doc', path, linkBase) : undefined}
        onOpenCodeFile={openLink ? (path) => openLink('code', path, linkBase) : undefined}
        headingAnchorId={headings.has(block.id) ? anchorPrefix + headings.get(block.id) : undefined}
        onNavigateAnchor={
          anchorPrefix
            ? (hash) => {
                try {
                  if (onSelectionLink?.(decodeURIComponent(hash.slice(1)))) return;
                  const target = document.getElementById(anchorPrefix + decodeURIComponent(hash.slice(1)));
                  if (target) { revealTarget(target); target.scrollIntoView({ block: 'nearest' }); }
                } catch {
                  /* Ignore malformed anchor escapes. */
                }
              }
            : undefined
        }
        onImageClick={(src, alt) => setImage({ src, alt })}
      />
    );
  }
  function renderGroups(items: DocumentGroup[]): ReactNode {
    return items.map(group => {
      if (group.type === 'section' && group.children.length) {
        const key = foldIds.get(group.block.id) ?? JSON.stringify([group.block.level, group.block.content]);
        return (
          <details key={key} className="document-section" open={!folded.has(key)} onToggle={event => {
            // Native toggles include keyboard use and programmatic link reveals.
            // Ignore descendant toggles and initial mount events that change nothing.
            if (event.target !== event.currentTarget) return;
            const isFolded = !event.currentTarget.open;
            if (folded.has(key) === isFolded) return;
            if (isFolded) folded.add(key); else folded.delete(key);
            try { localStorage.setItem(foldKey, JSON.stringify([...folded])); } catch { /* Per-browser reading preference only. */ }
          }}>
            <summary>{renderBlock(group.block)}</summary>{'\n'}
            {renderGroups(group.children)}
          </details>
        );
      }
      if (group.type !== 'list-group')
        return (
          <Fragment key={group.block.id}>
            {renderBlock(group.block)}
            {'\n'}
          </Fragment>
        );
      const indices = computeListIndices(group.blocks);
      return (
        <div key={group.key} className="py-1 -mx-2 px-2">
          {group.blocks.map((block, i) => (
            <Fragment key={block.id}>
              {renderBlock(block, indices[i])}
              {'\n'}
            </Fragment>
          ))}
        </div>
      );
    });
  }
  return (
    <>
      <div className="plannotator-content theme-plannotator" onClickCapture={event => {
        if (!(event.target instanceof Element)) return;
        const href = event.target.closest('a[href]')?.getAttribute('href');
        if (!href) return;
        const path = href.trim();
        // Plannotator misses document links with line suffixes and padded code links.
        // Normalize those cases without changing saved Markdown or external links.
        const [documentPath, line] = splitLineSuffix(path.replace(/#.*$/, ''));
        const isLocal = !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(documentPath) || /^file:\/\//i.test(documentPath);
        const isDocumentLine = !!line && hasLinkedDocExtension(documentPath);
        // Saved annotations keep their article-level thread/overlap navigation.
        const isHighlight = event.target.closest('#document mark.annotation-highlight');
        if (openLink && isLocal && !isHighlight && (isDocumentLine || (href !== path && isCodeFilePath(path)))) {
          event.preventDefault(); event.stopPropagation();
          openLink(isDocumentLine ? 'doc' : 'code', isDocumentLine ? documentPath : path.replace(/#.*$/, ''), linkBase);
          return;
        }
        if (anchorPrefix || !href.startsWith('#')) return;
        const hash = href;
        try {
          const target = document.getElementById(decodeURIComponent(hash.slice(1)));
          if (target) revealTarget(target);
        } catch { /* Ignore malformed anchor escapes. */ }
      }}>
        {renderGroups(groups)}
      </div>
      {image && createPortal(<ImageLightbox {...image} onClose={() => setImage(null)} />, document.body)}
    </>
  );
});

// Viewer.tsx's image overlay, with native dialog focus/keyboard handling.
function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="image-lightbox"
      aria-label={alt || 'Image preview'}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <button type="button" aria-label="Close image" onClick={onClose}>
        ×
      </button>
      <img src={src} alt={alt} />
      {alt && <p>{alt}</p>}
    </dialog>
  );
}
