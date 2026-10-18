import { createHmac } from "node:crypto";

// Aviso (fire-and-forget) à API quando um job em segundo plano termina. Sem saída no corpo: a API
// consulta o container. Autentica com HMAC-SHA256 do DEV_SANDBOX_TOKEN (o token nunca trafega):
//   assinatura = HMAC(token, `${timestamp}.${sessionId}.${corpo}`)
// Mantenha em sincronia com packages/sandbox/src/dev/callback.ts.

export const CALLBACK_RETRY_DELAYS_MS = [500, 1_500, 4_000];
const CALLBACK_TIMEOUT_MS = 5_000;

export function signCallback(token, sessionId, timestamp, body) {
	return createHmac("sha256", token).update(`${timestamp}.${sessionId}.${body}`).digest("hex");
}

/** Devolve `notify(event)` (nunca lança, nunca bloqueia) ou null sem URL/token/sessão configurados. */
export function createJobCallback({ url, token, sessionId, fetch: fetchFn = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, delays = CALLBACK_RETRY_DELAYS_MS } = {}) {
	if (!url || !token || !sessionId || typeof fetchFn !== "function") return null;
	async function send(event) {
		const body = JSON.stringify({ sessionId, jobId: event.jobId, status: event.status, exitCode: event.exitCode ?? null, durationMs: event.durationMs, endedAt: event.endedAt });
		for (let attempt = 0; attempt <= delays.length; attempt += 1) {
			try {
				const timestamp = String(Math.floor(now() / 1000));
				const res = await fetchFn(url, {
					method: "POST",
					headers: { "Content-Type": "application/json", "X-Atlas-Timestamp": timestamp, "X-Atlas-Signature": `sha256=${signCallback(token, sessionId, timestamp, body)}` },
					body,
					signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
				});
				if (res.ok) return true;
				if (res.status >= 400 && res.status < 500 && res.status !== 429) return false; // recusado: repetir não adianta
			} catch {
				// rede indisponível: tenta de novo
			}
			if (attempt < delays.length) await sleep(delays[attempt]);
		}
		return false;
	}
	return (event) => {
		void send(event).catch(() => undefined);
	};
}
