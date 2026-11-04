// Cartões de pedido do run (login de conector, login de página, segredo do Cofre): do que o servidor manda (cartão
// gravado ou evento ao vivo) ao que a tela desenha, e as decisões puras de cada um (botões, campos, desfecho).
// Nada aqui toca em rede nem guarda valor digitado: a credencial e o segredo vivem só no campo e vão direto à API.
import { registrableDomain, suggestSecretName, VAULT_ENVIRONMENT_ID, type LoginConnector, type LoginVaultOffer, type SecretsRequestInfo } from "@workspace/shared";
import type { ChatItem, ConfirmStatus } from "./chat-types";

export type LoginItem = Extract<ChatItem, { kind: "login" }>;
export type SecretsItem = Extract<ChatItem, { kind: "secrets" }>;

/** Campos do pedido de login, iguais no cartão gravado e no evento ao vivo (`type: "login"`). */
export type LoginFields = {
	loginId: string;
	site: string;
	url: string;
	runId?: string;
	status?: "pending" | "done";
	reason?: "login" | "captcha";
	composioToolkit?: string;
	connector?: LoginConnector;
	vault?: LoginVaultOffer;
	vaultTried?: string;
	codeField?: boolean;
};

export function loginToItem(id: string, fields: LoginFields, createdAt?: string): LoginItem {
	return {
		id,
		...(createdAt ? { createdAt } : {}),
		kind: "login",
		loginId: fields.loginId,
		site: fields.site,
		url: fields.url,
		status: fields.status === "done" ? "done" : "pending",
		...(fields.runId ? { runId: fields.runId } : {}),
		...(fields.reason === "captcha" ? { reason: "captcha" as const } : {}),
		...(fields.composioToolkit ? { composioToolkit: fields.composioToolkit } : {}),
		...(fields.connector ? { connector: fields.connector } : {}),
		...(fields.vault ? { vault: fields.vault } : {}),
		...(fields.vaultTried ? { vaultTried: fields.vaultTried } : {}),
		...(fields.codeField ? { codeField: true } : {}),
	};
}

/** Cartão de conectar app (com `connector`, ou o antigo só com `composioToolkit`) ou login de página. */
export function loginVariant(item: Pick<LoginItem, "connector" | "composioToolkit">): "connector" | "page" {
	return item.connector || item.composioToolkit ? "connector" : "page";
}

/** O conector que o cartão desenha: o enviado, ou o do cartão antigo (só o slug do Composio). */
export function connectorOf(item: Pick<LoginItem, "connector" | "composioToolkit">): LoginConnector | null {
	if (item.connector) return item.connector;
	if (item.composioToolkit) return { kind: "composio", id: item.composioToolkit, name: item.composioToolkit, description: "", icon: null };
	return null;
}

/** Só nativo (Marketplace) e Composio têm login pelo navegador; MCP próprio e API pedem dados que só o web coleta. */
export function connectorCanAuthorize(connector: LoginConnector): boolean {
	return connector.kind === "native" || connector.kind === "composio";
}

export const connectorNote = (botName: string): string => `O ${botName.trim() || "bot"} sempre pergunta antes de fazer alterações. Desconecte quando quiser.`;

/** Domínio de um endereço, sem "www." (vazio se não for um endereço). */
export function hostOf(raw: string): string {
	try {
		return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.replace(/^www\./i, "");
	} catch {
		return "";
	}
}

/** Domínios em que o preenchimento vale: o do endereço da página e o do cofre, sem repetir. */
export function siteDomains(item: Pick<LoginItem, "url" | "site" | "vault">): string[] {
	const out: string[] = [];
	// `site` é o nome de exibição ("GitHub"); só vale como domínio quando parece um ("github.com").
	const siteHost = item.site.includes(".") ? hostOf(item.site) : "";
	for (const domain of [hostOf(item.url), item.vault?.domain ? hostOf(item.vault.domain) : "", siteHost]) {
		if (domain && !out.includes(domain)) out.push(domain);
	}
	return out.slice(0, 3);
}

export function siteName(item: Pick<LoginItem, "url" | "site">): string {
	return item.site.trim() || hostOf(item.url) || "o site";
}

/** O código digitado serve ao runtime (3 a 12 letras, números ou hífen), a mesma regra do servidor. */
export function validLoginCode(code: string): boolean {
	return /^[A-Za-z0-9-]{3,12}$/.test(code.replace(/\s+/g, ""));
}

export function cleanLoginCode(code: string): string {
	return code.replace(/\s+/g, "");
}

export type DrawerFields = {
	/** O site pediu um código (e-mail/SMS) e o card tem o campo. */
	code: boolean;
	/** Dá para guardar usuário e senha deste site no Cofre (não há login do Cofre para ele, nem captcha). */
	credentials: boolean;
	/** Há login do Cofre para o site: "Entrar" usa o cofre, sem digitar nada. */
	vault: LoginVaultOffer | null;
	captcha: boolean;
};

/** O que a gaveta do login oferece, só com o que o contrato aceita (ver `resumeRun`, `/v1/vault`). */
export function drawerFields(item: Pick<LoginItem, "reason" | "codeField" | "vault" | "vaultTried">): DrawerFields {
	const captcha = item.reason === "captcha";
	return {
		code: item.codeField === true && !captcha,
		credentials: !captcha && !item.vault && !item.vaultTried,
		vault: captcha ? null : (item.vault ?? null),
		captcha,
	};
}

/** Qual é a ação do botão azul da gaveta e se ela já pode ser usada. */
export type DrawerSave = { kind: "vault" | "code" | "credentials" | "none"; enabled: boolean };

export function drawerSave(fields: DrawerFields, input: { code: string; username: string; password: string }): DrawerSave {
	if (fields.vault) return { kind: "vault", enabled: true };
	if (fields.code && validLoginCode(input.code)) return { kind: "code", enabled: true };
	if (fields.credentials && input.username.trim() && input.password) return { kind: "credentials", enabled: true };
	if (fields.code) return { kind: "code", enabled: false };
	return { kind: fields.credentials ? "credentials" : "none", enabled: false };
}

/** Corpo do `POST /v1/vault` (login do site). A senha só existe aqui, na chamada; nunca em estado, cache ou log. */
export function vaultLoginBody(item: Pick<LoginItem, "url" | "site">, username: string, password: string): { kind: "login"; name: string; label: string; siteUrl: string; username: string; password: string } {
	const host = hostOf(item.url);
	const base = host ? registrableDomain(host) || host : item.site;
	return { kind: "login", name: suggestSecretName(base, "login"), label: siteName(item).slice(0, 120), siteUrl: item.url.slice(0, 500), username: username.trim().slice(0, 300), password };
}

/** Desfecho do cartão de login resolvido (o selo que fica no lugar dos botões). */
export function loginOutcome(item: Pick<LoginItem, "status" | "connector" | "composioToolkit" | "reason">): { tone: "success" | "muted"; label: string } | null {
	if (item.status !== "done") return null;
	if (loginVariant(item) === "connector") return { tone: "success", label: item.connector?.noAuth ? "Ativado" : "Conectado" };
	return { tone: "success", label: item.reason === "captcha" ? "Verificado" : "Concluído" };
}

/**
 * "Concluído" na gaveta: nunca descarta em silêncio o que foi digitado.
 * - código válido digitado: retoma com o código;
 * - usuário e senha digitados e ainda não guardados: guarda no Cofre e só então retoma;
 * - só um dos dois: avisa (não retoma, não descarta);
 * - nada digitado (ou já guardado): retoma simples.
 */
export type ConcludeAction = { kind: "resume"; options: { via?: "code"; code?: string } } | { kind: "save-then-resume" } | { kind: "block"; message: string };

export function concludeAction(fields: DrawerFields, input: { code: string; username: string; password: string }): ConcludeAction {
	if (fields.code && validLoginCode(input.code)) return { kind: "resume", options: { via: "code", code: cleanLoginCode(input.code) } };
	if (fields.code && input.code.trim()) return { kind: "block", message: "O código está incompleto. Termine de digitar ou apague para continuar." };
	if (fields.credentials) {
		const user = input.username.trim().length > 0;
		const pass = input.password.length > 0;
		if (user && pass) return { kind: "save-then-resume" };
		if (user || pass) return { kind: "block", message: "Preencha usuário e senha, ou apague o que digitou, para continuar." };
	}
	return { kind: "resume", options: {} };
}

// ---- ícone do conector (copiado de `lib/apps.ts` de feat/mobile-aplicativos; unificar depois) --------------------------

/** Endereço da imagem do ícone: caminho do app (`/connectors/x.svg`, no servidor) ou https do Composio; o resto vira `null` (cai na inicial). */
export function resolveIconUri(src: string | null, serverUrl: string | null): string | null {
	if (!src) return null;
	if (/^\/(?!\/)[A-Za-z0-9._\-/]+$/.test(src) && !src.includes("..")) {
		if (!serverUrl) return null;
		try {
			return new URL(src, serverUrl).href;
		} catch {
			return null;
		}
	}
	try {
		const url = new URL(src);
		return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
	} catch {
		return null;
	}
}

/** SVG não abre no `Image` do React Native: vai pelo `SvgUri`. */
export function isSvgUri(uri: string): boolean {
	try {
		return new URL(uri).pathname.toLowerCase().endsWith(".svg");
	} catch {
		return false;
	}
}

/** Inicial para o ícone sem imagem. */
export function initialOf(name: string): string {
	const letter = name.trim().match(/[\p{L}\p{N}]/u);
	return letter ? letter[0]!.toUpperCase() : "?";
}

// ---- segredo ------------------------------------------------------------------------------------------------

/** O pedido de segredo é do Cofre (o único que o app desenha; os de ambiente de código ficam no web). */
export function isVaultSecretsRequest(info: SecretsRequestInfo | undefined): info is SecretsRequestInfo {
	return !!info && info.environmentId === VAULT_ENVIRONMENT_ID && info.names.length > 0;
}

export function secretsToItem(
	id: string,
	card: { confirmId: string; title: string; description?: string; status?: ConfirmStatus | "pending" | "approved" | "rejected"; confirmLabel?: string; cancelLabel?: string; secretsRequest?: SecretsRequestInfo },
	createdAt?: string,
): SecretsItem | null {
	if (!isVaultSecretsRequest(card.secretsRequest)) return null;
	return {
		id,
		...(createdAt ? { createdAt } : {}),
		kind: "secrets",
		confirmId: card.confirmId,
		title: card.title,
		names: card.secretsRequest.names.slice(0, 20),
		status: card.status ?? "pending",
		...(card.description ? { description: card.description } : {}),
		...(card.confirmLabel ? { confirmLabel: card.confirmLabel } : {}),
		...(card.cancelLabel ? { cancelLabel: card.cancelLabel } : {}),
	};
}

/** Só os campos preenchidos entram (como no web); o valor vai tal qual, sem aparar. */
export function secretEntries(names: readonly string[], values: Readonly<Record<string, string>>): { name: string; value: string }[] {
	return names.flatMap((name) => (values[name] ? [{ name, value: values[name]! }] : []));
}

/** O botão "Salvar" fica apagado até haver ao menos um valor. */
export function canSaveSecrets(names: readonly string[], values: Readonly<Record<string, string>>): boolean {
	return secretEntries(names, values).length > 0;
}

/** O que o cartão de segredo mostra: o formulário, o "Salvo. Tentar de novo" (o Cofre guardou e só o aviso ao bot falhou) ou o resolvido. */
export function secretsView(status: ConfirmStatus, stored: boolean): "form" | "retry" | "resolved" {
	if (status !== "pending") return "resolved";
	return stored ? "retry" : "form";
}

export function secretsBadge(status: ConfirmStatus): { tone: "success" | "muted" | "danger"; label: string } | null {
	if (status === "approved") return { tone: "success", label: "Salvo" };
	if (status === "rejected") return { tone: "muted", label: "Dispensado" };
	if (status === "failed") return { tone: "danger", label: "Não deu certo" };
	return null;
}

/** Frase simples para a falha ao guardar (sem texto técnico do servidor). */
export function vaultErrorText(status: number | null): string {
	if (status === 401) return "Sua sessão expirou. Entre de novo.";
	if (status === 503) return "O Cofre não está disponível no servidor agora.";
	if (status === 400 || status === 409) return "Não consegui guardar. Confira os dados e tente de novo.";
	if (status === null) return "Sem conexão com o seu servidor. Tente de novo.";
	return "Não consegui guardar agora. Tente de novo.";
}
