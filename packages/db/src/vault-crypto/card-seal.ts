// Selo dos segredos de pagamento (F6.2/F6.3) com a MESMA caixa dos conectores (`secretsEnc`, AES-256-GCM com
// CONNECTOR_ENCRYPTION_KEY). Sem chave válida nada é gravado (nunca em claro).
import type { SavedCardSecrets } from "@workspace/shared";
import { isSecretBoxConfigured, openSecrets, sealSecrets } from "./secret-box.js";

/** O cofre de cartões está pronto (chave do servidor configurada)? */
export const isCardVaultConfigured = (env: NodeJS.ProcessEnv = process.env): boolean => isSecretBoxConfigured(env);

/** Sela número, nome, validade e endereço de cobrança. Lança se a chave do servidor falta. */
export function sealCardSecrets(secrets: SavedCardSecrets, key?: Buffer | null): string {
	return sealSecrets({ card: secrets }, key);
}

/** Abre o texto selado e devolve o JSON de `SavedCardSecrets` (a porta `CardVault` o embrulha num `SecretValue`). */
export function openCardSecretsJson(sealed: string, key?: Buffer | null): string {
	const opened = openSecrets<{ card?: SavedCardSecrets }>(sealed, key);
	if (!opened.card) throw new Error("saved card payload is malformed");
	return JSON.stringify(opened.card);
}

/** Caixa do canal efêmero do CVV (estrutura da porta `EscrowSealer`, sem importar o motor). */
export function connectorEscrowSealer(key?: Buffer | null): { seal(plain: string): string; open(sealed: string): string | null } {
	return {
		seal: (plain) => sealSecrets({ v: plain }, key),
		open(sealed) {
			try {
				const opened = openSecrets<{ v?: unknown }>(sealed, key);
				return typeof opened.v === "string" ? opened.v : null;
			} catch {
				return null;
			}
		},
	};
}
