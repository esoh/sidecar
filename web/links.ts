// Agents link local files as absolute paths, file:// URLs or relative paths.
export type LinkTarget = { path: string } | { outside: string };

function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

export function resolveWorkspaceLink(target: string, root: string, baseDir = root): LinkTarget {
  let value = target.trim().replace(/^file:\/\//i, '');
  try { value = decodeURI(value); } catch { /* keep the raw link text */ }
  const absolute = normalize(value.startsWith('/') ? value : `${baseDir}/${value}`);
  return absolute.startsWith(`${root}/`) ? { path: absolute.slice(root.length + 1) } : { outside: absolute };
}

export type FileLineRange = { start: number; end: number };

export function splitLineSuffix(target: string): [string, string] {
  const match = target.match(/(?::\d+(?:-\d+)?(?:#.*)?|#L\d+(?:-L?\d+)?)$/);
  return match ? [target.slice(0, match.index), match[0]] : [target, ''];
}

export function fileLineRange(suffix: string): FileLineRange | undefined {
  const match = suffix.match(/^(?::(\d+)(?:-(\d+))?(?:#.*)?|#L(\d+)(?:-L?(\d+))?)$/);
  if (!match) return;
  const start = Number(match[1] ?? match[3]), end = Number(match[2] ?? match[4] ?? start);
  if (![start, end].every(value => Number.isSafeInteger(value) && value > 0)) return;
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

// A raw href from an untrusted HTML page. Only local file paths inside `root` open; anything with a URL
// scheme other than file:, scheme-relative URLs and same-page anchors return null (left to the page).
// Bare paths are repository-style (from root); ./ and ../ follow the HTML file's directory.
// `README.md:2-4` looks like a URI scheme; a dotted bare file name with a line suffix is a file.
// (Dotless names such as `Makefile:12` stay ambiguous with schemes like `tel:12`; link them with a path.)
const bareFileLine = /^[^:/?#]*\.[^:/?#]*:\d+(?:-\d+)?(?:#.*)?$/;
export type PageLinkTarget = { path: string; fragment?: string; lineRange?: FileLineRange } | { outside: string };
export function pageLinkTarget(href: string, root: string, htmlDir: string): PageLinkTarget | null {
  const value = href.trim();
  if (!value || value.length > 4096 || /[\x00-\x1f]/.test(value) || value.startsWith('#') || value.startsWith('//')
    || (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^file:\/\/\//i.test(value) && !bareFileLine.test(value))) return null;
  const [source, suffix] = splitLineSuffix(value);
  const html = !suffix ? source.match(/^([^#?]*\.html?)(#.*)$/i) : null;
  const file = html ? html[1] : source.replace(/[?#].*$/, '');
  if (!file) return null;
  const resolved = resolveWorkspaceLink(file, root, /^\.\.?\//.test(file) ? htmlDir : root);
  if ('outside' in resolved) return resolved;
  const lineRange = fileLineRange(suffix);
  return { path: resolved.path, ...(html ? { fragment: html[2] } : {}), ...(lineRange ? { lineRange } : {}) };
}
