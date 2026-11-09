// `login_fill`: preenche o login salvo de um site na página atual do navegador da VM, sem o valor passar pelo modelo.
// Efeito `credential`: o dono aprova TODA vez (cartão em qualquer autonomia; sem dono a tool fica fora). A tool só leva o
// NOME do login à porta `Sandbox` (`vault.login_fill`); o tratador do worker lê a senha do cofre, confere que a página é do
// site salvo e digita pelo control server. O que volta é só quais campos foram preenchidos e o site.
import { isValidSecretName } from "@workspace/shared";
import { z } from "zod";
import type { Vault, SecretHandle } from "../../ports/vault.js";
import { defineTool } from "../../tools/define-tool.js";
import { LOGIN_FILL_FIELDS, loginFillDataSchema, VAULT_KINDS, type LoginFillParams } from "./kinds.js";

function findLogin(handles: readonly SecretHandle[], wanted: string): SecretHandle | undefined {
	const logins = handles.filter((h) => h.kind === "login");
	const lower = wanted.toLowerCase();
	return logins.find((h) => h.id === wanted) ?? logins.find((h) => h.id.toLowerCase() === lower || h.label.toLowerCase() === lower);
}

export function createLoginFillTool(deps: { vault: Pick<Vault, "listHandles"> }) {
	return defineTool({
		name: "login_fill",
		description:
			"Fill a saved site login (username and password) into the CURRENT page of the VM browser without the values passing through you. The owner approves each use. " +
			"Open the sign-in page first (browser_open), then call this; it only types when the page belongs to the login's saved site, otherwise nothing is typed. Pass submit:true to press Enter after the last field. " +
			"Leave login out to pick the saved login by the SITE of the current page (the usual way: no need to guess a name); it works only when exactly one saved login belongs to that site, otherwise it lists the options and you pass login by name. " +
			"On a two-screen sign-in, fill username first, then password on the next screen. The 2FA code is never typed by you: if the site asks for it, the owner types it in the browser view. " +
			"secret_list shows the login names and sites. Do not use it for sites without a saved login, and never ask the owner for a password in the chat.",
		inputSchema: z.object({
			login: z.string().refine(isValidSecretName, "a login name from secret_list").optional().describe("Login name from secret_list. Omit to use the login saved for the site of the current page."),
			fields: z.array(z.enum(LOGIN_FILL_FIELDS)).min(1).max(2).optional().describe("What to fill (default username and password). The 2FA code cannot be filled."),
			submit: z.boolean().optional().describe("Press Enter after the last field."),
			usernameSelector: z.string().trim().min(1).max(300).optional().describe("CSS selector of the username field, only when the default detection fails. The password field is always found automatically."),
		}),
		effect: "credential",
		// Texto da página (domínio de chegada) volta no resultado: é dado de fora.
		trust: "untrusted",
		source: "web",
		// Sem nome, o login é o do site da página (só a VM sabe qual é): o cartão diz isso em vez de inventar um alvo.
		riskFacts: ({ login }) => ({ target: login ?? "o login salvo para o site da página atual" }),
		async enrichRiskFacts({ login }, _base, { ownerId }) {
			if (!login) return {};
			const handle = findLogin(await deps.vault.listHandles(ownerId), login);
			return handle ? { target: handle.site ? `${handle.label} (${handle.site})` : handle.label } : {};
		},
		async execute(args, ctx) {
			// Defesa em profundidade: sem o pedido de aprovação do dono não há credencial digitada.
			if (!ctx.approvalId) return { ok: false, error: "The owner did not approve using this login, so nothing was typed.", hint: "Ask the owner again; do not retry on your own." };
			const handles = await ctx.ports.vault.listHandles(ctx.ownerId);
			const logins = handles.filter((h) => h.kind === "login");
			let handle: SecretHandle | undefined;
			if (args.login !== undefined) {
				handle = findLogin(handles, args.login);
				if (!handle) {
					const names = logins.map((h) => h.id);
					return { ok: false, error: `No saved login called "${args.login.slice(0, 64)}".`, hint: names.length > 0 ? `Saved logins: ${names.join(", ")}. Or omit login to pick by the site of the current page.` : "The vault has no site login. Ask the owner to add one in Settings, Vault; do not ask for the password in the chat." };
				}
				if (!handle.site) return { ok: false, error: `The login "${handle.id}" has no saved site, so it is not typed anywhere.`, hint: "Ask the owner to save the site address on this login in Settings, Vault." };
			} else if (!logins.some((h) => h.site)) {
				return { ok: false, error: "The vault has no site login with a saved site, so there is nothing to pick for this page.", hint: "Ask the owner to add the login (with its site) in Settings, Vault; do not ask for the password in the chat." };
			}
			// Sem nome, a VM acha o login pelo site da página atual (uma só, senão devolve a lista para escolher pelo nome).
			const params: LoginFillParams = { ...(handle && { login: handle.id }), fields: args.fields ?? ["username", "password"], submit: args.submit === true, ...(args.usernameSelector && { usernameSelector: args.usernameSelector }) };
			let result: Awaited<ReturnType<typeof ctx.ports.sandbox.run>>;
			try {
				result = await ctx.ports.sandbox.run(ctx.ownerId, { kind: VAULT_KINDS.loginFill, params }, ctx.signal);
			} catch (error) {
				if (ctx.signal?.aborted) throw error;
				return { ok: false, error: `The browser could not be reached: ${error instanceof Error ? error.message : String(error)}.`, hint: "Nothing was typed. Try once more; if it keeps failing, tell the owner the browser is unavailable." };
			}
			if (!result.ok) return { ok: false, error: result.error && result.error.length > 0 ? result.error : "The browser refused to fill the login without a reason.", hint: "Check the page with browser_map: it must be the sign-in page of the saved site (https). Nothing more was typed." };
			const parsed = loginFillDataSchema.safeParse(result.data);
			if (!parsed.success) return { ok: false, error: "The browser answered in an unexpected format for the login, so it is unknown whether it was typed.", hint: "Look at the page with browser_map before trying again." };
			const { filled, site, submitted, landedHost, login: usedLogin } = parsed.data;
			const loginName = usedLogin ?? handle?.id ?? "the login";
			const done = filled.map((f) => (f === "username" ? "username" : "password")).join(" and ");
			return {
				ok: true,
				summary: `Filled the ${done} of "${loginName}" on ${site} without showing you the values.${submitted ? ` Submitted; the page is now on ${landedHost ?? "an unknown site"}. Check it with browser_map before saying the owner is signed in.` : " Click the sign-in button or call again with submit:true."}`,
				receipt: { what: `Used the saved login "${loginName}"${submitted ? " and submitted it" : ""}`, where: site },
			};
		},
	});
}
