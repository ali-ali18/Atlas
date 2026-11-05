// Prévia da conversa quando a última mensagem é um card: ícone do tipo + título (como a lista do Grok).
// O servidor manda `lastMessage.role` (o `kind` do card) e o `content` cortado em 200 caracteres
// (`BOT_PREVIEW_MAX_CHARS` em packages/db/src/bots.ts), ou seja, o JSON do card quase sempre vem truncado e não
// dá para `JSON.parse`. Por isso o título sai de uma leitura tolerante dos campos de texto que chegaram inteiros;
// faltou o campo, a prévia mostra o rótulo do tipo em pt-BR. Funções puras (testadas em card-preview.test.ts).

/** Chave do ícone de cada tipo; o desenho mora em `components/home/card-preview-icon.tsx`. */
export type CardIconKey =
	| "chart"
	| "panel"
	| "document"
	| "spreadsheet"
	| "presentation"
	| "images"
	| "routine"
	| "tasks"
	| "questionnaire"
	| "subagents"
	| "login"
	| "approval"
	| "skill"
	| "code"
	| "compaction"
	| "agent"
	| "profile"
	| "generic";

/** Todas as chaves de ícone (valida o que volta do cache do aparelho). */
export const CARD_ICON_KEYS: readonly CardIconKey[] = ["chart", "panel", "document", "spreadsheet", "presentation", "images", "routine", "tasks", "questionnaire", "subagents", "login", "approval", "skill", "code", "compaction", "agent", "profile", "generic"];

export type CardPreview = { icon: CardIconKey; title: string };

/** Marcadores internos (sem conteúdo para o usuário): não viram prévia. */
const MARKER_ROLES: ReadonlySet<string> = new Set(["tool-budget", "jev-status", "provider-fallback", "revised-draft"]);

/** Texto de um campo string do JSON, mesmo que o resto esteja cortado. `undefined` se o campo não chegou inteiro. */
export function jsonTextField(content: string, key: string): string | undefined {
	const match = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(content);
	if (!match) return undefined;
	try {
		const value = (JSON.parse(`"${match[1]}"`) as string).replace(/\s+/g, " ").trim();
		return value || undefined;
	} catch {
		return undefined;
	}
}

function jsonRecord(content: string): Record<string, unknown> | null {
	try {
		const raw: unknown = JSON.parse(content);
		return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

const first = (...values: Array<string | undefined>): string | undefined => values.find((value) => Boolean(value));

function fileIcon(filename: string | undefined): CardIconKey {
	const ext = filename?.toLowerCase().split(".").pop();
	if (ext === "xlsx" || ext === "xls" || ext === "csv") return "spreadsheet";
	if (ext === "pptx" || ext === "ppt") return "presentation";
	return "document";
}

function taskListTitle(content: string): string {
	const items = jsonRecord(content)?.items;
	if (!Array.isArray(items) || items.length === 0) return "Tarefas";
	const done = items.filter((item) => typeof item === "object" && item !== null && (item as { status?: unknown }).status === "completed").length;
	return `Tarefas · ${done}/${items.length} concluídas`;
}

function imagesTitle(content: string): string {
	const caption = jsonTextField(content, "caption");
	if (caption) return caption;
	const items = jsonRecord(content)?.items;
	return Array.isArray(items) && items.length > 1 ? `${items.length} imagens` : "Imagem";
}

/**
 * Ícone e título do card guardado com este `role`; `null` quando o papel não é de card (mensagem de texto).
 * Título do payload quando existe (nome da rotina, título do Painel, arquivo, pergunta); senão o rótulo do tipo.
 */
export function cardPreviewOf(role: string, content: string): CardPreview | null {
	const byRole = cardPreviewByKind(role, content);
	if (byRole) return byRole;
	// O papel não disse que é card (ex.: linha antiga ou papel genérico) mas o conteúdo é o JSON de um card:
	// o `kind` do próprio payload decide, e nunca vaza JSON cru para a prévia.
	const kind = cardKindOfContent(content);
	if (kind === null) return null;
	return cardPreviewByKind(kind, content) ?? { icon: "generic", title: "Card" };
}

/** `kind` de um card serializado (`{"v":1,"kind":"…`), lido do prefixo mesmo cortado em 200 caracteres. Formato fixo de `serializeConversationCard`. */
export function cardKindOfContent(content: string): string | null {
	const match = /^\s*\{\s*"v"\s*:\s*\d+\s*,\s*"kind"\s*:\s*"([^"\\]{1,60})"/.exec(content);
	if (match) return match[1] ?? null;
	// `kind` fora de ordem ou cortado: ainda é card (começa com `{"v":`), só não sabemos qual.
	return /^\s*\{\s*"v"\s*:/.test(content) ? "" : null;
}

function cardPreviewByKind(role: string, content: string): CardPreview | null {
	switch (role) {
		case "chart": {
			const head = content.split('"data"')[0] ?? content;
			return { icon: "chart", title: jsonTextField(head, "title") ?? "Gráfico" };
		}
		case "page":
			return { icon: "panel", title: jsonTextField(content, "title") ?? "Painel" };
		case "file": {
			const filename = jsonTextField(content, "filename");
			return { icon: fileIcon(filename), title: filename ?? "Documento" };
		}
		case "images":
			return { icon: "images", title: imagesTitle(content) };
		case "routine":
			return { icon: "routine", title: jsonTextField(content, "action") === "listed" ? "Rotinas" : (jsonTextField(content, "title") ?? "Rotina") };
		case "routine-proposal":
			return { icon: "routine", title: jsonTextField(content, "name") ?? "Rotina" };
		case "task-list":
			return { icon: "tasks", title: taskListTitle(content) };
		case "questionnaire":
			return { icon: "questionnaire", title: first(jsonTextField(content, "prompt"), jsonTextField(content, "title")) ?? "Questionário" };
		case "subagents":
			return { icon: "subagents", title: first(jsonTextField(content, "title"), jsonTextField(content, "goal")) ?? "Subagentes" };
		case "login": {
			const site = jsonTextField(content, "site");
			return { icon: "login", title: site ? `Login em ${site}` : "Login" };
		}
		case "confirm":
			return { icon: "approval", title: jsonTextField(content, "title") ?? "Pedido de aprovação" };
		case "skill":
			return { icon: "skill", title: jsonTextField(content, "action") === "listed" ? "Habilidades" : (jsonTextField(content, "title") ?? "Habilidade") };
		case "skill-proposal":
			return { icon: "skill", title: jsonTextField(content, "name") ?? "Habilidade" };
		case "code-run":
			return { icon: "code", title: "Código executado" };
		case "compaction":
			return { icon: "compaction", title: "Conversa compactada" };
		case "bot-proposal":
			return { icon: "agent", title: jsonTextField(content, "name") ?? "Novo agente" };
		case "bot-profile": {
			const name = jsonTextField(content, "name");
			return { icon: "profile", title: name ? `Atualizar perfil de ${name}` : "Atualizar perfil" };
		}
		default:
			return null;
	}
}

/** Papel de marcador interno (limite de ferramenta, fallback de modelo…): a conversa não tem prévia útil nele. */
export const isMarkerRole = (role: string): boolean => MARKER_ROLES.has(role);

/** Marcador interno cujo papel não veio como tal, mas o `kind` do conteúdo mostra que é. */
export const isMarkerContent = (content: string): boolean => {
	const kind = cardKindOfContent(content);
	return kind !== null && MARKER_ROLES.has(kind);
};

/** Todo `role` que vira card na prévia (para a folha de ícones e os testes). */
export const CARD_PREVIEW_ROLES = ["chart", "page", "file", "images", "routine", "routine-proposal", "task-list", "questionnaire", "subagents", "login", "confirm", "skill", "skill-proposal", "code-run", "compaction", "bot-proposal", "bot-profile"] as const;
