import type { Random } from "../ports/random.js";

// Nonce por run: prova de que um bloco `<atlas:runtime id="…">` veio do sistema.
// 16 bytes em hex minúsculo (128 bits): só [0-9a-f], seguro dentro de atributo/tag.

export type RunNonce = string & { readonly __brand: "RunNonce" };

const NONCE_BYTES = 16;
const NONCE_FORMAT = /^[0-9a-f]{32}$/;

export function createRunNonce(random: Random): RunNonce {
	const bytes = random.bytes(NONCE_BYTES);
	if (bytes.length !== NONCE_BYTES) throw new Error(`Random.bytes(${NONCE_BYTES}) devolveu ${bytes.length} bytes`);
	let hex = "";
	for (const b of bytes) hex += b.toString(16).padStart(2, "0");
	return hex as RunNonce;
}

/** Validação de formato (determinística; não é decisão de comportamento sobre texto livre). */
export function isRunNonce(value: unknown): value is RunNonce {
	return typeof value === "string" && NONCE_FORMAT.test(value);
}
