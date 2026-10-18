import { githubExcerpt, type GithubEnrichedFile, type NormalizedGithubEvent } from "@workspace/shared";
import { githubAppCall, type FetchFn } from "./api.js";
import { COMPARE_FILES_CAP, fetchCompare } from "./compare.js";

/**
 * Enriquecimento do evento do webhook antes de acordar a rotina. O payload de `push` do GitHub só
 * traz até 20 commits (e o normalizado só a contagem); aqui buscamos before..after inteiro pelo
 * `compare` paginado. Falha de rede/permissão nunca derruba o evento: devolve o original.
 */
const API = "https://api.github.com";
const ZERO_SHA = /^0+$/;
const PR_BODY_CAP = 1500;
const PR_FILES_MAX_PAGES = 3;

function rec(v: unknown): Record<string, unknown> {
	return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

export type EnrichInput = {
	event: NormalizedGithubEvent;
	/** Payload cru do webhook (só para ler `before`/`after`/`default_branch`; nada dele vai ao evento). */
	payload: Record<string, unknown>;
	token: string;
	fetchFn?: FetchFn;
};

function toFileList(files: Array<{ path: string; status: string; additions: number; deletions: number }>): GithubEnrichedFile[] {
	return files.slice(0, COMPARE_FILES_CAP).map((f) => ({ path: f.path, status: f.status, additions: f.additions, deletions: f.deletions }));
}

export async function enrichPushEvent(input: EnrichInput): Promise<NormalizedGithubEvent> {
	const { event, payload } = input;
	if (!event.push) return event;
	const before = typeof payload.before === "string" ? payload.before : "";
	const after = typeof payload.after === "string" ? payload.after : event.push.headSha;
	if (!after || ZERO_SHA.test(after)) return event;
	let base = before && !ZERO_SHA.test(before) ? before : "";
	if (!base) {
		// Branch nova: tudo que ela tem a mais que a branch padrão.
		const def = rec(payload.repository).default_branch;
		if (typeof def === "string" && def && def !== event.push.branch) base = def;
	}
	if (!base) return event;

	const res = await fetchCompare({
		token: input.token,
		repo: event.repo,
		base,
		head: after,
		fetchFn: input.fetchFn,
		commitDetails: true,
	});
	if (res.error) return event;
	const d = res.data;
	if (d.commits.length === 0) return event;
	return {
		...event,
		push: {
			...event.push,
			commits: Math.max(d.totalCommits, d.commits.length),
			commitList: d.commits.map((c) => ({
				sha: c.sha,
				subject: c.subject,
				...(c.body ? { body: c.body } : {}),
				...(c.author ? { author: c.author } : {}),
				...(c.url ? { url: c.url } : {}),
				...(c.files !== undefined ? { files: c.files, additions: c.additions, deletions: c.deletions } : {}),
			})),
			...(d.commitsTruncated ? { commitListTruncated: true } : {}),
			summary: { files: d.filesTotal, additions: d.additions, deletions: d.deletions },
			fileList: toFileList(d.files),
			...(d.files.length > COMPARE_FILES_CAP || d.filesTruncated ? { fileListTruncated: true } : {}),
		},
	};
}

export async function enrichPullRequestEvent(input: EnrichInput): Promise<NormalizedGithubEvent> {
	const { event } = input;
	if (!event.pr) return event;
	const fetchFn = input.fetchFn ?? fetch;
	const prRes = await githubAppCall<Record<string, unknown>>(fetchFn, `${API}/repos/${event.repo}/pulls/${event.pr.number}`, {
		token: input.token,
	});
	if (prRes.error) return event;
	const d = prRes.data;
	const files: GithubEnrichedFile[] = [];
	for (let page = 1; page <= PR_FILES_MAX_PAGES; page += 1) {
		const res = await githubAppCall<unknown[]>(
			fetchFn,
			`${API}/repos/${event.repo}/pulls/${event.pr.number}/files?per_page=100&page=${page}`,
			{ token: input.token },
		);
		if (res.error || !Array.isArray(res.data)) break;
		for (const row of res.data) {
			const f = rec(row);
			if (typeof f.filename !== "string") continue;
			files.push({
				path: f.filename,
				status: typeof f.status === "string" ? f.status : "modified",
				additions: typeof f.additions === "number" ? f.additions : 0,
				deletions: typeof f.deletions === "number" ? f.deletions : 0,
			});
		}
		if (res.data.length < 100) break;
	}
	const changedFiles = typeof d.changed_files === "number" ? d.changed_files : files.length;
	return {
		...event,
		pr: {
			...event.pr,
			...(githubExcerpt(d.body, PR_BODY_CAP) ? { body: githubExcerpt(d.body, PR_BODY_CAP) } : {}),
			...(typeof d.commits === "number" ? { commitsCount: d.commits } : {}),
			changedFiles,
			...(typeof d.additions === "number" ? { additions: d.additions } : {}),
			...(typeof d.deletions === "number" ? { deletions: d.deletions } : {}),
			fileList: files.slice(0, COMPARE_FILES_CAP),
			...(files.length > COMPARE_FILES_CAP || changedFiles > files.length ? { fileListTruncated: true } : {}),
		},
	};
}

/** Eventos de PR que ganham título/corpo/arquivos (os de interação — comentário, review — já trazem o recorte). */
const PR_ENRICHED_TYPES: ReadonlySet<string> = new Set(["pr_opened", "pr_pushed", "pr_merged", "pr_closed", "pr_review_requested"]);

/** Enriquece `push` e eventos de PR; os demais passam intactos. */
export async function enrichGithubEvent(input: EnrichInput): Promise<NormalizedGithubEvent> {
	try {
		if (input.event.type === "push") return await enrichPushEvent(input);
		if (input.event.pr && PR_ENRICHED_TYPES.has(input.event.type)) return await enrichPullRequestEvent(input);
	} catch {
		// enriquecer é best-effort
	}
	return input.event;
}
