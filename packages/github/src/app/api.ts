import { createGithubAppJwt } from "./jwt.js";
import type { ConvertedGithubApp, GithubAppCredentials } from "./credentials.js";

/** Chamadas REST do GitHub App (manifest, JWT, instalação, OAuth do usuário). `fetchFn` injetável nos testes. */
const API = "https://api.github.com";
const VERSION = "2022-11-28";
const UA = "atlas-agent";

export type FetchFn = typeof fetch;
export type AppApiError = { status: number; message: string };
export type AppApiResult<T> = { data: T; error?: never } | { data?: never; error: AppApiError };

function asRecord(v: unknown): Record<string, unknown> {
	return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

export async function githubAppCall<T>(
	fetchFn: FetchFn,
	url: string,
	init: { method?: string; token?: string; body?: unknown } = {},
): Promise<AppApiResult<T>> {
	let res: Response;
	try {
		res = await fetchFn(url, {
			method: init.method ?? "GET",
			headers: {
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": VERSION,
				"User-Agent": UA,
				...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
				...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
			},
			...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
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
		const message =
			typeof asRecord(json).message === "string" ? (asRecord(json).message as string) : res.statusText || "erro na API do GitHub";
		return { error: { status: res.status, message } };
	}
	return { data: json as T };
}

/** `POST /app-manifests/{code}/conversions` — troca o `code` do manifest pelas credenciais do app. Sem auth. */
export async function convertManifestCode(code: string, fetchFn: FetchFn = fetch): Promise<AppApiResult<ConvertedGithubApp>> {
	const res = await githubAppCall<Record<string, unknown>>(
		fetchFn,
		`${API}/app-manifests/${encodeURIComponent(code)}/conversions`,
		{ method: "POST" },
	);
	if (res.error) return res;
	const d = res.data;
	const owner = asRecord(d.owner);
	if (
		(typeof d.id !== "number" && typeof d.id !== "string") ||
		typeof d.slug !== "string" ||
		typeof d.pem !== "string" ||
		typeof d.webhook_secret !== "string" ||
		typeof d.client_id !== "string" ||
		typeof d.client_secret !== "string"
	) {
		return { error: { status: 502, message: "Resposta inesperada do GitHub ao criar o app" } };
	}
	return {
		data: {
			id: d.id,
			slug: d.slug,
			name: typeof d.name === "string" ? d.name : d.slug,
			html_url: typeof d.html_url === "string" ? d.html_url : undefined,
			client_id: d.client_id,
			client_secret: d.client_secret,
			webhook_secret: d.webhook_secret,
			pem: d.pem,
			owner: { login: typeof owner.login === "string" ? owner.login : undefined },
		},
	};
}

export type AppInstallationInfo = {
	id: string;
	accountLogin: string;
	accountType: string;
	repositorySelection: string;
	suspendedAt: string | null;
};

function mapInstallation(raw: unknown): AppInstallationInfo | null {
	const d = asRecord(raw);
	const account = asRecord(d.account);
	if ((typeof d.id !== "number" && typeof d.id !== "string") || typeof account.login !== "string") return null;
	return {
		id: String(d.id),
		accountLogin: account.login,
		accountType: typeof account.type === "string" ? account.type : "User",
		repositorySelection: d.repository_selection === "all" ? "all" : "selected",
		suspendedAt: typeof d.suspended_at === "string" ? d.suspended_at : null,
	};
}

/** `GET /app/installations/{id}` autenticado como o app (JWT). */
export async function fetchInstallationInfo(
	creds: Pick<GithubAppCredentials, "appId" | "privateKey">,
	installationId: string,
	fetchFn: FetchFn = fetch,
	now?: () => number,
): Promise<AppApiResult<AppInstallationInfo>> {
	const jwt = createGithubAppJwt({ appId: creds.appId, privateKey: creds.privateKey, now });
	const res = await githubAppCall<unknown>(fetchFn, `${API}/app/installations/${encodeURIComponent(installationId)}`, { token: jwt });
	if (res.error) return res;
	const info = mapInstallation(res.data);
	return info ? { data: info } : { error: { status: 502, message: "Resposta inesperada do GitHub" } };
}

/** `GET /app` autenticado como o app (JWT): permissões que o app tem hoje. */
export async function fetchAppPermissions(
	creds: Pick<GithubAppCredentials, "appId" | "privateKey">,
	fetchFn: FetchFn = fetch,
	now?: () => number,
): Promise<AppApiResult<Record<string, string>>> {
	const jwt = createGithubAppJwt({ appId: creds.appId, privateKey: creds.privateKey, now });
	const res = await githubAppCall<Record<string, unknown>>(fetchFn, `${API}/app`, { token: jwt });
	if (res.error) return res;
	const raw = asRecord(res.data.permissions);
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(raw)) if (typeof v === "string") out[k] = v;
	return { data: out };
}

/** `POST /app/installations/{id}/access_tokens` (JWT). `repositories` limita o token a esses repos (nomes sem owner). */
export async function createInstallationAccessToken(
	creds: Pick<GithubAppCredentials, "appId" | "privateKey">,
	installationId: string,
	options: { repositories?: string[]; fetchFn?: FetchFn; now?: () => number } = {},
): Promise<AppApiResult<{ token: string; expiresAt: number }>> {
	const jwt = createGithubAppJwt({ appId: creds.appId, privateKey: creds.privateKey, now: options.now });
	const res = await githubAppCall<Record<string, unknown>>(
		options.fetchFn ?? fetch,
		`${API}/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
		{ method: "POST", token: jwt, body: options.repositories?.length ? { repositories: options.repositories } : {} },
	);
	if (res.error) return res;
	const token = res.data.token;
	const exp = typeof res.data.expires_at === "string" ? Date.parse(res.data.expires_at) : NaN;
	if (typeof token !== "string") return { error: { status: 502, message: "Resposta inesperada do GitHub" } };
	return { data: { token, expiresAt: Number.isFinite(exp) ? exp : (options.now ?? Date.now)() + 55 * 60_000 } };
}

/** `GET /installation/repositories` com token de instalação (até 5 páginas de 100). */
export async function listInstallationRepositories(
	token: string,
	fetchFn: FetchFn = fetch,
): Promise<AppApiResult<Array<{ fullName: string; private: boolean }>>> {
	const out: Array<{ fullName: string; private: boolean }> = [];
	for (let page = 1; page <= 5; page += 1) {
		const res = await githubAppCall<Record<string, unknown>>(fetchFn, `${API}/installation/repositories?per_page=100&page=${page}`, { token });
		if (res.error) return res;
		const rows = Array.isArray(res.data.repositories) ? res.data.repositories : [];
		for (const row of rows) {
			const r = asRecord(row);
			if (typeof r.full_name === "string") out.push({ fullName: r.full_name, private: r.private === true });
		}
		if (rows.length < 100) break;
	}
	return { data: out };
}

/** Troca o `code` do OAuth do app pelo token do usuário (prova de quem instalou). */
export async function exchangeUserOAuthCode(
	input: { clientId: string; clientSecret: string; code: string },
	fetchFn: FetchFn = fetch,
): Promise<AppApiResult<{ accessToken: string }>> {
	let res: Response;
	try {
		res = await fetchFn("https://github.com/login/oauth/access_token", {
			method: "POST",
			headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": UA },
			body: JSON.stringify({ client_id: input.clientId, client_secret: input.clientSecret, code: input.code }),
		});
	} catch (error) {
		return { error: { status: 0, message: error instanceof Error ? error.message : "falha de rede ao chamar o GitHub" } };
	}
	const json = asRecord(await res.json().catch(() => ({})));
	if (!res.ok || typeof json.access_token !== "string") {
		return {
			error: {
				status: res.status || 400,
				message: typeof json.error_description === "string" ? json.error_description : "Autorização recusada pelo GitHub",
			},
		};
	}
	return { data: { accessToken: json.access_token } };
}

/** `GET /user/installations` com o token do usuário: ids das instalações do app que ele acessa. */
export async function listUserInstallationIds(userToken: string, fetchFn: FetchFn = fetch): Promise<AppApiResult<string[]>> {
	const ids: string[] = [];
	for (let page = 1; page <= 5; page += 1) {
		const res = await githubAppCall<Record<string, unknown>>(fetchFn, `${API}/user/installations?per_page=100&page=${page}`, {
			token: userToken,
		});
		if (res.error) return res;
		const rows = Array.isArray(res.data.installations) ? res.data.installations : [];
		for (const row of rows) {
			const id = asRecord(row).id;
			if (typeof id === "number" || typeof id === "string") ids.push(String(id));
		}
		if (rows.length < 100) break;
	}
	return { data: ids };
}
