import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Aviso de fim de job (container -> API). Assinatura HMAC-SHA256 com o DEV_SANDBOX_TOKEN da sessão
 * (o token nunca trafega): `HMAC(token, "${timestamp}.${sessionId}.${corpo}")`. O sessionId faz parte do
 * que é assinado e cada container tem token próprio, então uma assinatura não vale para outra sessão.
 * Manter em sincronia com docker/dev-sandbox/server/job-callback.mjs.
 */

export const CALLBACK_MAX_SKEW_MS = 5 * 60_000;

export function signDevCallback(token: string, sessionId: string, timestamp: string, body: string): string {
	return createHmac("sha256", token).update(`${timestamp}.${sessionId}.${body}`).digest("hex");
}

export type VerifyCallbackInput = {
	token: string;
	sessionId: string;
	timestamp: string | undefined;
	/** Cabeçalho `X-Atlas-Signature` (`sha256=<hex>`). */
	signature: string | undefined;
	body: string;
	now?: number;
};

export function verifyDevCallback(input: VerifyCallbackInput): boolean {
	const { token, sessionId, timestamp, signature, body } = input;
	if (!token || !timestamp || !signature?.startsWith("sha256=")) return false;
	const seconds = Number(timestamp);
	if (!Number.isFinite(seconds)) return false;
	if (Math.abs((input.now ?? Date.now()) - seconds * 1000) > CALLBACK_MAX_SKEW_MS) return false;
	const expected = Buffer.from(signDevCallback(token, sessionId, timestamp, body), "hex");
	const given = Buffer.from(signature.slice(7), "hex");
	return given.length === expected.length && timingSafeEqual(given, expected);
}
