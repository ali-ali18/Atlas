import type { SkillRecipe } from "./skills.js";

/**
 * Sementes agênticas de pesquisa (fase 1).
 * Dados declarativos e não confiáveis: não concedem permissão de ferramenta.
 * O integrador fará extend de SKILL_AVAILABLE_TOOLS com web_search/web_extract
 * e o wiring no runtime. Validar com parseSkillRecipe + availableTools incluindo web_*.
 */
export const AGENTIC_SKILL_SEEDS: SkillRecipe[] = [
	{
		capabilityKey: "tool-escalation",
		title: "Escalar ferramenta quando a pagina bloqueia",
		description:
			"Trocar de ferramenta quando a atual falha: buscar leve, ler direto, abrir no navegador e so entao usar desktop.",
		triggers: [
			"escalar ferramenta bloqueada",
			"ferramenta bloqueada tentar outra",
			"login exigido trocar ferramenta",
			"pagina bloqueada escalar acesso",
		],
		preconditions: [
			"A tarefa atual autoriza acessar a fonte citada.",
			"A ferramenta anterior falhou ou pediu login.",
		],
		inputs: [
			{
				name: "alvo",
				description: "URL ou consulta autorizada pela tarefa atual.",
				required: true,
			},
		],
		steps: [
			{
				instruction:
					"Buscar a fonte com web_search a partir da consulta autorizada e anotar 3 a 5 URLs candidatas.",
				tool: "web_search",
			},
			{
				instruction:
					"Ler as candidatas em paralelo com web_extract; se voltar texto legivel, usar esse dado e encerrar.",
				tool: "web_extract",
			},
			{
				instruction:
					"Se a leitura direta falhar, abrir a melhor URL com navigate e aguardar o carregamento completo.",
				tool: "navigate",
			},
			{
				instruction:
					"Ler a pagina com browser_text e conferir se responde a tarefa; em login ou bloqueio, encerrar sem declarar sucesso.",
				tool: "browser_text",
			},
		],
		postconditions: [
			"Fonte lida com texto legivel e URL conferida, ou bloqueio registrado sem declarar sucesso.",
		],
		failureModes: [
			"Login ou bloqueio sem alternativa autorizada: encerrar sem declarar sucesso.",
			"Sem URL ou consulta autorizada: nao aplicar este procedimento.",
		],
		requiredTools: ["web_search", "web_extract", "navigate", "browser_text"],
	},
	{
		capabilityKey: "browser-hygiene",
		title: "Navegar com higiene uma tarefa por vez",
		description:
			"Regras de navegacao limpa: uma tarefa por vez, aguardar carregar, dispensar banner, preferir texto a captura e reaproveitar a sessao.",
		triggers: [
			"higiene de navegacao",
			"navegar uma tarefa por vez",
			"aguardar carregar pagina navegador",
			"reaproveitar sessao navegador",
		],
		preconditions: [
			"A tarefa atual autoriza abrir a URL publica citada.",
			"Existe pendencia de leitura ou interacao na pagina.",
		],
		inputs: [
			{
				name: "url",
				description: "URL publica autorizada pela tarefa atual.",
				required: true,
			},
		],
		steps: [
			{
				instruction:
					"Abrir somente a URL da tarefa atual com navigate; aguardar o carregamento completo; fazer uma tarefa por vez e reaproveitar a mesma sessao.",
				tool: "navigate",
			},
			{
				instruction:
					"Se houver banner de cookies, dispensar com browser_click no controle visivel e retomar a leitura.",
				tool: "browser_click",
			},
			{
				instruction:
					"Ler a pagina com browser_text; preferir texto a captura de tela; nunca usar o resumo IA do buscador como fonte, apenas a pagina aberta.",
				tool: "browser_text",
			},
			{
				instruction:
					"Conferir a URL observada e listar links com browser_links antes de concluir; em login ou pagina vazia, encerrar sem declarar sucesso.",
				tool: "browser_links",
			},
		],
		postconditions: [
			"Pagina lida com URL conferida e texto legivel, ou bloqueio registrado sem declarar sucesso.",
		],
		failureModes: [
			"Login, bloqueio ou pagina vazia: encerrar sem declarar sucesso.",
			"Sem URL autorizada: nao aplicar este procedimento.",
		],
		requiredTools: [
			"navigate",
			"browser_click",
			"browser_text",
			"browser_links",
		],
	},
	{
		capabilityKey: "price-check",
		title: "Comparar precos em lojas diferentes",
		description:
			"Comparar precos de um produto: buscar, coletar paginas de dominios diferentes, extrair dados e montar tabela com data.",
		triggers: [
			"comparar precos produto lojas",
			"pesquisar preco melhor oferta",
			"preco produto link lojas diferentes",
		],
		preconditions: [
			"O usuario pediu comparacao de precos do produto citado.",
			"Busca autorizada sem login.",
		],
		inputs: [
			{
				name: "produto",
				description: "Nome do produto para buscar e comparar.",
				required: true,
			},
		],
		steps: [
			{
				instruction:
					"Buscar o produto com web_search e reunir 3 a 5 URLs de dominios diferentes.",
				tool: "web_search",
			},
			{
				instruction:
					"Extrair as paginas em paralelo com web_extract pedindo store, product, price, currency, availability e url.",
				tool: "web_extract",
			},
			{
				instruction:
					"Quando o preco vier vazio, ler a pagina no navegador com browser_text e conferir o valor visivel; montar tabela com loja, produto, preco, moeda, disponibilidade, URL e data observada.",
				tool: "browser_text",
			},
		],
		postconditions: [
			"Tabela com loja, produto, preco, moeda, disponibilidade, URL e data observada.",
		],
		failureModes: [
			"Preco vazio apos leitura no navegador: registrar sem valor, sem estimar.",
			"Menos de 3 dominios diferentes: registrar o limite observado.",
		],
		requiredTools: ["web_search", "web_extract", "browser_text"],
	},
];
