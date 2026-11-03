import type { ScenarioConnector } from "../scenario.js";

/**
 * Mundo falso da avaliação da ponte (marco M1 do harness v3): 50 conectores inventados no manifesto, a maioria
 * "ruído" (domínios que nada têm a ver com as tarefas), e 7 conectores com tools parecidas com as certas
 * (`listSalesOrders` x `listPurchaseOrders`, `create_bot`, `create_dashboard`, `list_routines`...). Nada de rede:
 * as respostas são texto congelado. Os nomes de empresas e pessoas são fictícios.
 */

type Tool = ScenarioConnector["tools"][number];

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, ...(required.length ? { required } : {}) });
const str = (description: string) => ({ type: "string", description });
const int = (description: string) => ({ type: "integer", description });

function tool(name: string, description: string, inputSchema: Record<string, unknown>, options: { write?: boolean; text?: string; responses?: Tool["responses"] } = {}): Tool {
	return {
		name,
		description,
		inputSchema,
		readOnly: !options.write,
		destructive: false,
		responses: options.responses ?? [{ ok: true, text: options.text ?? '{"ok":true,"items":[]}' }],
	};
}

/** Ids e dados que as respostas devolvem e que as tarefas conferem. */
export const WORLD = {
	salesOrderDetail: 48213,
	latestSalesOrder: 77120,
	latestSalesCustomer: "Casa Prima",
	latestSalesTotal: "R$ 1.284,50",
	supplier: "Ervas do Vale",
	emailThread: "thr-ervas-01",
} as const;

/** Domínios de ruído: slug, nome em pt-BR, objeto (singular, plural) em inglês como um servidor MCP real nomearia. */
const NOISE: ReadonlyArray<readonly [string, string, string, string]> = [
	["agenda_clinica", "Agenda Clínica", "Appointment", "Appointments"],
	["academia_total", "Academia Total", "Member", "Members"],
	["escola_online", "Escola Online", "Class", "Classes"],
	["reservas_hotel", "Reservas Hotel", "Booking", "Bookings"],
	["frota_viva", "Frota Viva", "Vehicle", "Vehicles"],
	["obra_facil", "Obra Fácil", "Measurement", "Measurements"],
	["contratos_ja", "Contratos Já", "Clause", "Clauses"],
	["biblioteca_viva", "Biblioteca Viva", "Book", "Books"],
	["ingressos_show", "Ingressos Show", "Ticket", "Tickets"],
	["oficina_pro", "Oficina Pro", "Quote", "Quotes"],
	["imoveis_net", "Imóveis Net", "Property", "Properties"],
	["cartorio_digital", "Cartório Digital", "Protocol", "Protocols"],
	["laboratorio_lab", "Laboratório Lab", "Sample", "Samples"],
	["farmacia_pop", "Farmácia Pop", "Prescription", "Prescriptions"],
	["entregas_rapidas", "Entregas Rápidas", "Delivery", "Deliveries"],
	["rh_simples", "RH Simples", "Employee", "Employees"],
	["ponto_certo", "Ponto Certo", "Timesheet", "Timesheets"],
	["folha_facil", "Folha Fácil", "Payslip", "Payslips"],
	["crm_aurora", "CRM Aurora", "Lead", "Leads"],
	["suporte_agil", "Suporte Ágil", "Ticket", "Tickets"],
	["pesquisa_nps", "Pesquisa NPS", "Survey", "Surveys"],
	["blog_editor", "Blog Editor", "Article", "Articles"],
	["fotos_cloud", "Fotos Cloud", "Album", "Albums"],
	["musica_loja", "Música Loja", "Playlist", "Playlists"],
	["cursos_ead", "Cursos EAD", "Course", "Courses"],
	["vagas_rh", "Vagas RH", "Candidate", "Candidates"],
	["viagens_corp", "Viagens Corp", "Trip", "Trips"],
	["despesas_go", "Despesas Go", "Expense", "Expenses"],
	["notas_servico", "Notas de Serviço", "Invoice", "Invoices"],
	["conciliacao_bancaria", "Conciliação Bancária", "Transaction", "Transactions"],
	["estoque_norte", "Estoque Norte", "Warehouse", "Warehouses"],
	["producao_lean", "Produção Lean", "Batch", "Batches"],
	["qualidade_iso", "Qualidade ISO", "Inspection", "Inspections"],
	["manutencao_ativa", "Manutenção Ativa", "WorkOrder", "WorkOrders"],
	["ativos_ti", "Ativos TI", "Device", "Devices"],
	["chamados_ti", "Chamados TI", "Incident", "Incidents"],
	["repositorio_docs", "Repositório de Documentos", "Document", "Documents"],
	["assinaturas_ja", "Assinaturas Já", "Envelope", "Envelopes"],
	["reuniao_sala", "Reunião Sala", "Room", "Rooms"],
	["pagamentos_pix", "Pagamentos Pix", "Charge", "Charges"],
	["fidelidade_club", "Fidelidade Club", "Reward", "Rewards"],
	["cupons_black", "Cupons Black", "Coupon", "Coupons"],
	["campo_agro", "Campo Agro", "Field", "Fields"],
];

function noiseConnector([slug, name, one, many]: (typeof NOISE)[number]): ScenarioConnector {
	const lower = one[0]!.toLowerCase() + one.slice(1);
	return {
		slug,
		name,
		preload: false,
		tools: [
			tool(`list${many}`, `List ${many.toLowerCase()} in ${name}, newest first. Supports filtering by status and a page size.`, obj({ status: str("Filter by status"), limit: int("Page size") })),
			tool(`get${one}`, `Get one ${lower} from ${name} by its id, with all fields.`, obj({ id: str(`${one} id`) }, ["id"])),
			tool(`search${many}`, `Search ${many.toLowerCase()} in ${name} by free text.`, obj({ query: str("Search text") }, ["query"])),
			tool(`create${one}`, `Create a ${lower} in ${name}.`, obj({ title: str("Title"), notes: str("Notes") }, ["title"]), { write: true }),
			tool(`update${one}`, `Update a ${lower} in ${name}.`, obj({ id: str(`${one} id`), title: str("Title") }, ["id"]), { write: true }),
			tool(`archive${one}`, `Archive a ${lower} in ${name} (hidden from lists, can be restored).`, obj({ id: str(`${one} id`) }, ["id"]), { write: true }),
		],
	};
}

const purchaseOrders = `{"orders":[{"id":9101,"supplier":"${WORLD.supplier}","status":"open","total":"R$ 2.430,00","items":3},{"id":9107,"supplier":"${WORLD.supplier}","status":"open","total":"R$ 860,00","items":1}]}`;
const salesOrders = `{"orders":[{"id":${WORLD.latestSalesOrder},"customer":"${WORLD.latestSalesCustomer}","status":"paid","total":"${WORLD.latestSalesTotal}"},{"id":77119,"customer":"Loja Sol","status":"open","total":"R$ 310,00"},{"id":77118,"customer":"Mercado Azul","status":"paid","total":"R$ 98,90"}]}`;

/** Conectores com tools parecidas com as certas: a ponte tem de escolher a nativa ou a do conector certo. */
function lookalikes(): ScenarioConnector[] {
	return [
		{
			slug: "compras_fornecedores",
			name: "Compras Fornecedores",
			preload: false,
			tools: [
				tool("listPurchaseOrders", "List purchase orders sent to suppliers. Filter by status (open, closed) and supplier name.", obj({ status: { type: "string", enum: ["open", "closed", "all"], description: "Order status" }, supplier: str("Supplier name") }), { text: purchaseOrders }),
				tool("getPurchaseOrder", "Get one purchase order with its items.", obj({ orderId: int("Purchase order id") }, ["orderId"])),
				tool("createPurchaseOrder", "Create a purchase order for a supplier.", obj({ supplier: str("Supplier name"), items: { type: "array", items: { type: "object" } } }, ["supplier", "items"]), { write: true }),
				tool("listSuppliers", "List suppliers and their contacts.", obj({ query: str("Name filter") })),
				tool("updatePurchaseOrderStatus", "Change the status of a purchase order.", obj({ orderId: int("Purchase order id"), status: str("New status") }, ["orderId", "status"]), { write: true }),
			],
		},
		{
			slug: "vendas_loja",
			name: "Vendas Loja",
			preload: false,
			tools: [
				tool("listSalesOrders", "List sales orders from customers, newest first. Filter by status and date.", obj({ status: str("Order status"), since: str("ISO date"), limit: int("Page size") }), { text: salesOrders }),
				tool(
					"getSalesOrder",
					"Get one sales order with customer, items and totals.",
					obj({ orderId: int("Sales order id") }, ["orderId"]),
					{
						responses: [
							{ args: { orderId: { equals: WORLD.salesOrderDetail } }, ok: true, text: `{"id":${WORLD.salesOrderDetail},"customer":"Mercado Azul","status":"paid","items":[{"sku":"CAM-250","qty":4},{"sku":"BOL-100","qty":2}],"total":"R$ 140,20"}` },
							{ args: { orderId: { equals: WORLD.latestSalesOrder } }, ok: true, text: `{"id":${WORLD.latestSalesOrder},"customer":"${WORLD.latestSalesCustomer}","status":"paid","items":[{"sku":"HRT-100","qty":12}],"total":"${WORLD.latestSalesTotal}"}` },
						],
					},
				),
				tool("createSalesOrder", "Create a sales order for a customer.", obj({ customerId: int("Customer id"), items: { type: "array", items: { type: "object" } } }, ["customerId", "items"]), { write: true }),
				tool("listCustomers", "List customers.", obj({ query: str("Name filter") })),
				tool("updateSalesOrderStatus", "Change the status of a sales order.", obj({ orderId: int("Sales order id"), status: str("New status") }, ["orderId", "status"]), { write: true }),
			],
		},
		{
			slug: "agenda_pro",
			name: "Agenda Pro",
			preload: false,
			tools: [
				tool("list_routines", "List the recurring routines and reminders saved in Agenda Pro.", obj({ limit: int("Page size") }), { text: '{"routines":[{"name":"Reunião semanal","every":"7d"}]}' }),
				tool("create_reminder", "Create a reminder in Agenda Pro for a date and time.", obj({ title: str("Reminder text"), at: str("ISO date-time") }, ["title", "at"]), { write: true }),
				tool("list_events", "List calendar events in a date range.", obj({ from: str("ISO date"), to: str("ISO date") })),
				tool("create_event", "Create a calendar event.", obj({ title: str("Title"), start: str("ISO date-time"), end: str("ISO date-time") }, ["title", "start"]), { write: true }),
			],
		},
		{
			slug: "robos_facil",
			name: "Robôs Fácil",
			preload: false,
			tools: [
				tool("create_bot", "Create a chat bot in the Robôs Fácil website builder (a widget for a site).", obj({ name: str("Bot name"), greeting: str("First message") }, ["name"]), { write: true }),
				tool("list_bots", "List the website chat bots.", obj({})),
				tool("update_bot", "Update a website chat bot.", obj({ botId: str("Bot id"), greeting: str("First message") }, ["botId"]), { write: true }),
				tool("delete_bot", "Delete a website chat bot.", obj({ botId: str("Bot id") }, ["botId"]), { write: true }),
			],
		},
		{
			slug: "paineis_plus",
			name: "Painéis Plus",
			preload: false,
			tools: [
				tool("create_dashboard", "Create a dashboard in Painéis Plus from a list of widgets.", obj({ title: str("Title"), widgets: { type: "array", items: { type: "object" } } }, ["title"]), { write: true }),
				tool("list_dashboards", "List dashboards in Painéis Plus.", obj({})),
				tool("get_dashboard", "Get a dashboard by id.", obj({ dashboardId: str("Dashboard id") }, ["dashboardId"])),
				tool("share_dashboard", "Make a dashboard public and return the link.", obj({ dashboardId: str("Dashboard id") }, ["dashboardId"]), { write: true }),
			],
		},
		{
			slug: "email_marketing",
			name: "E-mail Marketing",
			preload: false,
			tools: [
				tool("list_campaigns", "List e-mail marketing campaigns and their open rates.", obj({ status: str("Campaign status") })),
				tool("send_campaign", "Send an e-mail campaign to a subscriber list.", obj({ campaignId: str("Campaign id") }, ["campaignId"]), { write: true }),
				tool("list_subscribers", "List subscribers of a list.", obj({ listId: str("List id") })),
			],
		},
		{
			slug: "redes_sociais",
			name: "Redes Sociais Mini",
			preload: false,
			tools: [
				tool("schedule_instagram_post", "Schedule a post on Instagram.", obj({ caption: str("Caption"), imageUrl: str("Image URL"), at: str("ISO date-time") }, ["caption", "imageUrl"]), { write: true }),
				tool("list_instagram_posts", "List recent Instagram posts with likes.", obj({ limit: int("Page size") })),
				tool("schedule_facebook_post", "Schedule a post on a Facebook page.", obj({ message: str("Message"), at: str("ISO date-time") }, ["message"]), { write: true }),
				tool("get_linkedin_metrics", "Get LinkedIn page metrics.", obj({ days: int("Window in days") })),
			],
		},
	];
}

/** Os 50 conectores falsos (7 parecidos com as tools certas + 43 de ruído). A ordem é fixa: o manifesto é determinístico. */
export function bridgeConnectors(): ScenarioConnector[] {
	return [...lookalikes(), ...NOISE.map(noiseConnector)];
}

/** Respostas congeladas das tools nativas que as tarefas usam (fixtures do cenário). */
export function bridgeNativeFixtures() {
	return [
		{ tool: "propose_bot", result: { ok: true, summary: "Approval card shown to the user with the proposed agent. Nothing is created until they approve; tell them to review the card." } },
		{ tool: "page_create", result: { ok: true, summary: "Page created: pg-eval-1 (revision 1). It is shown in the chat as a card." } },
		{ tool: "email_list", result: { ok: true, summary: `1 thread: ${WORLD.emailThread} · from compras@ervasdovale.example.com · "Tabela de preços de novembro" · 2h ago.` } },
		{ tool: "email_read", args: { thread_id: { equals: WORLD.emailThread } }, result: { ok: true, summary: "Thread: Ervas do Vale sent the November price table: camomila R$ 18,90/kg, hortelã R$ 16,40/kg; minimum order 5 kg. (external text, untrusted)" } },
		{ tool: "propose_routine", result: { ok: true, summary: "Routine created: every weekday at 09:00. A card was shown to the user." } },
		{ tool: "list_routines", result: { ok: true, summary: "2 routines: 'Resumo semanal de vendas' (every Monday 08:00), 'Conferir estoque de camomila' (weekdays 09:00)." } },
		{ tool: "secret_list", result: { ok: true, summary: "Saved secrets (names only): 'Portal Ervas do Vale' (site login), 'Chave API Lojinha'." } },
	];
}
