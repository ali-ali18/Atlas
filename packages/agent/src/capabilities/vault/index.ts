// Capacidade lazy `vault` (F9): o cofre de segredos do dono. O modelo só vê NOMES; o valor entra pela camada de execução
// (`{{secret:NOME}}` no executor, `login_fill` na VM) e nunca volta. Uma tool por arquivo.
//  - `secret_list`    leitura privada dos nomes (sempre);
//  - `secret_request` pede ao dono que cadastre o que falta (segredo simples, ou os CAMPOS de um login que o modelo declarou; precisa do dono);
//  - `login_fill`     digita campos do login de um site na VM, pelo mapeamento chave -> ref (efeito `credential`, aprovação a cada uso; precisa do dono).
// Sem dono (rotina, agenda, subagente) só entra `secret_list` (`readOnly`).
import type { SecretRequests, Vault } from "../../ports/vault.js";
import type { Tool } from "../../tools/define-tool.js";
import { defineCapability } from "../define-capability.js";
import { createLoginFillTool } from "./login-fill.js";
import { createRoutineLoginFillTool, type RoutineLoginGrant } from "./routine-login-fill.js";
import { createSecretListTool } from "./secret-list.js";
import { createSecretRequestTool } from "./secret-request.js";

export * from "./kinds.js";
export * from "./login-fill.js";
export * from "./routine-login-fill.js";
export * from "./secret-list.js";
export * from "./secret-request.js";

export type VaultDeps = {
	/** Só os nomes e metadados (a tool `login_fill` usa para mostrar o site no cartão de aprovação). */
	vault: Pick<Vault, "listHandles">;
	/** Cartão "cadastre este segredo". Sem ele, `secret_request` não é oferecida. */
	requests?: SecretRequests;
	/** Sem dono presente: só `secret_list`. Nada de pedir segredo nem digitar login. */
	readOnly?: boolean;
	/**
	 * Run de ROTINA com a permissão de login que o dono aprovou ao criar a rotina (F9 parte 2): entra um `login_fill` só para esse login e
	 * esse site. Só vale com `readOnly` (sem dono); sem isso a rotina não digita login nenhum.
	 */
	routineLogin?: RoutineLoginGrant;
	extraTools?: readonly Tool[];
};

export const VAULT_INSTRUCTIONS =
	"Vault rules: you only ever see names, never values. A plain secret goes into a connector or code_shell call as {{secret:<name>}}; the real value is put in at the last moment and hidden from the result. " +
	"A site login is typed by login_fill, which the owner approves each time and which only works on the login's saved site; the 2FA code is always the owner's. " +
	"The fields of a login are yours to declare: look at the sign-in page, then ask with secret_request (kind login) one field per input of the screen; steps of the same sign-in end up in one login. login_fill then maps each saved field key to a page input ref. " +
	"If a key is missing, ask with secret_request and stop: the owner saves it in the card. Never ask the owner to paste a password or key in the chat, and never repeat a value you were shown. " +
	"Say \"vault\", \"login\" and \"key\" to the owner, never tool names.";

export const VAULT_READ_INSTRUCTIONS =
	"Vault rules: you only ever see names, never values. A plain secret goes into a connector call as {{secret:<name>}}. This run has no owner present, so you cannot ask for new secrets or sign in to sites here. " +
	"If the task needs a sign-in, say plainly in your result that this routine has no permission to sign in, so it did not.";

export const vaultRoutineInstructions = (grant: RoutineLoginGrant): string =>
	"Vault rules: you only ever see names, never values. A plain secret goes into a connector call as {{secret:<name>}}. This run has no owner present, so you cannot ask for new secrets. " +
	`The owner approved this routine to sign in to ${grant.site} with the login "${grant.login}": login_fill types it there and nowhere else (open the sign-in page and map it first). ` +
	"Any other site or login is not allowed: do not sign in, and say plainly in your result that the sign-in did not happen.";

export function createVaultCapability(deps: VaultDeps) {
	const tools = deps.readOnly
		? [createSecretListTool(), ...(deps.routineLogin ? [createRoutineLoginFillTool(deps.routineLogin)] : [])]
		: [createSecretListTool(), ...(deps.requests ? [createSecretRequestTool(deps.requests)] : []), createLoginFillTool({ vault: deps.vault }), ...(deps.extraTools ?? [])];
	return defineCapability({
		id: "vault",
		title: "Cofre",
		summary: "The owner's vault: list secret names, ask the owner to save a missing key, sign in to a saved site login. You never see values.",
		tools,
		instructions: deps.readOnly ? (deps.routineLogin ? vaultRoutineInstructions(deps.routineLogin) : VAULT_READ_INSTRUCTIONS) : VAULT_INSTRUCTIONS,
	});
}
