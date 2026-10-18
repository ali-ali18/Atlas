import type { McpAuthType } from "./mcp.js";

export type McpCatalogCategory = "search" | "google" | "productivity" | "creative" | "custom";

export type McpApiKeyPlacement =
	| { kind: "bearer" }
	| { kind: "header"; name: string }
	| { kind: "url"; template: string };

/** Habilidade exibida no detalhe do conector. */
export type McpCatalogSkill = {
	key: string;
	title: string;
	description: string;
};

/**
 * Login OAuth do conector. Sem `clientIdEnv`, o Atlas se registra sozinho no
 * servidor (registro dinâmico). Com ele, usa o app OAuth criado pelo dono da
 * instância (GitHub, Slack, Google não aceitam registro dinâmico).
 */
export type McpCatalogOAuth = {
	clientIdEnv?: string;
	clientSecretEnv?: string;
	scope?: string;
	/** Onde criar o app OAuth (exibido quando falta configurar). */
	setupUrl?: string;
	/** Parâmetros extras na URL de login (ex.: Google `access_type=offline`). */
	authorizationParams?: Readonly<Record<string, string>>;
	/**
	 * Servidor de autorização fixo (ex.: Google `https://accounts.google.com`).
	 * Usado pelos conectores `builtin://` — a URL do servidor MCP não é
	 * descobrível, então o login pula a descoberta via RFC 9728 e vai direto
	 * neste servidor (RFC 8414 / OpenID Connect Discovery).
	 */
	authorizationServer?: string;
};

export type McpCatalogEntry = {
	id: string;
	name: string;
	description: string;
	longDescription: string;
	category: McpCatalogCategory;
	icon: string;
	developer: string;
	website: string;
	sourceUrl: string;
	authType: McpAuthType;
	url?: string;
	apiKey?: { placement: McpApiKeyPlacement; label: string; helpUrl: string };
	oauth?: McpCatalogOAuth;
	/**
	 * Tools que só leem, para servidores que não mandam `readOnlyHint`. Sem
	 * isso tudo conta como escrita e pede confirmação (ex.: scrape do Firecrawl).
	 */
	readOnlyTools?: readonly string[];
	/** Timeout de cada chamada de tool (ms). Sem valor, vale o padrão do runtime (30 s). */
	callTimeoutMs?: number;
	/** Teto inicial de chamadas por tool no run (leitura e escrita). Sem valor, vale o padrão do runtime. */
	maxCallsPerTool?: number;
	availability: "available" | "coming_soon";
	docsUrl: string;
	skills: McpCatalogSkill[];
};

// Espelha o limite do runtime sem criar dependência dele na web.
export const MCP_MAX_EXPOSED_TOOLS_HINT = 40;

/**
 * App OAuth do Google (tipo "Aplicativo da Web"): o Google não aceita
 * registro dinâmico. `access_type=offline` + `prompt=consent` garantem o
 * refresh token (sem ele o login cai em 1 h).
 *
 * Os servidores MCP oficiais do Workspace (`...mcp.googleapis.com`) exigem o
 * Developer Preview Program, que não aceita conta pessoal @gmail.com — por
 * isso os 4 conectores Google abaixo usam servidores MCP embutidos
 * (`builtin://google/...`, ver `packages/agent-runtime/src/mcp/builtin/`)
 * que chamam a REST API normal do Google com o token OAuth do usuário.
 */
const GOOGLE_OAUTH = {
	clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
	clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
	setupUrl: "https://console.cloud.google.com/apis/credentials",
	authorizationParams: { access_type: "offline", prompt: "consent" },
	authorizationServer: "https://accounts.google.com",
} as const;

const GOOGLE_SCOPE_PREFIX = "https://www.googleapis.com/auth/";

/** Prefixa cada escopo com a URL padrão do Google (`calendar.readonly` → `.../auth/calendar.readonly`). */
function googleScope(...scopes: string[]): string {
	return scopes.map((scope) => `${GOOGLE_SCOPE_PREFIX}${scope}`).join(" ");
}

export const MCP_CATALOG: readonly McpCatalogEntry[] = [
	{
		id: "firecrawl",
		name: "Firecrawl",
		description: "Pesquise e extraia conteúdo de páginas da web.",
		longDescription: "Conecte o Firecrawl para pesquisar na web e extrair conteúdo de páginas. Use quando precisar reunir fontes externas, analisar páginas ou comparar informações publicadas em sites.",
		category: "search",
		icon: "/connectors/firecrawl.svg",
		developer: "Firecrawl",
		website: "firecrawl.dev",
		sourceUrl: "https://docs.firecrawl.dev/quickstarts/amp",
		authType: "api_key",
		apiKey: {
			placement: { kind: "url", template: "https://mcp.firecrawl.dev/{key}/v2/mcp" },
			label: "Chave de API Firecrawl",
			helpUrl: "https://docs.firecrawl.dev/quickstarts/amp",
		},
		// Nada no Firecrawl altera dados do usuário: tudo é pesquisa/leitura da web.
		readOnlyTools: [
			"firecrawl_scrape",
			"firecrawl_batch_scrape",
			"firecrawl_check_batch_status",
			"firecrawl_search",
			"firecrawl_map",
			"firecrawl_extract",
			"firecrawl_crawl",
			"firecrawl_check_crawl_status",
			"firecrawl_deep_research",
			"firecrawl_generate_llmstxt",
		],
		// Scrape/crawl passam de 30 s com frequência.
		callTimeoutMs: 90_000,
		availability: "available",
		docsUrl: "https://docs.firecrawl.dev/quickstarts/amp",
		skills: [
			{ key: "firecrawl-research-with-sources", title: "Pesquisa com fontes", description: "Use para encontrar páginas relevantes e reunir evidências para uma resposta." },
			{ key: "firecrawl-compare-pages", title: "Comparar páginas", description: "Use para extrair informações de vários sites e comparar seus conteúdos." },
			{ key: "firecrawl-extract-article", title: "Extrair artigo", description: "Use para ler o conteúdo de uma página específica antes de resumir ou analisar." },
		],
	},
	{
		id: "github",
		name: "GitHub",
		description: "Acesse repositórios, issues e pull requests.",
		longDescription: "Conecte sua conta GitHub para consultar repositórios, acompanhar issues e trabalhar com pull requests. O agente pode usar essas informações para entender mudanças e ajudar no fluxo de desenvolvimento.",
		category: "productivity",
		icon: "/connectors/github.svg",
		developer: "GitHub",
		website: "github.com",
		sourceUrl: "https://github.com/github/github-mcp-server",
		authType: "oauth",
		url: "https://api.githubcopilot.com/mcp/",
		// Sem app OAuth configurado, cai no token pessoal (PAT).
		apiKey: {
			placement: { kind: "bearer" },
			label:
				"Personal access token do GitHub (fine-grained) com permissões de repositório: Metadata (leitura), Contents (leitura), Pull requests (leitura e escrita), Issues (leitura e escrita), Checks (leitura), Actions (leitura) e Webhooks (leitura e escrita)",
			helpUrl: "https://github.com/github/github-mcp-server/blob/main/docs/installation-guides/install-codex.md",
		},
		oauth: {
			clientIdEnv: "GITHUB_OAUTH_CLIENT_ID",
			clientSecretEnv: "GITHUB_OAUTH_CLIENT_SECRET",
			setupUrl: "https://github.com/settings/applications/new",
			// Gatilhos de rotina reaproveitam essa mesma conexão: repo (webhook/status), read:org (times) e admin:repo_hook (criar webhook).
			scope: "repo read:org admin:repo_hook",
		},
		availability: "available",
		docsUrl: "https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md",
		skills: [
			{ key: "github-review-pr", title: "Revisar PR", description: "Use para entender as mudanças e a discussão de um pull request." },
			{ key: "github-open-issues-summary", title: "Resumo de issues abertas", description: "Use para organizar os problemas e pedidos ainda pendentes em um repositório." },
			{ key: "github-repository-context", title: "Explorar repositório", description: "Use para localizar arquivos e obter contexto antes de alterar código." },
		],
	},
	{
		id: "notion",
		name: "Notion",
		description: "Consulte e organize páginas e bases de dados.",
		longDescription: "Acesse páginas e bases de dados do Notion para encontrar decisões, notas e tarefas. Use o conteúdo do workspace como contexto para responder perguntas e organizar informações.",
		category: "productivity",
		icon: "/connectors/notion.svg",
		developer: "Notion Labs",
		website: "notion.com",
		sourceUrl: "https://www.notion.com/help/notion-mcp",
		authType: "oauth",
		url: "https://mcp.notion.com/mcp",
		oauth: {},
		availability: "available",
		docsUrl: "https://www.notion.com/help/notion-mcp",
		skills: [
			{ key: "notion-find-notes", title: "Encontrar notas", description: "Use para localizar páginas sobre um projeto, reunião ou decisão." },
			{ key: "notion-meeting-notes", title: "Notas de reunião", description: "Use para consultar registros de reuniões e recuperar encaminhamentos." },
		],
	},
	{
		id: "higgsfield",
		name: "Higgsfield",
		description: "Crie e edite imagens e vídeos com IA.",
		longDescription: "Conecte sua conta Higgsfield para criar e editar imagens e vídeos, consultar gerações e acompanhar créditos. As gerações feitas pelo MCP consomem créditos da sua conta.",
		category: "creative",
		icon: "/connectors/higgsfield.svg",
		developer: "Higgsfield",
		website: "higgsfield.ai",
		sourceUrl: "https://higgsfield.ai/creator-hub/help-center/integrations/how-do-i-connect-higgsfield-to-ai-agent",
		authType: "oauth",
		url: "https://mcp.higgsfield.ai/mcp",
		oauth: {},
		availability: "available",
		docsUrl: "https://higgsfield.ai/creator-hub/help-center/integrations/what-is-higgsfield-mcp",
		skills: [
			{ key: "higgsfield-generate-media", title: "Gerar imagens e vídeos", description: "Use para criar imagens ou vídeos a partir de uma ideia." },
			{ key: "higgsfield-edit-media", title: "Editar mídia", description: "Use para ampliar, reenquadrar ou remover o fundo de uma imagem." },
			{ key: "higgsfield-check-credits", title: "Consultar créditos", description: "Use para verificar os créditos e acompanhar gerações da conta." },
		],
	},
	{
		id: "slack",
		name: "Slack",
		description: "Encontre mensagens e colabore em canais.",
		longDescription: "Consulte conversas e canais do Slack para recuperar contexto compartilhado pela equipe. Encontre discussões, decisões e atualizações relevantes para o trabalho em andamento.",
		category: "productivity",
		icon: "/connectors/slack.svg",
		developer: "Slack",
		website: "slack.com",
		sourceUrl: "https://docs.slack.dev/ai/slack-mcp-server/",
		authType: "oauth",
		url: "https://mcp.slack.com/mcp",
		oauth: {
			clientIdEnv: "SLACK_OAUTH_CLIENT_ID",
			clientSecretEnv: "SLACK_OAUTH_CLIENT_SECRET",
			setupUrl: "https://api.slack.com/apps",
		},
		availability: "available",
		docsUrl: "https://docs.slack.dev/ai/slack-mcp-server/",
		skills: [
			{ key: "slack-find-discussion", title: "Encontrar conversa", description: "Use para localizar uma discussão ou decisão em canais e mensagens." },
			{ key: "slack-channel-summary", title: "Resumo de canal", description: "Use para acompanhar as principais atualizações de um canal." },
		],
	},
	{
		id: "gmail",
		name: "Gmail",
		description: "Pesquise e organize mensagens de e-mail.",
		longDescription: "Consulte mensagens do Gmail para encontrar conversas, compromissos e informações recebidas por e-mail. O agente pode ajudar a resumir trocas e preparar respostas com o contexto necessário.",
		category: "google",
		icon: "/connectors/gmail.svg",
		developer: "Google",
		website: "gmail.com",
		sourceUrl: "https://developers.google.com/workspace/guides/configure-mcp-servers",
		authType: "oauth",
		// Oficial (Developer Preview Program, não aceita @gmail.com pessoal): "https://gmailmcp.googleapis.com/mcp/v1"
		url: "builtin://google/gmail",
		oauth: { ...GOOGLE_OAUTH, scope: googleScope("gmail.readonly", "gmail.compose") },
		availability: "available",
		docsUrl: "https://developers.google.com/workspace/guides/configure-mcp-servers",
		skills: [
			{ key: "gmail-find-email", title: "Encontrar e-mail", description: "Use para recuperar uma mensagem ou conversa por assunto e remetente." },
			{ key: "gmail-summarize-thread", title: "Resumir conversa", description: "Use para entender rapidamente uma troca longa de e-mails." },
		],
	},
	{
		id: "google_drive",
		name: "Google Drive",
		description: "Localize e leia arquivos do Drive.",
		longDescription: "Encontre arquivos guardados no Google Drive e consulte seu conteúdo. Use documentos da sua conta como fonte para responder perguntas ou preparar materiais.",
		category: "google",
		icon: "/connectors/google-drive.svg",
		developer: "Google",
		website: "drive.google.com",
		sourceUrl: "https://developers.google.com/workspace/guides/configure-mcp-servers",
		authType: "oauth",
		// Oficial (Developer Preview Program, não aceita @gmail.com pessoal): "https://drivemcp.googleapis.com/mcp/v1"
		url: "builtin://google/drive",
		oauth: { ...GOOGLE_OAUTH, scope: googleScope("drive.readonly") },
		availability: "available",
		docsUrl: "https://developers.google.com/workspace/guides/configure-mcp-servers",
		skills: [
			{ key: "google-drive-find-file", title: "Encontrar arquivo", description: "Use para localizar um documento pelo nome, assunto ou contexto." },
			{ key: "google-drive-read-document", title: "Consultar documento", description: "Use para extrair informações de um arquivo armazenado no Drive." },
		],
	},
	{
		id: "google_calendar",
		name: "Google Agenda",
		description: "Consulte eventos e gerencie sua agenda.",
		longDescription: "Consulte eventos no Google Agenda para verificar compromissos e organizar o dia. O agente pode usar horários e detalhes dos eventos ao planejar suas atividades.",
		category: "google",
		icon: "/connectors/google-calendar.svg",
		developer: "Google",
		website: "calendar.google.com",
		sourceUrl: "https://developers.google.com/workspace/guides/configure-mcp-servers",
		authType: "oauth",
		// Oficial (Developer Preview Program, não aceita @gmail.com pessoal): "https://calendarmcp.googleapis.com/mcp/v1"
		url: "builtin://google/calendar",
		oauth: { ...GOOGLE_OAUTH, scope: googleScope("calendar.readonly", "calendar.events") },
		availability: "available",
		docsUrl: "https://developers.google.com/workspace/guides/configure-mcp-servers",
		skills: [
			{ key: "google-calendar-check-schedule", title: "Consultar agenda", description: "Use para verificar os próximos eventos e horários disponíveis." },
			{ key: "google-calendar-prepare-meeting", title: "Preparar reunião", description: "Use para consultar detalhes de um evento antes da reunião." },
		],
	},
	{
		id: "google_sheets",
		name: "Google Planilhas",
		description: "Leia e atualize planilhas.",
		longDescription: "Acesse dados em planilhas do Google para consultar registros e acompanhar mudanças. Use as tabelas como referência em análises e tarefas de organização.",
		category: "google",
		icon: "/connectors/google-sheets.svg",
		developer: "Google",
		website: "sheets.google.com",
		sourceUrl: "https://developers.google.com/workspace/guides/configure-mcp-servers",
		authType: "oauth",
		// Oficial (Developer Preview Program, não aceita @gmail.com pessoal): "https://sheetsmcp.googleapis.com/mcp/v1"
		url: "builtin://google/sheets",
		oauth: { ...GOOGLE_OAUTH, scope: googleScope("spreadsheets", "drive.readonly") },
		availability: "available",
		docsUrl: "https://developers.google.com/workspace/guides/configure-mcp-servers",
		skills: [
			{ key: "google-sheets-read-table", title: "Consultar tabela", description: "Use para localizar valores e comparar linhas de uma planilha." },
			{ key: "google-sheets-update-record", title: "Atualizar registro", description: "Use para registrar uma alteração em uma planilha existente." },
			{ key: "google-sheets-create-tracker", title: "Criar planilha de acompanhamento", description: "Use para criar uma planilha nova com cabeçalho para acompanhar preços, tarefas ou histórico." },
		],
	},
	{
		id: "brave_search",
		name: "Brave Search",
		description: "Pesquise páginas, notícias e imagens na web.",
		longDescription: "Use o Brave Search para descobrir páginas, notícias e imagens relacionadas a uma pergunta. A conexão estará disponível quando o aplicativo oferecer suporte ao servidor MCP local desse provedor.",
		category: "search",
		icon: "/connectors/brave.svg",
		developer: "Brave",
		website: "search.brave.com",
		sourceUrl: "https://github.com/brave/brave-search-mcp-server",
		authType: "api_key",
		availability: "coming_soon",
		docsUrl: "https://github.com/brave/brave-search-mcp-server",
		skills: [
			{ key: "brave-search-web", title: "Pesquisar na web", description: "Use para encontrar páginas relevantes para uma pergunta." },
			{ key: "brave-search-news", title: "Pesquisar notícias", description: "Use para localizar notícias recentes sobre um assunto." },
		],
	},
];

export function getMcpCatalogEntry(id: string): McpCatalogEntry | undefined {
	return MCP_CATALOG.find((entry) => entry.id === id);
}

/** `builtin://google/gmail` etc. — servidor MCP embutido no próprio Atlas, sem rede até o servidor MCP em si. */
export function isBuiltinMcpUrl(url: string): boolean {
	return url.startsWith("builtin://");
}

/** URL pública para guardar e exibir, sem a chave. */
export function publicMcpUrl(entry: McpCatalogEntry): string {
	const placement = entry.apiKey?.placement;
	if (placement?.kind === "url") return placement.template.replace("{key}", "***");
	return entry.url ?? "";
}

/** Constrói os dados de conexão sem modificar a entrada do catálogo. */
export function applyMcpApiKey(
	entry: McpCatalogEntry,
	key: string,
): { url: string; headers?: Record<string, string> } {
	const placement = entry.apiKey?.placement;
	if (placement?.kind === "url") {
		return { url: placement.template.replace("{key}", encodeURIComponent(key)) };
	}
	if (!entry.url) throw new Error("Conector sem URL MCP configurada");
	if (placement?.kind === "bearer") {
		return { url: entry.url, headers: { Authorization: `Bearer ${key}` } };
	}
	if (placement?.kind === "header") {
		return { url: entry.url, headers: { [placement.name]: key } };
	}
	return { url: entry.url };
}
