// Fakes do cofre para teste: itens por DONO (outro dono não lista nem resolve), pedidos de segredo registrados e uma VM que
// "digita" o login lendo o valor como o tratador do worker faz (para provar que o valor só passa worker → VM).
import { sealSecretValue } from "../adapters/vault.js";
import type { SecretHandle, SecretRequest, SecretRequests, SecretValue, Vault } from "../ports/vault.js";

export const TEST_SECRET_VALUE = "sk_live_TESTE_nao_vaze_9f3a";
export const TEST_LOGIN_PASSWORD = "Senha!Teste#Forte-4821";

export type FakeVaultItem = { owner: string; id: string; label?: string; description?: string } & (
	| { kind: "secret"; value: string }
	| { kind: "login"; password: string; site?: string; username?: string }
);

export class FakeVault implements Vault {
	readonly resolved: Array<{ userId: string; handleId: string }> = [];
	constructor(readonly items: FakeVaultItem[] = []) {}
	async listHandles(userId: string): Promise<SecretHandle[]> {
		return this.items
			.filter((item) => item.owner === userId)
			.map((item) => ({
				id: item.id,
				label: item.label ?? item.id,
				kind: item.kind,
				...(item.description && { description: item.description }),
				...(item.kind === "login" && item.site && { site: item.site }),
				...(item.kind === "login" && item.username && { username: item.username }),
			}));
	}
	async resolve(userId: string, handleId: string): Promise<SecretValue | null> {
		this.resolved.push({ userId, handleId });
		const item = this.items.find((i) => i.owner === userId && i.id === handleId);
		return item?.kind === "secret" ? sealSecretValue(item.value) : null;
	}
}

export class FakeSecretRequests implements SecretRequests {
	readonly asks: Array<{ userId: string; runId: string; request: SecretRequest }> = [];
	failWith: string | null = null;
	async ask(userId: string, runId: string, request: SecretRequest): Promise<void> {
		if (this.failWith) throw new Error(this.failWith);
		this.asks.push({ userId, runId, request });
	}
}
