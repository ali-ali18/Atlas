import { devPrStateFrom, summarizeCi, type DevCiCheck, type DevCiCheckStatus, type DevCiSummary, type DevPrInfo } from "@workspace/shared";

/**
 * Pull request e CI do GitHub para as sessões de código: lê o PR e as
 * verificações (check runs + status legados), abre o PR e devolve o fim do log
 * de um job. O token vai só no cabeçalho; o chamador redige a saída.
 */

const API = "https://api.github.com";
const USER_AGENT = "atlas-agent";
/** Teto de verificações lidas por PR (uma página de 100 por fonte). */
const PER_PAGE = 100;

export type PullCiFetch = typeof fetch;
export type PullCiOptions = { fetchFn?: PullCiFetch; signal?: AbortSignal };

export type PullCiError = { error: { status: number; message: string } };

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function headers(token: string | undefined, extra: Record<string, string> = {}): Record<string, string> {
	return {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		"User-Agent": USER_AGENT,
		...(token ? { Authorization: `Bearer ${token}` } : {}),
		...extra,
	};
}

async function request(
	path: string,
	token: string | undefined,
	options: PullCiOptions & { method?: string; body?: unknown } = {},
): Promise<{ data: unknown } | PullCiError> {
	const fetchFn = options.fetchFn ?? fetch;
	let res: Response;
	try {
		res = await fetchFn(`${API}${path}`, {
			method: options.method ?? "GET",
			headers: headers(token, options.body !== undefined ? { "Content-Type": "application/json" } : {}),
			...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
			...(options.signal ? { signal: options.signal } : {}),
		});
	} catch (error) {
		return { error: { status: 0, message: error instanceof Error ? error.message : "falha de rede ao chamar o GitHub" } };
	}
	const text = await res.text().catch(() => "");
	let json: unknown;
	if (text.trim()) {
		try {
			json = JSON.parse(text);
		} catch {
			json = undefined;
		}
	}
	if (!res.ok) {
		const record = asRecord(json);
		const base = typeof record.message === "string" ? record.message : res.statusText || "erro na API do GitHub";
		const detail = Array.isArray(record.errors)
			? record.errors
					.map((entry) => (typeof entry === "string" ? entry : typeof asRecord(entry).message === "string" ? (asRecord(entry).message as string) : ""))
					.filter(Boolean)
					.join("; ")
			: "";
		return { error: { status: res.status, message: detail ? `${base} (${detail})` : base } };
	}
	return { data: json };
}

export function describePullCiError(error: { status: number; message: string }, hasToken = true): string {
	if (error.status === 401) return "O GitHub recusou o token: reconecte o GitHub no Marketplace.";
	if (error.status === 403 || error.status === 404) {
		return hasToken
			? `${error.message}. Confira se o repositório existe e se a conexão do GitHub tem acesso (escopo repo).`
			: `${error.message}. Sem conexão do GitHub só repositórios públicos são acessíveis.`;
	}
	return error.message;
}

function mapPull(row: unknown): DevPrInfo | null {
	const pr = asRecord(row);
	const head = asRecord(pr.head);
	const base = asRecord(pr.base);
	if (typeof pr.number !== "number" || typeof pr.html_url !== "string") return null;
	return {
		number: pr.number,
		url: pr.html_url,
		state: devPrStateFrom({
			state: typeof pr.state === "string" ? pr.state : undefined,
			merged: pr.merged === true || typeof pr.merged_at === "string",
			draft: pr.draft === true,
		}),
		title: typeof pr.title === "string" ? pr.title : "",
		base: typeof base.ref === "string" ? base.ref : "",
		head: typeof head.ref === "string" ? head.ref : "",
		...(typeof head.sha === "string" ? { headSha: head.sha } : {}),
	};
}

const JOB_FROM_URL = /\/actions\/runs\/\d+\/job\/(\d+)/;

function mapCheckStatus(value: unknown): DevCiCheckStatus {
	return value === "completed" ? "completed" : value === "in_progress" ? "in_progress" : "queued";
}

/** Verificações do commit: check runs (Actions e apps) + status legados, sem repetir o mesmo nome. */
export function mapCheckRuns(checkRuns: unknown, statuses: unknown): DevCiCheck[] {
	const checks: DevCiCheck[] = [];
	const seen = new Set<string>();
	const runs = asRecord(checkRuns).check_runs;
	for (const entry of Array.isArray(runs) ? runs : []) {
		const run = asRecord(entry);
		const name = typeof run.name === "string" ? run.name : "";
		if (!name || seen.has(name)) continue;
		seen.add(name);
		const url = typeof run.html_url === "string" ? run.html_url : typeof run.details_url === "string" ? run.details_url : undefined;
		const startedAt = typeof run.started_at === "string" ? Date.parse(run.started_at) : Number.NaN;
		const completedAt = typeof run.completed_at === "string" ? Date.parse(run.completed_at) : Number.NaN;
		const detailsUrl = typeof run.details_url === "string" ? run.details_url : "";
		const jobMatch = JOB_FROM_URL.exec(detailsUrl) ?? (url ? JOB_FROM_URL.exec(url) : null);
		const status = mapCheckStatus(run.status);
		checks.push({
			name,
			status,
			conclusion: status === "completed" && typeof run.conclusion === "string" ? run.conclusion : null,
			...(url ? { url } : {}),
			...(Number.isFinite(startedAt) && Number.isFinite(completedAt) && completedAt >= startedAt ? { durationMs: completedAt - startedAt } : {}),
			...(jobMatch ? { jobId: Number(jobMatch[1]) } : {}),
		});
	}
	const legacy = asRecord(statuses).statuses;
	for (const entry of Array.isArray(legacy) ? legacy : []) {
		const item = asRecord(entry);
		const name = typeof item.context === "string" ? item.context : "";
		if (!name || seen.has(name)) continue;
		seen.add(name);
		const state = item.state;
		const url = typeof item.target_url === "string" && item.target_url ? item.target_url : undefined;
		checks.push({
			name,
			status: state === "pending" ? "in_progress" : "completed",
			conclusion: state === "pending" ? null : state === "success" ? "success" : "failure",
			...(url ? { url } : {}),
		});
	}
	return checks;
}

export type PullSnapshot = { pr: DevPrInfo; checks: DevCiCheck[]; summary: DevCiSummary };

/** PR + verificações do commit de cabeça (mesmo sem token para repositório público). */
export async function fetchPullSnapshot(
	token: string | undefined,
	repo: string,
	number: number,
	options: PullCiOptions = {},
): Promise<PullSnapshot | PullCiError> {
	const pull = await request(`/repos/${repo}/pulls/${number}`, token, options);
	if ("error" in pull) return pull;
	const pr = mapPull(pull.data);
	if (!pr) return { error: { status: 502, message: "O GitHub devolveu o PR num formato inesperado" } };
	if (!pr.headSha) return { pr, checks: [], summary: "none" };
	const [runs, statuses] = await Promise.all([
		request(`/repos/${repo}/commits/${pr.headSha}/check-runs?per_page=${PER_PAGE}`, token, options),
		request(`/repos/${repo}/commits/${pr.headSha}/status?per_page=${PER_PAGE}`, token, options),
	]);
	if ("error" in runs && "error" in statuses) return runs;
	const checks = mapCheckRuns("data" in runs ? runs.data : undefined, "data" in statuses ? statuses.data : undefined);
	return { pr, checks, summary: summarizeCi(checks) };
}

/** PR aberto da branch (idempotência da criação). */
export async function findOpenPull(
	token: string,
	repo: string,
	head: string,
	options: PullCiOptions = {},
): Promise<DevPrInfo | null | PullCiError> {
	const owner = repo.split("/")[0] ?? "";
	const result = await request(`/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}&per_page=5`, token, options);
	if ("error" in result) return result;
	const first = Array.isArray(result.data) ? result.data[0] : undefined;
	return first ? mapPull(first) : null;
}

export async function createPull(
	token: string,
	repo: string,
	input: { title: string; body: string; head: string; base: string; draft: boolean },
	options: PullCiOptions = {},
): Promise<DevPrInfo | PullCiError> {
	const result = await request(`/repos/${repo}/pulls`, token, { ...options, method: "POST", body: input });
	if ("error" in result) return result;
	return mapPull(result.data) ?? { error: { status: 502, message: "O GitHub devolveu o PR criado num formato inesperado" } };
}

/** Jobs de um run do Actions (para achar o que falhou). */
export async function listRunJobs(
	token: string | undefined,
	repo: string,
	runId: number,
	options: PullCiOptions = {},
): Promise<Array<{ id: number; name: string; conclusion: string | null; status: string; url?: string }> | PullCiError> {
	const result = await request(`/repos/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=${PER_PAGE}`, token, options);
	if ("error" in result) return result;
	const jobs = asRecord(result.data).jobs;
	return (Array.isArray(jobs) ? jobs : []).map((entry) => {
		const job = asRecord(entry);
		return {
			id: typeof job.id === "number" ? job.id : 0,
			name: typeof job.name === "string" ? job.name : "",
			conclusion: typeof job.conclusion === "string" ? job.conclusion : null,
			status: typeof job.status === "string" ? job.status : "",
			...(typeof job.html_url === "string" ? { url: job.html_url } : {}),
		};
	});
}

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const LOG_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;

/** Limpa o log do Actions (timestamps e ANSI) e fica com o fim, mais as linhas `##[error]`. */
export function tailJobLog(raw: string, maxChars = 6_000): string {
	const lines = raw.replace(ANSI, "").split(/\r?\n/).map((line) => line.replace(LOG_TIMESTAMP, ""));
	const errors = lines.filter((line) => line.startsWith("##[error]")).map((line) => line.slice(9));
	let tail = lines.join("\n").trimEnd();
	let cut = false;
	if (tail.length > maxChars) {
		tail = tail.slice(tail.length - maxChars);
		tail = tail.slice(tail.indexOf("\n") + 1);
		cut = true;
	}
	const head = errors.length ? `Erros anotados:\n${[...new Set(errors)].slice(0, 8).join("\n")}\n\n` : "";
	return `${head}${cut ? "[início do log omitido]\n" : ""}${tail}`;
}

/** Log de um job do Actions: o GitHub responde 302 para um link temporário, buscado SEM o token. */
export async function fetchJobLog(
	token: string | undefined,
	repo: string,
	jobId: number,
	options: PullCiOptions = {},
): Promise<string | PullCiError> {
	const fetchFn = options.fetchFn ?? fetch;
	try {
		const first = await fetchFn(`${API}/repos/${repo}/actions/jobs/${jobId}/logs`, {
			headers: headers(token),
			redirect: "manual",
			...(options.signal ? { signal: options.signal } : {}),
		});
		if (first.status >= 300 && first.status < 400) {
			const location = first.headers.get("location");
			if (!location || !/^https:\/\//.test(location)) return { error: { status: 502, message: "O GitHub não devolveu o link do log" } };
			const second = await fetchFn(location, { headers: { "User-Agent": USER_AGENT }, ...(options.signal ? { signal: options.signal } : {}) });
			if (!second.ok) return { error: { status: second.status, message: "Não consegui baixar o log do job" } };
			return await second.text();
		}
		if (first.ok) return await first.text();
		let message = first.statusText || "erro ao buscar o log";
		try {
			const body = asRecord(JSON.parse(await first.text()));
			if (typeof body.message === "string") message = body.message;
		} catch {
			// corpo não-JSON
		}
		return { error: { status: first.status, message } };
	} catch (error) {
		return { error: { status: 0, message: error instanceof Error ? error.message : "falha de rede ao buscar o log" } };
	}
}
