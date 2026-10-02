import { Fragment, memo, useMemo, useState, useEffect, useRef } from 'react';
import { BlockRenderer } from '@plannotator/ui/components/BlockRenderer';
import { MermaidBlock } from '@plannotator/ui/components/MermaidBlock';
import { GraphvizBlock } from '@plannotator/ui/components/GraphvizBlock';
import { computeListIndices, groupBlocks, parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';
import '@plannotator/ui/utils/math-eager';
import { setImageSrcResolver } from '@plannotator/ui/components/ImageThumbnail';
import { sanitizeBlockHtml } from '@plannotator/ui/utils/sanitizeHtml';
import { buildHeadingSlugMap } from '@plannotator/ui/utils/slugify';
import { createPortal } from 'react-dom';
import type { Block } from '@plannotator/ui/types';

setImageSrcResolver((path, documentId) =>
  /^(https:|data:image\/)/i.test(path)
    ? path
    : `/api/image?${documentId?.includes('/') ? `owner=${encodeURIComponent(documentId.split('/')[0])}&document=${encodeURIComponent(documentId.split('/')[1])}` : `document=${encodeURIComponent(documentId ?? '')}`}&path=${encodeURIComponent(path)}`,
);

// Plannotator's RenderedMarkdown composition, with its Viewer's diagram blocks.
// Sidecar owns conversations; the upstream components own rendering and controls.
export const MarkdownDocument = memo(function MarkdownDocument({
  markdown,
  documentId,
  anchorPrefix = '',
  libraryOwner,
}: {
  markdown: string;
  documentId: string;
  anchorPrefix?: string;
  libraryOwner?: string;
}) {
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
  const groups = useMemo(() => groupBlocks(blocks), [blocks]);
  const headings = useMemo(() => buildHeadingSlugMap(blocks), [blocks]);
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
        headingAnchorId={headings.has(block.id) ? anchorPrefix + headings.get(block.id) : undefined}
        onNavigateAnchor={
          anchorPrefix
            ? (hash) => {
                try {
                  document
                    .getElementById(anchorPrefix + decodeURIComponent(hash.slice(1)))
                    ?.scrollIntoView({ block: 'nearest' });
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
  return (
    <>
      <div className="plannotator-content theme-plannotator">
        {groups.map((group) => {
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
        })}
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
