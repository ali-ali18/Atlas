// Lógica pura da página local (splash/offline). Sem DOM aqui: o boot.ts liga isto à tela.
// O núcleo Rust abre index.html?target=<ATLAS_URL>&settings=<caminho do settings.json>.

export interface BootParams {
	/** URL do Atlas a abrir (só http/https). null = parâmetro ausente ou inválido. */
	target: string | null;
	/** Caminho do settings.json, só para mostrar ao usuário. */
	settingsPath: string | null;
}

const MAX_PARAM_LENGTH = 2048;

export function parseBootParams(search: string): BootParams {
	const params = new URLSearchParams(search);
	return {
		target: sanitizeTarget(params.get("target")),
		settingsPath: sanitizeText(params.get("settings")),
	};
}

function sanitizeTarget(raw: string | null): string | null {
	if (!raw || raw.length > MAX_PARAM_LENGTH) return null;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return null;
	if (url.username || url.password) return null;
	return url.toString();
}

function sanitizeText(raw: string | null): string | null {
	if (!raw) return null;
	const trimmed = raw.trim();
	if (!trimmed || trimmed.length > MAX_PARAM_LENGTH) return null;
	return trimmed;
}

export type ProbeResult = { ok: true } | { ok: false; reason: "timeout" | "network" };

export type ProbeFetch = (input: string, init: RequestInit) => Promise<unknown>;

/**
 * Confere se o Atlas responde. `no-cors` devolve resposta opaca: qualquer resposta HTTP conta como
 * "no ar" (o próprio Atlas mostra os erros dele); só falha de rede ou tempo esgotado contam como offline.
 */
export async function probe(target: string, fetchFn: ProbeFetch, timeoutMs: number): Promise<ProbeResult> {
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	try {
		await fetchFn(target, { mode: "no-cors", cache: "no-store", signal: controller.signal });
		return { ok: true };
	} catch {
		return { ok: false, reason: timedOut ? "timeout" : "network" };
	} finally {
		clearTimeout(timer);
	}
}

/** Espera antes da próxima tentativa automática: 5s, 10s, 20s… até 60s. */
export function retryDelayMs(attempt: number): number {
	const safe = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
	return Math.min(5_000 * 2 ** Math.min(safe, 4), 60_000);
}

export function offlineMessage(reason: "timeout" | "network" | "invalid-url"): string {
	switch (reason) {
		case "timeout":
			return "O Atlas demorou demais para responder.";
		case "network":
			return "Não conseguimos falar com o Atlas. Verifique sua conexão com a internet.";
		case "invalid-url":
			return "O endereço do Atlas configurado é inválido.";
	}
}
