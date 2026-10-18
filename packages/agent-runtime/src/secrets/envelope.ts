import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { openSecrets, readConnectorKey, sealSecrets, SecretBoxError } from "./secret-box.js";

/**
 * Cifragem em envelope do cofre do usuário.
 *  - chave mestra do servidor (CONNECTOR_ENCRYPTION_KEY) só embrulha a chave de dados do usuário;
 *  - cada usuário tem uma chave de dados AES-256 aleatória;
 *  - cada item é cifrado com a chave do usuário (AES-256-GCM) com AAD `userId:itemId`,
 *    então um item copiado para outro dono/linha não abre.
 * Rotação da mestra: `CONNECTOR_ENCRYPTION_KEY_PREVIOUS` abre chaves antigas; `rewrapDataKey` reembrulha
 * só a chave do usuário (os itens não são recifrados). Apagar a chave do usuário torna tudo ilegível.
 */

const ITEM_VERSION = "v2";
const IV_BYTES = 12;

export function readPreviousConnectorKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
	return readConnectorKey({ CONNECTOR_ENCRYPTION_KEY: env.CONNECTOR_ENCRYPTION_KEY_PREVIOUS });
}

export function newDataKey(): Buffer {
	return randomBytes(32);
}

export function wrapDataKey(dataKey: Buffer, master?: Buffer | null): string {
	return sealSecrets({ k: dataKey.toString("base64") }, master);
}

export function unwrapDataKey(wrapped: string, master?: Buffer | null): Buffer {
	const attempts = [master ?? readConnectorKey(), readPreviousConnectorKey()].filter((key): key is Buffer => key !== null);
	if (attempts.length === 0) throw new SecretBoxError("CONNECTOR_ENCRYPTION_KEY ausente ou inválida (esperado 32 bytes em base64)");
	let last: unknown;
	for (const key of attempts) {
		try {
			const opened = openSecrets<{ k?: string }>(wrapped, key);
			const raw = Buffer.from(opened.k ?? "", "base64");
			if (raw.length === 32) return raw;
		} catch (error) {
			last = error;
		}
	}
	throw last instanceof Error ? last : new SecretBoxError("chave do cofre inválida");
}

/** Reembrulha com a chave mestra atual (após trocar CONNECTOR_ENCRYPTION_KEY). */
export function rewrapDataKey(wrapped: string): string {
	return wrapDataKey(unwrapDataKey(wrapped));
}

export function itemAad(userId: string, itemId: string): Buffer {
	return Buffer.from(`${userId}:${itemId}`, "utf8");
}

export function sealItem(dataKey: Buffer, aad: Buffer, payload: object): string {
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv("aes-256-gcm", dataKey, iv);
	cipher.setAAD(aad);
	const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
	return [ITEM_VERSION, iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(":");
}

export function openItem<T extends object>(dataKey: Buffer, aad: Buffer, sealed: string): T {
	const [version, iv, tag, ciphertext] = sealed.split(":");
	if (version !== ITEM_VERSION || !iv || !tag || !ciphertext) throw new SecretBoxError("segredo em formato desconhecido");
	try {
		const decipher = createDecipheriv("aes-256-gcm", dataKey, Buffer.from(iv, "base64"));
		decipher.setAAD(aad);
		decipher.setAuthTag(Buffer.from(tag, "base64"));
		const plain = Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
		return JSON.parse(plain) as T;
	} catch {
		throw new SecretBoxError("não foi possível abrir o segredo (chave ou dono diferente)");
	}
}
