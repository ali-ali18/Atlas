/**
 * Proposta de novo agente (bot) com gate humano. Tipos e funções puras
 * compartilhados por runtime (emite), db (persiste e cria na aprovação), API
 * (resolve) e web (renderiza o card). Sem I/O. Nada é criado antes de o dono
 * aprovar o card.
 */
import { AVATAR_COLORS } from "./avatar/identity.js";
import { SHAPE_IDS } from "./avatar/geometry/shapes.js";

export type BotProposalStatus = "pending" | "approved" | "rejected";

export const BOT_PROPOSAL_NAME_MAX = 40;
export const BOT_PROPOSAL_DESCRIPTION_MAX = 600;
export const BOT_PROPOSAL_SNIPPET_MAX = 90;
export const BOT_PROPOSAL_TASK_MAX = 2000;
export const BOT_PROPOSAL_SKILLS_MAX = 5;
export const BOT_PROPOSAL_MODEL_MAX = 120;

/** Opções de aparência que o formulário de criar bot oferece (mesma paleta e formas do editor de avatar). */
export const BOT_PROPOSAL_COLOR_IDS: readonly string[] = AVATAR_COLORS.map((color) => color.id);
export const BOT_PROPOSAL_SHAPE_IDS: readonly string[] = SHAPE_IDS;
export const BOT_PROPOSAL_DEFAULT_COLOR = "#FF6700";
export const BOT_PROPOSAL_DEFAULT_SHAPE = "blob";

export type BotProposalData = {
	proposalId: string;
	status: BotProposalStatus;
	name: string;
	/** Papel do agente (vira o briefing/descrição do bot). */
	description: string;
	/** Linha curta da lista de conversas. */
	snippet: string;
	/** Cor do corpo, em hex da paleta. */
	color: string;
	shape: string;
	/** Modelo escolhido pelo bot; nulo = padrão da conta. */
	model: string | null;
	/** Skills da conta (slugs) copiadas para o escopo do novo bot. */
	skills: string[];
	/** Primeira tarefa enviada ao agente depois de criado. */
	firstTask: string | null;
	/** Id do bot criado (só depois de aprovado). */
	botId?: string;
};

export type BotProposalEvent = { type: "bot-proposal" } & Omit<BotProposalData, "status"> & {
		status?: BotProposalStatus;
	};

export type PersistedBotProposalCard = { v: 1; kind: "bot-proposal" } & BotProposalData;

/** Cor por id ("blue") ou hex da paleta, devolvida no hex canônico; fora da paleta = `null`. */
export function resolveBotProposalColor(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const text = raw.trim().toLowerCase();
	if (!text) return null;
	const found = AVATAR_COLORS.find((color) => color.id === text || color.value.toLowerCase() === text || color.name.toLowerCase() === text);
	return found ? found.value : null;
}

export function isBotProposalShape(raw: unknown): raw is string {
	return typeof raw === "string" && (SHAPE_IDS as readonly string[]).includes(raw.trim());
}

function clean(value: unknown, max: number): string | null {
	if (typeof value !== "string") return null;
	const text = value.replace(/\s+/g, " ").trim();
	return text && text.length <= max ? text : null;
}

/** Valida/normaliza o conteúdo do card (ao persistir e ao ler do banco). */
export function parseBotProposal(raw: unknown): BotProposalData | null {
	if (!raw || typeof raw !== "object") return null;
	const row = raw as Record<string, unknown>;
	if (typeof row.proposalId !== "string" || !row.proposalId.trim() || row.proposalId.length > 120) return null;
	const name = clean(row.name, BOT_PROPOSAL_NAME_MAX);
	const description = typeof row.description === "string" && row.description.trim().length <= BOT_PROPOSAL_DESCRIPTION_MAX ? row.description.trim() : null;
	if (!name || !description) return null;
	const color = resolveBotProposalColor(row.color) ?? BOT_PROPOSAL_DEFAULT_COLOR;
	const shape = isBotProposalShape(row.shape) ? row.shape.trim() : BOT_PROPOSAL_DEFAULT_SHAPE;
	const status: BotProposalStatus = row.status === "approved" || row.status === "rejected" ? row.status : "pending";
	const skills = Array.isArray(row.skills)
		? [...new Set(row.skills.filter((item): item is string => typeof item === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item)))].slice(0, BOT_PROPOSAL_SKILLS_MAX)
		: [];
	const model = clean(row.model, BOT_PROPOSAL_MODEL_MAX);
	const firstTask = typeof row.firstTask === "string" && row.firstTask.trim() && row.firstTask.length <= BOT_PROPOSAL_TASK_MAX ? row.firstTask.trim() : null;
	return {
		proposalId: row.proposalId.trim(),
		status,
		name,
		description,
		snippet: clean(row.snippet, BOT_PROPOSAL_SNIPPET_MAX) ?? description.slice(0, BOT_PROPOSAL_SNIPPET_MAX),
		color,
		shape,
		model,
		skills,
		firstTask,
		...(typeof row.botId === "string" && row.botId.trim() ? { botId: row.botId.trim() } : {}),
	};
}

export function parseBotProposalCard(raw: unknown): PersistedBotProposalCard | null {
	if (!raw || typeof raw !== "object") return null;
	const row = raw as Record<string, unknown>;
	if (row.v !== 1 || row.kind !== "bot-proposal") return null;
	const data = parseBotProposal(row);
	return data ? { v: 1, kind: "bot-proposal", ...data } : null;
}

/** Revisão feita no card antes de criar: só nome e papel. */
export function parseBotProposalEdits(raw: unknown): { name?: string; description?: string } | null {
	if (raw === undefined || raw === null) return {};
	if (typeof raw !== "object") return null;
	const row = raw as Record<string, unknown>;
	const out: { name?: string; description?: string } = {};
	if (row.name !== undefined) {
		const name = clean(row.name, BOT_PROPOSAL_NAME_MAX);
		if (!name) return null;
		out.name = name;
	}
	if (row.description !== undefined) {
		if (typeof row.description !== "string" || !row.description.trim() || row.description.trim().length > BOT_PROPOSAL_DESCRIPTION_MAX) return null;
		out.description = row.description.trim();
	}
	return out;
}

/**
 * Pedido vago de criar agente: a última fala só pede "cria um agente pra mim"
 * (menos de 3 palavras de conteúdo além do pedido). Estreita de propósito:
 * respostas de questionário e pedidos com o que o agente faz não casam.
 */
const BOT_CREATE_REQUEST = /\b(cri[aeo]\w*|faz\w*|fazer|mont\w+|nova|novo|preciso|quero|queria|gostaria|create|make|new)\b[^.!?\n]*\b(agentes?|bots?|assistentes?|agents?|assistants?)\b/i;
const BOT_FILLER = new Set([
	"quero", "queria", "preciso", "gostaria", "pode", "poderia", "por", "favor", "me", "mim", "de", "do", "da", "uma", "um", "nova", "novo", "agente", "agentes", "bot", "bots",
	"assistente", "assistentes", "criar", "crie", "cria", "criem", "fazer", "faz", "faça", "monte", "montar", "que", "pra", "para", "a", "o", "e", "eu", "voce", "você", "vc", "ai", "aí",
	"create", "make", "new", "an", "please", "i", "want", "need", "to", "agent", "agents", "assistant", "assistants",
]);

export function isBareBotCreateRequest(lastUserText: string | undefined): boolean {
	const last = lastUserText?.trim();
	if (!last || last.startsWith("{") || !BOT_CREATE_REQUEST.test(last)) return false;
	const words = last.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
	return words.filter((word) => !BOT_FILLER.has(word)).length < 3;
}
