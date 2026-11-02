export type ServerProviders = { google: boolean; github: boolean };

export type ServerCheckResult = { ok: true; providers: ServerProviders } | { ok: false; error: string };

export const SERVER_CHECK_ERRORS = {
	timeout: "O servidor demorou demais para responder. Confira o endereço e a sua conexão.",
	network: "Não consegui falar com o servidor. Confira o endereço e a sua conexão.",
	notAtlas: "O endereço respondeu, mas não parece ser um servidor Atlas.",
} as const;

export type ServerCheckOptions = {
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
};

/** O `GET /api/auth/providers` do Atlas devolve `{ google: boolean, github: boolean }`. */
function parseProviders(body: unknown): ServerProviders | null {
	if (typeof body !== "object" || body === null) return null;
	const { google, github } = body as Record<string, unknown>;
	if (typeof google !== "boolean" || typeof github !== "boolean") return null;
	return { google, github };
}

/** Confere se `baseUrl` (já normalizada) responde como um servidor Atlas. Nunca lança. */
export async function checkServer(baseUrl: string, options: ServerCheckOptions = {}): Promise<ServerCheckResult> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000);
	try {
		const response = await fetchImpl(`${baseUrl}/api/auth/providers`, {
			signal: controller.signal,
			headers: { accept: "application/json" },
		});
		if (!response.ok) return { ok: false, error: SERVER_CHECK_ERRORS.notAtlas };
		const providers = parseProviders(await response.json().catch(() => null));
		if (!providers) return { ok: false, error: SERVER_CHECK_ERRORS.notAtlas };
		return { ok: true, providers };
	} catch (error) {
		const aborted = controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
		return { ok: false, error: aborted ? SERVER_CHECK_ERRORS.timeout : SERVER_CHECK_ERRORS.network };
	} finally {
		clearTimeout(timer);
	}
}
