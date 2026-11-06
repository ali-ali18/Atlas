// Porta `Vault`: cofre de segredos.
// REGRA: o segredo é resolvido por HANDLE na camada de execução (ex.: preencher
// login) e NUNCA volta para a camada do modelo. O modelo vê só o handle e um
// rótulo; contexto, eventos, journal e mensagens não podem conter o valor.

export type SecretHandle = { id: string; label: string };

/** Valor resolvido: usar só dentro do executor e descartar. */
export type SecretValue = { reveal(): string };

export interface Vault {
	/** O que o modelo pode ver: handles e rótulos, nunca valores. */
	listHandles(userId: string): Promise<SecretHandle[]>;
	/** Só a camada de execução chama; `null` se o handle não é do dono. */
	resolve(userId: string, handleId: string): Promise<SecretValue | null>;
}
