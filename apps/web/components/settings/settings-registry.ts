/**
 * Modelo puro do modal de configurações: seções da nav, itens pesquisáveis,
 * busca (sem acento/caixa), parâmetro de URL e navegação por teclado.
 * Sem React nem `window`: tudo testável em unidade.
 *
 * Uma responsabilidade por seção: Conta, Geral (aparência, idioma, fuso),
 * Modelos e contexto, Provedores e chaves, Bots (autonomia, grupos,
 * reflexão, reação), Execução e limites, Notificações, Computador (navegador e ambientes de código),
 * Conexões, Habilidades, Uso e Avançado (sempre a última). As descrições de cada item só alimentam a busca.
 */

export const SETTINGS_URL_PARAM = "settings";

export type SettingsSectionId =
	| "conta"
	| "geral"
	| "provedores"
	| "modelos"
	| "bots"
	| "notificacoes"
	| "computador"
	| "conexoes"
	| "cofre"
	| "habilidades"
	| "uso"
	| "execucao"
	| "avancado";

export type SettingsNavId = SettingsSectionId;

/** Blocos da navegação: separam o dia a dia do que é raro/técnico. */
export type SettingsNavGroupId = "basico" | "inteligencia" | "ambiente" | "controle";

export const SETTINGS_NAV_GROUPS: Readonly<Record<SettingsNavGroupId, string>> = {
	basico: "Básico",
	inteligencia: "Bots e modelos",
	ambiente: "Ferramentas",
	controle: "Controle",
};

export type SettingsNavEntry = {
	id: SettingsSectionId;
	/** Bloco da nav onde a seção aparece. */
	group: SettingsNavGroupId;
	label: string;
	keywords: readonly string[];
};

export const SETTINGS_NAV: readonly SettingsNavEntry[] = [
	{ id: "conta", group: "basico", label: "Conta", keywords: ["perfil", "usuário", "nome", "e-mail", "sessão", "sair"] },
	{ id: "geral", group: "basico", label: "Geral", keywords: ["preferências", "aparência"] },
	{ id: "notificacoes", group: "basico", label: "Notificações", keywords: ["push", "celular", "avisos", "alertas", "aparelhos"] },
	{ id: "bots", group: "inteligencia", label: "Bots", keywords: ["bot principal", "memória", "reflexão", "autonomia", "grupos", "comportamento", "reação"] },
	{ id: "modelos", group: "inteligencia", label: "Modelos e contexto", keywords: ["modelo", "contexto", "memória da conversa", "tokens", "resposta", "imagens", "ditado", "reserva"] },
	{ id: "provedores", group: "inteligencia", label: "Provedores e chaves", keywords: ["assinaturas", "provedores", "chaves", "plano", "e-mail dos bots"] },
	{ id: "computador", group: "ambiente", label: "Computador", keywords: ["navegador", "sandbox", "máquina", "ambientes"] },
	{ id: "conexoes", group: "ambiente", label: "Conexões", keywords: ["integrações", "conectores", "apps", "plugins"] },
	{ id: "cofre", group: "ambiente", label: "Cofre", keywords: ["segredos", "senhas", "chaves", "logins", "2fa", "autenticador", "api key", "token", "credenciais", "gerenciador de senhas"] },
	{ id: "habilidades", group: "ambiente", label: "Habilidades", keywords: ["skills", "procedimentos", "receitas", "instruções"] },
	{ id: "uso", group: "controle", label: "Uso e custos", keywords: ["custo", "consumo", "tokens", "gastos", "cobrança"] },
	{ id: "execucao", group: "controle", label: "Execução e limites", keywords: ["limites", "passos", "tempo", "custo máximo", "paciência", "disciplina", "execução"] },
	{ id: "avancado", group: "controle", label: "Técnico", keywords: ["avançado", "técnico", "revisão", "jev", "diagnóstico", "versão", "saúde"] },
];

/** Entradas de Conexões que fecham o modal e abrem outra tela. */
export type SettingsShortcutId = "conectores" | "mcp" | "apps";

/** Configuração individual pesquisável (a busca acha "tema" e abre a seção). */
export type SettingsItem = {
	id: string;
	section: SettingsSectionId;
	label: string;
	keywords: readonly string[];
};

export const SETTINGS_ITEMS: readonly SettingsItem[] = [
	// Conta, Geral, Notificações, Bots e Provedores
	{ id: "conta.foto", section: "conta", label: "Foto", keywords: ["perfil", "avatar", "imagem", "câmera", "galeria", "remover", "conta"] },
	{ id: "conta.nome", section: "conta", label: "Nome", keywords: ["perfil", "conta", "alterar", "editar", "chamar"] },
	{ id: "conta.email", section: "conta", label: "E-mail", keywords: ["email", "endereço", "conta"] },
	{ id: "conta.sair", section: "conta", label: "Sair", keywords: ["logout", "encerrar", "sessão", "conta"] },
	{ id: "geral.tema", section: "geral", label: "Tema", keywords: ["aparência", "claro", "escuro", "sistema"] },
	{ id: "geral.idioma", section: "geral", label: "Idioma dos bots novos", keywords: ["língua", "português", "inglês", "espanhol", "idioma", "padrão"] },
	{ id: "notificacoes.celular", section: "notificacoes", label: "Notificações no celular", keywords: ["push", "aviso", "alerta", "celular", "notificar", "terminou", "precisa de você", "pwa", "testar"] },
	{ id: "notificacoes.aparelhos", section: "notificacoes", label: "Aparelhos com notificações", keywords: ["push", "celular", "dispositivos", "remover", "notificações"] },
	{ id: "geral.fuso", section: "geral", label: "Fuso horário", keywords: ["horário", "timezone", "agendamento", "lembretes", "rotinas", "modo proativo", "silêncio"] },
	{ id: "geral.reflexao", section: "bots", label: "Reflexão diária", keywords: ["reflexão", "refletir", "memória", "orquestrador", "bot principal", "pendências", "limpeza", "horário", "diária", "agora"] },
	{ id: "modelos.padrao", section: "modelos", label: "Modelo padrão", keywords: ["modelo", "bots novos", "openrouter", "chatgpt"] },
	{ id: "modelos.codigo", section: "modelos", label: "Modelo para código", keywords: ["modelo", "código", "programar", "sessão de código", "desenvolvimento", "bots"] },
	{ id: "provedores.chatgpt", section: "provedores", label: "Usar plano ChatGPT", keywords: ["chatgpt", "openai", "plano", "assinatura", "ligar", "desligar", "provedor"] },
	{ id: "provedores.conexao", section: "provedores", label: "Conexão com o ChatGPT", keywords: ["chatgpt", "conectar", "conectado", "login", "e-mail", "reconectar"] },
	{ id: "execucao.autonomia", section: "bots", label: "Autonomia padrão", keywords: ["aprovação", "permissão", "exceções", "confirmar", "sozinho", "autonomia"] },
	{ id: "jev.grupos", section: "bots", label: "Grupos: coordenação inteligente", keywords: ["jev", "grupo", "grupos", "coordenação", "delegar", "bots", "equipe", "inteligente"] },

	// Computador
	{ id: "execucao.navegador", section: "computador", label: "Iniciar o navegador automaticamente", keywords: ["sandbox", "ligar", "abrir", "navegador", "início automático"] },
	{ id: "ambientes.lista", section: "computador", label: "Ambientes de código", keywords: ["repositório", "repo", "instalação", "inicialização", "segredos", "variáveis", "internet", "domínios", "proxy", "recursos", "memória", "sessão de código", "github"] },

	// Conexões
	{ id: "github.app", section: "conexoes", label: "GitHub", keywords: ["github app", "app do github", "instalar", "repositórios", "webhook", "criar app", "código", "pull request", "push"] },
	{ id: "conectores.marketplace", section: "conexoes", label: "Conectores", keywords: ["marketplace", "integrações", "apps", "plugins", "github", "slack"] },
	{ id: "conectores.mcp", section: "conexoes", label: "MCP personalizado", keywords: ["mcp", "servidor", "conector", "personalizado", "custom"] },
	{ id: "composio.chave", section: "conexoes", label: "Chave do Composio", keywords: ["api key", "token", "remover", "salvar", "composio", "byo"] },
	{ id: "composio.apps", section: "conexoes", label: "Apps do Composio", keywords: ["conectar", "desconectar", "buscar", "toolkit", "trello", "linear", "hubspot", "composio"] },

	// Cofre
	{ id: "cofre.lista", section: "cofre", label: "Cofre de segredos e logins", keywords: ["senha", "senhas", "segredo", "chave", "api key", "token", "login", "site", "2fa", "totp", "autenticador", "gerar senha", "revelar", "copiar", "credenciais", "bot usa"] },

	// Habilidades
	{ id: "habilidades.lista", section: "habilidades", label: "Habilidades", keywords: ["skill", "skills", "habilidade", "procedimento", "receita", "instruções", "markdown", "importar", "exportar", "rascunho"] },

	// Uso
	{ id: "uso.custos", section: "uso", label: "Uso e custos", keywords: ["custo", "consumo", "tokens", "gastos"] },

	// Avançado
	{ id: "provedores.openrouter", section: "provedores", label: "Chave do OpenRouter", keywords: ["openrouter", "chave", "api key", "provedores", "servidor", "modelos"] },
	{ id: "provedores.anthropic", section: "provedores", label: "Anthropic (API)", keywords: ["anthropic", "claude", "api key", "chave", "provedores", "conectar", "modelos"] },
	{ id: "provedores.opencode-go", section: "provedores", label: "OpenCode Go", keywords: ["opencode", "go", "assinatura", "chave", "api key", "provedores", "kimi", "glm", "deepseek", "modelos"] },
	{ id: "provedores.openmail", section: "provedores", label: "E-mail dos bots (OpenMail)", keywords: ["openmail", "e-mail", "email", "endereço", "caixa", "chave", "api key", "bot", "provedores", "enviar", "receber", "domínio", "dominio", "dns", "domínio próprio"] },
	{ id: "provedores.desconectar", section: "provedores", label: "Desconectar o ChatGPT da conta", keywords: ["tokens", "remover", "desconectar", "chatgpt", "provedores", "chaves"] },
	{ id: "modelos.manutencao", section: "modelos", label: "Modelo de manutenção", keywords: ["resumo", "memória", "revisão", "modelos auxiliares"] },
	{ id: "modelos.visao", section: "modelos", label: "Modelo para ler imagens", keywords: ["visão", "imagem", "foto", "anexo", "modelos auxiliares"] },
	{ id: "modelos.imagem", section: "modelos", label: "Modelo para gerar imagens", keywords: ["gerar", "criar imagem", "desenho", "modelos auxiliares"] },
	{ id: "modelos.ditado", section: "modelos", label: "Modelo de ditado", keywords: ["voz", "ditar", "microfone", "transcrição", "áudio", "stt", "whisper", "modelos auxiliares"] },
	{ id: "modelos.reserva", section: "modelos", label: "Modelos de reserva", keywords: ["fallback", "falha", "alternativo", "modelos auxiliares"] },
	{ id: "jev.mcp", section: "avancado", label: "Revisão de escritas em conectores", keywords: ["jev", "revisão", "mcp", "escrita", "observar", "bloquear", "conectores"] },
	{ id: "jev.geral", section: "avancado", label: "Decisões auxiliares", keywords: ["jev", "revisão", "geral", "todos", "observar", "ativo", "latência"] },
	{ id: "jev.intencao", section: "avancado", label: "Entender o pedido", keywords: ["jev", "revisão", "intenção", "por recurso"] },
	{ id: "jev.tools", section: "avancado", label: "Escolher ferramentas", keywords: ["jev", "revisão", "seleção de tools", "ferramentas", "por recurso"] },
	{ id: "jev.verificacao", section: "avancado", label: "Conferir a resposta", keywords: ["jev", "revisão", "verificação", "resposta final", "por recurso"] },
	{ id: "jev.bloqueio", section: "avancado", label: "Página de bloqueio", keywords: ["jev", "revisão", "captcha", "login", "bloqueada", "por recurso"] },
	{ id: "jev.delegacao", section: "avancado", label: "Delegação", keywords: ["jev", "revisão", "subagente", "delegar", "por recurso"] },
	{ id: "jev.travamento", section: "avancado", label: "Travamento", keywords: ["jev", "revisão", "travado", "círculos", "loop", "por recurso"] },
	{ id: "execucao.disciplina", section: "execucao", label: "Disciplina de execução", keywords: ["execução", "progresso", "empacar", "estagnação", "lote", "agrupar"] },
	{ id: "execucao.economia", section: "modelos", label: "Economia de contexto", keywords: ["execução", "contexto", "tokens", "ferramentas", "prompt", "cache", "adiar"] },
	{ id: "execucao.memoria", section: "modelos", label: "Memória da conversa", keywords: ["execução", "contexto", "resumo", "resumir", "histórico", "conversa longa", "esquecer", "tokens", "custo", "padrão", "econômico", "janela", "cache"] },
	{ id: "execucao.reacao", section: "bots", label: "Responder só com reação", keywords: ["execução", "reação", "reagir", "emoji", "obrigado", "valeu", "ok", "sem resposta", "tokens", "custo", "economia", "conversa", "curtir"] },
	{ id: "execucao.paciencia", section: "execucao", label: "Paciência com o modelo", keywords: ["execução", "prazo", "timeout", "espera", "curto", "estendido", "lento"] },
	{ id: "execucao.resposta", section: "modelos", label: "Tamanho máximo da resposta", keywords: ["execução", "tokens", "saída", "limite", "cortar"] },
	{ id: "execucao.passos", section: "execucao", label: "Limite de passos", keywords: ["execução", "passos", "ferramentas", "teto"] },
	{ id: "execucao.tempo", section: "execucao", label: "Limite de tempo", keywords: ["execução", "duração", "minutos", "tempo máximo", "timeout", "run"] },
	{ id: "avancado.diagnostico", section: "avancado", label: "Diagnóstico", keywords: ["diagnóstico", "versão", "commit", "saúde", "redis", "postgres", "fila", "worker", "falhas", "erros", "sentry", "chaves", "push"] },
	{ id: "execucao.custo", section: "execucao", label: "Custo máximo por execução", keywords: ["execução", "dólar", "orçamento", "gasto", "limite"] },
];

export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = "geral";

/**
 * Ids antigos de `?settings=` (links salvos, cartões do chat) → seção nova.
 * `rotinas` não existe mais aqui: as rotinas moram no painel do bot.
 */
const LEGACY_SECTION: Readonly<Record<string, SettingsSectionId>> = {
	jev: "avancado",
	ambientes: "computador",
	ambiente: "computador",
	"ambientes-de-codigo": "computador",
	"dev-environments": "computador",
	skills: "habilidades",
	composio: "conexoes",
	conectores: "conexoes",
	rotinas: "geral",
};

/** Minúsculas, sem acento e sem espaços nas pontas. */
export function normalizeSearch(text: string): string {
	return text
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLocaleLowerCase("pt-BR")
		.trim();
}

function matches(query: string, label: string, keywords: readonly string[]): boolean {
	if (!query) return true;
	return [label, ...keywords].some((text) => normalizeSearch(text).includes(query));
}

export function isSettingsSectionId(value: unknown): value is SettingsSectionId {
	return SETTINGS_NAV.some((entry) => entry.id === value);
}

/** Id novo ou antigo → seção atual; desconhecido = `null`. */
export function resolveSettingsSection(value: unknown): SettingsSectionId | null {
	if (typeof value !== "string") return null;
	const id = value.trim().toLowerCase();
	if (isSettingsSectionId(id)) return id;
	return LEGACY_SECTION[id] ?? null;
}

export function navEntry(id: SettingsSectionId): SettingsNavEntry | undefined {
	return SETTINGS_NAV.find((entry) => entry.id === id);
}

export type SettingsSearchResult = {
	/** Seções da nav que sobraram, na ordem original. */
	entries: SettingsNavEntry[];
	/**
	 * Por seção: ids dos itens que casaram com a busca. Ausente = seção
	 * inteira visível (busca vazia ou casou pelo nome da seção).
	 */
	itemFilter: Partial<Record<SettingsSectionId, ReadonlySet<string>>>;
};

const NO_HIDDEN: ReadonlySet<string> = new Set();

/** Itens do ChatGPT (plano, conexão, desconectar) são só do dono da conta. */
const OWNER_ONLY_ITEMS: readonly string[] = ["provedores.chatgpt", "provedores.conexao", "provedores.desconectar"];

/**
 * Itens que somem para quem não pode usá-los. O plano ChatGPT é só do dono
 * (`capabilities.isOwner`); enquanto as capacidades não chegam, nada some.
 */
export function hiddenSettingsItems(
	capabilities: { isOwner: boolean } | null | undefined,
): ReadonlySet<string> {
	return capabilities?.isOwner === false ? new Set(OWNER_ONLY_ITEMS) : NO_HIDDEN;
}

/** Filtra nav e configurações por rótulo/palavra-chave. */
export function searchSettings(
	rawQuery: string,
	/** Itens escondidos por quem a pessoa é (ex.: o plano ChatGPT para quem não é dono). */
	hidden: ReadonlySet<string> = NO_HIDDEN,
): SettingsSearchResult {
	const query = normalizeSearch(rawQuery);
	const itemFilter: SettingsSearchResult["itemFilter"] = {};
	const entries: SettingsNavEntry[] = [];
	for (const entry of SETTINGS_NAV) {
		const visibleItems = SETTINGS_ITEMS.filter((item) => item.section === entry.id && !hidden.has(item.id));
		if (matches(query, entry.label, entry.keywords)) {
			entries.push(entry);
			continue;
		}
		const hits = visibleItems.filter((item) => matches(query, item.label, item.keywords));
		if (hits.length === 0) continue;
		entries.push(entry);
		itemFilter[entry.id] = new Set(hits.map((item) => item.id));
	}
	return { entries, itemFilter };
}

/** Item visível dentro da seção para o filtro atual. */
export function isItemVisible(result: SettingsSearchResult, section: SettingsSectionId, itemId: string): boolean {
	const filter = result.itemFilter[section];
	return !filter || filter.has(itemId);
}

/** Valor de `?settings=` → seção aberta (aceita ids antigos); desconhecido = fechado. */
export function parseSettingsParam(raw: string | null | undefined): SettingsSectionId | null {
	if (!raw) return null;
	return resolveSettingsSection(raw);
}

/**
 * Nova query string (com `?`, ou "" se ficou vazia) com a seção aberta;
 * `null` remove o parâmetro e preserva o resto (ex.: `?provider=chatgpt`).
 */
export function buildSettingsSearch(currentSearch: string, section: SettingsSectionId | null): string {
	const params = new URLSearchParams(currentSearch);
	if (section) params.set(SETTINGS_URL_PARAM, section);
	else params.delete(SETTINGS_URL_PARAM);
	const text = params.toString();
	return text ? `?${text}` : "";
}

/** Próximo índice da lista (setas circulares; Home/End vão às pontas). */
export function moveIndex(current: number, length: number, move: "next" | "prev" | "first" | "last"): number {
	if (length <= 0) return -1;
	if (move === "first") return 0;
	if (move === "last") return length - 1;
	const base = current < 0 ? (move === "next" ? -1 : 0) : current;
	return (base + (move === "next" ? 1 : -1) + length) % length;
}
