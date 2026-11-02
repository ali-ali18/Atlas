/**
 * Teto de códigos de entrada por e-mail de destino, somado a todos os IPs. O rate limit do better-auth conta por IP
 * (3 por minuto); sem este teto, quem troca de IP continuaria enchendo a caixa do dono de códigos.
 *
 * Fica em memória do processo: com várias instâncias da api o teto vale por instância (o total pode chegar a
 * `max` x instâncias) e reiniciar o processo zera a conta. Aceitável para o objetivo (conter abuso de e-mail, não
 * contabilidade exata); migrar para o Redis se virar problema. Função com `now` injetado, testada.
 */
export type EmailCodeLimiter = { allow: (email: string) => boolean };

export const EMAIL_CODE_LIMIT_MAX = 5;
export const EMAIL_CODE_LIMIT_WINDOW_MS = 15 * 60_000;
const MAX_TRACKED = 1000;

export function createEmailCodeLimiter(
	options: { max?: number; windowMs?: number; now?: () => number } = {},
): EmailCodeLimiter {
	const max = options.max ?? EMAIL_CODE_LIMIT_MAX;
	const windowMs = options.windowMs ?? EMAIL_CODE_LIMIT_WINDOW_MS;
	const now = options.now ?? Date.now;
	const hits = new Map<string, number[]>();
	return {
		allow(email) {
			const key = email.trim().toLowerCase();
			const t = now();
			const recent = (hits.get(key) ?? []).filter((at) => t - at < windowMs);
			if (recent.length >= max) {
				hits.set(key, recent);
				return false;
			}
			recent.push(t);
			hits.set(key, recent);
			// Só o e-mail do dono chega aqui, mas o mapa tem teto por garantia.
			if (hits.size > MAX_TRACKED) {
				for (const [k, list] of hits) if (list.every((at) => t - at >= windowMs)) hits.delete(k);
			}
			return true;
		},
	};
}
