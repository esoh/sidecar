// Structural copies of Plannotator's planDiffEngine types, so this module also loads outside the web bundle (tests).
export type InlineDiffToken = { type: 'added' | 'removed' | 'unchanged'; value: string };
export type InlineDiffWrap = { type: 'heading' | 'paragraph' | 'list-item'; level?: number; ordered?: boolean; listLevel?: number; checked?: boolean; orderedStart?: number };
type PlanDiffBlock = { type: 'added' | 'removed' | 'modified' | 'unchanged'; content: string; oldContent?: string; lines: number; inlineTokens?: InlineDiffToken[]; inlineWrap?: InlineDiffWrap };

// Pure helpers for MarkdownDiff: block units, wrapped inline-diff markdown, and folding of unchanged runs.
export type DiffUnit = { type: PlanDiffBlock['type']; markdown: string; content?: string; old?: string; tokens?: InlineDiffToken[]; wrap?: InlineDiffWrap };
export type FoldItem<T> = { unit: T; index: number } | { fold: { key: string; units: T[] } };

// Words in changed prose are marked with private-use sentinels, so the normal Markdown renderer
// keeps its context across tokens; MarkdownDiff turns them into <ins>/<del> afterwards.
export const ADDED_OPEN = '', ADDED_CLOSE = '', REMOVED_OPEN = '', REMOVED_CLOSE = '';

// Unchanged text is split on blank lines outside fences so long runs can fold block by block.
export function splitSegments(text: string): string[] {
  const segments: string[] = [];
  let current: string[] = [], fence: string | null = null;
  const flush = () => { if (current.some(line => line.trim())) segments.push(current.join('\n')); current = []; };
  for (const line of text.replace(/\n$/, '').split('\n')) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && !fence) fence = marker;
    else if (marker && fence && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
    if (!fence && !line.trim()) flush(); else current.push(line);
  }
  flush();
  return segments;
}

export function wrapInline(tokens: InlineDiffToken[], wrap: InlineDiffWrap): string {
  const text = tokens.map(token => token.type === 'added' ? `${ADDED_OPEN}${token.value}${ADDED_CLOSE}`
    : token.type === 'removed' ? `${REMOVED_OPEN}${token.value}${REMOVED_CLOSE}` : token.value).join('').replace(/\n+$/, '');
  if (wrap.type === 'heading') return `${'#'.repeat(wrap.level ?? 1)} ${text}`;
  if (wrap.type !== 'list-item') return text;
  return `${'  '.repeat(wrap.listLevel ?? 0)}${wrap.ordered ? `${wrap.orderedStart ?? 1}. ` : '- '}${wrap.checked === undefined ? '' : wrap.checked ? '[x] ' : '[ ] '}${text}`;
}

// Plannotator diffs line by line, so a table with one changed row arrives as several units. Adjacent units
// that meet inside a table (and include a change) merge into one whole-table unit, so each side stays a valid table.
const tableRow = /^\s*\|/;
const trim = (text: string) => text.replace(/\n+$/, '');
const sides = (unit: DiffUnit) => unit.type === 'unchanged' ? [unit.markdown, unit.markdown] : [unit.old ?? (unit.type === 'removed' ? unit.markdown : undefined), unit.type === 'removed' ? undefined : unit.content ?? unit.markdown];
const edgeLine = (unit: DiffUnit, last: boolean) => {
  const lines = sides(unit).flatMap(side => side?.split('\n').filter(line => line.trim()) ?? []);
  return last ? lines.at(-1) : lines[0];
};

export function mergeTables(units: DiffUnit[]): DiffUnit[] {
  const groups: DiffUnit[][] = [];
  for (const unit of units) {
    const group = groups.at(-1), prev = group?.at(-1);
    if (group && prev && (prev.type !== 'unchanged' || unit.type !== 'unchanged') && tableRow.test(edgeLine(prev, true) ?? '') && tableRow.test(edgeLine(unit, false) ?? '')) group.push(unit);
    else groups.push([unit]);
  }
  return groups.map((group): DiffUnit => {
    if (group.length === 1) return group[0];
    const join = (at: 0 | 1) => { const parts = group.map(unit => sides(unit)[at]).filter((part): part is string => part !== undefined); return parts.length ? parts.map(trim).join('\n') : undefined; };
    const old = join(0), current = join(1);
    return { type: old === undefined ? 'added' : current === undefined ? 'removed' : old === current ? 'unchanged' : 'modified', markdown: current ?? old!, content: current, old: old === current ? undefined : old };
  });
}

export function buildUnits(blocks: PlanDiffBlock[]): DiffUnit[] {
  return mergeTables(blocks.flatMap((block): DiffUnit[] => block.type === 'unchanged'
    ? splitSegments(block.content).map(markdown => ({ type: 'unchanged', markdown }))
    : [{ type: block.type, markdown: block.type === 'modified' && block.inlineTokens && block.inlineWrap ? wrapInline(block.inlineTokens, block.inlineWrap) : block.content,
      content: block.content, old: block.oldContent, tokens: block.inlineTokens, wrap: block.inlineWrap }]));
}

// Runs of more than `min` unchanged blocks fold, keeping `context` blocks beside each change.
// A fully unchanged file shows everything.
export function foldUnchanged<T extends { type: string }>(units: T[], expanded: ReadonlySet<string>, keyOf: (unit: T) => string, context = 1, min = 3): FoldItem<T>[] {
  const items: FoldItem<T>[] = [];
  const hasChange = units.some(unit => unit.type !== 'unchanged');
  for (let at = 0; at < units.length;) {
    if (units[at].type !== 'unchanged') { items.push({ unit: units[at], index: at }); at++; continue; }
    let end = at;
    while (end < units.length && units[end].type === 'unchanged') end++;
    const keepStart = at === 0 ? 0 : context, keepEnd = end === units.length ? 0 : context;
    const hidden = units.slice(at + keepStart, end - keepEnd);
    const key = `${keyOf(hidden[0] ?? units[at])}|${hidden.length}`;
    if (!hasChange || end - at <= min || expanded.has(key)) for (let i = at; i < end; i++) items.push({ unit: units[i], index: i });
    else {
      for (let i = at; i < at + keepStart; i++) items.push({ unit: units[i], index: i });
      items.push({ fold: { key, units: hidden } });
      for (let i = end - keepEnd; i < end; i++) items.push({ unit: units[i], index: i });
    }
    at = end;
  }
  return items;
}
