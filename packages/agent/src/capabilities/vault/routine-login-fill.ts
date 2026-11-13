// `login_fill` do RUN DE ROTINA (F9 parte 2, decisão do dono 09/11). Sem dono presente o `login_fill` comum não existe (efeito
// `credential`). Mas o dono já aprovou, ao criar ou editar a rotina, "este login, neste site" (`routines.loginPermissionJson`).
// Com essa permissão a rotina ganha uma tool de mesmo nome que só serve àquele login e àquele site:
//  - o login é FIXO (o modelo não escolhe nome nem site);
//  - o tratador da VM só digita quando o site da página bate com o permitido (mesma normalização do cofre) e confere antes de
//    CADA campo; as checagens de sempre (https, site salvo do login, campo e origem na VM) continuam valendo;
//  - efeito `write_internal`: a aprovação já aconteceu (cartão da criação), então não há cartão por uso;
//  - sem permissão (ou site diferente) a rotina não entra e diz isso no resultado dela.
// O valor nunca passa pelo modelo: só a chave do campo salvo e o ref do campo da página.
import { z } from "zod";
import { defineTool } from "../../tools/define-tool.js";
import { LOGIN_FILL_MAX_FIELDS, loginFillDataSchema, loginFillMappingSchema, VAULT_KINDS, type LoginFillParams } from "./kinds.js";

/** A permissão que o dono aprovou: o NOME do login e o site já normalizado (`siteKey`). */
export type RoutineLoginGrant = { login: string; site: string };

export function createRoutineLoginFillTool(grant: RoutineLoginGrant) {
	return defineTool({
		name: "login_fill",
		description:
			`Fill the saved login "${grant.login}" into the CURRENT page of the VM browser without the values passing through you. The owner approved this routine to sign in to ${grant.site} with this login, and nowhere else. ` +
			"Open the sign-in page and map it first (browser_open, browser_map), then pass fields: one { key, ref } per input to type, where key is a saved field of the login (see secret_list) and ref is the page input from browser_map. Pass submit:true to press Enter after the last field. " +
			`It only types when the page is on ${grant.site}; on any other site nothing is typed, and you must not try another site or another login. On a sign-in with steps, fill only the fields of the screen you see. ` +
			"The 2FA code is never typed by you: if the site asks for it, stop. If you cannot sign in, say so plainly in your result (the owner reads it), do not pretend the sign-in worked.",
		inputSchema: z.object({
			fields: z.array(loginFillMappingSchema).min(1).max(LOGIN_FILL_MAX_FIELDS).describe('What to type, in order: [{ key: "email", ref: "e5" }, { key: "password", ref: "e6" }].'),
			submit: z.boolean().optional().describe("Press Enter after the last field."),
		}),
		// A aprovação do dono foi a da criação da rotina (cartão `credential`); aqui não há dono para um cartão por uso.
		effect: "write_internal",
		// Texto da página (domínio de chegada) volta no resultado: é dado de fora.
		trust: "untrusted",
		source: "web",
		async execute(args, ctx) {
			const keys = args.fields.map((f) => f.key);
			const refs = args.fields.map((f) => f.ref);
			if (new Set(keys).size !== keys.length) return { ok: false, error: "A saved field is mapped more than once.", hint: "Pass each saved key once, with the page input where it goes." };
			if (new Set(refs).size !== refs.length) return { ok: false, error: "Two saved fields are mapped to the same page input.", hint: "Each saved field goes to its own input of the page (refs from browser_map)." };
			const handles = await ctx.ports.vault.listHandles(ctx.ownerId);
			const handle = handles.find((h) => h.kind === "login" && h.id === grant.login);
			if (!handle) return { ok: false, error: `The login "${grant.login}" approved for this routine is not in the vault any more, so nothing was typed.`, hint: "Say in your result that the routine could not sign in; the owner can edit the routine to approve another login." };
			const saved = (handle.fields ?? []).map((f) => f.key);
			const unknown = keys.filter((key) => !saved.includes(key));
			if (unknown.length > 0) return { ok: false, error: `The login "${handle.id}" has no saved field called ${unknown.map((k) => `"${k}"`).join(", ")}.`, hint: `Saved fields: ${saved.join(", ") || "none"}. Map only those.` };
			const params: LoginFillParams = { login: handle.id, fields: args.fields, submit: args.submit === true, onlySite: grant.site };
			let result: Awaited<ReturnType<typeof ctx.ports.sandbox.run>>;
			try {
				result = await ctx.ports.sandbox.run(ctx.ownerId, { kind: VAULT_KINDS.loginFill, params }, ctx.signal);
			} catch (error) {
				if (ctx.signal?.aborted) throw error;
				return { ok: false, error: `The browser could not be reached: ${error instanceof Error ? error.message : String(error)}.`, hint: "Nothing was typed. Say in your result that the routine could not sign in." };
			}
			if (!result.ok) return { ok: false, error: result.error && result.error.length > 0 ? result.error : "The browser refused to fill the login without a reason.", hint: `The page must be the sign-in page of ${grant.site} (https). Nothing more was typed. Say in your result that the routine could not sign in.` };
			const parsed = loginFillDataSchema.safeParse(result.data);
			if (!parsed.success) return { ok: false, error: "The browser answered in an unexpected format for the login, so it is unknown whether it was typed.", hint: "Look at the page with browser_map before trying again." };
			const { filled, site, submitted, landedHost } = parsed.data;
			return {
				ok: true,
				summary: `Filled the fields ${filled.join(", ")} of "${grant.login}" on ${site} without showing you the values.${submitted ? ` Submitted; the page is now on ${landedHost ?? "an unknown site"}. Check it with browser_map before saying the sign-in worked.` : " Click the sign-in button or call again with submit:true."}`,
				receipt: { what: `Routine signed in with "${grant.login}"${submitted ? " and submitted it" : ""}`, where: site },
			};
		},
	});
}
