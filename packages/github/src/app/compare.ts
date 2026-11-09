import type { FetchFn } from "./api.js";
import { githubAppCall } from "./api.js";

/**
 * `compare` do GitHub com paginação: lista COMPLETA de commits entre dois pontos e estatística de
 * arquivos. Usado pelo enriquecimento do webhook de push e pela tool `github_compare` do bot.
 * Nunca devolve patch, exceto quando pedido (`includePatch`, poucos arquivos e cortado).
 */
const API = "https://api.github.com";

export const COMPARE_PER_PAGE = 100;
export const COMPARE_MAX_PAGES = 5;
export const COMPARE_MAX_COMMIT_DETAILS = 40;
export const COMPARE_MESSAGE_CAP = 1000;
export const COMPARE_FILES_CAP = 100;
export const COMPARE_PATCH_FILES_MAX = 20;
export const COMPARE_PATCH_CHARS = 2000;

export type CompareCommit = {
	sha: string;
	subject: string;
	body?: string;
	author?: string;
	url?: string;
	files?: number;
	additions?: number;
	deletions?: number;
};

export type CompareFile = { path: string; status: string; additions: number; deletions: number; patch?: string };

export type CompareData = {
	repo: string;
	base: string;
	head: string;
	status: string;
	aheadBy: number;
	behindBy: number;
	/** Total informado pelo GitHub (pode ser maior que `commits.length` acima do teto de páginas). */
	totalCommits: number;
	commits: CompareCommit[];
	commitsTruncated: boolean;
	files: CompareFile[];
	filesTotal: number;
	filesTruncated: boolean;
	additions: number;
	deletions: number;
	htmlUrl?: string;
	patchOmittedReason?: string;
};

export type CompareResult = { data: CompareData; error?: never } | { data?: never; error: { status: number; message: string } };

function rec(v: unknown): Record<string, unknown> {
	return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function splitMessage(message: unknown): { subject: string; body?: string } {
	const text = typeof message === "string" ? message.trim() : "";
	const [first = "", ...rest] = text.split("\n");
	const subject = first.trim().slice(0, 200);
	const more = rest.join("\n").trim();
	return more ? { subject, body: text.slice(0, COMPARE_MESSAGE_CAP) } : { subject };
}

function mapCommit(raw: unknown): CompareCommit | null {
	const c = rec(raw);
	if (typeof c.sha !== "string") return null;
	const commit = rec(c.commit);
	const author = rec(commit.author);
	const ghAuthor = rec(c.author);
	const { subject, body } = splitMessage(commit.message);
	return {
		sha: c.sha,
		subject,
		...(body ? { body } : {}),
		author:
			typeof ghAuthor.login === "string" ? ghAuthor.login : typeof author.name === "string" ? author.name : undefined,
		url: typeof c.html_url === "string" ? c.html_url : undefined,
	};
}

function mapFile(raw: unknown): CompareFile | null {
	const f = rec(raw);
	if (typeof f.filename !== "string") return null;
	return {
		path: f.filename,
		status: typeof f.status === "string" ? f.status : "modified",
		additions: typeof f.additions === "number" ? f.additions : 0,
		deletions: typeof f.deletions === "number" ? f.deletions : 0,
		...(typeof f.patch === "string" ? { patch: f.patch } : {}),
	};
}

const refSegment = (ref: string): string => ref.split("/").map(encodeURIComponent).join("/");

/** `GET /repos/{o}/{r}/commits/{sha}` → nº de arquivos e +/- do commit (best-effort). */
async function fetchCommitStats(
	token: string,
	repo: string,
	sha: string,
	fetchFn: FetchFn,
): Promise<{ files: number; additions: number; deletions: number } | null> {
	const res = await githubAppCall<Record<string, unknown>>(fetchFn, `${API}/repos/${repo}/commits/${encodeURIComponent(sha)}`, {
		token,
	});
	if (res.error) return null;
	const stats = rec(res.data.stats);
	const files = Array.isArray(res.data.files) ? res.data.files.length : undefined;
	if (files === undefined) return null;
	return {
		files,
		additions: typeof stats.additions === "number" ? stats.additions : 0,
		deletions: typeof stats.deletions === "number" ? stats.deletions : 0,
	};
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const item = items[next++]!;
			await fn(item);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export type FetchCompareInput = {
	token: string;
	repo: string;
	base: string;
	head: string;
	fetchFn?: FetchFn;
	maxPages?: number;
	/** Consulta cada commit (até `maxCommitDetails`) para obter nº de arquivos por commit. */
	commitDetails?: boolean;
	maxCommitDetails?: number;
	includePatch?: boolean;
};

export async function fetchCompare(input: FetchCompareInput): Promise<CompareResult> {
	const fetchFn = input.fetchFn ?? fetch;
	const maxPages = input.maxPages ?? COMPARE_MAX_PAGES;
	const url = (page: number) =>
		`${API}/repos/${input.repo}/compare/${refSegment(input.base)}...${refSegment(input.head)}?per_page=${COMPARE_PER_PAGE}&page=${page}`;

	const commits: CompareCommit[] = [];
	const seenCommits = new Set<string>();
	const files = new Map<string, CompareFile>();
	let meta: Record<string, unknown> = {};
	let total = 0;

	for (let page = 1; page <= maxPages; page += 1) {
		const res = await githubAppCall<Record<string, unknown>>(fetchFn, url(page), { token: input.token });
		if (res.error) {
			if (page === 1) return { error: res.error };
			break;
		}
		const d = res.data;
		if (page === 1) {
			meta = d;
			total = typeof d.total_commits === "number" ? d.total_commits : 0;
		}
		const rows = Array.isArray(d.commits) ? d.commits : [];
		for (const row of rows) {
			const c = mapCommit(row);
			if (c && !seenCommits.has(c.sha)) {
				seenCommits.add(c.sha);
				commits.push(c);
			}
		}
		for (const row of Array.isArray(d.files) ? d.files : []) {
			const f = mapFile(row);
			if (f && !files.has(f.path)) files.set(f.path, f);
		}
		if (rows.length < COMPARE_PER_PAGE) break;
		if (total > 0 && commits.length >= total) break;
	}

	if (!total) total = commits.length;
	const allFiles = Array.from(files.values());
	// O GitHub devolve no máximo 300 arquivos no compare; chegar nesse teto significa que pode haver mais.
	const filesTruncated = allFiles.length >= 300;
	let additions = 0;
	let deletions = 0;
	for (const f of allFiles) {
		additions += f.additions;
		deletions += f.deletions;
	}

	if (input.commitDetails) {
		const limit = input.maxCommitDetails ?? COMPARE_MAX_COMMIT_DETAILS;
		await mapLimit(commits.slice(0, limit), 5, async (c) => {
			const stats = await fetchCommitStats(input.token, input.repo, c.sha, fetchFn);
			if (stats) Object.assign(c, stats);
		});
	}

	let patchOmittedReason: string | undefined;
	const outFiles: CompareFile[] = allFiles.map((f) => ({ ...f }));
	if (input.includePatch) {
		if (allFiles.length > COMPARE_PATCH_FILES_MAX) {
			patchOmittedReason = `patch omitido: ${allFiles.length} arquivos (máximo ${COMPARE_PATCH_FILES_MAX})`;
			for (const f of outFiles) delete f.patch;
		} else {
			for (const f of outFiles) {
				if (f.patch && f.patch.length > COMPARE_PATCH_CHARS) f.patch = `${f.patch.slice(0, COMPARE_PATCH_CHARS)}\n…[patch cortado]`;
			}
		}
	} else {
		for (const f of outFiles) delete f.patch;
	}

	return {
		data: {
			repo: input.repo,
			base: input.base,
			head: input.head,
			status: typeof meta.status === "string" ? meta.status : "unknown",
			aheadBy: typeof meta.ahead_by === "number" ? meta.ahead_by : commits.length,
			behindBy: typeof meta.behind_by === "number" ? meta.behind_by : 0,
			totalCommits: total,
			commits,
			commitsTruncated: commits.length < total,
			files: outFiles,
			filesTotal: outFiles.length,
			filesTruncated,
			additions,
			deletions,
			htmlUrl: typeof meta.html_url === "string" ? meta.html_url : undefined,
			...(patchOmittedReason ? { patchOmittedReason } : {}),
		},
	};
}

export const COMPARE_OUTPUT_MAX_CHARS = 18_000;
const STATUS_LETTER: Record<string, string> = { added: "A", removed: "D", modified: "M", renamed: "R", copied: "C", changed: "M" };

function commitLine(c: CompareCommit, index: number, subjectMax: number): string {
	const stats =
		c.files !== undefined ? ` (${c.files} arq${c.additions !== undefined ? `, +${c.additions} -${c.deletions ?? 0}` : ""})` : "";
	const subject = c.subject.length > subjectMax ? `${c.subject.slice(0, subjectMax - 1)}…` : c.subject;
	return `${index + 1}. ${c.sha.slice(0, 7)} ${c.author ?? "?"}: ${subject}${stats}`;
}

/**
 * Texto compacto para o modelo: cabeçalho, lista COMPLETA de commits primeiro, arquivos depois.
 * Se passar do teto, corta primeiro patches, depois arquivos, e por último encurta os assuntos —
 * a lista de commits nunca perde itens.
 */
export function formatCompareForModel(data: CompareData, maxChars: number = COMPARE_OUTPUT_MAX_CHARS): string {
	const header = [
		`compare ${data.repo} ${data.base}...${data.head}`,
		`status=${data.status} ahead_by=${data.aheadBy} behind_by=${data.behindBy}`,
		`commits=${data.totalCommits} listed=${data.commits.length}${data.commitsTruncated ? " (LIST INCOMPLETE: GitHub cap; page with github_compare on narrower ranges)" : ""}`,
		`files=${data.filesTotal}${data.filesTruncated ? "+" : ""} additions=${data.additions} deletions=${data.deletions}`,
		...(data.htmlUrl ? [`url=${data.htmlUrl}`] : []),
		...(data.patchOmittedReason ? [data.patchOmittedReason] : []),
	].join("\n");

	const buildCommits = (subjectMax: number) =>
		["COMMITS:", ...data.commits.map((c, i) => commitLine(c, i, subjectMax))].join("\n");

	const fileLine = (f: CompareFile) =>
		`${STATUS_LETTER[f.status] ?? "M"} ${f.path} +${f.additions} -${f.deletions}${f.patch ? `\n${f.patch}` : ""}`;

	let subjectMax = 160;
	let commitsText = buildCommits(subjectMax);
	while (header.length + commitsText.length + 2 > maxChars && subjectMax > 40) {
		subjectMax -= 30;
		commitsText = buildCommits(subjectMax);
	}

	const budget = maxChars - header.length - commitsText.length - 40;
	const fileLines: string[] = [];
	let used = 0;
	for (const f of data.files) {
		const line = fileLine(f);
		if (used + line.length + 1 > budget) break;
		fileLines.push(line);
		used += line.length + 1;
	}
	const hidden = data.files.length - fileLines.length;
	const filesText =
		data.files.length === 0
			? ""
			: `\nFILES:\n${fileLines.join("\n")}${hidden > 0 ? `\n[${hidden} more files not shown]` : ""}`;
	return `${header}\n${commitsText}${filesText}`;
}
