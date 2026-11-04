// Nomes das categorias do Composio no idioma do aparelho. A tradução é pelo id/slug (estável), não pelo texto que a API
// devolve. Id desconhecido mostra o nome original arrumado; idioma sem tabela mostra o original. Funções puras.

type Table = Record<string, string>;

const PT: Table = {
	popular: "Populares",
	productivity: "Produtividade",
	"developer-tools": "Ferramentas de desenvolvimento",
	"dev-tools": "Ferramentas de desenvolvimento",
	developer: "Desenvolvimento",
	communication: "Comunicação",
	collaboration: "Colaboração",
	marketing: "Marketing",
	"email-marketing": "E-mail marketing",
	sales: "Vendas",
	"sales-crm": "Vendas e CRM",
	crm: "CRM",
	finance: "Finanças",
	accounting: "Contabilidade",
	"finance-accounting": "Finanças e contabilidade",
	payment: "Pagamentos",
	payments: "Pagamentos",
	analytics: "Análises",
	"data-analytics": "Dados e análises",
	ai: "Inteligência artificial",
	"ai-tools": "Inteligência artificial",
	"artificial-intelligence": "Inteligência artificial",
	"ai-machine-learning": "Inteligência artificial",
	design: "Design",
	"images-design": "Imagens e design",
	"social-media": "Redes sociais",
	"social-media-marketing": "Redes sociais",
	"project-management": "Gestão de projetos",
	"task-management": "Gestão de tarefas",
	storage: "Armazenamento",
	"file-storage": "Armazenamento",
	"file-management-storage": "Armazenamento",
	education: "Educação",
	entertainment: "Entretenimento",
	ecommerce: "E-commerce",
	"e-commerce": "E-commerce",
	hr: "Recursos humanos",
	"human-resources": "Recursos humanos",
	"hr-talent-management": "Recursos humanos",
	"customer-support": "Atendimento ao cliente",
	"customer-service": "Atendimento ao cliente",
	support: "Suporte",
	security: "Segurança",
	"it-operations": "Operações de TI",
	devops: "DevOps",
	database: "Banco de dados",
	databases: "Banco de dados",
	calendar: "Agenda",
	"scheduling-booking": "Agendamentos",
	scheduling: "Agendamentos",
	"documents-and-notes": "Documentos e notas",
	documents: "Documentos",
	notes: "Notas",
	"note-taking": "Notas",
	"video-conferencing": "Videoconferência",
	"forms-surveys": "Formulários e pesquisas",
	forms: "Formulários",
	surveys: "Pesquisas",
	"e-signatures": "Assinaturas eletrônicas",
	"content-management": "Gestão de conteúdo",
	"website-builders": "Criadores de sites",
	"time-tracking": "Controle de horas",
	"team-chat": "Chat de equipe",
	"transactional-email": "E-mail transacional",
	email: "E-mail",
	"phone-sms": "Telefonia e SMS",
	"contact-management": "Contatos",
	"lead-generation": "Geração de leads",
	advertising: "Publicidade",
	ads: "Publicidade",
	"video-audio": "Vídeo e áudio",
	"photo-video": "Fotos e vídeos",
	"music-audio": "Música e áudio",
	"news-media": "Notícias e mídia",
	"maps-location": "Mapas e localização",
	travel: "Viagens",
	"health-fitness": "Saúde e bem-estar",
	healthcare: "Saúde",
	legal: "Jurídico",
	"real-estate": "Imóveis",
	gaming: "Jogos",
	automation: "Automação",
	"workflow-automation": "Automação",
	"no-code": "Sem código",
	other: "Outros",
	others: "Outros",
	"other-miscellaneous": "Outros",
	miscellaneous: "Outros",
	misc: "Outros",
};

const ES: Table = {
	popular: "Populares",
	productivity: "Productividad",
	"developer-tools": "Herramientas de desarrollo",
	communication: "Comunicación",
	collaboration: "Colaboración",
	marketing: "Marketing",
	sales: "Ventas",
	"sales-crm": "Ventas y CRM",
	crm: "CRM",
	finance: "Finanzas",
	accounting: "Contabilidad",
	"finance-accounting": "Finanzas y contabilidad",
	payment: "Pagos",
	payments: "Pagos",
	analytics: "Analítica",
	ai: "Inteligencia artificial",
	design: "Diseño",
	"social-media": "Redes sociales",
	"project-management": "Gestión de proyectos",
	storage: "Almacenamiento",
	education: "Educación",
	entertainment: "Entretenimiento",
	ecommerce: "Comercio electrónico",
	"e-commerce": "Comercio electrónico",
	hr: "Recursos humanos",
	"human-resources": "Recursos humanos",
	"customer-support": "Atención al cliente",
	security: "Seguridad",
	database: "Bases de datos",
	databases: "Bases de datos",
	calendar: "Calendario",
	email: "Correo electrónico",
	automation: "Automatización",
	other: "Otros",
	"other-miscellaneous": "Otros",
	miscellaneous: "Otros",
};

const TABLES: Record<string, Table> = { pt: PT, es: ES };

/** Fica na frente (rank 0) ou no fim (rank 2). Ids fora daqui mantêm a ordem que vieram. */
const FIRST = new Set(["popular"]);
const LAST = new Set(["other", "others", "other-miscellaneous", "miscellaneous", "misc"]);

/** Chave de busca: minúsculas, sem acento, separadores viram "-". "Other / Miscellaneous" → "other-miscellaneous". */
export function categoryKey(id: string): string {
	return id
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/** Nome original arrumado: separadores viram espaço e a primeira letra fica maiúscula. Nunca vazio. */
export function tidyCategoryName(name: string, id = ""): string {
	const base = name.trim() || id;
	const spaced = base.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
	return spaced ? spaced[0]!.toLocaleUpperCase() + spaced.slice(1) : "Outros";
}

/** Rótulo da categoria no idioma pedido ("pt", "pt-BR", "es"…). Idioma sem tabela: nome original; id sem tradução: original arrumado. */
export function composioCategoryLabel(id: string, name: string, language: string): string {
	const lang = language.trim().toLowerCase().split(/[-_]/)[0] ?? "";
	const table = Object.hasOwn(TABLES, lang) ? TABLES[lang]! : null;
	if (!table) return name.trim() || tidyCategoryName(name, id);
	for (const key of [categoryKey(id), categoryKey(name)]) {
		if (key && Object.hasOwn(table, key)) return table[key]!;
	}
	return tidyCategoryName(name, id);
}

/** Posição para ordenar: "popular" primeiro, "outros" por último, o resto no meio (sort estável mantém a ordem da API). */
export function composioCategoryRank(id: string, name = ""): number {
	const keys = [categoryKey(id), categoryKey(name)];
	if (keys.some((key) => FIRST.has(key))) return 0;
	if (keys.some((key) => LAST.has(key))) return 2;
	return 1;
}
