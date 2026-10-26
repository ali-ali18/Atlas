/**
 * Fontes do brief "Seu dia": cada conector ligado cai numa categoria (e-mail, agenda, mensagens…),
 * para o painel se organizar por tipo e não por produto (trocar Gmail por Outlook não muda o brief).
 * Funções puras, sem I/O.
 */

export type SourceCategory = "email" | "calendar" | "messages" | "tasks" | "business" | "other";

export const SOURCE_CATEGORIES: readonly SourceCategory[] = ["email", "calendar", "messages", "tasks", "business", "other"];

/** Nome da categoria para o usuário (pt-BR). */
export const SOURCE_CATEGORY_LABELS: Readonly<Record<SourceCategory, string>> = {
	email: "E-mail",
	calendar: "Agenda",
	messages: "Mensagens",
	tasks: "Tarefas",
	business: "Negócio",
	other: "Outros",
};

export type BriefSourceKind = "mcp" | "composio" | "api";

/** Chave comparável: minúscula, sem acento nem separador ("Google Agenda" → "googleagenda"). */
function sourceKey(raw: string): string {
	return raw
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "");
}

const EXACT: Readonly<Record<string, SourceCategory>> = {
	// e-mail
	gmail: "email",
	googlemail: "email",
	outlook: "email",
	outlookmail: "email",
	microsoftoutlook: "email",
	office365mail: "email",
	yahoomail: "email",
	protonmail: "email",
	fastmail: "email",
	imap: "email",
	// agenda
	googlecalendar: "calendar",
	googleagenda: "calendar",
	outlookcalendar: "calendar",
	microsoftcalendar: "calendar",
	icloudcalendar: "calendar",
	calendly: "calendar",
	calcom: "calendar",
	// mensagens
	slack: "messages",
	discord: "messages",
	telegram: "messages",
	whatsapp: "messages",
	whatsappbusiness: "messages",
	microsoftteams: "messages",
	teams: "messages",
	intercom: "messages",
	zendesk: "messages",
	twilio: "messages",
	// tarefas
	notion: "tasks",
	linear: "tasks",
	trello: "tasks",
	github: "tasks",
	gitlab: "tasks",
	asana: "tasks",
	jira: "tasks",
	clickup: "tasks",
	todoist: "tasks",
	mondaycom: "tasks",
	monday: "tasks",
	basecamp: "tasks",
	googletasks: "tasks",
	microsofttodo: "tasks",
	// negócio
	bling: "business",
	shopify: "business",
	stripe: "business",
	hubspot: "business",
	salesforce: "business",
	pipedrive: "business",
	quickbooks: "business",
	xero: "business",
	woocommerce: "business",
	nuvemshop: "business",
	vtex: "business",
	mercadolivre: "business",
	mercadopago: "business",
	contaazul: "business",
	omie: "business",
	tiny: "business",
	paypal: "business",
	// ficam de fora do brief (não são caixa de entrada nem trabalho do dia)
	googledrive: "other",
	googlesheets: "other",
	firecrawl: "other",
	bravesearch: "other",
	higgsfield: "other",
	composio: "other",
};

/** Palavras-chave para nomes que a tabela não conhece (conector próprio, apelido). Ordem importa: agenda antes de e-mail. */
const KEYWORDS: ReadonlyArray<[RegExp, SourceCategory]> = [
	[/calendar|agenda/, "calendar"],
	[/mail|outlook|inbox/, "email"],
	[/slack|whatsapp|telegram|discord|teams|message|sms/, "messages"],
	[/task|todo|issue|ticket|kanban|jira|linear|notion|trello|asana/, "tasks"],
	[/erp|crm|shop|loja|pedido|order|invoice|financ|bank|banco|stock|estoque/, "business"],
];

/**
 * Categoria de uma fonte conectada. `toolkit` (Composio) e `catalogId` (catálogo nativo) têm prioridade
 * sobre o nome livre; conector de API (OpenAPI, ex.: Bling) é "negócio" por padrão.
 */
export function categorizeSource(input: {
	kind?: BriefSourceKind;
	catalogId?: string | null;
	toolkit?: string | null;
	name?: string | null;
}): SourceCategory {
	for (const raw of [input.toolkit, input.catalogId, input.name]) {
		if (!raw) continue;
		const key = sourceKey(raw);
		if (!key) continue;
		const exact = EXACT[key];
		if (exact) return exact;
	}
	for (const raw of [input.toolkit, input.catalogId, input.name]) {
		if (!raw) continue;
		const key = sourceKey(raw);
		for (const [pattern, category] of KEYWORDS) if (pattern.test(key)) return category;
	}
	return input.kind === "api" ? "business" : "other";
}

/**
 * Toolkit de uma tool do Composio pelo prefixo do nome: `GMAIL_FETCH_EMAILS` → "gmail",
 * `GOOGLE_CALENDAR_EVENTS_LIST` → "googlecalendar" (dois primeiros termos quando o primeiro sozinho não é conhecido).
 */
export function composioToolkitOfTool(toolName: string): string {
	const parts = toolName.trim().split("_").filter(Boolean);
	const first = sourceKey(parts[0] ?? "");
	if (!first) return "";
	if (EXACT[first]) return first;
	const two = sourceKey(parts.slice(0, 2).join(""));
	return EXACT[two] ? two : first;
}

/** Fontes que o brief lê (as "outros" ficam de fora: Drive, Planilhas, busca na web). */
export function isBriefCategory(category: SourceCategory): boolean {
	return category !== "other";
}
