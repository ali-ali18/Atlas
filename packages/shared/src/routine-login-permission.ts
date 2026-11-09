// Permissão de login de uma rotina (decisão do dono, 09/11): ao criar ou editar a rotina, o modelo DECLARA que ela vai precisar
// entrar num site com um login do cofre; o dono aprova num cartão; a rotina guarda "este login, neste site". No run da rotina
// (sem dono) o `login_fill` existe só para esse login e só digita quando o site da página bate. Funções puras: nada de texto
// livre decide nada, só os campos declarados e a normalização de site (`siteKey`).
import { isValidSecretName, siteKey } from "./vault.js";

/** O que fica guardado na rotina (`routines.loginPermissionJson`). `site` já normalizado (`siteKey`). */
export type RoutineLoginPermission = {
	/** Nome do item de login no cofre (o `id` do handle). */
	login: string;
	/** Site permitido, normalizado: minúsculas, sem `www.`, esquema, caminho nem query. */
	site: string;
	/** ISO de quando o dono aprovou. */
	approvedAt: string;
};

export type RoutineLoginPermissionParse = { ok: true; permission: Omit<RoutineLoginPermission, "approvedAt"> } | { ok: false; error: string };

/** Valida o que o modelo declarou (`{ login, site }`): nome de login do cofre e um site legível. Mensagens para o modelo (inglês). */
export function parseRoutineLoginAccess(raw: unknown): RoutineLoginPermissionParse {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "login_access must be an object { login, site }." };
	const row = raw as Record<string, unknown>;
	const extra = Object.keys(row).filter((key) => key !== "login" && key !== "site");
	if (extra.length > 0) return { ok: false, error: `Unknown field(s) in login_access: ${extra.join(", ")}. Accepted: login, site.` };
	const login = typeof row.login === "string" ? row.login.trim() : "";
	if (!isValidSecretName(login)) return { ok: false, error: "login_access.login must be the name of a saved login (see secret_list)." };
	const siteRaw = typeof row.site === "string" ? row.site.trim() : "";
	const site = siteRaw ? siteKey(siteRaw) : null;
	if (!site) return { ok: false, error: 'login_access.site must be the site the routine signs in to, like "banco.example" or a sign-in URL.' };
	return { ok: true, permission: { login, site } };
}

/** Lê `loginPermissionJson` do banco com tolerância (linha antiga ou lixo = sem permissão). */
export function parseRoutineLoginPermission(value: unknown): RoutineLoginPermission | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const row = value as Record<string, unknown>;
	if (typeof row.login !== "string" || !isValidSecretName(row.login)) return null;
	const site = typeof row.site === "string" ? siteKey(row.site) : null;
	if (!site) return null;
	return { login: row.login, site, approvedAt: typeof row.approvedAt === "string" ? row.approvedAt : "" };
}

/** O site da página atual é o que o dono aprovou? Mesma normalização do cofre; só o host conta (o https é conferido por quem digita). */
export function loginPermissionAllowsPage(permission: Pick<RoutineLoginPermission, "site">, pageUrl: string): boolean {
	const page = siteKey(pageUrl);
	return page !== null && page === permission.site;
}

/** Frase da permissão para o dono (cartão de aprovação, resumo), sem verbo: "o login banco para entrar em banco.example". */
export function describeRoutineLoginPermission(permission: Pick<RoutineLoginPermission, "login" | "site">): string {
	return `o login ${permission.login} para entrar em ${permission.site}`;
}
