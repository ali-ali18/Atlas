// Adaptador da porta `Vault` (F1.12) sobre o serviço de cofre do legado, que chega por INJEÇÃO (o worker liga o
// `VaultService`; este pacote não importa o agent-runtime). Regra do cofre: o valor só sai de `resolve`, dentro de um
// `SecretValue` que não vira texto por acidente (JSON, console, template string): só `reveal()` entrega o segredo.
import { inspect } from "node:util";
import type { SecretHandle, SecretValue, Vault } from "../ports/vault.js";

export type VaultBackend = {
	/** Handles e rótulos do dono (nunca valores). */
	listHandles(userId: string): Promise<readonly SecretHandle[]>;
	/** Valor do segredo do dono ou `null` se o handle não existe / não é dele. */
	resolveSecret(userId: string, handleId: string): Promise<string | null>;
};

class SealedSecret implements SecretValue {
	readonly #value: string;
	constructor(value: string) {
		this.#value = value;
	}
	reveal(): string {
		return this.#value;
	}
	toJSON(): string {
		return "[redacted]";
	}
	toString(): string {
		return "[redacted]";
	}
	[inspect.custom](): string {
		return "SecretValue([redacted])";
	}
}

export function createVaultAdapter(backend: VaultBackend): Vault {
	return {
		async listHandles(userId) {
			// Só id e rótulo: um backend que devolva campos a mais não vaza nada para o modelo.
			return (await backend.listHandles(userId)).map(({ id, label }) => ({ id, label }));
		},
		async resolve(userId, handleId) {
			const value = await backend.resolveSecret(userId, handleId);
			return value === null ? null : new SealedSecret(value);
		},
	};
}
