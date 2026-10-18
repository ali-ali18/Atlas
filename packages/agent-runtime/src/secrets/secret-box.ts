import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export class SecretBoxError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SecretBoxError";
	}
}

const VERSION = "v1";
const KEY_BYTES = 32;
const IV_BYTES = 12;

export function readConnectorKey(
	env: NodeJS.ProcessEnv = process.env,
): Buffer | null {
	const raw = (env.CONNECTOR_ENCRYPTION_KEY ?? "")
		.trim()
		.replace(/^["']|["']$/g, "");
	if (!raw) return null;
	const key = Buffer.from(raw, "base64");
	return key.length === KEY_BYTES ? key : null;
}

export function isSecretBoxConfigured(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return readConnectorKey(env) !== null;
}

function requireKey(key?: Buffer | null): Buffer {
	const resolved = key ?? readConnectorKey();
	if (!resolved) {
		throw new SecretBoxError(
			"CONNECTOR_ENCRYPTION_KEY ausente ou inválida (esperado 32 bytes em base64)",
		);
	}
	return resolved;
}

/**
 * Genérico o bastante pra selar qualquer segredo pequeno (não só MCP) — ex.:
 * webhook secret/token de gatilhos (routine-github). Default `McpConnectorSecrets`
 * preserva a inferência dos call sites existentes sem precisar de `<T>` explícito.
 */
export function sealSecrets<T extends object = Record<string, unknown>>(
	secrets: T,
	key?: Buffer | null,
): string {
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv("aes-256-gcm", requireKey(key), iv);
	const ciphertext = Buffer.concat([
		cipher.update(JSON.stringify(secrets), "utf8"),
		cipher.final(),
	]);
	return [
		VERSION,
		iv.toString("base64"),
		cipher.getAuthTag().toString("base64"),
		ciphertext.toString("base64"),
	].join(":");
}

export function openSecrets<T extends object = Record<string, unknown>>(
	sealed: string | null | undefined,
	key?: Buffer | null,
): T {
	if (!sealed) return {} as T;
	const [version, iv, tag, ciphertext] = sealed.split(":");
	if (version !== VERSION || !iv || !tag || !ciphertext) {
		throw new SecretBoxError("segredo em formato desconhecido");
	}
	try {
		const decipher = createDecipheriv(
			"aes-256-gcm",
			requireKey(key),
			Buffer.from(iv, "base64"),
		);
		decipher.setAuthTag(Buffer.from(tag, "base64"));
		const plain = Buffer.concat([
			decipher.update(Buffer.from(ciphertext, "base64")),
			decipher.final(),
		]).toString("utf8");
		const parsed = JSON.parse(plain) as unknown;
		return parsed && typeof parsed === "object" ? (parsed as T) : ({} as T);
	} catch (error) {
		if (error instanceof SecretBoxError) throw error;
		throw new SecretBoxError(
			"não foi possível abrir o segredo (chave trocada?)",
		);
	}
}
