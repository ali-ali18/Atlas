import type { DevEndpoint } from "./provider.js";

/** Cliente HTTP do servidor dentro do container (docker/dev-sandbox/server). */

export class DevSandboxError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "DevSandboxError";
	}
}

export type DevExecStartInput = {
	cmd: string;
	cwd?: string;
	env?: Record<string, string>;
	timeoutMs?: number;
	/** Se já há um job rodando com o mesmo comando/diretório, devolve o dele (`deduped`) em vez de iniciar outro. */
	dedupe?: boolean;
};

export type DevExecSnapshot = {
	id: string;
	status: string;
	running: boolean;
	exitCode: number | null;
	signal: string | null;
	timedOut: boolean;
	stdout: string;
	stderr: string;
	nextOut: number;
	nextErr: number;
	truncated: boolean;
	omittedBytes: number;
	durationMs: number;
	cwd: string;
	/** Com `until` no poll: a saída nova casou com a condição. */
	matched?: boolean;
	/** Caminho (dentro do container) com a saída completa do job, quando ela passou do limite inline. */
	spillPath?: string;
};

export type DevReadResult = {
	path: string;
	kind: "text" | "binary";
	size: number;
	content: string;
	totalLines: number;
	startLine?: number;
	endLine?: number;
	nextOffset: number | null;
	truncated: boolean;
	note?: string;
};

export type DevWriteResult = { path: string; created: boolean; bytes: number; diff: string; added: number; removed: number };
export type DevPatchResult = { path: string; diff: string; added: number; removed: number };
export type DevListResult = {
	path: string;
	entries: Array<{ path: string; type: "file" | "dir" | "link"; size: number }>;
	total: number;
	truncated: boolean;
};
export type DevGrepResult = { matches: string; count: number; totalFound: number; truncated: boolean };

/** Política de internet do container: `full` sem proxy, `allowlist` só os domínios, `off` nada. */
export type DevEgressPolicy = { mode: "full" | "allowlist" | "off"; allowlist: string[] };

export type DevClient = ReturnType<typeof createDevClient>;

export function createDevClient(endpoint: DevEndpoint, options: { fetchFn?: typeof fetch; signal?: AbortSignal } = {}) {
	const doFetch = options.fetchFn ?? fetch;

	async function call<T>(method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
		const signals = [AbortSignal.timeout(timeoutMs), ...(options.signal ? [options.signal] : [])];
		let response: Response;
		try {
			response = await doFetch(`${endpoint.baseUrl}${path}`, {
				method,
				headers: {
					Authorization: `Bearer ${endpoint.token}`,
					...(body !== undefined ? { "Content-Type": "application/json" } : {}),
				},
				body: body !== undefined ? JSON.stringify(body) : undefined,
				signal: AbortSignal.any(signals),
			});
		} catch (error) {
			throw new DevSandboxError(
				`Ambiente de desenvolvimento inacessível: ${error instanceof Error ? error.message : String(error)}`,
				503,
			);
		}
		const text = await response.text();
		let data: unknown = {};
		try {
			data = text ? JSON.parse(text) : {};
		} catch {
			// corpo não JSON: cai no erro abaixo se !ok
		}
		if (!response.ok) {
			const message = typeof (data as { error?: unknown }).error === "string" ? (data as { error: string }).error : `HTTP ${response.status}`;
			throw new DevSandboxError(message, response.status);
		}
		return data as T;
	}

	const qs = (params: Record<string, string | number | undefined>) => {
		const search = new URLSearchParams();
		for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, String(value));
		const text = search.toString();
		return text ? `?${text}` : "";
	};

	return {
		health: () => call<{ ok: boolean; runningJobs: number }>("GET", "/health", undefined, 5_000),
		execStart: (input: DevExecStartInput) => call<{ id: string; deduped?: boolean; durationMs?: number }>("POST", "/exec", { ...input, background: true }),
		execPoll: (id: string, input: { out?: number; err?: number; waitMs?: number; until?: string } = {}) =>
			call<DevExecSnapshot>("GET", `/exec/${id}${qs(input)}`, undefined, (input.waitMs ?? 0) + 15_000),
		execStdin: (id: string, input: { data?: string; end?: boolean }) => call<{ ok: boolean }>("POST", `/exec/${id}/stdin`, input),
		execKill: (id: string, signal: "SIGTERM" | "SIGKILL" = "SIGTERM") => call<{ ok: boolean }>("POST", `/exec/${id}/kill`, { signal }),
		readFile: (input: { path: string; offset?: number; limit?: number }) => call<DevReadResult>("GET", `/files${qs(input)}`),
		writeFile: (input: { path: string; content: string; encoding?: "base64" }) => call<DevWriteResult>("PUT", "/files", input),
		patchFile: (input: { path: string; old: string; new: string; replaceAll?: boolean }) =>
			call<DevPatchResult>("POST", "/files/patch", input),
		list: (input: { path?: string; depth?: number }) => call<DevListResult>("GET", `/files/list${qs(input)}`),
		getEgress: () => call<DevEgressPolicy>("GET", "/egress", undefined, 5_000),
		setEgress: (policy: DevEgressPolicy) => call<DevEgressPolicy>("PUT", "/egress", policy, 10_000),
		grep: (input: { pattern: string; path?: string; glob?: string; ignoreCase?: boolean; fixed?: boolean; maxResults?: number }) =>
			call<DevGrepResult>("POST", "/grep", input, 30_000),
	};
}
