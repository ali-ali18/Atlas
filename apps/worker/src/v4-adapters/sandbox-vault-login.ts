// Tratador `vault.login_fill` da porta `Sandbox` (F9): preenche o login salvo na página atual do navegador da VM.
// REGRA: a ação traz só o NOME do login. Usuário e senha são lidos aqui, no worker, e vão direto à VM pela rota que já existe
// (`/browser/type`, via `manager.execBrowserType`), que ainda confere o campo (senha só em input de senha visível, formulário
// que não envia para outro site) e a ORIGEM da aba antes de digitar. Nada do valor volta: o resultado é reconstruído campo a
// campo e todo texto livre (erro da VM) passa por `redactSecrets` com os valores lidos.
//
// Anti-phishing: a senha só é digitada quando a página atual é o site salvo do login (host exato, https; ver `domainMatches`),
// conferido antes de CADA campo (a aba pode mudar entre usuário e senha). Login sem site salvo nunca é digitado: o dono salva o
// site em Configurações, Cofre (o vínculo por cartão do legado fica fora do v4 por enquanto).
import { loginFillParamsSchema, type LoginFillData, type LoginFillField } from "@workspace/agent";
import { domainMatches, hostOf, LOGIN_FIELD_SELECTORS, redactSecrets } from "@workspace/shared";
import type { SandboxKindHandler } from "./sandbox.js";
import { type LoginSource, realV4LoginSource } from "./vault.js";

const FIELD_NAME: Readonly<Record<LoginFillField, string>> = { username: "username", password: "password" };

export function createLoginFillHandler(source: LoginSource): SandboxKindHandler {
	return async (ctx, rawParams) => {
		const parsed = loginFillParamsSchema.safeParse(rawParams);
		if (!parsed.success) return { ok: false, error: "The login request was incomplete, so nothing was typed." };
		const params = parsed.data;

		const login = await source.getLogin(ctx.userId, params.login).catch(() => null);
		if (!login) return { ok: false, error: `No saved login called "${params.login}" in this owner's vault, so nothing was typed.` };
		if (!login.siteUrl) return { ok: false, error: `The login "${login.name}" has no saved site, so it is not typed anywhere. The owner can save the site in Settings, Vault.` };
		const site = login.domain ?? hostOf(login.siteUrl) ?? login.siteUrl;
		const siteUrl = login.siteUrl;

		const currentUrl = async (): Promise<string> => (await ctx.manager.execBrowserText(ctx.sessionId, { mode: "viewport", limit: 1 })).url;
		let pageUrl: string;
		try {
			pageUrl = await currentUrl();
		} catch {
			return { ok: false, error: "The browser page could not be read, so nothing was typed." };
		}
		if (!domainMatches(pageUrl, siteUrl)) {
			return { ok: false, error: `Refused: the current page (${hostOf(pageUrl) ?? "unknown"}) is not the saved site of this login (${site}) or is not https. Nothing was typed. Open the sign-in page of ${site} and try again.` };
		}

		let values: Awaited<ReturnType<LoginSource["useLogin"]>>;
		try {
			values = await source.useLogin(ctx.userId, login, params.fields);
		} catch (error) {
			// Texto fixo da própria fonte (`VaultUnavailableError`) ou da checagem de dono: sem valor nenhum.
			return { ok: false, error: error instanceof Error ? error.message : "The login could not be read from the vault." };
		}
		const secrets = [values.username, values.password].filter((v): v is string => typeof v === "string" && v.length > 0);
		const safe = (text: string) => redactSecrets(text, secrets).slice(0, 300);

		const done: LoginFillField[] = [];
		const progress = () => (done.length > 0 ? ` Already filled: ${done.map((f) => FIELD_NAME[f]).join(", ")}.` : " Nothing was typed.");
		for (const [index, field] of params.fields.entries()) {
			const value = values[field];
			if (!value) continue;
			try {
				// A aba pode ter mudado de site entre os campos: reconfere antes de CADA digitação.
				const current = await currentUrl();
				if (!domainMatches(current, siteUrl)) return { ok: false, error: `The page moved to another site (${hostOf(current) ?? "unknown"}) before the ${FIELD_NAME[field]} was typed; stopped.${progress()}` };
				const selector = field === "username" && params.usernameSelector ? params.usernameSelector : LOGIN_FIELD_SELECTORS[field];
				const result = await ctx.manager.execBrowserType(ctx.sessionId, { selector, text: value, submit: params.submit && index === params.fields.length - 1, guard: { kind: field, origin: new URL(current).origin } });
				if (result.ok === false) return { ok: false, error: `The ${FIELD_NAME[field]} field was not found on this page.${progress()} Look at the page with browser_map${field === "username" ? " and pass usernameSelector" : ""}.` };
				done.push(field);
			} catch (error) {
				// A VM recusa por regra (campo errado, formulário para outro site, origem trocada) com texto próprio: passa, sem valor.
				const reason = error instanceof Error ? safe(error.message) : "unknown error";
				return { ok: false, error: `The browser did not type the ${FIELD_NAME[field]}: ${reason}${progress()}` };
			}
		}
		if (done.length === 0) return { ok: false, error: "The login has nothing to fill for the requested fields (no username or password saved). Nothing was typed." };

		let landedHost: string | undefined;
		if (params.submit) landedHost = await currentUrl().then((url) => hostOf(url) ?? undefined, () => undefined);
		const data: LoginFillData = { filled: done, site, submitted: params.submit, ...(landedHost && { landedHost }) };
		return { ok: true, data };
	};
}

/** Registrado em `defaultSandboxHandlers` (sandbox.ts). Usa o cofre real; o dono e a VM vêm do run, nunca da ação. */
export const loginFillHandler: SandboxKindHandler = (ctx, params) => createLoginFillHandler(realV4LoginSource)(ctx, params);
