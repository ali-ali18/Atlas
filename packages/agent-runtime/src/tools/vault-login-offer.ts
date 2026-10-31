import { detectEmailCodeStep, detectExtraLoginStep, detectLoginWall, domainMatches, pickVaultLoginForPage, type LoginVaultOffer } from "@workspace/shared";
import { fetchLoginEmailCode, type EmailSource } from "./email-code.js";
import type { VaultService } from "../secrets/vault-service.js";
import { executeLoginFill, LOGIN_CODE_SELECTOR, type VaultToolContext } from "./vault-tools.js";

/**
 * Caminho automático do Cofre para o muro de login. Quem decide é o runtime,
 * não o modelo: ao parar numa tela de login, procura no cofre do dono um login
 * cujo site casa (mesma regra de domínio do `login_fill`) e o card passa a
 * oferecer "Entrar com o login do Cofre". Só metadados saem daqui.
 */

/** Marca "já usei o Cofre nesta URL" no `loginAsked` do run (vai no checkpoint). */
export function vaultTriedKey(url: string): string {
	return `vault-tried:${url}`;
}

export async function findVaultLoginOffer(vault: Pick<VaultService, "listMeta">, userId: string, pageUrl: string, emailCode?: string): Promise<LoginVaultOffer | null> {
	const pick = pickVaultLoginForPage(await vault.listMeta(userId), pageUrl);
	// Só o site SALVO autoriza o login automático. Casar pelo nome nunca digita (vira dica ao modelo) e ambíguo
	// (duas contas para o mesmo site) o runtime não chuta: o modelo pergunta qual item usar.
	if (pick.kind !== "match" || pick.byName) return null;
	const meta = pick.item;
	const domain = meta.domain ?? new URL(pageUrl).hostname.replace(/^www\./, "");
	return { name: meta.name, label: meta.label || domain, ...(meta.username ? { username: meta.username } : {}), domain, ...(emailCode ? { emailCode } : {}) };
}

/**
 * Nota ao modelo (só nomes, nunca valores) quando o runtime NÃO entra sozinho mas há item do cofre que serve:
 * mais de um item para a página (pergunta qual usar) ou um item sem site salvo que parece ser deste site
 * (login_fill pede ao dono, uma vez, para vincular o host). Em rotina ninguém responde: o run termina avisando o dono.
 */
export async function vaultHintNote(vault: Pick<VaultService, "listMeta">, userId: string, pageUrl: string, unattended = false): Promise<string | null> {
	try {
		const pick = pickVaultLoginForPage(await vault.listMeta(userId), pageUrl);
		if (pick.kind === "none" || (pick.kind === "match" && !pick.byName)) return null;
		const names = pick.kind === "ambiguous" ? pick.items.map((item) => `"${item.name}"`).join(", ") : `"${pick.item.name}"`;
		if (unattended) {
			return pick.kind === "ambiguous"
				? `The vault has several logins that could fit this page: ${names}. This is an unattended routine, so do NOT type anything. Finish with ONE short message to the owner (their language, plain words): the routine needs to sign in here and they should say which vault login to use.`
				: `The vault login ${names} may be for this site but has no site saved, so a routine never types it. Do NOT type anything. Finish with ONE short message to the owner (their language, plain words): the routine needs to sign in here with that vault login; they should open the conversation and confirm the site once (or save the site in Settings > Vault), then the routine will use it by itself.`;
		}
		return pick.kind === "ambiguous"
			? `The vault has several logins that could fit this page: ${names}. Ask the user which one to use (in their language), then call login_fill with that name.`
			: `The vault login ${names} may be for this site but has no site saved. Call login_fill with it: the user will be asked once to confirm using it on this host, and after that it works by itself. Never type credentials any other way.`;
	} catch {
		return null;
	}
}

/** Domínios dos logins salvos (nunca usuário nem senha), sem repetição, em ordem estável. */
export async function listVaultLoginDomains(vault: Pick<VaultService, "listMeta">, userId: string): Promise<string[]> {
	const items = await vault.listMeta(userId);
	return [...new Set(items.filter((item) => item.kind === "login" && item.domain).map((item) => item.domain as string))].sort();
}

/** Linha curta do prompt: o modelo sabe que o cofre tem logins (só domínios). */
export function vaultLoginsPromptLine(domains: readonly string[]): string {
	if (domains.length === 0) return "";
	const shown = domains.slice(0, 12);
	const more = domains.length > shown.length ? ` e mais ${domains.length - shown.length}` : "";
	return `Saved site logins in the user's vault (${domains.length}): ${shown.join(", ")}${more}. When asked to sign in to one of these sites, call login_fill (never ask the user to log in by hand first); the runtime also offers the vault login automatically on a login screen.`;
}

type OfferableEvent = {
	url: string;
	reason?: "login" | "captcha";
	composioToolkit?: string;
	connector?: unknown;
	vault?: LoginVaultOffer;
	vaultTried?: string;
};

const VAULT_TRIED_NOTE = "Usei o login do Cofre, mas o site pediu mais um passo que só você resolve (código, captcha ou confirmação).";

/**
 * Enriquece o evento de login: com login casando no cofre, o card oferece
 * "Entrar"; se o Cofre já foi usado nesta URL, o card humano explica o que falta.
 * Falha do cofre (indisponível, sem chave) nunca derruba o run: cai no card humano.
 */
export async function withVaultOffer<T extends OfferableEvent>(
	event: T,
	deps: { vault: Pick<VaultService, "listMeta">; userId: string; loginAsked: Set<string>; emailSourceName?: string },
): Promise<T> {
	if (event.reason === "captcha" || event.connector || event.composioToolkit) return event;
	if (deps.userId === "default") return event;
	if (deps.loginAsked.has(vaultTriedKey(event.url))) return { ...event, vaultTried: event.vaultTried ?? VAULT_TRIED_NOTE };
	try {
		const offer = await findVaultLoginOffer(deps.vault, deps.userId, event.url, deps.emailSourceName);
		return offer ? { ...event, vault: offer } : event;
	} catch {
		return event;
	}
}

export type VaultResumeResult = { kind: "filled"; summary: string; emailCode?: boolean } | { kind: "needs-human"; reason: string; codeField?: boolean };

const NEEDS_CODE_NOTE = "O site pediu o código enviado ao seu e-mail. Digite o código que chegou no seu e-mail aqui no cartão: ele vai direto para a página, sem passar pelo modelo.";

type ReadPage = { url: string; title?: string; text?: string; lines?: readonly string[] };

function pageNeedsPerson(page: ReadPage): boolean {
	return detectExtraLoginStep(page) || Boolean(detectLoginWall({ url: page.url, title: page.title, text: page.text, lines: page.lines ?? page.text?.split("\n") }));
}

/**
 * "Entrar" no card: o clique é a aprovação (vault-use). O runtime preenche o
 * login (duas etapas: usuário e depois senha), espera a página assentar e confere:
 * se ainda há tela de login, captcha, código ou passkey, devolve `needs-human`.
 */
export async function fillVaultLoginOnResume(input: {
	offer: LoginVaultOffer;
	userId: string;
	botId?: string;
	conversationId?: string;
	vault: VaultService;
	fillContext: VaultToolContext;
	readPage: () => Promise<ReadPage>;
	settle?: () => Promise<void>;
	/** Conector de e-mail do usuário: busca o código quando o site o pede. */
	emailSource?: EmailSource | null;
	/** Teste: espera/relógio da busca do código. */
	emailSearch?: { sleep?: (ms: number) => Promise<void>; now?: () => number; timeoutMs?: number; intervalMs?: number };
}): Promise<VaultResumeResult> {
	const { offer, vault, userId } = input;
	const settle = input.settle ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 3000)));
	const startedAtMs = (input.emailSearch?.now ?? Date.now)();
	try {
		const meta = (await vault.listMeta(userId)).find((item) => item.kind === "login" && item.name === offer.name);
		if (!meta) return { kind: "needs-human", reason: "Esse login não está mais no Cofre." };
		const ctx: VaultToolContext = { ...input.fillContext, vault, userId, botId: input.botId, conversationId: input.conversationId, unattended: false };
		try {
			await executeLoginFill({ login: offer.name, fields: ["username", "password"], submit: true }, ctx);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// Entrada em duas telas (usuário, depois senha): envia o usuário e preenche a senha na seguinte.
			if (!/campo de password/.test(message)) throw error;
			await executeLoginFill({ login: offer.name, fields: ["username"], submit: true }, ctx);
			await settle();
			await executeLoginFill({ login: offer.name, fields: ["password"], submit: true }, ctx);
		}
		await settle();
		let page = await input.readPage();
		if (detectEmailCodeStep(page)) {
			if (!input.emailSource) return { kind: "needs-human", reason: NEEDS_CODE_NOTE, codeField: true };
			const code = await fetchLoginEmailCode({ source: input.emailSource, siteHost: offer.domain, startedAtMs, ...input.emailSearch });
			if (!code) return { kind: "needs-human", reason: `Não encontrei o código no seu ${input.emailSource.name} a tempo. ${NEEDS_CODE_NOTE}`, codeField: true };
			// O código só entra na página do site do item (a aba pode ter ido para outro lugar depois do login) e o
			// control server reconfere campo e origem antes de digitar, como na senha.
			const browser = input.fillContext.browser!;
			const current = await browser.currentUrl();
			if (!meta.siteUrl || !domainMatches(current, meta.siteUrl)) {
				return { kind: "needs-human", reason: `A página mudou de site; não digitei o código. ${NEEDS_CODE_NOTE}`, codeField: true };
			}
			await browser.type(LOGIN_CODE_SELECTOR, code, true, { kind: "code", origin: new URL(current).origin });
			await settle();
			page = await input.readPage();
			if (pageNeedsPerson(page)) return { kind: "needs-human", reason: detectEmailCodeStep(page) ? `O código do ${input.emailSource.name} não foi aceito. ${NEEDS_CODE_NOTE}` : VAULT_TRIED_NOTE, ...(detectEmailCodeStep(page) ? { codeField: true } : {}) };
			return { kind: "filled", emailCode: true, summary: `O runtime entrou em ${offer.domain} com o login do Cofre "${offer.name}" e o código de verificação do seu e-mail (você não viu a senha nem o código).` };
		}
		if (pageNeedsPerson(page)) {
			return { kind: "needs-human", reason: VAULT_TRIED_NOTE };
		}
		return { kind: "filled", summary: `O runtime entrou em ${offer.domain} com o login do Cofre "${offer.name}" (você não viu a senha).` };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { kind: "needs-human", reason: `Não consegui usar o login do Cofre: ${message.slice(0, 200)}` };
	}
}

/**
 * Código digitado no card (e-mail/SMS): o runtime o digita na página, espera e
 * confere. O modelo só recebe "[login-email-code-filled]".
 */
export async function typeLoginCodeOnResume(input: {
	code: string;
	type: (selector: string, text: string, submit: boolean) => Promise<void>;
	readPage: () => Promise<{ url: string; title?: string; text?: string }>;
	settle: () => Promise<void>;
}): Promise<VaultResumeResult> {
	try {
		await input.type(LOGIN_CODE_SELECTOR, input.code, true);
		await input.settle();
		const page = await input.readPage();
		if (detectEmailCodeStep(page)) return { kind: "needs-human", reason: `O site não aceitou o código. ${NEEDS_CODE_NOTE}`, codeField: true };
		if (pageNeedsPerson(page)) return { kind: "needs-human", reason: VAULT_TRIED_NOTE };
		return { kind: "filled", emailCode: true, summary: "O runtime digitou o código de verificação informado pelo usuário (você não o viu)." };
	} catch {
		return { kind: "needs-human", reason: `Não achei o campo do código na página. ${NEEDS_CODE_NOTE}`, codeField: true };
	}
}

/**
 * Muro de login com login salvo no Cofre: o runtime entra sozinho ANTES de mostrar o card (sem aprovação:
 * o item é do dono do run e a senha só é digitada na página do site do item). Depois do preenchimento, confere a tela
 * (snapshot): se ainda há login, código, captcha ou senha errada, devolve o card humano explicando o que falta.
 */
export type AutoVaultLoginResult =
	| { kind: "skip" }
	| { kind: "filled"; summary: string }
	| { kind: "needs-human"; reason: string; codeField?: boolean };

export async function tryAutoVaultLogin(input: {
	event: { reason?: "login" | "captcha"; vault?: LoginVaultOffer; vaultTried?: string };
	userId: string;
	botId?: string;
	conversationId?: string;
	vault: VaultService;
	fillContext: VaultToolContext;
	readPage: () => Promise<ReadPage>;
	settle?: () => Promise<void>;
	emailSource?: EmailSource | null;
	emailSearch?: Parameters<typeof fillVaultLoginOnResume>[0]["emailSearch"];
}): Promise<AutoVaultLoginResult> {
	const { event } = input;
	if (!event.vault || event.vaultTried || event.reason === "captcha") return { kind: "skip" };
	try {
		// O item é do dono do run (listMeta é escopado por userId); sem aprovação por uso.
		const meta = (await input.vault.listMeta(input.userId)).find((item) => item.kind === "login" && item.name === event.vault!.name);
		if (!meta) return { kind: "skip" };
	} catch {
		return { kind: "skip" };
	}
	const result = await fillVaultLoginOnResume({
		offer: event.vault,
		userId: input.userId,
		botId: input.botId,
		conversationId: input.conversationId,
		vault: input.vault,
		fillContext: input.fillContext,
		readPage: input.readPage,
		settle: input.settle,
		emailSource: input.emailSource,
		emailSearch: input.emailSearch,
	});
	if (result.kind === "filled") return { kind: "filled", summary: result.summary };
	return { kind: "needs-human", reason: result.reason, ...(result.codeField ? { codeField: true } : {}) };
}
