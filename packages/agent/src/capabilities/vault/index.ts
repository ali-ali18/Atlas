// Capacidade lazy `vault` (F9): o cofre de segredos do dono. O modelo só vê NOMES; o valor entra pela camada de execução
// (`{{secret:NOME}}` no executor, `login_fill` na VM) e nunca volta. Uma tool por arquivo.
//  - `secret_list`    leitura privada dos nomes (sempre);
//  - `secret_request` pede ao dono que cadastre o que falta (cartão com campo de senha; precisa do dono);
//  - `login_fill`     digita o login de um site na VM (efeito `credential`, aprovação a cada uso; precisa do dono).
// Sem dono (rotina, agenda, subagente) só entra `secret_list` (`readOnly`).
import type { SecretRequests, Vault } from "../../ports/vault.js";
import type { Tool } from "../../tools/define-tool.js";
import { defineCapability } from "../define-capability.js";
import { createLoginFillTool } from "./login-fill.js";
import { createSecretListTool } from "./secret-list.js";
import { createSecretRequestTool } from "./secret-request.js";

export * from "./kinds.js";
export * from "./login-fill.js";
export * from "./secret-list.js";
export * from "./secret-request.js";

export type VaultDeps = {
	/** Só os nomes e metadados (a tool `login_fill` usa para mostrar o site no cartão de aprovação). */
	vault: Pick<Vault, "listHandles">;
	/** Cartão "cadastre este segredo". Sem ele, `secret_request` não é oferecida. */
	requests?: SecretRequests;
	/** Sem dono presente: só `secret_list`. Nada de pedir segredo nem digitar login. */
	readOnly?: boolean;
	extraTools?: readonly Tool[];
};

export const VAULT_INSTRUCTIONS =
	"Vault rules: you only ever see names, never values. A plain secret goes into a connector or code_shell call as {{secret:<name>}}; the real value is put in at the last moment and hidden from the result. " +
	"A site login is typed by login_fill, which the owner approves each time and which only works on the login's saved site; the 2FA code is always the owner's. " +
	"If a key is missing, ask with secret_request and stop: the owner saves it in the card. Never ask the owner to paste a password or key in the chat, and never repeat a value you were shown. " +
	"Say \"vault\", \"login\" and \"key\" to the owner, never tool names.";

export const VAULT_READ_INSTRUCTIONS =
	"Vault rules: you only ever see names, never values. A plain secret goes into a connector call as {{secret:<name>}}. This run has no owner present, so you cannot ask for new secrets or sign in to sites here.";

export function createVaultCapability(deps: VaultDeps) {
	const tools = deps.readOnly
		? [createSecretListTool()]
		: [createSecretListTool(), ...(deps.requests ? [createSecretRequestTool(deps.requests)] : []), createLoginFillTool({ vault: deps.vault }), ...(deps.extraTools ?? [])];
	return defineCapability({
		id: "vault",
		title: "Cofre",
		summary: "The owner's vault: list secret names, ask the owner to save a missing key, sign in to a saved site login. You never see values.",
		tools,
		instructions: deps.readOnly ? VAULT_READ_INSTRUCTIONS : VAULT_INSTRUCTIONS,
	});
}
