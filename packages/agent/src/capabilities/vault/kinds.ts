// Protocolo da capacidade `vault` com a porta `Sandbox` (F9): o `kind` da ação e o formato do que volta em `data`.
// A porta é opaca de propósito; ESTE arquivo é o contrato entre a capacidade e o tratador do worker
// (`apps/worker/src/v4-adapters/sandbox-vault-login.ts`). Mudou aqui, muda lá.
//
// REGRA DO COFRE: a ação leva só o NOME do login (handle) e o mapeamento chave-do-campo-salvo -> ref-do-campo-da-página.
// Os VALORES são lidos pelo tratador, no worker, e seguem do worker para a VM (rota `/browser/type` do control server, que
// confere o campo e a origem antes de digitar). Nada disso volta: o resultado tem só as chaves preenchidas e o site.
import { z } from "zod";

export const VAULT_KINDS = {
	/** Preenche o login salvo na página atual do navegador da VM. */
	loginFill: "vault.login_fill",
} as const;
export type VaultKind = (typeof VAULT_KINDS)[keyof typeof VAULT_KINDS];

/** Ref de campo do mapa da página (`e12` do DOM ou `a7` da árvore), do documento principal (sem iframe). */
export const LOGIN_FILL_REF = /^[ea]\d{1,5}$/;
export const LOGIN_FILL_MAX_FIELDS = 8;

/** Um campo salvo do login (pela chave) e o campo da página onde digitar (pelo ref do `browser_map`). */
export const loginFillMappingSchema = z.strictObject({
	key: z.string().min(1).max(64),
	ref: z.string().regex(LOGIN_FILL_REF, 'a ref from browser_map (like "e12" or "a7")'),
});
export type LoginFillMapping = z.infer<typeof loginFillMappingSchema>;

export const loginFillParamsSchema = z.strictObject({
	/** Nome do item do cofre (o `id` do handle). Ausente = o tratador acha o login pelo SITE da página atual. */
	login: z.string().min(1).max(64).optional(),
	/** Mapeamento decidido pelo modelo: qual campo salvo vai em qual campo da página, na ordem de digitação. */
	fields: z.array(loginFillMappingSchema).min(1).max(LOGIN_FILL_MAX_FIELDS),
	submit: z.boolean(),
});
export type LoginFillParams = z.infer<typeof loginFillParamsSchema>;

export const loginFillDataSchema = z.object({
	/** Nome do login usado (só o nome, nunca valor). Ausente em tratador antigo. */
	login: z.string().min(1).optional(),
	/** Chaves dos campos preenchidos (nunca valor). */
	filled: z.array(z.string().min(1)).min(1),
	/** Domínio do site do login. */
	site: z.string().min(1),
	submitted: z.boolean(),
	/** Domínio da página depois de enviar (só quando `submitted`). Nunca título nem texto da página. */
	landedHost: z.string().optional(),
});
export type LoginFillData = z.infer<typeof loginFillDataSchema>;
