// Pure, DOM-free map from one rendered Markdown block to its source text.
// Offsets are relative to the block's own source.
//
// `visible` models what Plannotator renders (parseMarkdownToBlocks content, then
// InlineMarkdown's regex scanner, ported below), NOT CommonMark. The conformance
// test in test/source-map.test.ts renders the real components and compares.

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

class Unmappable extends Error {}

/** Text with a source range per character (from[i], to[i]). */
type Txt = { s: string; from: number[]; to: number[] };

const txtOf = (source: string, a: number, b: number): Txt => ({
  s: source.slice(a, b),
  from: Array.from({ length: b - a }, (_, i) => a + i),
  to: Array.from({ length: b - a }, (_, i) => a + i + 1),
});
const sub = (t: Txt, a: number, b: number): Txt => ({ s: t.s.slice(a, b), from: t.from.slice(a, b), to: t.to.slice(a, b) });
const rng = (t: Txt, a: number, b: number): [number, number] => {
  if (b > a) return [t.from[a], t.to[b - 1]];
  const p = a < t.s.length ? t.from[a] : (t.to[a - 1] ?? 0);
  return [p, p];
};
const concat = (parts: Txt[]): Txt => ({
  s: parts.map((p) => p.s).join(''),
  from: parts.flatMap((p) => p.from),
  to: parts.flatMap((p) => p.to),
});
const lit = (s: string, a: number, b: number): Txt => ({ s, from: Array(s.length).fill(a), to: Array(s.length).fill(b) });

class Builder {
  chars: string[] = [];
  starts: number[] = [];
  ends: number[] = [];
  elements: SyntaxElement[] = [];
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

export function blockMap(source: string, kind: BlockKind): BlockMap | null {
  try {
    return build(source, kind);
  } catch {
    // Unmappable syntax, or anything unexpected: the caller falls back to whole lines.
    return null;
  }
}

const lineList = (source: string, end: number) => {
  const out: { text: string; start: number }[] = [];
  let start = 0;
  for (const text of source.slice(0, end).split('\n')) {
    out.push({ text, start });
    start += text.length + 1;
  }
  return out;
};
// Offsets of `line.trim()` inside the source.
const trimmed = (l: { text: string; start: number }) => {
  const lead = l.text.length - l.text.trimStart().length;
  const t = l.text.trim();
  return { t, a: l.start + lead, b: l.start + lead + t.length };
};

function build(source: string, kind: BlockKind): BlockMap | null {
  if (kind === 'html' || kind === 'directive' || kind === 'math') return null;
  const end = source.replace(/\s+$/, '').length;
  const b = new Builder();
  if (kind === 'hr') return b.finish();
  if (kind === 'code') return codeMap(source, end, b);
  if (kind === 'table') return tableMap(source, end, b);

  const lines = lineList(source, end);
  let segments: Txt[];
  let markerEnd = -1;
  if (kind === 'paragraph') {
    // Plannotator keeps paragraph lines raw (untrimmed) joined by \n.
    segments = [txtOf(source, 0, source.replace(/[\r\n]+$/, '').length)];
  } else if (kind === 'heading') {
    if (lines.length !== 1) return null;
    const { t, a, b: e } = trimmed(lines[0]);
    if (!t.startsWith('#')) return null;
    const m = /^#+\s*/.exec(t)![0].length;
    markerEnd = a + m;
    segments = [txtOf(source, a + m, e)];
  } else if (kind === 'list-item') {
    const first = trimmed(lines[0]);
    const lm = /^(\*|-|(\d+)\.)\s/.exec(first.t);
    if (!lm) return null;
    let at = lm[0].length;
    const cb = /^\[([ xX])\]\s*/.exec(first.t.slice(at));
    if (cb) at += cb[0].length;
    markerEnd = first.a + at;
    const parts = [txtOf(source, markerEnd, first.b)];
    let prevBlank = false;
    let prevNl = lines[0].start + lines[0].text.length;
    for (const line of lines.slice(1)) {
      const tr = trimmed(line);
      if (tr.t === '') { prevBlank = true; continue; }
      const nl = line.start - 1;
      parts.push(lit(prevBlank ? '\n\n' : '\n', prevBlank ? prevNl : nl, prevBlank ? nl + 1 : nl + 1));
      parts.push(txtOf(source, tr.a, tr.b));
      prevBlank = false;
      prevNl = nl;
    }
    segments = splitParagraphs(concat(parts));
  } else {
    // blockquote
    const parts: Txt[] = [];
    for (const line of lines) {
      const tr = trimmed(line);
      if (tr.t === '') continue;
      if (!tr.t.startsWith('>')) return null;
      const m = /^>\s*/.exec(tr.t)![0].length;
      const body = tr.t.slice(m);
      if (parts.length === 0) {
        if (/^\[!(NOTE|TIP|WARNING|CAUTION|IMPORTANT)\]\s*$/i.test(body)) return null; // alert: rendered with a title
        markerEnd = tr.a + m;
      } else {
        parts.push(lit('\n', line.start - 1, line.start));
      }
      parts.push(txtOf(source, tr.a + m, tr.b));
    }
    if (markerEnd < 0) return null;
    segments = splitParagraphs(concat(parts));
  }
  if (markerEnd >= 0) b.elements.push({ open: [0, markerEnd], close: [end, end] });
  for (const seg of segments) scan(seg, b);
  return b.finish();
}

// Plannotator renders `content.split(/\n\n+/)` as separate <p>; the separators leave no text node.
function splitParagraphs(t: Txt): Txt[] {
  const out: Txt[] = [];
  let last = 0;
  for (const m of t.s.matchAll(/\n\n+/g)) {
    out.push(sub(t, last, m.index));
    last = m.index + m[0].length;
  }
  out.push(sub(t, last, t.s.length));
  return out;
}

function codeMap(source: string, end: number, b: Builder): BlockMap | null {
  const lines = lineList(source, end);
  const open = trimmed(lines[0]);
  if (!open.t.startsWith('```')) return null;
  const fenceLen = /^`+/.exec(open.t)![0].length;
  const closing = new RegExp('^\\s*`{' + fenceLen + ',}');
  let k = 1;
  const body: typeof lines = [];
  while (k < lines.length && !closing.test(lines[k].text)) body.push(lines[k++]);
  const openEnd = lines.length > 1 ? lines[1].start : end;
  const closeFrom = k >= lines.length ? end : body.length ? lines[k].start - 1 : lines[k].start;
  b.elements.push({ open: [0, openEnd], close: [closeFrom, end] });
  body.forEach((line, i) => {
    if (i > 0) b.add('\n', line.start - 1, line.start);
    // \r before \n is not part of the rendered text (innerHTML normalises CRLF).
    const n = line.text.endsWith('\r') && (i < body.length - 1 || k < lines.length) ? line.text.length - 1 : line.text.length;
    for (let c = 0; c < n; c++) b.add(line.text[c], line.start + c, line.start + c + 1);
  });
  return b.finish();
}

// Port of TableBlock.parseTableContent, keeping source offsets.
function tableMap(source: string, end: number, b: Builder): BlockMap | null {
  const lines = lineList(source, end).filter((l) => l.text.trim());
  if (!lines.length) return null;
  lines.forEach((line, idx) => {
    // The header row is parsed untrimmed, body rows trimmed.
    const row = idx === 0 ? { t: line.text, a: line.start, b: line.start + line.text.length } : trimmed(line);
    if (idx > 0 && /^[|\-:\s]+$/.test(row.t)) return; // separator row
    let a = row.a;
    let e = row.b;
    if (row.t.startsWith('|')) a++;
    if (row.t.endsWith('|') && e > a) e--;
    const text = source.slice(a, e);
    const cells: [number, number][] = [];
    let from = 0;
    for (let i = 0; i <= text.length; i++) {
      if (i === text.length || (text[i] === '|' && text[i - 1] !== '\\')) {
        cells.push([a + from, a + i]);
        from = i + 1;
      }
    }
    const el = { open: [line.start, line.start] as [number, number], close: [e, line.start + line.text.length] as [number, number] };
    cells.forEach(([cs, ce], ci) => {
      while (cs < ce && /\s/.test(source[cs])) cs++;
      while (ce > cs && /\s/.test(source[ce - 1])) ce--;
      if (ci === 0) el.open = [line.start, cs];
      if (ci === cells.length - 1) el.close = [ce, line.start + line.text.length];
      const parts: Txt[] = [];
      for (let i = cs; i < ce; i++) {
        if (source[i] === '\\' && source[i + 1] === '|') { parts.push(lit('|', i, i + 2)); i++; }
        else parts.push(txtOf(source, i, i + 1));
      }
      scan(concat(parts), b);
    });
    b.elements.push(el);
  });
  return b.finish();
}

// ---- Port of Plannotator InlineMarkdown's scanner (text-affecting branches only) ----

const EMOJI: Record<string, string> = {
  smile: '😄', heart: '❤️', thumbsup: '👍', thumbsdown: '👎',
  fire: '🔥', star: '⭐', tada: '🎉', rocket: '🚀',
  bug: '🐛', sparkles: '✨', warning: '⚠️', white_check_mark: '✅',
  x: '❌', eyes: '👀', wave: '👋', thinking: '🤔',
  ok: '🆗', construction: '🚧', boom: '💥', gear: '⚙️',
  hourglass: '⏳', zap: '⚡', lock: '🔒', unlock: '🔓',
  memo: '📝', book: '📖', package: '📦', hammer: '🔨',
  checkered_flag: '🏁', question: '❓', exclamation: '❗', bulb: '💡',
};
// utils/inlineTransforms.ts, in order. Lookbehinds replace the original's `(^|[\s([{])` prefix group.
const TRANSFORMS: [RegExp, (m: RegExpExecArray) => string][] = [
  [/:([a-z_]+):/g, (m) => EMOJI[m[1]] ?? m[0]],
  [/\.{3}/g, () => '…'],
  [/---/g, () => '—'],
  [/(?<=\d)--(?=\d)/g, () => '–'],
  [/(?<![^\s([{])"/g, () => '“'],
  [/"/g, () => '”'],
  [/(?<![^\s([{])'/g, () => '‘'],
  [/'/g, () => '’'],
];

type Token = { t: string; a: number; b: number };

// transformPlainText with each output char keeping the source span of the chars it came from.
function emitTransformed(t: Txt, from: number, to: number, out: Builder) {
  let tokens: Token[] = [];
  for (let i = from; i < to; i++) tokens.push({ t: t.s[i], a: t.from[i], b: t.to[i] });
  for (const [re, repl] of TRANSFORMS) {
    const str = tokens.map((k) => k.t).join('');
    const next: Token[] = [];
    let ti = 0; // token index
    let tpos = 0; // string offset of tokens[ti]
    for (const m of str.matchAll(re)) {
      const r = repl(m);
      if (r === m[0]) continue;
      while (tpos + tokens[ti].t.length <= m.index) { next.push(tokens[ti]); tpos += tokens[ti++].t.length; }
      const first = ti;
      let covered = tpos;
      while (covered < m.index + m[0].length) covered += tokens[ti++].t.length;
      const overhang = str.slice(m.index + m[0].length, covered);
      next.push({ t: str.slice(tpos, m.index) + r + overhang, a: tokens[first].a, b: tokens[ti - 1].b });
      tpos = covered;
    }
    while (ti < tokens.length) next.push(tokens[ti++]);
    tokens = next;
  }
  for (const k of tokens) for (let i = 0; i < k.t.length; i++) out.add(k.t[i], k.a, k.b);
}

// Copy of InlineMarkdown's trimUrlTail.
function trimUrlTail(url: string): string {
  const balanced = (u: string, close: string, open: string) => {
    let opens = 0;
    let closes = 0;
    for (const c of u) {
      if (c === open) opens++;
      else if (c === close) closes++;
    }
    return opens >= closes;
  };
  while (url.length > 0) {
    const last = url[url.length - 1];
    if (!/[.,;:!?)\]}>"']/.test(last)) break;
    if (last === ')' && balanced(url, ')', '(')) break;
    if (last === ']' && balanced(url, ']', '[')) break;
    if (last === '}' && balanced(url, '}', '{')) break;
    url = url.slice(0, -1);
  }
  return url;
}

const HEX = /^(#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|(?=[0-9a-fA-F]*[a-fA-F])[0-9a-fA-F]{4}|(?=[0-9a-fA-F]*[a-fA-F])[0-9a-fA-F]{3}))(?![0-9a-fA-F\w])/;
const EMPHASIS: { re: RegExp; d: number; needsBoundary?: boolean }[] = [
  { re: /^~~([\s\S]+?)~~/, d: 2 },
  { re: /^\*\*\*([\s\S]+?)\*\*\*/, d: 3 },
  { re: /^\*\*([\s\S]+?)\*\*/, d: 2 },
  { re: /^\*([\s\S]+?)\*/, d: 1 },
  { re: /^_([^_\s](?:[\s\S]*?[^_\s])?)_(?!\w)/, d: 1, needsBoundary: true },
];

function scan(t: Txt, out: Builder) {
  const s = t.s;
  let pos = 0;
  let prev = '';
  const raw = (a: number, b: number) => { for (let k = a; k < b; k++) out.add(s[k], t.from[k], t.to[k]); };
  while (pos < s.length) {
    const rem = s.slice(pos);
    let m: RegExpMatchArray | null = rem.match(/^<!--[\s\S]*?-->/);
    if (m) { pos += m[0].length; prev = '>'; continue; }

    if (rem.startsWith('\\(')) {
      for (let i = 2; i < rem.length - 1; i++) {
        if (rem[i] === '\\' && rem[i + 1] === ')') {
          if (rem[i - 1] === '\\') continue;
          if (rem.slice(2, i).trim()) throw new Unmappable(); // inline math
          break;
        }
      }
    }
    m = rem.match(/^\\([\\*_`\[\]~!.()\-#>+|{}&$])/);
    if (m) { out.add(m[1], ...rng(t, pos, pos + 2)); pos += 2; prev = m[1]; continue; }

    if (rem.startsWith('$') && prev !== '$' && !rem.startsWith('$$')) {
      let close = -1;
      for (let i = 1; i < rem.length; i++) {
        if (rem[i] === '\\') { i++; continue; }
        if (rem[i] === '$') { close = i; break; }
      }
      if (close > 1) {
        const tex = rem.slice(1, close);
        const after = rem[close + 1];
        const money = /^\s*\d/.test(tex) && after !== undefined && /\d/.test(after);
        if (!money) throw new Unmappable(); // inline math (or math-like text): not mapped
      }
    }

    if (!/\w/.test(prev)) {
      m = rem.match(/^https?:\/\/[^\s<>"']+/);
      if (m) {
        const url = trimUrlTail(m[0]);
        if (url.length > 0 && !/^\s*(javascript|data|vbscript|file)\s*:/i.test(url)) {
          raw(pos, pos + url.length); pos += url.length; prev = url[url.length - 1]; continue;
        }
      }
    }

    m = rem.match(/^<(https?:\/\/[^>]+)>/) ?? rem.match(/^<([^@>\s]+@[^>\s]+)>/);
    if (m) {
      out.elements.push({ open: rng(t, pos, pos + 1), close: rng(t, pos + m[0].length - 1, pos + m[0].length) });
      raw(pos + 1, pos + m[0].length - 1); pos += m[0].length; prev = '>'; continue;
    }
    m = rem.match(/^<([A-Za-z][A-Za-z0-9.+-]{0,31}:[^\s<>]*)>/);
    if (m) { raw(pos, pos + m[0].length); pos += m[0].length; prev = '>'; continue; }

    let done = false;
    for (const { re, d, needsBoundary } of EMPHASIS) {
      if (needsBoundary && /\w/.test(prev)) continue;
      m = rem.match(re);
      if (!m) continue;
      const len = m[0].length;
      out.elements.push({ open: rng(t, pos, pos + d), close: rng(t, pos + len - d, pos + len) });
      scan(sub(t, pos + d, pos + len - d), out);
      pos += len; prev = m[0][len - 1]; done = true;
      break;
    }
    if (done) continue;

    m = rem.match(/^`([^`]+)`/);
    if (m) {
      out.elements.push({ open: rng(t, pos, pos + 1), close: rng(t, pos + m[0].length - 1, pos + m[0].length) });
      raw(pos + 1, pos + m[0].length - 1); pos += m[0].length; prev = '`'; continue;
    }

    // Swatch, issue ref and @mention render their own text unchanged.
    m = rem.match(HEX);
    if (!m && !/\w/.test(prev)) m = rem.match(/^#(\d+)(?!\w)/) ?? rem.match(/^@([a-zA-Z][a-zA-Z0-9_-]{0,38})(?!\w)/);
    if (m) { raw(pos, pos + m[0].length); pos += m[0].length; prev = m[0][m[0].length - 1]; continue; }

    if (/^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/.test(rem)) throw new Unmappable(); // wiki link: label is host-resolved

    m = rem.match(/^!\[([^\]]*)\]\(([^)]+)\)/);
    if (m) { pos += m[0].length; prev = ')'; continue; } // image: no text

    const link = parseLink(rem);
    if (link) {
      out.elements.push({ open: rng(t, pos, pos + 1), close: rng(t, pos + link.textEnd, pos + link.consumed) });
      raw(pos + 1, pos + link.textEnd); // link text is NOT re-scanned for Markdown
      pos += link.consumed; prev = ')'; continue;
    }

    const hb = / {2,}\n|\\\n/.exec(rem);
    if (hb) {
      if (hb.index > 0) scan(sub(t, pos, pos + hb.index), out);
      pos += hb.index + hb[0].length; prev = '\n'; continue; // <br> has no text node
    }

    const next = rem.slice(1).search(/[\*_`\[!~\\<#@$]/);
    const chunk = next === -1 ? rem.length : next + 1;
    emitPlain(t, pos, pos + chunk, prev, out);
    prev = rem[chunk - 1] || prev;
    pos += chunk;
  }
}

function parseLink(rem: string): { textEnd: number; consumed: number } | null {
  if (rem[0] !== '[') return null;
  let i = 1;
  let depth = 1;
  while (i < rem.length && depth > 0) {
    const ch = rem[i];
    if (ch === '\\' && i + 1 < rem.length) { i += 2; continue; }
    if (ch === '[') depth++;
    else if (ch === ']') depth--;
    if (depth === 0) break;
    i++;
  }
  if (depth !== 0 || rem[i + 1] !== '(') return null;
  let j = i + 2;
  let parens = 1;
  while (j < rem.length && parens > 0) {
    const ch = rem[j];
    if (ch === '\\' && j + 1 < rem.length) { j += 2; continue; }
    if (ch === '(') parens++;
    else if (ch === ')') { parens--; if (parens === 0) break; }
    else if (ch === '\n') return null;
    j++;
  }
  if (parens !== 0 || i === 1 || j === i + 2) return null;
  return { textEnd: i, consumed: j + 1 };
}

// emitPlainTextWithBareUrls: bare URLs stay raw, the rest goes through transformPlainText.
function emitPlain(t: Txt, from: number, to: number, prev: string, out: Builder) {
  const text = t.s.slice(from, to);
  const urlRe = /https?:\/\/[^\s<>"']+/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(text)) !== null) {
    const before = m.index === 0 ? prev : text[m.index - 1];
    if (/\w/.test(before)) continue;
    const url = trimUrlTail(m[0]);
    if (!url.length) continue;
    if (m.index > last) emitTransformed(t, from + last, from + m.index, out);
    for (let k = 0; k < url.length; k++) out.add(url[k], t.from[from + m.index + k], t.to[from + m.index + k]);
    last = m.index + url.length;
    urlRe.lastIndex = last;
  }
  if (last < text.length) emitTransformed(t, from + last, to, out);
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
