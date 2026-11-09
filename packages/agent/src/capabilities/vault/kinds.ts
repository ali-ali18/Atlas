// Protocolo da capacidade `vault` com a porta `Sandbox` (F9): o `kind` da ação e o formato do que volta em `data`.
// A porta é opaca de propósito; ESTE arquivo é o contrato entre a capacidade e o tratador do worker
// (`apps/worker/src/v4-adapters/sandbox-vault-login.ts`). Mudou aqui, muda lá.
//
// REGRA DO COFRE: a ação leva só o NOME do login (handle). A senha e o usuário são lidos pelo tratador, no worker, e
// seguem do worker para a VM (rota `/browser/type` do control server, que confere o campo e a origem antes de digitar).
// Nada disso volta: o resultado tem só o que foi preenchido (nomes de campo) e o site.
import { z } from "zod";

export const VAULT_KINDS = {
	/** Preenche o login salvo na página atual do navegador da VM. */
	loginFill: "vault.login_fill",
} as const;
export type VaultKind = (typeof VAULT_KINDS)[keyof typeof VAULT_KINDS];

export const LOGIN_FILL_FIELDS = ["username", "password"] as const;
export type LoginFillField = (typeof LOGIN_FILL_FIELDS)[number];

export const loginFillParamsSchema = z.strictObject({
	/** Nome do item do cofre (o `id` do handle). Ausente = o tratador acha o login pelo SITE da página atual. */
	login: z.string().min(1).max(64).optional(),
	fields: z.array(z.enum(LOGIN_FILL_FIELDS)).min(1).max(2),
	submit: z.boolean(),
	/** Seletor CSS do campo de usuário quando a detecção padrão falha. A senha é sempre achada sozinha. */
	usernameSelector: z.string().min(1).max(300).optional(),
});
export type LoginFillParams = z.infer<typeof loginFillParamsSchema>;

export const loginFillDataSchema = z.object({
	/** Nome do login usado (só o nome, nunca valor). Ausente em tratador antigo. */
	login: z.string().min(1).optional(),
	filled: z.array(z.enum(LOGIN_FILL_FIELDS)).min(1),
	/** Domínio do site do login. */
	site: z.string().min(1),
	submitted: z.boolean(),
	/** Domínio da página depois de enviar (só quando `submitted`). Nunca título nem texto da página. */
	landedHost: z.string().optional(),
});
export type LoginFillData = z.infer<typeof loginFillDataSchema>;
