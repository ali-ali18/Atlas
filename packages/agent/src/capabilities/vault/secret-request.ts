// `secret_request`: pede ao dono que cadastre no cofre o que falta. O dono digita o valor num campo de senha do cartão e ele
// vai direto ao cofre; o modelo nunca o vê e o valor nunca passa pela conversa. Encerra o turno: a resposta do dono chega
// depois como uma mensagem comum. Duas formas:
//  - segredo simples (`names`): chave de API, token;
//  - login (`kind: "login"`, `site`, `fields`): o MODELO olha a página e declara os campos que o login pede (chave, rótulo,
//    se é secreto). O cartão mostra um campo por item. Etapas diferentes do mesmo login (e-mail, depois senha) são cartões
//    diferentes e se juntam num item só do site (o servidor acrescenta campos ao item existente).
import { isValidSecretName, parseLoginFieldDecls, siteKey } from "@workspace/shared";
import { z } from "zod";
import type { SecretHandle, SecretRequests } from "../../ports/vault.js";
import { defineTool } from "../../tools/define-tool.js";

const MAX_NAMES = 5;

export function createSecretRequestTool(requests: SecretRequests) {
	return defineTool({
		name: "secret_request",
		description:
			"Ask the owner to save something you lack in their vault. A card with password fields is shown; the values go straight to the vault and you never see them. This ends your turn. " +
			"Two forms. (1) A simple secret (API key, token): pass names, e.g. [\"stripe-key\"]; later use it as {{secret:<name>}}. " +
			"(2) A site LOGIN: look at the sign-in page first (browser_map / browser_read), then pass kind:\"login\", site (the address of the sign-in page) and fields, ONE entry per input the page asks for on this screen: " +
			"{ key (short id, letters/digits/-/_, e.g. email, cpf, password), label (what the owner sees, in their language), secret (true for password or code, false for e-mail or name) }. " +
			"Everything on the same page goes in one card. If the sign-in has steps (e-mail first, password on the next screen), ask only the fields of the step you see; call again for the next step: all steps are saved in the same login of the site. " +
			"Afterwards use login_fill, mapping each saved field to the page field. Names use letters, digits, - and _. Do not use it for something secret_list already shows, or to ask for a value in the chat.",
		inputSchema: z.object({
			kind: z.enum(["secret", "login"]).optional().describe("secret (default) for a simple key; login for the fields of a site sign-in."),
			names: z.array(z.string().refine(isValidSecretName, "use letters, digits, - and _ (up to 64), e.g. stripe-key")).min(1).max(MAX_NAMES).optional().describe("Simple secret: vault names to ask for (1 to 5), e.g. [\"stripe-key\"]."),
			site: z.string().trim().min(1).max(200).optional().describe("Login: address of the sign-in page, e.g. https://chatgpt.com/auth/login."),
			name: z.string().refine(isValidSecretName, "use letters, digits, - and _ (up to 64)").optional().describe("Login: name of the vault item (default: the site name). Leave it out unless the owner named it."),
			fields: z
				.array(z.object({ key: z.string(), label: z.string(), secret: z.boolean() }))
				.min(1)
				.max(8)
				.optional()
				.describe("Login: one entry per input of this sign-in screen, e.g. [{ key: \"email\", label: \"E-mail\", secret: false }]."),
			reason: z.string().trim().min(1).max(300).describe("One short sentence, in the owner's language: why you need it."),
		}),
		effect: "read",
		endsTurn: true,
		async execute(args, ctx) {
			const handles = await ctx.ports.vault.listHandles(ctx.ownerId);
			if (args.kind === "login") return askLogin(args, ctx, handles, requests);
			if (args.site !== undefined || args.fields !== undefined || args.name !== undefined) return { ok: false, error: "site, name and fields only go with kind:\"login\".", hint: "For a site sign-in pass kind:\"login\"; for a simple key pass only names and reason." };
			if (!args.names || args.names.length === 0) return { ok: false, error: "names is missing: say which secret to ask for.", hint: "Pass names, e.g. [\"stripe-key\"], or kind:\"login\" with site and fields for a site sign-in." };
			const unique = [...new Set(args.names)];
			// Login (campos de um site) não é segredo simples: `{{secret:x}}` não o alcança, quem o usa é `login_fill`.
			const logins = unique.filter((name) => handles.some((h) => h.id === name && h.kind === "login"));
			if (logins.length > 0) return { ok: false, error: `"${logins.join(", ")}" is a saved site login, not a simple secret.`, hint: "Sign in with login_fill (the owner approves it); {{secret:<name>}} does not work for logins. Pick another name if you need a separate API key or token." };
			const existing = new Set(handles.filter((h) => h.kind !== "login").map((h) => h.id));
			const missing = unique.filter((name) => !existing.has(name));
			if (missing.length === 0) return { ok: true, summary: `Already in the vault: ${unique.join(", ")}. Use ${unique.map((name) => `{{secret:${name}}}`).join(", ")}; nothing was asked of the owner.` };
			await requests.ask(ctx.ownerId, ctx.runId, { names: missing, reason: args.reason });
			return { ok: true, summary: `A card asked the owner to save ${missing.join(", ")} (the value goes straight to the vault). Your turn ends here; afterwards use ${missing.map((name) => `{{secret:${name}}}`).join(", ")}. Do not ask for the value in the chat.` };
		},
	});
}

type Args = { kind?: "secret" | "login"; names?: string[]; site?: string; name?: string; fields?: Array<{ key: string; label: string; secret: boolean }>; reason: string };
type Ctx = { ownerId: string; runId: string };

async function askLogin(args: Args, ctx: Ctx, handles: readonly SecretHandle[], requests: SecretRequests) {
	if (args.names !== undefined) return { ok: false as const, error: "names does not go with kind:\"login\".", hint: "Pass site and fields (one entry per input of the sign-in screen)." };
	if (!args.site) return { ok: false as const, error: "site is missing for the login.", hint: "Pass the address of the sign-in page, e.g. https://chatgpt.com/auth/login." };
	const key = siteKey(args.site);
	if (!key) return { ok: false as const, error: `"${args.site.slice(0, 80)}" is not a site address.`, hint: "Pass the address of the sign-in page, e.g. https://chatgpt.com/auth/login." };
	const parsed = parseLoginFieldDecls(args.fields);
	if ("error" in parsed) return { ok: false as const, error: `Invalid fields: ${parsed.error}.`, hint: "Declare one { key, label, secret } per input the sign-in page shows (look with browser_map first)." };
	// O item do site: o que já guarda esse site (qualquer etapa anterior) ou o de mesmo nome; senão será criado com o nome do pedido.
	const logins = handles.filter((h) => h.kind === "login");
	// Mesmo critério do servidor: só entre os logins DESTE site (login sem site nunca é adotado por nome), e vários no site pedem o nome.
	const sameSite = logins.filter((h) => h.site !== undefined && siteKey(h.site) === key);
	if (!args.name && sameSite.length > 1) return { ok: false as const, error: `More than one saved login belongs to ${key}: ${sameSite.map((h) => h.id).join(", ")}.`, hint: "Pass name set to the one that should receive these fields (the owner may have named it), or ask which." };
	const existing = args.name ? sameSite.find((h) => h.id === args.name) : sameSite[0];
	if (args.name && !existing && handles.some((h) => h.id === args.name)) return { ok: false as const, error: `"${args.name}" is already used by another vault item.`, hint: "Leave name out (the site name is used) or pick another one." };
	const saved = new Set((existing?.fields ?? []).map((f) => f.key));
	const missing = parsed.fields.filter((f) => !saved.has(f.key));
	const itemName = existing?.id ?? args.name;
	if (missing.length === 0) return { ok: true as const, summary: `The login of ${key} already has: ${parsed.fields.map((f) => f.key).join(", ")}; nothing was asked of the owner. Use login_fill with these keys.` };
	await requests.ask(ctx.ownerId, ctx.runId, { names: missing.map((f) => f.key), reason: args.reason, login: { site: key, ...(itemName && { name: itemName }), fields: missing } });
	const keep = saved.size > 0 ? ` The login of this site already has: ${[...saved].join(", ")}; the new fields are added to it.` : "";
	return { ok: true as const, summary: `A card asked the owner for ${missing.map((f) => f.key).join(", ")} of the login of ${key} (the values go straight to the vault).${keep} Your turn ends here; afterwards continue the sign-in: if the page has another step, look at it and ask only its fields; when the page asks for fields that are saved, call login_fill mapping each key to the page field. Do not ask for the values in the chat.` };
}
