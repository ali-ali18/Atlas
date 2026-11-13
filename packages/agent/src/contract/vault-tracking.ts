// Rastreia os valores que o cofre entregou à camada de execução durante UM run, para que o executor
// os redija mesmo quando não têm formato de token conhecido (senha comum, chave sem prefixo).
//
// O valor nunca sai daqui para o modelo, evento, journal ou checkpoint: o conjunto vive só na memória
// do processo e só `secrets()` (do executor) o lê, para trocar o valor por `[redacted]`. Numa retomada
// em outro processo o conjunto recomeça vazio, o que é seguro: tudo que foi produzido antes já passou
// pelo executor e foi persistido redigido.
import type { SecretValue, Vault } from "../ports/vault.js";

export type TrackedVault = {
	/** Cofre para entregar às tools: igual ao original, mas cada valor resolvido entra no conjunto. */
	vault: Vault;
	/** Valores vistos até agora (vazios ignorados). Passar a `createExecutor({ secrets })`. */
	secrets: () => readonly string[];
};

export function trackVault(inner: Vault): TrackedVault {
	const seen = new Set<string>();
	const remember = (value: string) => {
		if (value) seen.add(value);
	};
	const vault: Vault = {
		listHandles: (userId) => inner.listHandles(userId),
		async resolve(userId, handleId) {
			const resolved = await inner.resolve(userId, handleId);
			if (!resolved) return null;
			// Registra já na resolução (antes de a tool usar o valor) e de novo a cada `reveal`, caso o cofre o gire.
			remember(resolved.reveal());
			const tracked: SecretValue = {
				reveal() {
					const value = resolved.reveal();
					remember(value);
					return value;
				},
			};
			return tracked;
		},
	};
	return { vault, secrets: () => [...seen] };
}
