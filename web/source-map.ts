// Pure, DOM-free map from one rendered Markdown block to its source text.
// Offsets are relative to the block's own source.

export type BlockKind =
  | 'paragraph' | 'heading' | 'blockquote' | 'list-item' | 'code'
  | 'hr' | 'table' | 'html' | 'directive' | 'math';

export type SyntaxElement = { open: [number, number]; close: [number, number] };

export type BlockMap = {
  visible: string;
  /** toSource[i] = source offset of visible char i; toSource[visible.length] = end of the last char. */
  toSource: number[];
  /** Source end of each visible char (differs from toSource[i + 1] when syntax follows it). */
  ends: number[];
  elements: SyntaxElement[];
};

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};
const SKIP = '\u0000'; // masks block syntax (continuation prefixes) so the scanner ignores it
const isSpace = (c: string | undefined) => c === undefined || c === SKIP || /\s/.test(c);
const isWord = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}_]/u.test(c);

class Unmappable extends Error {}

export function blockMap(source: string, kind: BlockKind): BlockMap | null {
  try {
    return build(source, kind);
  } catch (e) {
    if (e instanceof Unmappable) return null;
    throw e;
  }
}

function build(source: string, kind: BlockKind): BlockMap | null {
  if (kind === 'html' || kind === 'directive' || kind === 'math') return null;
  const end = source.replace(/\s+$/, '').length;
  const b = new Builder(source);
  if (kind === 'hr') return b.finish();
  if (kind === 'code') return codeMap(source, end, b);
  if (kind === 'table') return tableMap(source, end, b);

  // Block marker on the first line, then mask continuation prefixes on later lines.
  let markerEnd = 0;
  if (kind === 'heading') {
    const m = /^#{1,6}[ \t]+/.exec(source);
    if (!m) return null;
    markerEnd = m[0].length;
  } else if (kind === 'list-item') {
    const m = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/.exec(source);
    if (!m) return null;
    markerEnd = m[0].length;
  } else if (kind === 'blockquote') {
    const m = /^[ \t]*(?:>[ \t]?)+/.exec(source);
    if (!m) return null;
    markerEnd = m[0].length;
  }
  let masked = source.slice(0, end);
  const mask = (from: number, to: number) => {
    masked = masked.slice(0, from) + SKIP.repeat(to - from) + masked.slice(to);
  };
  mask(0, markerEnd);
  for (let i = masked.indexOf('\n'); i >= 0 && i < end; i = masked.indexOf('\n', i + 1)) {
    const m = (kind === 'blockquote' ? /^[ \t]*(?:>[ \t]?)*/ : /^[ \t]*/).exec(masked.slice(i + 1))!;
    mask(i + 1, i + 1 + m[0].length);
  }
  if (markerEnd > 0) b.elements.push({ open: [0, markerEnd], close: [end, end] });
  new Inline(masked, b).scan(markerEnd, end);
  return b.finish();
}

class Builder {
  chars: string[] = [];
  starts: number[] = [];
  ends: number[] = [];
  elements: SyntaxElement[] = [];
  constructor(readonly source: string) {}
  add(ch: string, start: number, end: number) {
    this.chars.push(ch);
    this.starts.push(start);
    this.ends.push(end);
  }
  finish(): BlockMap {
    const last = this.ends.length ? this.ends[this.ends.length - 1] : 0;
    return { visible: this.chars.join(''), toSource: [...this.starts, last], ends: this.ends, elements: this.elements };
  }
}

function codeMap(source: string, end: number, b: Builder): BlockMap | null {
  const open = /^[ \t]*(`{3,}|~{3,})[^\n]*\n?/.exec(source);
  if (!open) return null;
  let contentEnd = end;
  let closeFrom = end;
  const lines = source.slice(open[0].length, end);
  const closing = new RegExp(`\\n?[ \\t]*${open[1][0]}{${open[1].length},}[ \\t]*$`).exec(lines);
  if (closing) {
    contentEnd = open[0].length + closing.index;
    closeFrom = contentEnd;
  }
  b.elements.push({ open: [0, open[0].length], close: [closeFrom, end] });
  for (let i = open[0].length; i < contentEnd; i++) b.add(source[i], i, i + 1);
  return b.finish();
}

function tableMap(source: string, end: number, b: Builder): BlockMap | null {
  const text = source.slice(0, end);
  let pos = 0;
  let first = true;
  for (const line of text.split('\n')) {
    const lineStart = pos;
    pos += line.length + 1;
    const body = line.replace(/\r$/, '');
    if (/^[\s|:-]+$/.test(body) && body.includes('-')) continue; // delimiter row
    // split on unescaped pipes
    const pipes: number[] = [];
    for (let i = 0; i < body.length; i++) {
      if (body[i] === '\\') i++;
      else if (body[i] === '|') pipes.push(i);
    }
    const bounds: [number, number][] = [];
    let from = 0;
    for (const p of [...pipes, body.length]) {
      bounds.push([from, p]);
      from = p + 1;
    }
    if (pipes[0] === first_nonspace(body)) bounds.shift();
    const lastPipeAtEnd = pipes.length && pipes[pipes.length - 1] === body.trimEnd().length - 1;
    if (lastPipeAtEnd) bounds.pop();
    if (!bounds.length) return null;
    if (!first) b.add('\n', lineStart - 1, lineStart);
    first = false;
    const rowOpen = b.elements.push({ open: [0, 0], close: [0, 0] }) - 1;
    let rowFrom = -1;
    let rowTo = lineStart;
    bounds.forEach(([s, e], idx) => {
      let cs = s;
      let ce = e;
      while (cs < ce && /\s/.test(body[cs])) cs++;
      while (ce > cs && /\s/.test(body[ce - 1])) ce--;
      if (idx > 0) b.add(' ', lineStart + s - 1, lineStart + s);
      if (rowFrom < 0) rowFrom = lineStart + cs;
      rowTo = lineStart + ce;
      new Inline(source, b).scan(lineStart + cs, lineStart + ce);
    });
    b.elements[rowOpen] = { open: [lineStart, rowFrom], close: [rowTo, lineStart + body.length] };
  }
  return b.finish();
}
const first_nonspace = (s: string) => s.search(/\S/);

class Inline {
  constructor(readonly s: string, readonly b: Builder) {}

  scan(from: number, to: number) {
    const { s, b } = this;
    let i = from;
    while (i < to) {
      const c = s[i];
      if (c === SKIP || (c === '\r' && s[i + 1] === '\n')) { i++; continue; }
      if (c === '\n') { b.add('\n', i, i + 1); i++; continue; }
      if (c === '\\') {
        const n = s[i + 1];
        if (n === '\n' || (n === '\r' && s[i + 2] === '\n')) {
          const e = i + (n === '\n' ? 2 : 3);
          b.add('\n', i, e); i = e; continue;
        }
        if (n !== undefined && i + 1 < to && /[!-/:-@[-`{-~]/.test(n)) { b.add(n, i, i + 2); i += 2; continue; }
      }
      if (c === ' ') {
        const m = /^ {2,}\r?\n/.exec(s.slice(i, to + 1));
        if (m) { b.add('\n', i, i + m[0].length); i += m[0].length; continue; }
      }
      if (c === '&') {
        const m = /^&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([A-Za-z][A-Za-z0-9]*));/.exec(s.slice(i, to));
        if (m) {
          const ch = m[3] !== undefined ? ENTITIES[m[3]] : String.fromCodePoint(parseInt(m[1] ?? m[2], m[1] ? 10 : 16));
          if (ch === undefined) throw new Unmappable();
          b.add(ch, i, i + m[0].length); i += m[0].length; continue;
        }
      }
      if (c === '<') {
        const auto = /^<(https?:\/\/[^>\s]+|[^@>\s]+@[^>\s]+)>/.exec(s.slice(i, to));
        if (auto) {
          const e = i + auto[0].length;
          b.elements.push({ open: [i, i + 1], close: [e - 1, e] });
          for (let k = i + 1; k < e - 1; k++) b.add(s[k], k, k + 1);
          i = e; continue;
        }
        if (/^<[A-Za-z/!?]/.test(s.slice(i, to))) throw new Unmappable(); // inline HTML
      }
      if (c === '`') { i = this.code(i, to); continue; }
      if (c === '!' && s[i + 1] === '[') {
        const e = this.link(i + 1, to, true);
        if (e >= 0) { i = e; continue; }
      }
      if (c === '[') {
        if (s[i + 1] === '[') throw new Unmappable(); // wiki link
        const e = this.link(i, to, false);
        if (e >= 0) { i = e; continue; }
      }
      if (c === '*' || c === '_' || c === '~') {
        const e = this.emphasis(i, to);
        if (e >= 0) { i = e; continue; }
      }
      b.add(c, i, i + 1);
      i++;
    }
  }

  code(i: number, to: number): number {
    const { s, b } = this;
    let n = 1;
    while (s[i + n] === '`') n++;
    for (let j = i + n; j < to; j++) {
      if (s[j] !== '`') continue;
      let m = 0;
      while (s[j + m] === '`') m++;
      if (m === n && j > i + n) {
        b.elements.push({ open: [i, i + n], close: [j, j + n] });
        for (let k = i + n; k < j; k++) if (s[k] !== SKIP) b.add(s[k], k, k + 1);
        return j + n;
      }
      j += m - 1;
    }
    for (let k = i; k < i + n; k++) b.add('`', k, k + 1);
    return i + n;
  }

  // Returns the index after the link/image, or -1 when it is not one.
  link(i: number, to: number, image: boolean): number {
    const { s, b } = this;
    let depth = 0;
    let j = i;
    for (; j < to; j++) {
      if (s[j] === '\\') j++;
      else if (s[j] === '`') { const e = this.skipCode(j, to); j = e - 1; }
      else if (s[j] === '[') depth++;
      else if (s[j] === ']' && --depth === 0) break;
    }
    if (j >= to || s[j + 1] !== '(') return -1;
    let k = j + 2;
    let parens = 1;
    let quote = '';
    for (; k < to; k++) {
      const c = s[k];
      if (c === '\\') k++;
      else if (quote) { if (c === quote) quote = ''; }
      else if (c === '"' && /\s/.test(s[k - 1] ?? '')) quote = c;
      else if (c === '(') parens++;
      else if (c === ')' && --parens === 0) break;
    }
    if (k >= to) return -1;
    if (!image) {
      b.elements.push({ open: [i, i + 1], close: [j, k + 1] });
      this.scan(i + 1, j);
    }
    return k + 1;
  }

  skipCode(i: number, to: number): number {
    let n = 0;
    while (this.s[i + n] === '`') n++;
    for (let j = i + n; j < to; j++) {
      if (this.s[j] !== '`') continue;
      let m = 0;
      while (this.s[j + m] === '`') m++;
      if (m === n) return j + m;
      j += m - 1;
    }
    return i + n;
  }

  emphasis(i: number, to: number): number {
    const { s, b } = this;
    const ch = s[i];
    for (const d of ch === '*' ? ['***', '**', '*'] : ch === '_' ? ['__', '_'] : ['~~']) {
      if (!s.startsWith(d, i) || i + d.length >= to || isSpace(s[i + d.length])) continue;
      if (ch === '_' && isWord(s[i - 1])) continue;
      const close = this.closer(i + d.length, to, d);
      if (close < 0) continue;
      b.elements.push({ open: [i, i + d.length], close: [close, close + d.length] });
      this.scan(i + d.length, close);
      return close + d.length;
    }
    return -1;
  }

  closer(from: number, to: number, d: string): number {
    const { s } = this;
    for (let j = from; j < to; j++) {
      if (s[j] === '\\') { j++; continue; }
      if (s[j] === '`') { j = this.skipCode(j, to) - 1; continue; }
      if (s[j] !== d[0]) continue;
      let run = 0;
      while (s[j + run] === d[0]) run++;
      const ok = d.length === 1 ? run === 1 : run >= d.length;
      if (ok && j > from && !isSpace(s[j - 1]) && !(d[0] === '_' && isWord(s[j + d.length]))) return j;
      j += run - 1;
    }
    return -1;
  }
}

// Visible range of an element: the chars strictly between its open and close syntax.
function elementRange(map: BlockMap, el: SyntaxElement): [number, number] | null {
  let a = -1;
  let z = -1;
  for (let i = 0; i < map.visible.length; i++) {
    if (map.toSource[i] >= el.open[1] && map.ends[i] <= el.close[0]) {
      if (a < 0) a = i;
      z = i + 1;
    }
  }
  return a < 0 ? null : [a, z];
}

/** Visible range [start, end) to source range, applying the edge rule. */
export function sourceSpan(map: BlockMap, start: number, end: number): { start: number; end: number } {
  const n = map.visible.length;
  const a = Math.max(0, Math.min(start, n));
  const z = Math.max(a, Math.min(end, n));
  if (a === z) return { start: map.toSource[a] ?? 0, end: map.toSource[a] ?? 0 };
  let s = map.toSource[a];
  let e = map.ends[z - 1];
  for (const el of map.elements) {
    const r = elementRange(map, el);
    if (r && a <= r[0] && z >= r[1]) {
      s = Math.min(s, el.open[0]);
      e = Math.max(e, el.close[1]);
    }
  }
  return { start: s, end: e };
}

/** Source range to the visible range it touches, or null if no visible char is covered. */
export function visibleSpan(map: BlockMap, start: number, end: number): { start: number; end: number } | null {
  let a = -1;
  let z = -1;
  for (let i = 0; i < map.visible.length; i++) {
    if (map.toSource[i] < end && map.ends[i] > start) {
      if (a < 0) a = i;
      z = i + 1;
    }
  }
  return a < 0 ? null : { start: a, end: z };
}

const normalize = (t: string) =>
  t.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();

export function sameVisible(a: string, b: string): boolean {
  return normalize(a) === normalize(b);
}
