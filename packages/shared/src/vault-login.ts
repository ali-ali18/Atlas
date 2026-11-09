import { isValidSecretName } from "./vault.js";

/**
 * Campos de um login do cofre decididos pela IA (F9): quem olha a página declara o que o login pede (`email`; `nome`, `cpf`,
 * `senha`; `usuario`, `senha`…), com rótulo legível e se é secreto. Lógica pura: roda no worker, na API e no navegador.
 * O VALOR de cada campo só existe dentro do envelope cifrado do item (`payload.fields`); declaração (chave, rótulo, secreto)
 * não é segredo e viaja em eventos e na lista do modelo.
 */

export const LOGIN_FIELDS_MAX = 8;
export const LOGIN_FIELD_LABEL_MAX = 60;
export const LOGIN_FIELD_VALUE_MAX = 2_000;

/** Declaração de um campo: a chave segue o formato de nome do cofre (letras, números, - e _). */
export type LoginFieldDecl = { key: string; label: string; secret: boolean };
/** Campo guardado (dentro do cifrado). */
export type LoginFieldValue = LoginFieldDecl & { value: string };
/** Pedido de login ao dono: o site e os campos desta etapa; `name` opcional (padrão: nome do site). */
export type LoginRequestInfo = { site: string; name?: string; fields: LoginFieldDecl[] };

/** Chaves do login antigo (usuário em claro na coluna, senha no cifrado), tratadas como campos na leitura. */
export const LEGACY_USERNAME_KEY = "username";
export const LEGACY_PASSWORD_KEY = "password";

export function parseLoginFieldDecls(raw: unknown): { fields: LoginFieldDecl[] } | { error: string } {
	if (!Array.isArray(raw) || raw.length === 0) return { error: "fields must list at least one field: [{ key, label, secret }]" };
	if (raw.length > LOGIN_FIELDS_MAX) return { error: `at most ${LOGIN_FIELDS_MAX} fields per request` };
	const fields: LoginFieldDecl[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object" || Array.isArray(item)) return { error: "each field must be { key, label, secret }" };
		const row = item as Record<string, unknown>;
		const unknown = Object.keys(row).filter((k) => k !== "key" && k !== "label" && k !== "secret");
		if (unknown.length > 0) return { error: `unknown field property: ${unknown.join(", ")} (accepted: key, label, secret)` };
		if (!isValidSecretName(row.key)) return { error: "field key must use letters, digits, - and _ (up to 64), e.g. email" };
		const label = typeof row.label === "string" ? row.label.trim() : "";
		if (!label || label.length > LOGIN_FIELD_LABEL_MAX) return { error: `field "${row.key}" needs a label of 1 to ${LOGIN_FIELD_LABEL_MAX} characters, in the owner's language` };
		if (typeof row.secret !== "boolean") return { error: `field "${row.key}" must say secret: true (password, code) or false (email, name)` };
		if (fields.some((f) => f.key === row.key)) return { error: `field key "${row.key}" is repeated` };
		fields.push({ key: row.key, label, secret: row.secret });
	}
	return { fields };
}

/** Junta os campos recebidos aos já guardados, por chave: mesma chave troca valor, rótulo e sigilo; chave nova é acrescentada. Nada é apagado. */
export function mergeLoginFields(existing: readonly LoginFieldValue[], incoming: readonly LoginFieldValue[]): LoginFieldValue[] {
	const out = existing.map((f) => ({ ...f }));
	for (const field of incoming) {
		const at = out.findIndex((f) => f.key === field.key);
		if (at >= 0) out[at] = { ...field };
		else out.push({ ...field });
	}
	return out;
}

/**
 * Todos os campos de um login, na leitura: os de `payload.fields` mais, se não houver campo com a mesma chave, o
 * `username` (claro, não secreto) e a `password` (cifrada, secreta) do login antigo. Sem migrar dado.
 */
export function loginFieldsView(input: { username?: string | null; password?: string; fields?: readonly LoginFieldValue[] }): LoginFieldValue[] {
	const out: LoginFieldValue[] = (input.fields ?? []).map((f) => ({ ...f }));
	const has = (key: string) => out.some((f) => f.key === key);
	if (input.username && !has(LEGACY_USERNAME_KEY)) out.unshift({ key: LEGACY_USERNAME_KEY, label: "Usuário", secret: false, value: input.username });
	if (input.password && !has(LEGACY_PASSWORD_KEY)) out.push({ key: LEGACY_PASSWORD_KEY, label: "Senha", secret: true, value: input.password });
	return out;
}

/** Só a declaração (sem valor): o que o modelo e a lista podem ver. */
export function loginFieldDecls(fields: readonly LoginFieldValue[]): LoginFieldDecl[] {
	return fields.map(({ key, label, secret }) => ({ key, label, secret }));
}

/** Lê com segurança o `payload.fields` de um envelope aberto (dado antigo ou corrompido vira lista vazia). */
export function readStoredLoginFields(raw: unknown): LoginFieldValue[] {
	if (!Array.isArray(raw)) return [];
	const out: LoginFieldValue[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const row = item as Record<string, unknown>;
		if (!isValidSecretName(row.key) || typeof row.value !== "string" || out.some((f) => f.key === row.key)) continue;
		out.push({ key: row.key, label: typeof row.label === "string" && row.label ? row.label.slice(0, LOGIN_FIELD_LABEL_MAX) : row.key, secret: row.secret !== false, value: row.value });
	}
	return out;
}
