import { parseScenario, type ArgPredicates, type MockTurn, type Scenario } from "../scenario.js";
import { bridgeConnectors, bridgeNativeFixtures, WORLD } from "./world.js";

/**
 * As 10 tarefas da avaliação da ponte (harness v3, marco M1; desenho 14.2). Em todas a tool certa está FORA do núcleo
 * e há 50 conectores falsos no manifesto. Cada tarefa traz o que precisa acontecer (`steps`), o que não pode
 * (`forbid`), o mínimo de passos de modelo e um roteiro por motor para o modo mock (prova a mecânica, não o modelo).
 */

export type BridgeStep = {
	/** Nome real da tool (como o runtime a executa, `mcp__slug__nome` para conector). */
	tool: string;
	/** Valor certo dos argumentos (correção). */
	args?: ArgPredicates;
	/** Campos obrigatórios das tools nativas (a validade dos de conector sai do `inputSchema` do cenário). */
	required?: string[];
};

export type BridgeTask = {
	id: string;
	title: string;
	user: string;
	/** `call`: as `steps` precisam acontecer, nessa ordem. `none`: nenhuma tool de ação existe, o bot tem de dizer que não dá. */
	kind: "call" | "none";
	steps: BridgeStep[];
	/** Tools que NÃO podem rodar: nome exato ou prefixo terminado em `*`. Em `none`, vale para qualquer tool que não seja de busca. */
	forbid: string[];
	/** Passos de modelo no melhor caso (uma tool por passo; a segunda depende do resultado da primeira). */
	minSteps: number;
	scenario: Scenario;
	/** Roteiro por motor: `v2` = "carrega e anexa" (`mcp_tool_search` e depois a tool); `v3` = ponte (`tool_call` direto do manifesto, ou `tool_search`). */
	turns: { v2: MockTurn[]; v3: MockTurn[] };
	/** O bot tem caixa de e-mail própria neste cenário. */
	email: boolean;
};

const say = (text: string): MockTurn => ({ say: text });
const direct = (name: string, args: Record<string, unknown>): MockTurn => ({ calls: [{ name, args }] });
const viaBridge = (name: string, args: Record<string, unknown>): MockTurn => direct("tool_call", { name, args });
const search = (query: string): MockTurn => direct("tool_search", { query });
const load = (query: string): MockTurn => direct("mcp_tool_search", { query });

const COMPRAS = (name: string) => `mcp__compras_fornecedores__${name}`;
const VENDAS = (name: string) => `mcp__vendas_loja__${name}`;

type TaskInput = Omit<BridgeTask, "scenario" | "email"> & { email?: boolean };

function build(input: TaskInput): BridgeTask {
	const parsed = parseScenario({
		version: 1,
		id: `ponte-${input.id}`,
		title: input.title,
		tags: ["bridge"],
		bot: { name: "Lia", about: "Assistente de uma loja de chás e ervas.", language: "pt-BR" },
		user: input.user,
		tools: { fixtures: bridgeNativeFixtures(), connectors: bridgeConnectors() },
		run: { maxSteps: 8, origin: "chat" },
		expect: [{ type: "completed" }],
	});
	if (!parsed.ok) throw new Error(`tarefa ${input.id}: ${parsed.error}`);
	return { ...input, email: input.email ?? false, scenario: parsed.scenario };
}

export function bridgeTasks(): BridgeTask[] {
	return [
		build({
			id: "criar-bot",
			title: "Criar um bot novo (propose_bot x 50 create_bot de conector)",
			user: "Cria um agente novo pra cuidar do meu estoque: avisar quando um item estiver acabando e organizar as reposições.",
			kind: "call",
			steps: [{ tool: "propose_bot", required: ["name", "description"] }],
			forbid: ["mcp__robos_facil__*"],
			minSteps: 1,
			turns: {
				v2: [load("propose_bot"), direct("propose_bot", { name: "Estoquinho", description: "Cuida do estoque: avisa quando um item está acabando e organiza as reposições." }), say("Montei a proposta do agente de estoque. É só revisar o cartão e aprovar.")],
				v3: [viaBridge("propose_bot", { name: "Estoquinho", description: "Cuida do estoque: avisa quando um item está acabando e organiza as reposições." }), say("Montei a proposta do agente de estoque. É só revisar o cartão e aprovar.")],
			},
		}),
		build({
			id: "criar-painel",
			title: "Criar um painel com gráfico (page_create x create_dashboard de conector)",
			user: "Monta um painel de vendas do mês com um gráfico de barras por produto: camomila 120, hortelã 80, boldo 45.",
			kind: "call",
			steps: [{ tool: "page_create", required: ["title", "root"] }],
			forbid: ["mcp__paineis_plus__*"],
			minSteps: 1,
			turns: {
				v2: [load("page_create"), direct("page_create", { title: "Vendas do mês", root: { type: "chart", id: "c1" } }), say("Pronto, o painel de vendas do mês está no chat.")],
				v3: [viaBridge("page_create", { title: "Vendas do mês", root: { type: "chart", id: "c1" } }), say("Pronto, o painel de vendas do mês está no chat.")],
			},
		}),
		build({
			id: "ler-email",
			title: "Ler o e-mail do bot (email_list e depois email_read, em sequência)",
			user: "Chegou algum e-mail novo na sua caixa? Me conta o que o último diz.",
			kind: "call",
			steps: [{ tool: "email_list" }, { tool: "email_read", args: { thread_id: { equals: WORLD.emailThread } }, required: ["thread_id"] }],
			forbid: ["mcp__email_marketing__*"],
			minSteps: 2,
			email: true,
			turns: {
				v2: [load("email_list email_read"), direct("email_list", {}), direct("email_read", { thread_id: WORLD.emailThread }), say("O último e-mail é do Ervas do Vale com a tabela de novembro: camomila R$ 18,90/kg e hortelã R$ 16,40/kg.")],
				v3: [viaBridge("email_list", {}), viaBridge("email_read", { thread_id: WORLD.emailThread }), say("O último e-mail é do Ervas do Vale com a tabela de novembro: camomila R$ 18,90/kg e hortelã R$ 16,40/kg.")],
			},
		}),
		build({
			id: "criar-rotina",
			title: "Criar uma rotina em dias úteis (propose_routine x create_reminder de conector)",
			user: "Todo dia útil às 9h confere o estoque de camomila e me avisa se estiver baixo.",
			kind: "call",
			steps: [{ tool: "propose_routine", required: ["action", "detail", "trigger_type"], args: { action: { equals: "create" } } }],
			forbid: ["mcp__agenda_pro__*"],
			minSteps: 1,
			turns: {
				v2: [load("propose_routine"), direct("propose_routine", { action: "create", title: "Estoque de camomila", detail: "Conferir o estoque de camomila e avisar se estiver baixo.", trigger_type: "cron", schedule: "0 9 * * 1-5" }), say("Combinado: todo dia útil às 9h eu confiro a camomila.")],
				v3: [viaBridge("propose_routine", { action: "create", title: "Estoque de camomila", detail: "Conferir o estoque de camomila e avisar se estiver baixo.", trigger_type: "cron", schedule: "0 9 * * 1-5" }), say("Combinado: todo dia útil às 9h eu confiro a camomila.")],
			},
		}),
		build({
			id: "conector-prefixo",
			title: "Conector com nome degradado no manifesto (prefixo + listPurchaseOrders x listSalesOrders)",
			user: "Quais pedidos de compra em aberto eu tenho com o Ervas do Vale?",
			kind: "call",
			steps: [{ tool: COMPRAS("listPurchaseOrders") }],
			forbid: [VENDAS("*")],
			minSteps: 1,
			turns: {
				v2: [load("listPurchaseOrders"), direct(COMPRAS("listPurchaseOrders"), { status: "open", supplier: WORLD.supplier }), say("Você tem 2 pedidos de compra em aberto com o Ervas do Vale: R$ 2.430,00 e R$ 860,00.")],
				v3: [search("list purchase orders"), viaBridge(COMPRAS("listPurchaseOrders"), { status: "open", supplier: WORLD.supplier }), say("Você tem 2 pedidos de compra em aberto com o Ervas do Vale: R$ 2.430,00 e R$ 860,00.")],
			},
		}),
		build({
			id: "args-obrigatorios",
			title: "Tool com argumento obrigatório e tipo inteiro (getSalesOrder.orderId)",
			user: "Mostra os detalhes do pedido de venda 48213.",
			kind: "call",
			steps: [{ tool: VENDAS("getSalesOrder"), args: { orderId: { equals: WORLD.salesOrderDetail } } }],
			forbid: [COMPRAS("*")],
			minSteps: 1,
			turns: {
				v2: [load("getSalesOrder"), direct(VENDAS("getSalesOrder"), { orderId: WORLD.salesOrderDetail }), say("O pedido 48213 é do Mercado Azul, está pago: 4 de camomila 250 g e 2 de boldo 100 g, total de R$ 140,20.")],
				v3: [search("get sales order"), viaBridge(VENDAS("getSalesOrder"), { orderId: WORLD.salesOrderDetail }), say("O pedido 48213 é do Mercado Azul, está pago: 4 de camomila 250 g e 2 de boldo 100 g, total de R$ 140,20.")],
			},
		}),
		build({
			id: "tool-inexistente",
			title: "Pedido sem tool que sirva (publicar no TikTok): dizer que não dá, sem inventar nome",
			user: "Publica no TikTok o vídeo novo do nosso produto.",
			kind: "none",
			steps: [],
			forbid: ["*"],
			minSteps: 1,
			turns: {
				v2: [load("tiktok publicar vídeo"), say("Não consigo publicar no TikTok daqui. Posso deixar a legenda pronta para você postar, se quiser.")],
				v3: [search("publish video tiktok"), say("Não consigo publicar no TikTok daqui. Posso deixar a legenda pronta para você postar, se quiser.")],
			},
		}),
		build({
			id: "duas-em-sequencia",
			title: "Duas tools em sequência (listSalesOrders e depois getSalesOrder com o id do resultado; só o detalhe traz os itens)",
			user: "Pega o pedido de venda mais recente e me diz quais produtos (SKU e quantidade) tem nele.",
			kind: "call",
			steps: [{ tool: VENDAS("listSalesOrders") }, { tool: VENDAS("getSalesOrder"), args: { orderId: { equals: WORLD.latestSalesOrder } } }],
			forbid: [COMPRAS("*")],
			minSteps: 2,
			turns: {
				v2: [load("listSalesOrders getSalesOrder"), direct(VENDAS("listSalesOrders"), { limit: 1 }), direct(VENDAS("getSalesOrder"), { orderId: WORLD.latestSalesOrder }), say(`O pedido mais recente é o ${WORLD.latestSalesOrder}, da ${WORLD.latestSalesCustomer}: 12 unidades do HRT-100.`)],
				v3: [search("sales orders"), viaBridge(VENDAS("listSalesOrders"), { limit: 1 }), viaBridge(VENDAS("getSalesOrder"), { orderId: WORLD.latestSalesOrder }), say(`O pedido mais recente é o ${WORLD.latestSalesOrder}, da ${WORLD.latestSalesCustomer}: 12 unidades do HRT-100.`)],
			},
		}),
		build({
			id: "nativa-vs-conector",
			title: "Nativa e conector empatados (list_routines do sistema x list_routines do Agenda Pro)",
			user: "Lista as minhas rotinas.",
			kind: "call",
			steps: [{ tool: "list_routines" }],
			forbid: ["mcp__agenda_pro__*"],
			minSteps: 1,
			turns: {
				v2: [load("list_routines"), direct("list_routines", {}), say("Você tem 2 rotinas: o resumo semanal de vendas (segundas, 8h) e a conferência do estoque de camomila (dias úteis, 9h).")],
				v3: [viaBridge("list_routines", {}), say("Você tem 2 rotinas: o resumo semanal de vendas (segundas, 8h) e a conferência do estoque de camomila (dias úteis, 9h).")],
			},
		}),
		build({
			id: "cofre-pt-br",
			title: "Pedido coloquial em pt-BR sem o nome da tool (cofre de segredos)",
			user: "Será que eu já guardei a senha do portal do fornecedor? Dá uma olhada no cofre.",
			kind: "call",
			steps: [{ tool: "secret_list" }],
			forbid: [],
			minSteps: 1,
			turns: {
				v2: [load("secret_list"), direct("secret_list", {}), say("Sim, tem um acesso salvo chamado Portal Ervas do Vale, e também a chave da Lojinha.")],
				v3: [viaBridge("secret_list", {}), say("Sim, tem um acesso salvo chamado Portal Ervas do Vale, e também a chave da Lojinha.")],
			},
		}),
	];
}
