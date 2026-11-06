import type { ModelChainEntry, RoleChains } from "@workspace/shared";

/**
 * Cadeia por papel com a MESMA entrada em todos os papéis (o modelo do run). O literal é conferido pelo compilador
 * contra `RoleChains`: um papel novo em `MODEL_ROLES` quebra o `tsc` aqui, em vez de passar por um `as unknown as`
 * nos chamadores (auditoria F1, A3).
 */
export function chainsForAllRoles(entry: ModelChainEntry): RoleChains {
	const chain = (): ModelChainEntry[] => [{ ...entry }];
	return { main: chain(), helper: chain(), code: chain(), vision: chain(), sleep: chain(), classifier: chain() };
}
