// Copied from Plannotator packages/shared/workspace-status.ts at 772c620 (MIT); see THIRD_PARTY_NOTICES.md.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DomainError, isBranchName } from "./store.ts";

import type { WorkspaceFileChange, WorkspaceStatusPayload, GitRepositoryInfo, WorkspaceFileStatus } from '@plannotator/core/workspace-status-types';
export type { WorkspaceFileChange, WorkspaceStatusPayload, GitRepositoryInfo, WorkspaceFileStatus };

const TEXT_FILE_MAX_BYTES = 2 * 1024 * 1024;
const GIT_MAX_BUFFER = 20 * 1024 * 1024;
const DEFAULT_GIT_TIMEOUT_MS = 30_000;
type GitResult = { ok: true; stdout: string } | { ok: false; error: string };
export type ComparisonMode = "uncommitted" | "base";
export interface WorkspaceComparison {
	mode: ComparisonMode;
	base?: string;
	ref?: string;
	commit?: string;
	behind?: number;
	remoteCheckedAt?: number;
	remoteError?: string;
	error?: string;
}
export type ComparisonRequest = { mode: ComparisonMode; base?: string; fetch?: boolean };
export type WorkspaceStatusResult = WorkspaceStatusPayload & { comparison: WorkspaceComparison };
interface WorkspaceStatusFlight {
	promise?: Promise<WorkspaceStatusResult>;
	rerunRequested: boolean;
}
const workspaceStatusFlights = new Map<string, WorkspaceStatusFlight>();
const COUNTS_NONE = { additions: 0, deletions: 0 };

function getGitTimeoutMs(): number {
	const timeout = Number.parseInt(process.env.PLANNOTATOR_GIT_TIMEOUT_MS ?? "", 10);
	return Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_GIT_TIMEOUT_MS;
}

function runGit(cwd: string, args: string[]): GitResult {
	const result = spawnSync("git", ["--no-optional-locks", "-C", cwd, ...args], {
		encoding: "utf8",
		maxBuffer: GIT_MAX_BUFFER,
	});
	if (result.error) return { ok: false, error: result.error.message };
	if (result.status !== 0) {
		const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
		return { ok: false, error: stderr || `git exited with status ${result.status ?? "unknown"}` };
	}
	return { ok: true, stdout: result.stdout ?? "" };
}

function runGitAsync(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<GitResult> {
	return new Promise((resolveResult) => {
		const child = spawn("git", ["--no-optional-locks", "-C", cwd, ...args], {
			stdio: ["ignore", "pipe", "pipe"],
			...(env ? { env: { ...process.env, ...env } } : {}),
		});
		let stdout = "";
		let stderr = "";
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | null = null;

		const finish = (result: GitResult) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			resolveResult(result);
		};

		const timeoutMs = getGitTimeoutMs();
		timeout = setTimeout(() => {
			child.kill("SIGKILL");
			finish({ ok: false, error: `git timed out after ${timeoutMs}ms` });
		}, timeoutMs);

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdoutBytes += Buffer.byteLength(chunk);
			if (stdoutBytes > GIT_MAX_BUFFER) {
				child.kill();
				finish({ ok: false, error: `git stdout exceeded ${GIT_MAX_BUFFER} bytes` });
				return;
			}
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderrBytes += Buffer.byteLength(chunk);
			if (stderrBytes <= GIT_MAX_BUFFER) stderr += chunk;
		});
		child.on("error", (error) => finish({ ok: false, error: error.message }));
		child.on("close", (status) => {
			if (status === 0) {
				finish({ ok: true, stdout });
				return;
			}
			const message = stderr.trim() || `git exited with status ${status ?? "unknown"}`;
			finish({ ok: false, error: message });
		});
	});
}

function resolveGitPath(cwd: string, value: string): string {
	return isAbsolute(value) ? value : resolve(cwd, value);
}

export function getGitRepositoryInfo(cwd: string): GitRepositoryInfo | null {
	const topLevel = runGit(cwd, ["rev-parse", "--show-toplevel"]);
	if (!topLevel.ok) return null;
	const rawRepoRoot = topLevel.stdout.trim();
	if (!rawRepoRoot) return null;
	let gitCwd: string;
	try {
		gitCwd = realpathSync(resolve(cwd));
	} catch {
		return null;
	}
	const repoRoot = realpathSync(rawRepoRoot);

	const gitDir = runGit(cwd, ["rev-parse", "--git-dir"]);
	const gitCommonDir = runGit(cwd, ["rev-parse", "--git-common-dir"]);

	return {
		repoRoot,
		gitDir: gitDir.ok && gitDir.stdout.trim() ? resolveGitPath(gitCwd, gitDir.stdout.trim()) : resolve(repoRoot, ".git"),
		gitCommonDir: gitCommonDir.ok && gitCommonDir.stdout.trim()
			? resolveGitPath(gitCwd, gitCommonDir.stdout.trim())
			: gitDir.ok && gitDir.stdout.trim()
				? resolveGitPath(gitCwd, gitDir.stdout.trim())
				: resolve(repoRoot, ".git"),
	};
}

async function getGitRepositoryInfoAsync(cwd: string): Promise<GitRepositoryInfo | null> {
	const topLevel = await runGitAsync(cwd, ["rev-parse", "--show-toplevel"]);
	if (!topLevel.ok) return null;
	const rawRepoRoot = topLevel.stdout.trim();
	if (!rawRepoRoot) return null;
	let gitCwd: string;
	try {
		gitCwd = await realpath(resolve(cwd));
	} catch {
		return null;
	}
	let repoRoot: string;
	try {
		repoRoot = await realpath(rawRepoRoot);
	} catch {
		return null;
	}

	const [gitDir, gitCommonDir] = await Promise.all([
		runGitAsync(cwd, ["rev-parse", "--git-dir"]),
		runGitAsync(cwd, ["rev-parse", "--git-common-dir"]),
	]);

	return {
		repoRoot,
		gitDir: gitDir.ok && gitDir.stdout.trim() ? resolveGitPath(gitCwd, gitDir.stdout.trim()) : resolve(repoRoot, ".git"),
		gitCommonDir: gitCommonDir.ok && gitCommonDir.stdout.trim()
			? resolveGitPath(gitCwd, gitCommonDir.stdout.trim())
			: gitDir.ok && gitDir.stdout.trim()
				? resolveGitPath(gitCwd, gitDir.stdout.trim())
				: resolve(repoRoot, ".git"),
	};
}

function isWithinPath(candidate: string, root: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function mapStatus(x: string, y: string): WorkspaceFileStatus {
	if (x === "?" || y === "?") return "untracked";
	if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) return "conflicted";
	if (x === "R" || y === "R") return "renamed";
	if (x === "C" || y === "C") return "copied";
	if (x === "A" || y === "A") return "added";
	if (x === "D" || y === "D") return "deleted";
	if (x === "T" || y === "T") return "typechange";
	return "modified";
}

function parsePorcelain(output: string): Array<{
	repoRelativePath: string;
	oldRepoRelativePath?: string;
	status: WorkspaceFileStatus;
	staged: boolean;
	unstaged: boolean;
}> {
	const fields = output.split("\0").filter(Boolean);
	const result: Array<{
		repoRelativePath: string;
		oldRepoRelativePath?: string;
		status: WorkspaceFileStatus;
		staged: boolean;
		unstaged: boolean;
	}> = [];

	for (let i = 0; i < fields.length; i++) {
		const record = fields[i];
		if (record.length < 4) continue;
		const x = record[0] ?? " ";
		const y = record[1] ?? " ";
		const path = record.slice(3);
		let oldPath: string | undefined;
		if (x === "R" || y === "R" || x === "C" || y === "C") {
			oldPath = fields[i + 1];
			i += 1;
		}
		result.push({
			repoRelativePath: path,
			oldRepoRelativePath: oldPath,
			status: mapStatus(x, y),
			staged: x !== " " && x !== "?",
			unstaged: y !== " " && y !== "?",
		});
	}

	return result;
}

function parseNumstat(output: string): Map<string, { additions: number; deletions: number }> {
	const counts = new Map<string, { additions: number; deletions: number }>();
	const records = output.split("\0");
	for (let i = 0; i < records.length; i++) {
		const record = records[i];
		if (!record) continue;
		const parts = record.split("\t");
		if (parts.length < 3) continue;
		const additions = parts[0] === "-" ? 0 : Number.parseInt(parts[0] ?? "0", 10);
		const deletions = parts[1] === "-" ? 0 : Number.parseInt(parts[1] ?? "0", 10);
		let path = parts.slice(2).join("\t");
		if (!path) {
			path = records[i + 2] ?? "";
			i += 2;
		}
		if (!path) continue;
		counts.set(path, {
			additions: Number.isFinite(additions) ? additions : 0,
			deletions: Number.isFinite(deletions) ? deletions : 0,
		});
	}
	return counts;
}

async function countTextFileLines(path: string): Promise<number> {
	try {
		const fileStat = await stat(path);
		if (!fileStat.isFile() || fileStat.size > TEXT_FILE_MAX_BYTES) return 0;
		const text = (await readFile(path, "utf8")).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		if (text.length === 0) return 0;
		const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
		return trimmed.length === 0 ? 1 : trimmed.split("\n").length;
	} catch {
		return 0;
	}
}

function unavailableWorkspaceStatus(
	rootPath: string,
	error: string,
	repoRoot?: string,
): WorkspaceStatusPayload {
	return {
		available: false,
		rootPath,
		repoRoot,
		files: {},
		totals: { files: 0, additions: 0, deletions: 0 },
		error,
	};
}

type StatusEntry = { repoRelativePath: string; oldRepoRelativePath?: string; status: WorkspaceFileStatus; staged: boolean; unstaged: boolean };

const NAME_STATUS: Record<string, WorkspaceFileStatus> = { M: "modified", A: "added", D: "deleted", R: "renamed", C: "copied", T: "typechange", U: "conflicted" };
function parseNameStatus(output: string): StatusEntry[] {
	const fields = output.split("\0");
	const result: StatusEntry[] = [];
	for (let i = 0; i < fields.length;) {
		const code = fields[i++];
		if (!code) continue;
		const copied = code[0] === "R" || code[0] === "C";
		const oldRepoRelativePath = copied ? fields[i++] : undefined;
		const repoRelativePath = fields[i++];
		if (!repoRelativePath) continue;
		result.push({ repoRelativePath, oldRepoRelativePath, status: NAME_STATUS[code[0]] ?? "modified", staged: false, unstaged: false });
	}
	return result;
}

async function revSha(repoRoot: string, rev: string): Promise<string | undefined> {
	const result = await runGitAsync(repoRoot, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
	return result.ok ? result.stdout.trim() || undefined : undefined;
}

// Resolve what the working tree is compared against. Base mode uses merge-base(HEAD, base) so commits that exist
// only on the base never read as our changes; an old merge-base is normal and not an error.
async function resolveComparison(repo: GitRepositoryInfo, request: ComparisonRequest, fetch: boolean): Promise<{ comparison: WorkspaceComparison; target?: string }> {
	if (request.mode !== "base") {
		const commit = await revSha(repo.repoRoot, "HEAD");
		return { comparison: { mode: "uncommitted", ...(commit ? { commit } : {}) }, target: "HEAD" };
	}
	const base = request.base;
	const comparison: WorkspaceComparison = { mode: "base", ...(base ? { base } : {}) };
	if (!isBranchName(base)) return { comparison: { ...comparison, error: "invalid-base-branch" } };
	if (fetch) {
		const fetched = await runGitAsync(repo.repoRoot, ["fetch", "--no-tags", "origin", base], { GIT_TERMINAL_PROMPT: "0" });
		if (!fetched.ok) comparison.remoteError = fetched.error;
	}
	// FETCH_HEAD is per worktree; a fetch from any worktree refreshes the shared remote refs.
	const fetchedAt = await Promise.all([...new Set([repo.gitDir, repo.gitCommonDir])].map((dir) => stat(join(dir, "FETCH_HEAD")).then((info) => info.mtimeMs, () => 0)));
	if (Math.max(...fetchedAt) > 0) comparison.remoteCheckedAt = Math.floor(Math.max(...fetchedAt));
	let refSha = await revSha(repo.repoRoot, `refs/remotes/origin/${base}`);
	if (refSha) comparison.ref = `origin/${base}`;
	else {
		refSha = await revSha(repo.repoRoot, `refs/heads/${base}`);
		if (refSha) comparison.ref = base;
	}
	if (!refSha) return { comparison: { ...comparison, error: "base-not-found" } };
	const mergeBase = await runGitAsync(repo.repoRoot, ["merge-base", "HEAD", refSha]);
	const commit = mergeBase.ok ? mergeBase.stdout.trim() : "";
	if (!commit) return { comparison: { ...comparison, error: "no-merge-base" } };
	comparison.commit = commit;
	const behind = await runGitAsync(repo.repoRoot, ["rev-list", "--count", `HEAD..${refSha}`]);
	if (behind.ok) comparison.behind = Number.parseInt(behind.stdout, 10) || 0;
	return { comparison, target: commit };
}

async function computeWorkspaceStatusForDirectory(rootPath: string, request: ComparisonRequest, fetch: boolean): Promise<WorkspaceStatusResult> {
	const fail = (error: string, comparison: WorkspaceComparison, repoRoot?: string): WorkspaceStatusResult =>
		({ ...unavailableWorkspaceStatus(rootPath, error, repoRoot), comparison });
	const repo = await getGitRepositoryInfoAsync(rootPath);
	if (!repo) return fail("not-a-git-repo", { mode: request.mode });
	const { comparison, target } = await resolveComparison(repo, request, fetch);
	if (!target) return fail(comparison.error ?? "comparison-unavailable", comparison, repo.repoRoot);

	const relativeRoot = relative(repo.repoRoot, rootPath).replace(/\\/g, "/");
	const rootPathspec = relativeRoot ? `:(literal)${relativeRoot}` : ".";
	const status = await runGitAsync(repo.repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", rootPathspec]);
	if (!status.ok) return fail(status.error, comparison, repo.repoRoot);

	const porcelain = parsePorcelain(status.stdout);
	// Net counts against the comparison commit: a file with staged and unstaged edits is counted once.
	const numstat = await runGitAsync(repo.repoRoot, ["diff", "--numstat", "-z", "-M", target, "--", rootPathspec]);
	const lineCounts = numstat.ok ? parseNumstat(numstat.stdout) : new Map<string, { additions: number; deletions: number }>();
	let entries: StatusEntry[] = porcelain;
	if (request.mode === "base") {
		const names = await runGitAsync(repo.repoRoot, ["diff", "--name-status", "-z", "-M", target, "--", rootPathspec]);
		if (!names.ok) return fail(names.error, comparison, repo.repoRoot);
		const flags = new Map(porcelain.map((entry) => [entry.repoRelativePath, entry]));
		entries = [
			...parseNameStatus(names.stdout).map((entry) => ({ ...entry, staged: flags.get(entry.repoRelativePath)?.staged ?? false, unstaged: flags.get(entry.repoRelativePath)?.unstaged ?? false })),
			...porcelain.filter((entry) => entry.status === "untracked"),
		];
	}

	const files: Record<string, WorkspaceFileChange> = {};
	let totalAdditions = 0;
	let totalDeletions = 0;

	for (const entry of entries) {
		const absolutePath = resolve(repo.repoRoot, entry.repoRelativePath);
		if (!isWithinPath(absolutePath, rootPath)) continue;

		const counts = lineCounts.get(entry.repoRelativePath) ?? COUNTS_NONE;
		const oldCounts = entry.oldRepoRelativePath ? lineCounts.get(entry.oldRepoRelativePath) ?? COUNTS_NONE : COUNTS_NONE;
		const countedAdditions = counts.additions + oldCounts.additions;
		const additions = (entry.status === "untracked" || entry.status === "added") && countedAdditions === 0
			? await countTextFileLines(absolutePath)
			: countedAdditions;
		const deletions = counts.deletions + oldCounts.deletions;
		const oldPath = entry.oldRepoRelativePath
			? resolve(repo.repoRoot, entry.oldRepoRelativePath)
			: undefined;

		files[absolutePath] = {
			path: absolutePath,
			repoRelativePath: entry.repoRelativePath,
			oldPath,
			status: entry.status,
			additions,
			deletions,
			staged: entry.staged,
			unstaged: entry.unstaged,
		};
		totalAdditions += additions;
		totalDeletions += deletions;
	}

	return {
		available: true,
		rootPath,
		repoRoot: repo.repoRoot,
		files,
		totals: {
			files: Object.keys(files).length,
			additions: totalAdditions,
			deletions: totalDeletions,
		},
		comparison,
	};
}

async function runWorkspaceStatusFlight(key: string, rootPath: string, request: ComparisonRequest, flight: WorkspaceStatusFlight): Promise<WorkspaceStatusResult> {
	try {
		let status: WorkspaceStatusResult;
		let fetch = !!request.fetch;
		do {
			flight.rerunRequested = false;
			status = await computeWorkspaceStatusForDirectory(rootPath, request, fetch);
			fetch = false;
		} while (flight.rerunRequested);
		return status;
	} finally {
		if (workspaceStatusFlights.get(key) === flight) {
			workspaceStatusFlights.delete(key);
		}
	}
}

export async function getWorkspaceStatusForDirectory(dirPath: string, request: ComparisonRequest = { mode: "uncommitted" }): Promise<WorkspaceStatusResult> {
	let rootPath: string;
	try {
		rootPath = await realpath(resolve(dirPath));
	} catch {
		return { ...unavailableWorkspaceStatus(resolve(dirPath), "invalid-directory"), comparison: { mode: request.mode } };
	}

	// The fetch flag is part of the key so a fetching request is never satisfied by a flight that will not fetch.
	const key = [rootPath, request.mode, request.mode === "base" ? request.base ?? "" : "", request.fetch ? "fetch" : ""].join("\0");
	const existing = workspaceStatusFlights.get(key);
	if (existing?.promise) {
		existing.rerunRequested = true;
		return existing.promise;
	}

	const flight: WorkspaceStatusFlight = { rerunRequested: false };
	const status = runWorkspaceStatusFlight(key, rootPath, request, flight);
	flight.promise = status;
	workspaceStatusFlights.set(key, flight);
	return status;
}

// Text of a file at the comparison commit (null when absent there), following a rename to its old path.
export async function readComparisonOldText(absPath: string, request: { mode: ComparisonMode; base?: string }): Promise<string | null> {
	let existing = dirname(absPath);
	while (existing !== dirname(existing) && !(await stat(existing).catch(() => null))?.isDirectory()) existing = dirname(existing);
	const repo = await getGitRepositoryInfoAsync(existing);
	if (!repo) return null;
	const real = resolve(await realpath(existing), relative(existing, absPath));
	const rel = relative(repo.repoRoot, real).replace(/\\/g, "/");
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
	const { target } = await resolveComparison(repo, request, false);
	if (!target) return null;
	const show = async (path: string): Promise<string | null> => {
		const size = await runGitAsync(repo.repoRoot, ["cat-file", "-s", `${target}:${path}`]);
		if (!size.ok) return null;
		if (Number.parseInt(size.stdout, 10) > TEXT_FILE_MAX_BYTES) throw new DomainError("File exceeds the 2 MiB preview limit", 413);
		const blob = await runGitAsync(repo.repoRoot, ["cat-file", "blob", `${target}:${path}`]);
		return blob.ok ? blob.stdout : null;
	};
	const direct = await show(rel);
	if (direct !== null) return direct;
	const names = await runGitAsync(repo.repoRoot, ["diff", "--name-status", "-z", "-M", target]);
	const renamed = names.ok ? parseNameStatus(names.stdout).find((entry) => entry.repoRelativePath === rel && entry.oldRepoRelativePath) : undefined;
	return renamed?.oldRepoRelativePath ? show(renamed.oldRepoRelativePath) : null;
}

// Local heads plus origin branches, as short names.
export async function listBranches(dirPath: string): Promise<string[]> {
	const result = await runGitAsync(dirPath, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes/origin"]);
	if (!result.ok) return [];
	const names = new Set<string>();
	for (const ref of result.stdout.split("\n")) {
		const name = ref.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\/origin\//, "");
		if (ref && name !== "HEAD" && isBranchName(name)) names.add(name);
	}
	return [...names].sort((a, b) => a.localeCompare(b));
}

export function filterWorkspaceStatusForDirectory<T extends WorkspaceStatusPayload>(
	status: T,
	dirPath: string,
	filter?: (relativePath: string, change: WorkspaceFileChange) => boolean,
): T {
	if (!status.available) return status;
	let rootPath = status.rootPath || resolve(dirPath);
	try {
		rootPath = status.rootPath || realpathSync(resolve(dirPath));
	} catch {
		// Fall back to the resolved input when the directory disappeared between calls.
	}
	const files: Record<string, WorkspaceFileChange> = {};
	let additions = 0;
	let deletions = 0;
	for (const change of Object.values(status.files)) {
		const rel = relative(rootPath, change.path).replace(/\\/g, "/");
		if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue;
		if (filter && !filter(rel, change)) continue;
		files[change.path] = change;
		additions += change.additions;
		deletions += change.deletions;
	}
	return {
		...status,
		files,
		totals: {
			files: Object.keys(files).length,
			additions,
			deletions,
		},
	};
}

export function getGitMetadataWatchPaths(cwd: string): string[] {
	const repo = getGitRepositoryInfo(cwd);
	if (!repo) return [];
	let currentRefPath: string | null = null;
	try {
		const head = readFileSync(resolve(repo.gitDir, "HEAD"), "utf8").trim();
		if (head.startsWith("ref: ")) {
			const refsRoot = resolve(repo.gitCommonDir, "refs");
			const candidate = resolve(repo.gitCommonDir, head.slice("ref: ".length).trim());
			if (candidate !== refsRoot && isWithinPath(candidate, refsRoot)) currentRefPath = candidate;
		}
	} catch {
		// A detached, missing, or concurrently replaced HEAD has no symbolic ref target.
	}
	const candidates = [
		resolve(repo.gitDir, "HEAD"),
		resolve(repo.gitDir, "index"),
		resolve(repo.gitDir, "logs", "HEAD"),
		resolve(repo.gitCommonDir, "packed-refs"),
		currentRefPath,
	];
	return [...new Set(candidates)].filter((path): path is string => {
		if (path === null) return false;
		try {
			return !statSync(path).isDirectory();
		} catch {
			return true;
		}
	});
}
