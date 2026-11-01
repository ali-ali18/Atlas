import { looksLikeLongTask } from "@workspace/shared";
import { parseScenario, type MockTurn, type Scenario } from "../scenario.js";
import { COMPETITORS, SKUS, STORES, SUPPLIERS, brl, competitorPage, skuPage, storePage, supplierPage } from "./world.js";

/**
 * As 11 tarefas do comparativo `motor-v1-vs-v2`. Cada uma traz o roteiro do modelo (determinístico, sem rede) por motor:
 * o MESMO comportamento de pesquisa nos dois (mesmas buscas e leituras); o v2 acrescenta o que o prompt dele pede
 * (lista de tarefas, caderno, documento). O roteiro é a hipótese de comportamento do modelo: o que o comparativo mede
 * é o que cada motor FAZ com esse comportamento (travas, perguntas, entrega, custo), não a qualidade de um modelo.
 */

export type EngineTask = {
	id: string;
	title: string;
	user: string;
	/** Termos que a entrega precisa citar (texto final ou documento): cobertura = achados / total. */
	mustMention: string[];
	/** A entrega esperada é um documento (relatório longo) e não só uma resposta no chat. */
	expectsDocument: boolean;
	scenario: Scenario;
	turns: { v1: MockTurn[]; v2: MockTurn[] };
};

const search = (query: string): MockTurn => ({ calls: [{ name: "web_search", args: { query } }] });
const extract = (...urls: string[]): MockTurn => ({ calls: [{ name: "web_extract", args: { urls } }] });
const say = (text: string): MockTurn => ({ say: text });
const taskList = (items: Array<[string, "pending" | "in_progress" | "completed"]>): MockTurn => ({
	calls: [{ name: "update_task_list", args: { items: items.map(([content, status]) => ({ content, status })) } }],
});
const note = (title: string, excerpt: string, source: string, kind: "finding" | "unconfirmed" = "finding"): MockTurn => ({
	calls: [{ name: "notebook_write", args: { title, excerpt, source, ...(kind === "unconfirmed" ? { kind } : {}) } }],
});

/** Parágrafos de análise determinísticos até chegar a `words` palavras (para a resposta/relatório longo). */
function prose(subject: string, facts: string[], words: number): string {
	const sentences = [
		`Resumo sobre ${subject}.`,
		...facts,
		"A comparação considera preço por quilo, pedido mínimo, prazo de entrega e a confiabilidade da fonte consultada.",
		"Recomendação: priorizar quem combina preço baixo com pedido mínimo compatível com o volume mensal da operação.",
		"Próximos passos: confirmar condições de pagamento, pedir amostra e negociar desconto por volume antes de fechar.",
	];
	const out: string[] = [];
	let count = 0;
	let index = 0;
	while (count < words) {
		const sentence = sentences[index % sentences.length]!;
		out.push(sentence);
		count += sentence.split(/\s+/).length;
		index += 1;
	}
	return out.join(" ");
}

type TaskInput = Omit<EngineTask, "scenario"> & { fixtures: Scenario["tools"]["fixtures"] };

/**
 * No v2, pedido de tarefa (`looksLikeLongTask`) roda em trabalho longo e o prompt exige lista de tarefas: o roteiro que
 * não a tem ganha uma, aberta no início e fechada antes da resposta final.
 */
function withTaskList(user: string, turns: MockTurn[]): MockTurn[] {
	if (!looksLikeLongTask(user) || turns.some((turn) => "calls" in turn && turn.calls.some((call) => call.name === "update_task_list"))) return turns;
	const body = turns.slice(0, -1);
	const last = turns.at(-1)!;
	return [taskList([["Pesquisar", "in_progress"], ["Entregar", "pending"]]), ...body, taskList([["Pesquisar", "completed"], ["Entregar", "completed"]]), last];
}

function build(input: TaskInput): EngineTask {
	const { fixtures, ...rest } = input;
	rest.turns = { v1: rest.turns.v1, v2: withTaskList(rest.user, rest.turns.v2) };
	const parsed = parseScenario({
		version: 1,
		id: rest.id,
		title: rest.title,
		tags: ["motor-v1-vs-v2"],
		bot: { name: "Radar de Mercado", about: "Pesquisa mercado, fornecedores e preços e entrega relatórios.", language: "pt-BR" },
		user: rest.user,
		tools: { fixtures },
		run: { maxSteps: 40, origin: "chat" },
		expect: [{ type: "completed" }],
		mock: { turns: rest.turns.v1 },
	});
	if (!parsed.ok) throw new Error(`tarefa ${rest.id} inválida: ${parsed.error}`);
	return { ...rest, scenario: parsed.scenario };
}

const equals = (value: string) => ({ equals: value });
const searchFixture = (query: string, summary: string) => ({ tool: "web_search", args: { query: equals(query) }, result: { ok: true, summary } });
const extractFixture = (url: string, summary: string, ok = true) => ({ tool: "web_extract", args: { urls: { contains: url } }, result: { ok, summary } });

function supplierResearch(): EngineTask {
	const steps = SUPPLIERS.flatMap((s) => [search(`${s.name} preço erva seca atacado`), extract(`https://${s.host}/precos`)]);
	const findings = SUPPLIERS.map((s) => `${s.name}: ${brl(s.price)} por kg, mínimo de ${s.minOrder} kg.`);
	const final = say(prose("os 5 fornecedores de ervas", findings, 260));
	return build({
		id: "pesquisa-5-fornecedores-ervas",
		title: "Pesquisa de mercado: 5 fornecedores de ervas (preço, mínimo e prazo)",
		user: "Faça uma pesquisa de mercado com 5 fornecedores de ervas secas a granel e monte um comparativo de preço, pedido mínimo e prazo de entrega",
		mustMention: SUPPLIERS.map((s) => s.name),
		expectsDocument: false,
		fixtures: SUPPLIERS.flatMap((s) => [searchFixture(`${s.name} preço erva seca atacado`, supplierPage(s)), extractFixture(`https://${s.host}/precos`, supplierPage(s))]),
		turns: {
			v1: [...steps, final],
			v2: [
				taskList([["Pesquisar os 5 fornecedores", "in_progress"], ["Comparar e entregar", "pending"]]),
				...SUPPLIERS.flatMap((s, index) => [steps[index * 2]!, steps[index * 2 + 1]!, note(s.name, `${brl(s.price)}/kg, mínimo ${s.minOrder} kg`, `https://${s.host}/precos`)]),
				taskList([["Pesquisar os 5 fornecedores", "completed"], ["Comparar e entregar", "completed"]]),
				final,
			],
		},
	});
}

function deepResearch(): EngineTask {
	// 45 passos de uma ferramenta por vez: a pesquisa funda que o v1 encerra no teto de passos.
	const queries = Array.from({ length: 45 }, (_, i) => `concorrente ${i + 1} preço e posicionamento`);
	const mentioned = COMPETITORS.map((c) => c.name);
	const final = say(prose("os 12 concorrentes mapeados", COMPETITORS.map((c) => `${c.name}: ${c.focus}.`), 300));
	return build({
		id: "pesquisa-funda-45-passos",
		title: "Levantamento fundo de concorrentes (45 passos de pesquisa)",
		user: "Levante todos os concorrentes do mercado de chás e ervas, analise o posicionamento de cada um e monte o panorama completo",
		mustMention: mentioned,
		expectsDocument: false,
		fixtures: queries.map((q, i) => searchFixture(q, competitorPage(COMPETITORS[i % COMPETITORS.length]!) + ` (achado ${i + 1})`)),
		turns: {
			v1: [...queries.map(search), final],
			v2: [
				taskList([["Mapear os concorrentes", "in_progress"], ["Entregar o panorama", "pending"]]),
				...queries.map(search),
				taskList([["Mapear os concorrentes", "completed"], ["Entregar o panorama", "completed"]]),
				final,
			],
		},
	});
}

function compareStores(): EngineTask {
	const reads = STORES.map((s) => extract(`https://${s.host}/kit-cha`));
	const final = say(`Comparativo do Kit Chá Premium: ${STORES.map((s) => `${s.name} ${brl(s.price)}`).join("; ")}. A mais barata é a Mercado Azul; a Casa Prima é a mais cara e a Loja Sol fica no meio.`);
	return build({
		id: "comparar-precos-3-lojas",
		title: "Comparar o preço do mesmo kit em 3 lojas",
		user: "Compare o preço do Kit Chá Premium nas lojas Loja Sol, Mercado Azul e Casa Prima e diga qual compensa mais",
		mustMention: STORES.map((s) => s.name),
		expectsDocument: false,
		fixtures: STORES.map((s) => extractFixture(`https://${s.host}/kit-cha`, storePage(s))),
		turns: { v1: [...reads, final], v2: [...reads, final] },
	});
}

function competitorSummary(): EngineTask {
	const steps = COMPETITORS.flatMap((c) => [search(`${c.name} posicionamento`), extract(`https://${c.host}/sobre`)]);
	const final = say(prose("os concorrentes", COMPETITORS.map((c) => `${c.name}: ${c.focus}.`), 220));
	return build({
		id: "resumo-concorrentes",
		title: "Resumo dos 4 principais concorrentes",
		user: "Pesquise os 4 principais concorrentes e faça um resumo do posicionamento de cada um",
		mustMention: COMPETITORS.map((c) => c.name),
		expectsDocument: false,
		fixtures: COMPETITORS.flatMap((c) => [searchFixture(`${c.name} posicionamento`, competitorPage(c)), extractFixture(`https://${c.host}/sobre`, competitorPage(c))]),
		turns: {
			v1: [...steps, final],
			v2: [
				taskList([["Pesquisar os 4 concorrentes", "in_progress"], ["Resumir", "pending"]]),
				...steps,
				taskList([["Pesquisar os 4 concorrentes", "completed"], ["Resumir", "completed"]]),
				final,
			],
		},
	});
}

function skuQuote(): EngineTask {
	// Uma das páginas (HRT-100) está bloqueada: o v2 registra como "não confirmado"; o v1 só cita no texto.
	const reads = SKUS.map((s) => extract(`https://catalogo.example.com/${s.sku}`));
	const quoted = SKUS.filter((s) => s.sku !== "HRT-100");
	const body = `Cotação por SKU: ${quoted.map((s) => `${s.sku} ${brl(s.price)}`).join("; ")}.`;
	const v1Final = say(`${body} O SKU HRT-100 não abriu (página bloqueada) e ficou sem preço.`);
	const v2Final = say(`${body}\n\nNão deu para confirmar:\n- HRT-100: a página bloqueou a leitura, então ficou sem preço.`);
	return build({
		id: "cotacao-varios-sku",
		title: "Cotação com várias opções de SKU (uma página bloqueada)",
		user: "Faça a cotação dos SKUs CAM-100, CAM-250, HRT-100, BOL-100, ERV-100 e CID-100 no catálogo e me dê o preço de cada um",
		mustMention: SKUS.map((s) => s.sku),
		expectsDocument: false,
		fixtures: SKUS.map((s) => extractFixture(`https://catalogo.example.com/${s.sku}`, s.sku === "HRT-100" ? "Erro: blocked. A página exige verificação humana." : skuPage(s), s.sku !== "HRT-100")),
		turns: {
			v1: [...reads, v1Final],
			v2: [
				taskList([["Ler os 6 SKUs", "in_progress"], ["Montar a cotação", "pending"]]),
				...reads,
				note("HRT-100", "Página bloqueada; preço não confirmado.", "https://catalogo.example.com/HRT-100", "unconfirmed"),
				taskList([["Ler os 6 SKUs", "completed"], ["Montar a cotação", "completed"]]),
				v2Final,
			],
		},
	});
}

function shortReport(): EngineTask {
	const steps = [search("tendência consumo de chás 2026"), search("preço médio chá premium Brasil"), extract("https://setor.example.com/chas")];
	const final = say("Relatório curto: o consumo de chás premium cresce no Brasil e o preço médio do sachê premium fica entre R$ 0,90 e R$ 1,40. Vale focar em kits de presente e assinatura.");
	return build({
		id: "relatorio-curto",
		title: "Relatório curto sobre consumo de chás",
		user: "Escreva um relatório curto sobre a tendência de consumo de chás premium e o preço médio por sachê",
		mustMention: ["premium", "sachê"],
		expectsDocument: false,
		fixtures: [
			searchFixture("tendência consumo de chás 2026", "Consumo de chás premium cresce 8% ao ano no Brasil (setor.example.com)."),
			searchFixture("preço médio chá premium Brasil", "Sachê premium: R$ 0,90 a R$ 1,40 (setor.example.com)."),
			extractFixture("https://setor.example.com/chas", "Panorama do setor: kits de presente e assinatura puxam o crescimento."),
		],
		turns: { v1: [...steps, final], v2: [...steps, final] },
	});
}

function goodMorning(): EngineTask {
	const final = say("Bom dia! Como posso ajudar hoje?");
	return build({ id: "bom-dia", title: "Conversa curta: Bom dia", user: "Bom dia", mustMention: ["Bom dia"], expectsDocument: false, fixtures: [], turns: { v1: [final], v2: [final] } });
}

function simpleQuestion(): EngineTask {
	const final = say("A capital do Brasil é Brasília.");
	return build({ id: "pergunta-simples", title: "Pergunta simples de conhecimento geral", user: "Qual é a capital do Brasil?", mustMention: ["Brasília"], expectsDocument: false, fixtures: [], turns: { v1: [final], v2: [final] } });
}

function flakyTool(): EngineTask {
	// A mesma página falha 4 vezes seguidas; depois o modelo troca de fonte e conclui.
	const bad = "https://lento.example.com/precos";
	const failing = Array.from({ length: 4 }, () => extract(bad));
	const alt = [search("Ervas do Vale preço erva seca atacado"), extract("https://ervasdovale.example.com/precos")];
	const final = say(`Não consegui abrir a fonte lenta, então usei outra: ${supplierPage(SUPPLIERS[0])} Se quiser, tento a fonte original mais tarde.`);
	return build({
		id: "ferramenta-falhando",
		title: "Fonte que falha várias vezes e o modelo troca de fonte",
		user: "Pesquise o preço da erva seca no fornecedor lento.example.com e, se não abrir, procure em outra fonte e me diga o valor",
		mustMention: ["Ervas do Vale"],
		expectsDocument: false,
		fixtures: [
			extractFixture(bad, "Erro: timeout ao abrir a página.", false),
			searchFixture("Ervas do Vale preço erva seca atacado", supplierPage(SUPPLIERS[0])),
			extractFixture("https://ervasdovale.example.com/precos", supplierPage(SUPPLIERS[0])),
		],
		turns: { v1: [...failing, ...alt, final], v2: [...failing, ...alt, final] },
	});
}

function noNewInformation(): EngineTask {
	// A web quase não tem dado sobre o nicho: 14 buscas diferentes devolvem a mesma página. É onde a estagnação do v1 age.
	const queries = Array.from({ length: 14 }, (_, i) => `fornecedores de erva rara variação ${i + 1}`);
	const page = supplierPage(SUPPLIERS[2]);
	const final = say(`Só encontrei uma fonte com dado confiável sobre erva rara: ${page} As demais buscas voltaram a mesma página, então não há como comparar mais fornecedores com segurança.`);
	return build({
		id: "pesquisa-sem-novidade",
		title: "Nicho com pouca informação: as buscas repetem a mesma página",
		user: "Pesquise fornecedores de erva rara e levante todos os que existem no Brasil com preço e condições",
		mustMention: ["Natureza Viva Atacado"],
		expectsDocument: false,
		fixtures: queries.map((q) => searchFixture(q, page)),
		turns: { v1: [...queries.map(search), final], v2: [...queries.map(search), final] },
	});
}

function longReport(): EngineTask {
	const steps = SUPPLIERS.flatMap((s) => [search(`${s.name} relatório de preço e condições`), extract(`https://${s.host}/condicoes`)]).slice(0, 8);
	const findings = SUPPLIERS.map((s) => `${s.name}: ${brl(s.price)} por kg, mínimo de ${s.minOrder} kg, prazo de cinco dias úteis.`);
	const longText = prose("o mercado de fornecedores de ervas", findings, 1700);
	return build({
		id: "relatorio-longo-documento",
		title: "Relatório longo de fornecedores (deve virar documento)",
		user: "Monte um relatório completo e detalhado dos fornecedores de ervas com preços, condições e recomendação",
		mustMention: SUPPLIERS.map((s) => s.name),
		expectsDocument: true,
		fixtures: SUPPLIERS.flatMap((s) => [searchFixture(`${s.name} relatório de preço e condições`, supplierPage(s)), extractFixture(`https://${s.host}/condicoes`, supplierPage(s))]),
		turns: {
			v1: [...steps, say(longText)],
			v2: [
				taskList([["Levantar os fornecedores", "in_progress"], ["Escrever o relatório", "pending"]]),
				...steps,
				...SUPPLIERS.slice(0, 4).map((s) => note(s.name, `${brl(s.price)}/kg`, `https://${s.host}/condicoes`)),
				taskList([["Levantar os fornecedores", "completed"], ["Escrever o relatório", "in_progress"]]),
				say(longText),
				{ calls: [{ name: "create_file", args: { filename: "relatorio-fornecedores.md", content: `# Relatório de fornecedores\n\n${longText}` } }] },
				taskList([["Levantar os fornecedores", "completed"], ["Escrever o relatório", "completed"]]),
				say("Pronto: o relatório completo está no arquivo relatorio-fornecedores.md, com os 5 fornecedores, preços e a recomendação."),
			],
		},
	});
}

export function engineTasks(): EngineTask[] {
	return [supplierResearch(), deepResearch(), compareStores(), competitorSummary(), skuQuote(), shortReport(), goodMorning(), simpleQuestion(), flakyTool(), noNewInformation(), longReport()];
}
