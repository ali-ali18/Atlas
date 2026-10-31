import type { ChatTool } from "@workspace/llm";
import { hookPublicUrl, listUserRoutineWebhooks, saveSkillPendingIntent, persistConversationCardFromEvent } from "@workspace/db";
import { domainMatches, hostOf, isValidSecretName, loginMarker, routineSecretMarker, secretMarker, VAULT_ENVIRONMENT_ID } from "@workspace/shared";
import { getVaultService, routineSlug, VaultError, type VaultService } from "../secrets/vault-service.js";

/**
 * Ferramentas do Cofre. O agente vê só nomes, descrições, domínios e usuários;
 * os valores entram pelo runtime (`{{secret:...}}`, `login_fill`) e nunca voltam ao modelo.
 */

export const SECRET_LIST_TOOL_NAME = "secret_list";
export const ROUTINE_WEBHOOK_INFO_TOOL_NAME = "routine_webhook_info";
export const SECRET_REQUEST_TOOL_NAME = "secret_request";
export const LOGIN_FILL_TOOL_NAME = "login_fill";
export const VAULT_TOOL_NAMES = [SECRET_LIST_TOOL_NAME, ROUTINE_WEBHOOK_INFO_TOOL_NAME, SECRET_REQUEST_TOOL_NAME, LOGIN_FILL_TOOL_NAME] as const;

export const SECRET_LIST_TOOL: ChatTool = {
	type: "function",
	function: {
		name: SECRET_LIST_TOOL_NAME,
		description:
			"List the user's vault (Cofre): names, descriptions, site logins (site domain and username only). You never see values. To USE a secret, write the marker {{secret:<name>}} (or {{login:<name>.username|password|totp}}) inside the arguments of a connector (MCP) or sandbox/code-shell tool call; the runtime swaps in the real value at the last moment and hides it from results. Never ask the user to paste a secret in the chat: use secret_request.",
		parameters: { type: "object", properties: {} },
	},
};

export const ROUTINE_WEBHOOK_INFO_TOOL: ChatTool = {
	type: "function",
	function: {
		name: ROUTINE_WEBHOOK_INFO_TOOL_NAME,
		description:
			"List the user's routines that have a webhook: public URL WITHOUT the secret, the header to send (X-Atlas-Hook-Secret) and the marker {{secret:rotina:<slug>}} that stands for the routine secret. Use it to wire another system (n8n, Zapier...) to a routine without the user pasting the secret: put the URL (no ?secret=) and the header with the marker in the connector tool call (e.g. n8n create_workflow / HTTP Request node). The runtime injects the real secret on the call.",
		parameters: { type: "object", properties: {} },
	},
};

export const SECRET_REQUEST_TOOL: ChatTool = {
	type: "function",
	function: {
		name: SECRET_REQUEST_TOOL_NAME,
		description:
			"Ask the user for a secret you lack (API key, token, password). Shows a card with a password field; the value goes straight to the user's vault, never into the conversation. Afterwards use the marker {{secret:<name>}}. Names: letters, digits, - and _ (e.g. openai-key). Do not call it for something already listed by secret_list.",
		parameters: {
			type: "object",
			properties: {
				names: { type: "array", items: { type: "string" }, description: "Vault names to ask for (1-5), e.g. [\"stripe-key\"]." },
				reason: { type: "string", description: "One short sentence: why you need it." },
			},
			required: ["names", "reason"],
		},
	},
};

export const LOGIN_FILL_TOOL: ChatTool = {
	type: "function",
	function: {
		name: LOGIN_FILL_TOOL_NAME,
		description:
			"Fill a saved site login (username and password) into the CURRENT page of the VM browser without the values passing through you. It only works when the page domain matches the login's registered site (otherwise nothing is typed). It needs no approval for a login that already has its site saved, in chats and routines. A login saved without a site is never typed by name: the first time in a chat the user is asked once to confirm the host (a card), and in a routine it is refused. The 2FA code is never typed by you: if the site asks for it, the user does it. Open the login page first (navigate), then call this; afterwards click the sign-in button or pass submit:true.",
		parameters: {
			type: "object",
			properties: {
				login: { type: "string", description: "Login name from secret_list." },
				fields: { type: "array", items: { type: "string", enum: ["username", "password"] }, description: "What to fill (default username and password); on a two-screen sign-in, username first and password on the next screen." },
				submit: { type: "boolean", description: "Press Enter after the last field." },
				username_selector: { type: "string", description: "Optional CSS selector for the username field when the default detection fails. The password field is always found automatically." },
			},
			required: ["login"],
		},
	},
};

type VaultCard = {
	type: "confirm";
	confirmId: string;
	title: string;
	description?: string;
	confirmLabel?: string;
	cancelLabel?: string;
	alwaysLabel?: string;
	secretsRequest?: { environmentId: string; repo: string; names: string[]; reason: string };
};

export type VaultToolContext = {
	userId?: string;
	botId?: string;
	botName?: string;
	conversationId?: string;
	runId?: string;
	origin?: string;
	vault?: VaultService;
	/** Navegador da VM (login_fill). */
	browser?: {
		currentUrl: () => Promise<string>;
		type: (selector: string, text: string, submit: boolean, guard?: { kind: "password" | "username"; origin?: string }) => Promise<void>;
		/** URL e título da página agora (lidos depois de enviar o login). */
		readPage?: () => Promise<{ url: string; title?: string }>;
	};
	/** Injetáveis em testes. */
	saveIntent?: typeof saveSkillPendingIntent;
	persistCard?: (conversationId: string, card: VaultCard) => Promise<unknown>;
	unattended?: boolean;
};

function need<T>(value: T | undefined, message: string): T {
	if (value === undefined || value === null || (value as unknown) === "") throw new Error(message);
	return value;
}

export async function executeSecretList(ctx: VaultToolContext): Promise<{ summary: string }> {
	const userId = need(ctx.userId, "usuário desconhecido");
	const vault = ctx.vault ?? getVaultService();
	const items = await vault.listMeta(userId);
	if (items.length === 0) return { summary: "O cofre está vazio. Peça o que faltar com secret_request (nunca peça para colar o valor no chat)." };
	const lines = items.map((item) => {
		if (item.kind === "login") {
			return `- login "${item.name}" (${item.label || item.domain || item.name}): site ${item.domain ?? "?"}, usuário ${item.username ?? "(não informado)"}. Para entrar no site use login_fill; marcadores: ${loginMarker(item.name, "username")}, ${loginMarker(item.name, "password")}, ${loginMarker(item.name, "totp")}.`;
		}
		return `- segredo "${item.name}"${item.description ? `: ${item.description}` : ""}. Marcador: ${secretMarker(item.name)}`;
	});
	return { summary: `Cofre do usuário (você não vê os valores):\n${lines.join("\n")}` };
}

export async function executeRoutineWebhookInfo(ctx: VaultToolContext): Promise<{ summary: string }> {
	const userId = need(ctx.userId, "usuário desconhecido");
	const vault = ctx.vault ?? getVaultService();
	const hooks = await listUserRoutineWebhooks(userId);
	if (hooks.length === 0) return { summary: "Nenhuma rotina com webhook. Crie uma rotina com gatilho de webhook (propose_routine) e chame esta ferramenta de novo." };
	const lines: string[] = [];
	for (const hook of hooks) {
		const slug = routineSlug(hook);
		const hasSecret = Boolean(await vault.routineSecret(userId, hook));
		lines.push(
			[
				`- Rotina "${hook.name}" (${hook.enabled ? "ligada" : "pausada"}), id ${hook.routineId}`,
				`  URL (POST, corpo JSON, sem segredo): ${hookPublicUrl(hook.hookKey)}`,
				`  Cabeçalho: X-Atlas-Hook-Secret: ${routineSecretMarker(slug)}`,
				hasSecret ? "  Segredo disponível para o runtime: sim." : "  Segredo disponível para o runtime: NÃO (rotina antiga). Peça ao usuário para usar \"Gerar novo segredo\" no painel da rotina; depois o marcador funciona.",
			].join("\n"),
		);
	}
	return {
		summary: [
			"Webhooks das rotinas do usuário:",
			...lines,
			"Como ligar outro sistema: use a URL SEM ?secret= e envie o cabeçalho X-Atlas-Hook-Secret com o marcador acima. No n8n, nó HTTP Request: Method POST, URL acima, Send Headers com X-Atlas-Hook-Secret = o marcador, Body JSON. Ao chamar a ferramenta do conector (ex. create_workflow) escreva o marcador literalmente: o runtime grava o valor real só no n8n (que é do usuário) e você nunca o vê. O usuário aprova no cartão.",
		].join("\n"),
	};
}

async function persist(ctx: VaultToolContext, conversationId: string, card: VaultCard) {
	if (ctx.persistCard) return ctx.persistCard(conversationId, card);
	return persistConversationCardFromEvent(conversationId, card as never).catch(() => undefined);
}

export async function executeSecretRequest(
	args: Record<string, unknown>,
	ctx: VaultToolContext,
): Promise<{ summary: string; confirmEvent?: VaultCard }> {
	const userId = need(ctx.userId, "usuário desconhecido");
	if (ctx.unattended) throw new Error("secret_request precisa de uma pessoa para responder; não está disponível em rotinas.");
	const conversationId = need(ctx.conversationId, "secret_request só funciona dentro de uma conversa.");
	const names: string[] = [];
	for (const raw of Array.isArray(args.names) ? args.names.slice(0, 5) : []) {
		if (!isValidSecretName(raw)) throw new Error(`Nome inválido "${String(raw).slice(0, 40)}": use letras, números, - e _ (ex.: stripe-key).`);
		if (!names.includes(raw)) names.push(raw);
	}
	if (names.length === 0) throw new Error("Informe names: ao menos um nome.");
	const reason = typeof args.reason === "string" ? args.reason.trim().slice(0, 300) : "";
	if (!reason) throw new Error("Informe reason: por que você precisa disso.");
	const vault = ctx.vault ?? getVaultService();
	const existing = new Set((await vault.listMeta(userId)).map((item) => item.name));
	const missing = names.filter((name) => !existing.has(name));
	if (missing.length === 0) return { summary: `Já existem no cofre: ${names.join(", ")}. Use os marcadores ${names.map(secretMarker).join(", ")}.` };
	const confirmId = `confirm-${ctx.runId ?? "local"}`;
	const secretsRequest = { environmentId: VAULT_ENVIRONMENT_ID, repo: "", names: missing, reason };
	await (ctx.saveIntent ?? saveSkillPendingIntent)({
		userId,
		conversationId,
		payload: { kind: "confirm", action: "request-secrets", confirmId, botId: ctx.botId, secretsRequest: { environmentId: VAULT_ENVIRONMENT_ID, repo: "", names: missing } },
		ttlMs: 60 * 60_000,
	});
	const card: VaultCard = {
		type: "confirm",
		confirmId,
		title: missing.length === 1 ? `O bot precisa da chave ${missing[0]}` : `O bot precisa de: ${missing.join(", ")}`,
		description: reason,
		confirmLabel: "Salvar no cofre",
		cancelLabel: "Agora não",
		secretsRequest,
	};
	await persist(ctx, conversationId, card);
	return {
		summary: `Card enviado ao usuário pedindo ${missing.join(", ")} (o valor vai direto ao cofre). Aguarde; depois use ${missing.map(secretMarker).join(", ")}. Não peça o valor no chat.`,
		confirmEvent: card,
	};
}

const DEFAULT_SELECTORS = {
	username:
		'input[autocomplete="username"], input[type="email"], input[name*="user" i], input[name*="email" i], input[name*="login" i], input[id*="user" i], input[id*="email" i], input[id*="login" i], input[type="text"]',
	password: 'input[type="password"]',
	totp: 'input[autocomplete="one-time-code"], input[name*="otp" i], input[name*="code" i], input[name*="token" i], input[id*="otp" i], input[id*="code" i], input[inputmode="numeric"]',
} as const;

/** Seletor do campo de código (2FA/e-mail/SMS) usado também pelo runtime ao digitar o código do e-mail. */
export const LOGIN_CODE_SELECTOR = DEFAULT_SELECTORS.totp;

export async function executeLoginFill(
	args: Record<string, unknown>,
	ctx: VaultToolContext,
): Promise<{ summary: string; confirmEvent?: VaultCard }> {
	const userId = need(ctx.userId, "usuário desconhecido");
	const browser = need(ctx.browser, "login_fill precisa do navegador da VM (computador) neste run.");
	const vault = ctx.vault ?? getVaultService();
	const wanted = String(args.login ?? "").trim();
	const logins = (await vault.listMeta(userId)).filter((item) => item.kind === "login");
	const meta = logins.find((item) => item.name === wanted) ?? logins.find((item) => item.name.toLowerCase() === wanted.toLowerCase() || item.label.toLowerCase() === wanted.toLowerCase());
	if (!meta) throw new Error(`Login "${wanted.slice(0, 60)}" não encontrado no cofre. Logins: ${logins.map((item) => item.name).join(", ") || "(nenhum)"}. Peça ao usuário para cadastrar em Configurações → Cofre.`);
	if (args.password_selector !== undefined || args.totp_selector !== undefined) {
		throw new Error("Recusado: o campo de senha é sempre localizado automaticamente (input de senha da página principal); não aceito seletor para ele. Nada foi preenchido.");
	}
	const requested = Array.isArray(args.fields) ? args.fields : ["username", "password"];
	if (requested.includes("totp")) {
		throw new Error("Recusado: o código 2FA não é digitado pelo bot. Peça ao usuário para informá-lo no site ou no cartão de código. Nada foi preenchido.");
	}
	const fields = requested.filter((f): f is "username" | "password" => f === "username" || f === "password");
	if (fields.length === 0) throw new Error("Informe fields: username e/ou password.");

	// Casamento por nome NUNCA autoriza digitação. Item sem site: no chat o dono confirma o host uma vez (o "Sim" grava o
	// site no item); em rotina não há quem confirme, então recusa e o run termina pedindo o vínculo.
	const pageUrl = await browser.currentUrl();
	const host = hostOf(pageUrl) ?? "desconhecido";
	if (!meta.siteUrl) {
		if (ctx.unattended) {
			throw new Error(`O login "${meta.name}" não tem site cadastrado, então a rotina não o usa. Nada foi preenchido. Termine o run avisando o dono (em palavras simples) que precisa vincular o site desse login: ele abre a conversa e confirma uma vez, ou cadastra o site em Configurações > Cofre.`);
		}
		if (!/^https:\/\//i.test(pageUrl) || host === "desconhecido") throw new Error(`A página atual (${host}) não é https; não vinculo o login "${meta.name}" a ela. Nada foi preenchido.`);
		const conversationId = need(ctx.conversationId, "login_fill só funciona dentro de uma conversa.");
		const confirmId = `confirm-${ctx.runId ?? "local"}`;
		const site = meta.label || meta.name;
		await (ctx.saveIntent ?? saveSkillPendingIntent)({
			userId,
			conversationId,
			payload: { kind: "confirm", action: "vault-use", confirmId, botId: ctx.botId, vaultUse: { secretId: meta.id, name: meta.name, label: site, domain: host, linkHost: host } },
			ttlMs: 60 * 60_000,
		});
		const card: VaultCard = {
			type: "confirm",
			confirmId,
			title: `Usar o login do Cofre ${site} em ${host}?`,
			description: `O bot vai preencher usuário e senha em ${host} e lembrar desse site para as próximas vezes, inclusive nas rotinas. Ele não vê a senha.`,
			confirmLabel: "Sim, usar",
			cancelLabel: "Agora não",
		};
		await persist(ctx, conversationId, card);
		return { summary: `Card enviado ao usuário: "Usar o login do Cofre ${site} em ${host}?". Nada foi preenchido; aguarde a decisão e chame login_fill de novo.`, confirmEvent: card };
	}

	// Anti-phishing: a senha só é digitada na página do site do item (host salvo ou subdomínio dele; Public Suffix List).
	// O item é do próprio dono (a lista acima é escopada por `userId`); sem aprovação por uso, no chat e em rotina.
	const siteDomain = meta.domain ?? hostOf(meta.siteUrl) ?? host;
	if (!domainMatches(pageUrl, meta.siteUrl)) {
		throw new Error(`Recusado: a página atual (${host}) não é do site deste login (${siteDomain}). Nada foi preenchido. Abra a página de entrada do site certo (https) e tente de novo.`);
	}

	const use = await vault.useLogin(userId, meta.id, fields, { actor: "bot", botId: ctx.botId, botName: ctx.botName, conversationId: ctx.conversationId });
	const submit = args.submit === true;
	const done: string[] = [];
	for (const [index, field] of fields.entries()) {
		const value = use[field];
		if (!value) continue;
		// Revalida a aba imediatamente antes de CADA digitação (inclusive entre usuário e senha): se mudou de site, aborta.
		const current = await browser.currentUrl();
		if (!domainMatches(current, meta.siteUrl)) {
			throw new Error(`A página mudou de site (${hostOf(current) ?? "desconhecido"}) antes de digitar; interrompi sem digitar o resto. ${done.length ? `Já foi preenchido: ${done.join(", ")}.` : "Nada foi preenchido."}`);
		}
		const custom = field === "username" && typeof args.username_selector === "string" && args.username_selector.trim() ? String(args.username_selector).slice(0, 300) : undefined;
		const origin = new URL(current).origin;
		try {
			await browser.type(custom ?? DEFAULT_SELECTORS[field], value, submit && index === fields.length - 1, { kind: field, origin });
			done.push(field === "username" ? "usuário" : "senha");
		} catch (error) {
			const message = error instanceof Error ? error.message : "";
			if (/^Recusado|mudou de site|nada foi digitado/i.test(message)) throw new Error(message);
			throw new Error(`Não consegui achar o campo de ${field} nesta página. Use browser_snapshot${field === "username" ? " e passe username_selector" : ""}.`);
		}
	}
	// Depois de enviar, devolve onde a página foi parar: o modelo não deve afirmar "entrei" sem olhar a tela.
	let landed = "";
	if (submit && browser.readPage) {
		try {
			const page = await browser.readPage();
			landed = ` Depois de enviar, a página está em: ${page.title ? `"${page.title.slice(0, 120)}" ` : ""}(${page.url.slice(0, 300)}). Confira com browser_snapshot antes de dizer que entrou.`;
		} catch {
			landed = " Não consegui ler a página depois de enviar; confira com browser_snapshot antes de dizer que entrou.";
		}
	}
	return { summary: `Preenchi ${done.join(", ")} em ${siteDomain}${submit ? " e enviei" : ""} sem passar os valores por você. ${submit ? "Veja o resultado da página." : "Clique no botão de entrar (ou chame de novo com submit:true)."}${landed}` };
}

export { VaultError };
