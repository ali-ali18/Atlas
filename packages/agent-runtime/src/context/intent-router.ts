import type { ContextGroup } from "./prompt-blocks.js";

/**
 * Roteador determinístico de intenção (L5): decide quais grupos de tool e de
 * procedimento já entram no 1º passo, só por palavra-chave da última fala do
 * usuário (ou do objetivo da rotina) e pela origem. Sem chamada ao modelo. O
 * que ele não pega o modelo carrega por `mcp_tool_search` (ou chamando a tool).
 */
function normalize(text: string): string {
	return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

const URL_OR_DOMAIN = /https?:\/\/|\bwww\.|\b[a-z0-9-]+\.(com|org|net|io|gov|edu|app|dev|co|ai)(\.[a-z]{2})?\b/;

const PATTERNS: Array<[ContextGroup, RegExp]> = [
	[
		"routines",
		/\b(rotinas?|lembr\w*|agend\w*|cron|webhook|gatilho|trigger\w*|diari\w+|semanal\w*|mensal\w*|todo dia|todos os dias|toda (semana|manha|tarde|noite|hora|segunda|terca|quarta|quinta|sexta|sabado|domingo)|(a )?cada \d+|de \d+ em \d+|remind\w*|schedul\w*|recurr\w*|routines?|alarm\w*|every (day|week|month|hour|\d+)|fica de olho|me avis\w+|avis\w+ (me )?(quando|se))\b/,
	],
	[
		"vault",
		/\b(cofre|segredos?|senhas?|chaves? (de )?(api|acesso)|api ?keys?|tokens?|passwords?|secrets?|credenciais|credentials|2fa|totp|n8n|login (de|do|no|na) )/,
	],
	["api", /\b(apis?|openapi|swagger|endpoints?)\b/],
	["email", /\b(e-?mails?|mails?|correio|caixa de entrada|inbox|mailbox)\b/],
	[
		"bots",
		/\b(cri\w+|faz\w*|mont\w+|nov[oa]s?|quero|preciso|queria|gostaria|create|make|new)\b[^.!?\n]{0,40}\b(agentes?|bots?|assistentes?|agents?|assistants?)\b/,
	],
	["questionnaire", /\b(question\w*rio|questionnaires?|formularios?|enquetes?|onboarding)\b/],
	// Plano para aprovar: só quando o usuário fala em plano; tarefa longa sem a palavra carrega pelo índice (`mcp_tool_search`).
	["plan", /\b(planej\w*|plano de (acao|trabalho|execucao)|(monta|faz|faca|mostra|cria|me da|me de) (um |o )?plano|passo a passo|make a plan|plan (it|this) (out|first)|step[- ]by[- ]step)\b/],
	[
		"memory",
		/\b(memori\w*|guarda\w*|anota\w*|salv\w+ (isso|que|na|em)|meu nome|o que (voce )?(lembra|sabe)|voce (se )?lembra|lembra (de mim|que eu|do que)|me chama\w*|prefiro|preferenc\w*|esquec\w*|remember|my name|call me|i prefer|forget|conversas? (anterior\w*|passada\w*)|ontem|semana passada|ja falamos|combinamos|last time|previous (chat|conversation)s?)\b/,
	],
	[
		"files",
		/\b(pdf|docx?|word|xlsx?|excel|planilhas?|csv|pptx|slides?|powerpoint|apresentac\w+|arquivos?|documentos?|relatorios?|files?|spreadsheets?|reports?|presentations?|markdown|txt|exporta\w*)\b/,
	],
	[
		"presentations",
		/\b(apresentac\w*|presentations?|slides?|power ?points?|pptx?|potx|decks?|pitch(es)?|keynote|google slides)\b/,
	],
	[
		"pages",
		/\b(dashboards?|paineis|painel|forecast|kpis?|scorecard|visao geral|overview|resumo executivo|(live|living) (dashboard|report)s?|relatorios? (semanal|mensal|diario|executivo|vivo|do (mes|trimestre|ano))|(mont\w+|cri\w+|faz\w*|ger\w+|build|create|make) (uma? |meu |minha |o |a )*(relatorio|report))\b/,
	],
	[
		"data",
		/\b(relatorios?|listar|lista de|filtr\w+|totais|total (de|do|da|dos|das)|quanto (foi|deu|tenho|temos|vendi|vendemos|recebi|gastei|falta)|quantos?|quantas?|vendas?|faturamento|receitas?|despesas?|atrasad\w+|vencid\w+|em aberto|ranking|top \d+|por (mes|dia|semana|cliente|empresa|categoria)|reports?|list (all|the)|breakdown|how (much|many)|overdue|outstanding)\b/,
	],
	[
		"code",
		/\b(calcul\w+|estatistic\w+|statistic\w*|graficos?|charts?|plot\w*|pandas|numpy|matplotlib|regressao|correlacao|mediana|desvio padrao|media de|soma d[aeo]s?|somar|porcentagem|percentual|(analis\w+|resum\w+|cruz\w+|filtr\w+|ordena\w*|agrup\w+) (a |os |as |o |essa |esse |esta |este )?(planilha|tabela|csv|dados|xlsx)|python)\b/,
	],
	[
		"images",
		/\b(imagem|imagens|fotos?|figuras?|desenh\w+|ilustra\w*|logos?|logotipos?|images?|pictures?|photos?|draw\w*|illustrat\w*|screenshots?|prints?|captur\w+|(fa[zc]\w*|cri\w+|ger\w+|mont\w+|produz\w*|make|create|generate) (uma? |as |os |me |pra mim |para mim )*(arte|artes|capa|banner|cartaz|avatar|mascote|wallpaper|papel de parede|icone|poster|meme|art|cover|icon))\b/,
	],
	[
		"browser",
		/\b(navegador|browser|sites?|paginas?|abr(a|ir|e)|acess(a|e|ar)|login|logar|entrar no|clic(a|ar|k)|cliq\w+|digit(a|e|ar)|role (a|para|ate)|captura de tela|tela|preench\w+|baix(a|ar)|download|web ?pages?|websites?|open (the )?(page|site|url)|navigate|click)\b/,
	],
	[
		"shell",
		/\b(scripts?|shell|bash|terminal|python|playwright|curl|em lote|bulk|baix(a|ar|e) (todos|todas|os|as)|download (de )?(todos|todas)|todos os (pdfs?|arquivos|cursos|materiais)|todas as (disciplinas|materias|aulas|semanas|paginas)|scrap\w*|extrair (tudo|todos|todas)|ava|moodle|lms|classroom)\b/,
	],
	[
		"dev",
		/\b(repo(sitorio)?s?|pull requests?|prs?|branch(es)?|commits?|merge|pnpm|npm (run|install|test)|yarn|typecheck|lint(er)?|compil\w+|refator\w+|refactor\w*|bugs?|unit tests?|testes? (unitari\w+|automatizad\w+)|rod(a|ar|e) (os |a )?(testes|suite)|testa(r)? (o |a |os |as )?(ultim\w+|repo\w*|commits?|pr|codigo|projeto)|(build|compila\w*) (do|da|de|o|a) (repo\w*|projeto|codigo)|run (the )?tests|codigo( fonte)?|source code|implement\w+ (a |o |uma? )?(feature|funcionalidade|endpoint|funcao|function))\b/,
	],
	[
		"desktop",
		/\b(desktop|area de trabalho|xdotool|libreoffice|aplicativos? (de )?desktop|janelas? do (sistema|desktop)|arrast\w+|drag(ging)?|coordenadas?|coordinates)\b/,
	],
	[
		"web",
		/\b(pesquis\w+|busca\w*|procur\w+|noticias?|previsao|clima|cotac\w+|precos?|compar\w+|quanto (custa|esta)|search|news|weather|prices?|look up|find out|research)\b/,
	],
];

export function routeContextGroups(input: {
	/** Última fala do usuário (ou o objetivo da rotina). */
	text: string;
	/** Run de evento de config do bot, onboarding ou resposta de questionário de onboarding. */
	onboarding?: boolean;
	/** O pedido trouxe imagens anexadas. */
	hasImageAttachments?: boolean;
	/** A regra de perfil já abriu a porta de `propose_profile_update` neste run. */
	profileAllowed?: boolean;
}): Set<ContextGroup> {
	const groups = new Set<ContextGroup>();
	const text = normalize(input.text ?? "");
	for (const [group, pattern] of PATTERNS) {
		if (pattern.test(text)) groups.add(group);
	}
	if (URL_OR_DOMAIN.test(text)) {
		groups.add("browser");
		groups.add("web");
	}
	// Novo agente sem dizer para quê: a única pergunta do fluxo usa o card de escolhas.
	if (groups.has("bots")) groups.add("questionnaire");
	// Apresentação precisa de create_file e, para fundos e ilustrações, de generate_image.
	if (groups.has("presentations")) {
		groups.add("files");
		groups.add("images");
	}
	if (groups.has("shell")) groups.add("browser");
	if (groups.has("browser")) {
		// Mostrar ao usuário o que o navegador viu e a escada de pesquisa vêm junto.
		groups.add("images");
		groups.add("web");
	}
	if (input.hasImageAttachments) groups.add("images");
	if (input.onboarding) {
		groups.add("questionnaire");
		groups.add("memory");
		if (input.profileAllowed) groups.add("profile");
	}
	return groups;
}

const COUNT_WORDS = "[2-9]|10|dois|duas|tres|quatro|cinco|seis|two|three|four|five|six|dos|cuatro";
const PARALLEL_TARGETS =
	"lojas|fornecedor\\w*|sites|fontes|empresas|clientes|produtos|concorrentes|marcas|bancos|planos|opcoes|alternativas|cidades|universidades|cursos|ferramentas|modelos|repositorios|repos|documentos|artigos|papers|stores|shops|suppliers|vendors|sources|companies|clients|customers|products|competitors|brands|banks|plans|options|alternatives|cities|tools|models|documents|articles|tiendas|proveedores";
/** "3 fornecedores", "cinco lojas", "two suppliers". */
const COUNTED_TARGETS = new RegExp(`\\b(${COUNT_WORDS})\\s+(${PARALLEL_TARGETS})\\b`);
/** Pesquisa/comparação: o verbo que torna as partes leituras independentes. */
const RESEARCH_VERB = /\b(pesquis\w+|busc\w+|procur\w+|compar\w+|cot\w+|levant\w+|analis\w+|avali\w+|research\w*|search\w*|compare\w*|look up|find|investig\w+|benchmark\w*|review\w*|revis\w+)\b/;

/**
 * Pedido que divide em partes independentes que valem um subagente cada (mesma pesquisa em N
 * fontes, comparar N itens): só por palavra-chave, sem chamada ao modelo. Serve de reserva
 * quando o Jev de delegação está desligado ou não respondeu; conversa curta nunca casa.
 */
export function delegationCue(text: string): boolean {
	const plain = normalize(text ?? "");
	if (plain.length < 12) return false;
	return COUNTED_TARGETS.test(plain) && RESEARCH_VERB.test(plain);
}
