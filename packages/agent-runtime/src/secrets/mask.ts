import { createRedactor } from "./redact.js";
import { getVaultService, type VaultService } from "./vault-service.js";

/**
 * Mensagem recebida do usuário: troca valores de segredos já conhecidos (rotinas e
 * itens do cofre, literal/URL-encoded/base64) pelo marcador antes de persistir ou
 * enviar ao modelo. Nunca lança: sem cofre/chave devolve o texto como veio.
 */
export async function maskKnownSecrets(userId: string, text: string, vault: VaultService = getVaultService()): Promise<{ text: string; masked: boolean }> {
	if (!text || !userId) return { text, masked: false };
	try {
		const entries = await vault.redactionEntries(userId);
		if (entries.length === 0) return { text, masked: false };
		const out = createRedactor(entries).text(text);
		return { text: out, masked: out !== text };
	} catch {
		return { text, masked: false };
	}
}

/** Mascara as mensagens do usuário de uma lista (carrega os segredos do dono uma vez). */
export async function maskKnownSecretsInMessages<T extends { role: string; content: string }>(
	userId: string,
	messages: readonly T[],
	vault: VaultService = getVaultService(),
): Promise<T[]> {
	if (!userId || !messages.some((message) => message.role === "user")) return [...messages];
	try {
		const entries = await vault.redactionEntries(userId);
		if (entries.length === 0) return [...messages];
		const redactor = createRedactor(entries);
		return messages.map((message) => (message.role === "user" ? { ...message, content: redactor.text(message.content) } : message));
	} catch {
		return [...messages];
	}
}
