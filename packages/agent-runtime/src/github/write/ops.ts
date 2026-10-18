import { githubAppCall, type AppApiResult, type FetchFn } from "../app/api.js";

/**
 * Escritas no GitHub que o bot faz com a identidade do GitHub App (token de instalação): issues,
 * comentários, PRs, reviews, labels, branch e arquivo. Entrada = nome e argumentos da tool do
 * conector (GitHub MCP ou Composio); saída = um plano executável ou "sem suporte no app".
 */
const API = "https://api.github.com";

export type GithubWriteOutcome = { ok: true; text: string } | { ok: false; text: string; status: number };
export type GithubWritePlan = {
	/** `owner/name`. */
	repo: string;
	/** Resumo curto da ação (mensagens e cartões). */
	label: string;
	run: (token: string, options?: { fetchFn?: FetchFn; signature?: string | null }) => Promise<GithubWriteOutcome>;
};
export type GithubWriteLookup = { plan: GithubWritePlan } | { plan: null; repo: string | null };

type Args = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const num = (v: unknown): number | undefined => {
	const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
	return Number.isInteger(n) && n > 0 ? n : undefined;
};
const strList = (v: unknown): string[] | undefined =>
	Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : undefined;

/** Texto + rodapé (idempotente: não repete se o corpo já termina com ele). */
export function withGithubSignature(body: string | undefined, signature: string | null | undefined): string | undefined {
	if (!signature) return body;
	const footer = `<sub>— ${signature}</sub>`;
	if (body?.trimEnd().endsWith(footer)) return body;
	return body && body.trim() ? `${body.trimEnd()}\n\n---\n${footer}` : footer;
}

export function githubRepoOf(args: Args): string | null {
	const owner = str(args.owner);
	const repo = str(args.repo);
	return owner && repo ? `${owner}/${repo}` : null;
}

function pick(entries: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(entries)) if (v !== undefined) out[k] = v;
	return out;
}

function summarize(data: unknown, kind: string): string {
	const d = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
	const keep = pick({
		number: d.number,
		id: d.id,
		html_url: d.html_url,
		title: d.title,
		state: d.state,
		merged: d.merged,
		message: d.message,
		sha: d.sha,
		ref: d.ref,
	});
	return `${kind}: ${JSON.stringify(keep)}`;
}

async function call(
	options: { fetchFn?: FetchFn } | undefined,
	token: string,
	method: string,
	path: string,
	body: unknown,
	kind: string,
): Promise<GithubWriteOutcome> {
	const res = await githubAppCall<unknown>(options?.fetchFn ?? fetch, `${API}${path}`, {
		method,
		token,
		...(body === undefined ? {} : { body }),
	});
	if (res.error) return { ok: false, status: res.error.status, text: `GitHub ${res.error.status}: ${res.error.message}` };
	return { ok: true, text: summarize(res.data, kind) };
}

function plan(repo: string, label: string, run: GithubWritePlan["run"]): GithubWriteLookup {
	return { plan: { repo, label, run } };
}

function normalizeName(toolName: string): string {
	return toolName.trim().toLowerCase().replace(/^github_/, "");
}

const COMMENT_NAMES = new Set(["add_issue_comment", "create_an_issue_comment", "create_issue_comment"]);
const ISSUE_CREATE_NAMES = new Set(["create_issue", "create_an_issue"]);
const ISSUE_UPDATE_NAMES = new Set(["update_issue", "update_an_issue"]);
const PR_CREATE_NAMES = new Set(["create_pull_request", "create_a_pull_request"]);
const PR_UPDATE_NAMES = new Set(["update_pull_request", "update_a_pull_request"]);
const PR_MERGE_NAMES = new Set(["merge_pull_request", "merge_a_pull_request"]);
const REVIEW_NAMES = new Set(["pull_request_review_write", "create_pull_request_review", "create_a_review_for_a_pull_request"]);

export function planGithubWrite(toolName: string, args: Args): GithubWriteLookup {
	const name = normalizeName(toolName);
	const repo = githubRepoOf(args);
	if (!repo) return { plan: null, repo: null };
	const unsupported: GithubWriteLookup = { plan: null, repo };
	const issueNumber = num(args.issue_number) ?? num(args.issueNumber) ?? num(args.number);
	const pullNumber = num(args.pullNumber) ?? num(args.pull_number) ?? num(args.pull_request_number) ?? num(args.number);
	const bodyOf = (signature: string | null | undefined): string | undefined =>
		args.body === undefined ? undefined : withGithubSignature(str(args.body) ?? "", signature);

	const issueFields = (signature: string | null | undefined, create: boolean) =>
		pick({
			title: str(args.title),
			body: bodyOf(signature),
			labels: strList(args.labels),
			assignees: strList(args.assignees),
			milestone: num(args.milestone),
			state: create ? undefined : str(args.state),
			state_reason: create ? undefined : str(args.state_reason),
			type: str(args.type),
		});
	const createIssue = () =>
		plan(repo, `criar issue em ${repo}`, (t, o) => call(o, t, "POST", `/repos/${repo}/issues`, issueFields(o?.signature, true), "Issue criada"));
	const updateIssue = (n: number) =>
		plan(repo, `editar issue #${n} em ${repo}`, (t, o) =>
			call(o, t, "PATCH", `/repos/${repo}/issues/${n}`, issueFields(o?.signature, false), "Issue atualizada"),
		);

	if (name === "issue_write") {
		const method = str(args.method) ?? "create";
		if (method === "create" && str(args.title)) return createIssue();
		if (method === "update" && issueNumber) return updateIssue(issueNumber);
		return unsupported;
	}
	if (ISSUE_CREATE_NAMES.has(name) && str(args.title)) return createIssue();
	if (ISSUE_UPDATE_NAMES.has(name) && issueNumber) return updateIssue(issueNumber);
	if (COMMENT_NAMES.has(name) && issueNumber && str(args.body)) {
		return plan(repo, `comentar em #${issueNumber} de ${repo}`, (t, o) =>
			call(o, t, "POST", `/repos/${repo}/issues/${issueNumber}/comments`, { body: withGithubSignature(str(args.body), o?.signature) }, "Comentário criado"),
		);
	}
	if (PR_CREATE_NAMES.has(name) && str(args.title) && str(args.head) && str(args.base)) {
		return plan(repo, `abrir PR em ${repo}`, (t, o) =>
			call(
				o,
				t,
				"POST",
				`/repos/${repo}/pulls`,
				pick({
					title: str(args.title),
					head: str(args.head),
					base: str(args.base),
					body: bodyOf(o?.signature),
					draft: typeof args.draft === "boolean" ? args.draft : undefined,
					maintainer_can_modify: typeof args.maintainer_can_modify === "boolean" ? args.maintainer_can_modify : undefined,
				}),
				"PR criado",
			),
		);
	}
	if (PR_UPDATE_NAMES.has(name) && pullNumber) {
		// Alternar rascunho exige GraphQL; o restante é REST.
		if (args.draft !== undefined) return unsupported;
		return plan(repo, `editar PR #${pullNumber} em ${repo}`, (t, o) =>
			call(
				o,
				t,
				"PATCH",
				`/repos/${repo}/pulls/${pullNumber}`,
				pick({
					title: str(args.title),
					body: bodyOf(o?.signature),
					state: str(args.state),
					base: str(args.base),
					maintainer_can_modify: typeof args.maintainer_can_modify === "boolean" ? args.maintainer_can_modify : undefined,
				}),
				"PR atualizado",
			),
		);
	}
	if (PR_MERGE_NAMES.has(name) && pullNumber) {
		return plan(repo, `fazer merge do PR #${pullNumber} em ${repo}`, (t, o) =>
			call(
				o,
				t,
				"PUT",
				`/repos/${repo}/pulls/${pullNumber}/merge`,
				pick({ commit_title: str(args.commit_title), commit_message: str(args.commit_message), merge_method: str(args.merge_method) }),
				"Merge feito",
			),
		);
	}
	if (REVIEW_NAMES.has(name) && pullNumber) {
		// Só cria a review (com evento = envia); enviar/apagar review pendente precisa do id e fica na conta.
		if ((str(args.method) ?? "create") !== "create") return unsupported;
		return plan(repo, `revisar PR #${pullNumber} em ${repo}`, (t, o) =>
			call(
				o,
				t,
				"POST",
				`/repos/${repo}/pulls/${pullNumber}/reviews`,
				pick({ body: bodyOf(o?.signature), event: str(args.event), commit_id: str(args.commitID) ?? str(args.commit_id) }),
				"Review criada",
			),
		);
	}
	if (name === "create_branch" && str(args.branch)) {
		const branch = str(args.branch)!;
		return plan(repo, `criar branch ${branch} em ${repo}`, async (t, o) => {
			const from = str(args.from_branch) ?? (await defaultBranch(repo, t, o));
			if (!from) return { ok: false, status: 404, text: "Não consegui descobrir a branch de origem" };
			const ref = await githubAppCall<{ object?: { sha?: string } }>(o?.fetchFn ?? fetch, `${API}/repos/${repo}/git/ref/heads/${from.split("/").map(encodeURIComponent).join("/")}`, { token: t });
			const sha = ref.data?.object?.sha;
			if (ref.error || !sha) {
				return { ok: false, status: ref.error?.status ?? 404, text: `GitHub ${ref.error?.status ?? 404}: ${ref.error?.message ?? "branch de origem não encontrada"}` };
			}
			return call(o, t, "POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha }, "Branch criada");
		});
	}
	if (name === "create_or_update_file" && str(args.path) && typeof args.content === "string" && str(args.message)) {
		const path = str(args.path)!;
		return plan(repo, `gravar ${path} em ${repo}`, (t, o) =>
			call(
				o,
				t,
				"PUT",
				`/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`,
				pick({
					message: str(args.message),
					content: Buffer.from(args.content as string, "utf8").toString("base64"),
					branch: str(args.branch),
					sha: str(args.sha),
				}),
				"Arquivo gravado",
			),
		);
	}
	if (name === "fork_repository") {
		return plan(repo, `fazer fork de ${repo}`, (t, o) =>
			call(
				o,
				t,
				"POST",
				`/repos/${repo}/forks`,
				pick({
					organization: str(args.organization),
					name: str(args.name),
					default_branch_only: typeof args.default_branch_only === "boolean" ? args.default_branch_only : undefined,
				}),
				"Fork criado",
			),
		);
	}
	if (name === "delete_file" && str(args.path) && str(args.message)) {
		const path = str(args.path)!;
		const api = `/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
		return plan(repo, `apagar ${path} em ${repo}`, async (t, o) => {
			const ref = str(args.branch);
			const current = await githubAppCall<{ sha?: string }>(o?.fetchFn ?? fetch, `${API}${api}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`, { token: t });
			if (current.error || !current.data?.sha) return fail(current.error, "arquivo não encontrado");
			return call(o, t, "DELETE", api, pick({ message: str(args.message), sha: current.data.sha, branch: ref }), "Arquivo apagado");
		});
	}
	if (name === "push_files" && str(args.branch) && str(args.message) && Array.isArray(args.files) && args.files.length > 0) {
		const branch = str(args.branch)!;
		const files = (args.files as unknown[]).flatMap((f) => {
			const r = f && typeof f === "object" ? (f as Record<string, unknown>) : {};
			return str(r.path) && typeof r.content === "string" ? [{ path: str(r.path)!, content: r.content }] : [];
		});
		if (files.length === 0) return unsupported;
		return plan(repo, `enviar ${files.length} arquivo(s) para ${branch} em ${repo}`, async (t, o) => {
			const f = o?.fetchFn ?? fetch;
			const ref = await githubAppCall<{ object?: { sha?: string } }>(f, `${API}/repos/${repo}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`, { token: t });
			const head = ref.data?.object?.sha;
			if (ref.error || !head) return fail(ref.error, "branch não encontrada");
			const commit = await githubAppCall<{ tree?: { sha?: string } }>(f, `${API}/repos/${repo}/git/commits/${head}`, { token: t });
			const base = commit.data?.tree?.sha;
			if (commit.error || !base) return fail(commit.error, "commit base não encontrado");
			const tree = await githubAppCall<{ sha?: string }>(f, `${API}/repos/${repo}/git/trees`, {
				method: "POST",
				token: t,
				body: { base_tree: base, tree: files.map((x) => ({ path: x.path, mode: "100644", type: "blob", content: x.content })) },
			});
			if (tree.error || !tree.data?.sha) return fail(tree.error, "não consegui montar a árvore");
			const created = await githubAppCall<{ sha?: string }>(f, `${API}/repos/${repo}/git/commits`, {
				method: "POST",
				token: t,
				body: { message: str(args.message), tree: tree.data.sha, parents: [head] },
			});
			if (created.error || !created.data?.sha) return fail(created.error, "não consegui criar o commit");
			return call(o, t, "PATCH", `/repos/${repo}/git/refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}`, { sha: created.data.sha }, "Commit enviado");
		});
	}
	return unsupported;
}

function fail(error: { status: number; message: string } | undefined, fallback: string): GithubWriteOutcome {
	return { ok: false, status: error?.status ?? 404, text: `GitHub ${error?.status ?? 404}: ${error?.message ?? fallback}` };
}

async function defaultBranch(repo: string, token: string, o?: { fetchFn?: FetchFn }): Promise<string | undefined> {
	const res: AppApiResult<{ default_branch?: string }> = await githubAppCall(o?.fetchFn ?? fetch, `${API}/repos/${repo}`, { token });
	return res.data?.default_branch;
}
