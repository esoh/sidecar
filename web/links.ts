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

export function splitLineSuffix(target: string): [string, string] {
  const match = target.match(/:\d+(?:-\d+)?$/);
  return match ? [target.slice(0, match.index), match[0]] : [target, ''];
}
