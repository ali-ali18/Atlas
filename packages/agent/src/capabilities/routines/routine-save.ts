// Peças comuns de `routine_create` e `routine_update` (F9 parte 2): o schema do alerta e da permissão de login, a conferência da
// permissão contra o cofre e o texto do cartão de aprovação. Nada aqui decide por texto livre: só campos declarados.
import { ALERT_CONDITION_MAX, ALERT_HINT_MAX, ALERT_CONDITION_MIN, describeRoutineLoginPermission, parseRoutineLoginAccess, siteKey } from "@workspace/shared";
import { z } from "zod";
import type { RoutineAlertSpec, RoutineLoginAccess } from "../../ports/routines.js";
import type { Vault } from "../../ports/vault.js";

export const NOTIFY_MODES = ["always", "important"] as const;

export const alertField = z
	.strictObject({
		condition: z.string().trim().min(ALERT_CONDITION_MIN).max(ALERT_CONDITION_MAX).describe('The condition as a short phrase in the owner\'s language that completes "avisa se ...", like "o estoque da canela cair abaixo de 10".'),
		hint: z.string().trim().max(ALERT_HINT_MAX).optional().describe("Where to look: connector or tool, product, field, threshold, date range."),
		frequent: z.boolean().optional().describe("true ONLY when the owner explicitly asked to check more often than every 2 hours. Never set it on your own."),
	})
	.describe("Turns the routine into an alert (only with triggerType cron or interval): it checks on its schedule and the owner hears from it only when the condition newly becomes true.");

export const loginAccessField = z
	.strictObject({
		login: z.string().trim().min(1).max(64).describe("Name of a saved login (see secret_list)."),
		site: z.string().trim().min(1).max(200).describe('The site the routine signs in to, like "banco.example" or its sign-in URL. Must be the saved site of that login.'),
	})
	.describe("Declare this ONLY when the routine will need to sign in to a site with a saved login. The owner is asked once to approve exactly this login on exactly this site; without it the routine cannot sign in.");

/** O que o modelo escreveu do alerta, sem o `frequent` (que só vale na criação, para o mínimo de 2 h). */
export function alertSpecOf(alert: { condition: string; hint?: string | undefined }): RoutineAlertSpec {
	return { condition: alert.condition, ...(alert.hint && { hint: alert.hint }) };
}

export type LoginAccessCheck = { ok: true; access: RoutineLoginAccess } | { ok: false; error: string; hint: string };

/**
 * A permissão que o modelo declarou existe de verdade? O login tem de ser um item do cofre do dono COM site salvo, e o site
 * declarado tem de ser o dele (mesma normalização): uma permissão que o `login_fill` recusaria depois não vale a aprovação.
 * Só nomes e sites; nunca valor.
 */
export async function checkLoginAccess(raw: unknown, ownerId: string, vault: Pick<Vault, "listHandles"> | undefined): Promise<LoginAccessCheck> {
	const parsed = parseRoutineLoginAccess(raw);
	if (!parsed.ok) return { ok: false, error: parsed.error, hint: "Pass loginAccess: { login, site } with a login name from secret_list and its site." };
	if (!vault) return { ok: false, error: "The vault is not available in this run, so a login permission cannot be checked.", hint: "Create the routine without loginAccess and tell the owner it cannot sign in yet." };
	const handles = await vault.listHandles(ownerId);
	const logins = handles.filter((h) => h.kind === "login");
	const wanted = parsed.permission.login.toLowerCase();
	const handle = logins.find((h) => h.id === parsed.permission.login) ?? logins.find((h) => h.id.toLowerCase() === wanted);
	if (!handle) {
		return { ok: false, error: `No saved login called "${parsed.permission.login.slice(0, 64)}".`, hint: logins.length > 0 ? `Saved logins: ${logins.map((h) => h.id).join(", ")}.` : "The vault has no site login. Ask the owner to save one with secret_request (kind login) first, then create the routine." };
	}
	const saved = handle.site ? siteKey(handle.site) : null;
	if (!saved) return { ok: false, error: `The login "${handle.id}" has no saved site, so a routine could not sign in with it.`, hint: "Ask the owner to save the site on this login in Settings, Vault." };
	if (saved !== parsed.permission.site) {
		return { ok: false, error: `The login "${handle.id}" belongs to ${saved}, not to ${parsed.permission.site}.`, hint: `Declare site ${saved} for this login, or pick another login.` };
	}
	return { ok: true, access: { login: handle.id, site: saved } };
}

/** O que o cartão de aprovação mostra: a frase "usar o login X para entrar em Y" e que vale só para esta rotina. */
export function loginAccessTarget(access: { login: string; site: string }): string {
	return `${describeRoutineLoginPermission({ login: access.login, site: siteKey(access.site) ?? access.site })} nesta rotina`;
}
