import { DETECT_TEXT_FILES, normalizeEnvRepo, type RepoProbe } from "@workspace/shared";

const API = "https://api.github.com";
const FILE_TIMEOUT_MS = 3000;
const MAX_FILE_BYTES = 200_000;

export type ProbeResult = { probe: RepoProbe } | { reason: "invalid_repo" | "no_access" | "not_found" | "unavailable" };

type FetchFn = typeof fetch;

function headers(token: string, raw: boolean): Record<string, string> {
	return {
		Authorization: `Bearer ${token}`,
		Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		"User-Agent": "atlas-agent",
	};
}

/** Lê a raiz do repositório e poucos arquivos de texto (somente leitura, sem clone). */
export async function probeRepo(token: string, repoInput: string, fetchFn: FetchFn = fetch): Promise<ProbeResult> {
	const repo = normalizeEnvRepo(repoInput);
	if (!repo) return { reason: "invalid_repo" };
	const base = `${API}/repos/${repo}/contents`;
	let rootRes: Response;
	try {
		rootRes = await fetchFn(`${base}/`, { headers: headers(token, false), signal: AbortSignal.timeout(FILE_TIMEOUT_MS) });
	} catch {
		return { reason: "unavailable" };
	}
	if (rootRes.status === 401 || rootRes.status === 403) return { reason: "no_access" };
	if (rootRes.status === 404) return { reason: "not_found" };
	if (!rootRes.ok) return { reason: "unavailable" };
	const listing: unknown = await rootRes.json().catch(() => null);
	if (!Array.isArray(listing)) return { reason: "unavailable" };
	const rootFiles = listing.map((item) => (item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string" ? (item as { name: string }).name : "")).filter(Boolean);
	const wanted = DETECT_TEXT_FILES.filter((name) => rootFiles.includes(name));
	const texts: Record<string, string | undefined> = {};
	await Promise.all(
		wanted.map(async (name) => {
			try {
				const res = await fetchFn(`${base}/${name}`, { headers: headers(token, true), signal: AbortSignal.timeout(FILE_TIMEOUT_MS) });
				if (!res.ok) return;
				const length = Number(res.headers.get("content-length") ?? "0");
				if (length > MAX_FILE_BYTES) return;
				const text = await res.text();
				if (text.length <= MAX_FILE_BYTES) texts[name] = text;
			} catch {
				// tempo esgotado ou falha: segue sem esse arquivo
			}
		}),
	);
	return { probe: { rootFiles, texts } };
}
