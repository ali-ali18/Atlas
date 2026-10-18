import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readConnectorKey } from "../../secrets/secret-box.js";

/**
 * `state` assinado (HMAC-SHA256) das voltas do GitHub: guarda o usuário e o propósito,
 * expira rápido e quebra com qualquer alteração. A chave é derivada de CONNECTOR_ENCRYPTION_KEY.
 */
export type GithubAppStatePurpose = "install" | "manifest";
export type GithubAppState = { userId: string; purpose: GithubAppStatePurpose };

export const GITHUB_APP_STATE_TTL_MS = 10 * 60_000;

function signingKey(key?: Buffer | null): Buffer {
	const base = key ?? readConnectorKey();
	if (!base) throw new Error("CONNECTOR_ENCRYPTION_KEY ausente ou inválida");
	return createHmac("sha256", base).update("github-app-state-v1").digest();
}

export function signGithubAppState(
	input: GithubAppState & { ttlMs?: number; now?: () => number; key?: Buffer | null },
): string {
	const now = (input.now ?? Date.now)();
	const body = Buffer.from(
		JSON.stringify({
			u: input.userId,
			p: input.purpose,
			n: randomBytes(8).toString("hex"),
			e: now + (input.ttlMs ?? GITHUB_APP_STATE_TTL_MS),
		}),
	).toString("base64url");
	const sig = createHmac("sha256", signingKey(input.key)).update(body).digest("base64url");
	return `${body}.${sig}`;
}

export function verifyGithubAppState(
	state: string | undefined | null,
	options: { purpose: GithubAppStatePurpose; now?: () => number; key?: Buffer | null },
): GithubAppState | null {
	if (!state || typeof state !== "string" || state.length > 1024) return null;
	const [body, sig, ...rest] = state.split(".");
	if (!body || !sig || rest.length > 0) return null;
	let expected: Buffer;
	try {
		expected = createHmac("sha256", signingKey(options.key)).update(body).digest();
	} catch {
		return null;
	}
	const got = Buffer.from(sig, "base64url");
	if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
	try {
		const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
		if (typeof data.u !== "string" || !data.u) return null;
		if (data.p !== options.purpose) return null;
		if (typeof data.e !== "number" || (options.now ?? Date.now)() > data.e) return null;
		return { userId: data.u, purpose: options.purpose };
	} catch {
		return null;
	}
}
