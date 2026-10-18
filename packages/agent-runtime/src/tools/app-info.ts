import type { ChatTool } from "@workspace/llm";
import { MCP_OAUTH_CALLBACK_PATH } from "../mcp/oauth-provider.js";

/**
 * `app_info`: fatos operacionais do sistema onde o agente roda (URLs de callback,
 * webhooks, onde ficam as configurações, limites). Somente leitura, sem segredos:
 * as URLs saem do ambiente em tempo de execução, nunca de um valor fixo no código.
 */

export const APP_INFO_TOOL_NAME = "app_info";

export const APP_INFO_TOPICS = ["oauth", "mcp", "webhooks", "vault", "login", "settings", "models", "limits"] as const;
export type AppInfoTopic = (typeof APP_INFO_TOPICS)[number];

export const APP_INFO_TOOL: ChatTool = {
	type: "function",
	function: {
		name: APP_INFO_TOOL_NAME,
		description:
			"Facts about THIS app and the server it runs on. Call it BEFORE answering any question about the app itself or its integrations: which URL to paste as the OAuth redirect/callback URL when connecting an MCP server or app (n8n, Notion, Slack...), how to add a custom MCP connector (with or without OAuth), the incoming webhook URL and how to authenticate it, the login callback, composio callback, where each setting lives in the UI, supported model providers and limits. Never guess these values: the answer comes from here. Returns no secrets.",
		parameters: {
			type: "object",
			properties: {
				topic: {
					type: "string",
					enum: [...APP_INFO_TOPICS],
					description: "oauth (callback URL for MCP/OAuth), mcp (adding connectors), webhooks, vault (secrets and site logins), login, settings (where things are), models (providers), limits. Omit for everything.",
				},
			},
		},
	},
};

type Env = Readonly<Record<string, string | undefined>>;

function clean(value: string | undefined): string | undefined {
	const text = value?.trim().replace(/\/+$/, "");
	return text ? text : undefined;
}

const NOT_CONFIGURED =
	"The server URL is not configured (ATLAS_URL is not set), so the exact address is unknown. Tell the user to set ATLAS_URL on the server (the public address where they open the app) and then ask again. Do not invent a URL.";

function section(topic: AppInfoTopic, env: Env): string {
	const web = clean(env.ATLAS_URL);
	const publicBase = clean(env.ATLAS_PUBLIC_URL) ?? web;
	const at = (base: string | undefined, path: string): string => (base ? `${base}${path}` : `<server URL>${path}`);
	switch (topic) {
		case "oauth":
			return [
				"## OAuth redirect (callback) URL for connectors",
				web
					? `Paste this exact URL wherever the other service asks for the allowed redirect / callback / "Allowed OAuth Redirect URLs": ${web}${MCP_OAUTH_CALLBACK_PATH}`
					: `Path: ${MCP_OAUTH_CALLBACK_PATH}. ${NOT_CONFIGURED}`,
				"It must match exactly (scheme, host and port; localhost is not 127.0.0.1). One URL serves every MCP connector.",
				"Notion and custom MCP servers with OAuth register themselves automatically (dynamic client registration): nothing to create there, only the redirect URL above when the server asks for it. GitHub, Slack and Google connectors need an OAuth app created by the server owner (client id/secret in the server environment), with this same redirect URL.",
				web ? `Composio connections return to ${web}/v1/composio/callback (handled automatically).` : "",
			]
				.filter(Boolean)
				.join("\n");
		case "mcp":
			return [
				"## Adding a custom MCP connector",
				"Settings -> Conexões -> MCP personalizado -> Adicionar (the Marketplace of connectors is in the same section).",
				"Fields: Nome, URL do servidor (a remote MCP endpoint, https; http only for localhost).",
				"Auth option 1, OAuth: turn on 'Entrar com OAuth'; a login window opens for the service. The redirect URL to register on the service is in the oauth topic. Use it when the server asks for an account instead of a key.",
				"Auth option 2, header: leave OAuth off and fill 'Nome do header' (for example Authorization) and 'Valor do header' (for example 'Bearer <token>'). The value is stored encrypted and never shown to the agent.",
				"No auth at all: leave both empty. After connecting, the tools appear in the chat under that connector. Expired logins show 'Reconectar'.",
			].join("\n");
		case "webhooks":
			return [
				"## Incoming webhooks (routines)",
				web || publicBase ? "" : NOT_CONFIGURED,
				`Generic webhook of a routine: POST ${at(publicBase, "/v1/hooks/<hookKey>")} with a JSON body (default max 64 KB). The exact URL of a routine is in the routine's menu -> Webhook…, which can also generate a new secret.`,
				"Authentication: send the routine secret in the X-Atlas-Hook-Secret header (preferred) or Authorization: Bearer <secret>. The ?secret= query parameter still works but is deprecated (the secret ends up in URLs and logs): do not use it in new integrations. Wrong or missing secret: 401; paused routine: 409; GET returns 405 with a hint.",
				"Never ask the user to paste the secret or the URL with ?secret=. Call routine_webhook_info: it lists the routines' URLs (without secret), the header and a marker {{secret:rotina:<slug>}} that the runtime replaces with the real secret when you call a connector (e.g. n8n create_workflow). In an n8n HTTP Request node: Method POST, URL without ?secret=, header X-Atlas-Hook-Secret = the marker. The real secret will then live only in the user's n8n; the approval card says so.",
				"Rate limit: 60 requests per minute per IP on /v1/hooks/*.",
				`GitHub trigger: events arrive at ${at(publicBase, "/v1/hooks/github")}, signed by GitHub; it only works when the server URL is public (not localhost). Normally set up by the GitHub App in Settings -> Conexões -> GitHub, with no manual webhook.`,
				"The routine itself is created with the routines tools (propose_routine); the webhook URL and secret are shown to the user in the routine panel, so do not make them up.",
			]
				.filter(Boolean)
				.join("\n");
		case "vault":
			return [
				"## Vault (Cofre)",
				"Settings -> Cofre keeps the user's secrets (name, hidden value, description) and site logins (site link, username, password, optional 2FA key, notes, extra fields), encrypted per user. You see only names, descriptions, domains and usernames (secret_list), never values.",
				"Use a secret by writing {{secret:<name>}} (or {{login:<name>.username|password|totp}}) in the arguments of a connector (MCP) or sandbox/code-shell call; the runtime injects the value at the last moment and replaces it back with the marker in any result. Other tools (web search, browser typing...) refuse markers.",
				"Missing secret: call secret_request (a card with a password field; the value goes straight to the vault). Browser sign-in: login_fill fills the current page only if its domain matches the saved site; the user approves the first use of each login per conversation.",
				"If the user pastes something that looks like a key in the chat, a notice offers to save it in the vault and replaces it with a marker.",
			].join("\n");
		case "login":
			return [
				"## Sign-in",
				"Single-owner app: only the configured owner e-mail can sign in (magic link by e-mail, and GitHub or Google when the server has them configured).",
				web
					? `OAuth callbacks for the owner login: ${web}/api/auth/callback/github and ${web}/api/auth/callback/google.`
					: `Login callbacks are <server URL>/api/auth/callback/github and /api/auth/callback/google. ${NOT_CONFIGURED}`,
			].join("\n");
		case "settings":
			return [
				"## Where things are (Configurações)",
				"Geral: Nome, E-mail, Sair, Tema, Idioma dos bots novos, Fuso horário, Notificações no celular (ativar, testar) e Aparelhos com notificações, Modelo padrão, Modelo para código, Usar plano ChatGPT, Autonomia padrão, Grupos: coordenação inteligente.",
				"Computador: Iniciar o navegador automaticamente.",
				"Cofre: segredos e logins de sites (nome, valor oculto, descrição; revelar com confirmação, copiar, editar, apagar; histórico de uso por item).",
				"Conexões: GitHub (GitHub App: tudo que o bot escreve no GitHub sai como o app, nunca como a conta do usuário; aviso se o app precisa aceitar novas permissões; assinatura opcional no rodapé) ou Minha conta, aviso se o app precisa aceitar novas permissões, assinatura opcional no rodapé), Conectores (marketplace), MCP personalizado, Composio (chave e apps), Ambientes de código (repositório, instalação, segredos, internet, recursos), Habilidades (skills).",
				"Uso: Uso e custos.",
				"Avançado: chaves de provedores (OpenRouter, Anthropic, OpenCode Go), modelos auxiliares (manutenção, ler imagens, gerar imagens, ditado, reserva), revisão (Jev), disciplina de execução, economia de contexto, paciência com o modelo, tamanho máximo da resposta, limite de passos, de tempo e de custo por execução.",
				"Routines (schedules, webhooks, GitHub triggers) live in each bot's panel, not in Settings. Bot profile, tools and autonomy are also per bot.",
			].join("\n");
		case "models":
			return [
				"## Models and providers",
				"OpenRouter (server key, many vendors), ChatGPT plan (sign in with the ChatGPT account in Settings -> Geral), Anthropic API key and OpenCode Go key (Settings -> Avançado -> provedores). Each bot can use its own model; the account default is in Settings -> Geral.",
				"Models are written provider/model (openrouter ids like vendor/name, chatgpt/..., anthropic-direct/..., opencode-go/...). Not every model reads images: Settings -> Avançado -> 'Modelo para ler imagens' is the helper that describes pictures for models without vision.",
				"Auxiliary models (maintenance/summaries, image reading, image generation, dictation, fallbacks) are set in Settings -> Avançado.",
			].join("\n");
		case "limits":
			return [
				"## Limits",
				"Images: up to 10 MB each (png, jpeg, webp, gif). Webhook body: 64 KB by default. Webhooks: 60 requests/min per IP.",
				"Per run (Settings -> Avançado): max steps 100/200/300/500, max time in minutes, max cost per run (0.05, 0.10, 0.25 default, 0.50, 1.00 USD or none), max response size.",
				"OAuth login for a connector expires after 15 minutes if not completed.",
			].join("\n");
	}
}

/** Texto do guia; `topic` inválido ou ausente devolve todos os assuntos. */
export function appInfoText(topic?: unknown, env: Env = process.env): string {
	const wanted = typeof topic === "string" ? (APP_INFO_TOPICS as readonly string[]).find((item) => item === topic.trim().toLowerCase()) : undefined;
	const topics = wanted ? [wanted as AppInfoTopic] : [...APP_INFO_TOPICS];
	return topics.map((item) => section(item, env)).join("\n\n");
}

export async function executeAppInfo(args: Record<string, unknown>): Promise<{ summary: string }> {
	return { summary: appInfoText(args.topic) };
}
