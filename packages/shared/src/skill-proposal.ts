/**
 * Proposta de skill com gate humano (PLANO-SKILLS K1). Tipos e funções puras
 * compartilhados por runtime (emite), db (persiste), API (aplica na aprovação)
 * e web (renderiza o card). Sem I/O.
 */
import { SKILL_BODY_MAX_BYTES, SKILL_DOCUMENT_MAX_BYTES, SKILL_NAME_MAX_CHARS } from "./skill-markdown.js";

export const SKILL_PROPOSAL_ACTIONS = ["create", "edit", "delete"] as const;
export type SkillProposalAction = (typeof SKILL_PROPOSAL_ACTIONS)[number];
export type SkillProposalStatus = "pending" | "approved" | "rejected";

/**
 * Conteúdo do card de aprovação. `markdown` é o documento final já renderizado
 * (o que o usuário aprova); em `delete` é o documento atual, só para exibir.
 * `botId` nulo = skill da conta inteira. `skillId` e `expectedRevision` só em
 * edit/delete: a aprovação checa a revisão para não sobrescrever edição nova.
 */
export type SkillProposalData = {
	proposalId: string;
	action: SkillProposalAction;
	status: SkillProposalStatus;
	name: string;
	description: string;
	tools: string[];
	body: string;
	markdown: string;
	botId: string | null;
	skillId?: string;
	expectedRevision?: number;
};

/** Evento SSE do card (o `status` é opcional: ausente = pendente). */
export type SkillProposalEvent = { type: "skill-proposal" } & Omit<SkillProposalData, "status"> & {
		status?: SkillProposalStatus;
	};

export const SKILL_PATCH_MAX_ITEMS = 20;

export type SkillBodyPatch = { find: string; replace: string };

export type SkillPatchApplyResult = { ok: true; body: string } | { ok: false; error: string };

/**
 * Edição por trechos (`find`/`replace`) sem reenviar o corpo inteiro. Cada
 * `find` precisa casar exatamente uma vez no corpo já com os patches
 * anteriores; ambíguo ou ausente é erro (nada é aplicado pela metade).
 */
export function applySkillBodyPatches(body: string, patches: unknown): SkillPatchApplyResult {
	if (!Array.isArray(patches) || patches.length === 0) {
		return { ok: false, error: "patch must be a non-empty list of { find, replace }." };
	}
	if (patches.length > SKILL_PATCH_MAX_ITEMS) {
		return { ok: false, error: `patch accepts at most ${SKILL_PATCH_MAX_ITEMS} items.` };
	}
	let next = body;
	for (const [index, item] of patches.entries()) {
		const entry = item as { find?: unknown; replace?: unknown } | null;
		if (!entry || typeof entry.find !== "string" || typeof entry.replace !== "string" || entry.find === "") {
			return { ok: false, error: `patch[${index}] needs a non-empty string "find" and a string "replace".` };
		}
		const first = next.indexOf(entry.find);
		if (first === -1) return { ok: false, error: `patch[${index}]: "find" text not found in the skill body.` };
		if (next.indexOf(entry.find, first + 1) !== -1) {
			return { ok: false, error: `patch[${index}]: "find" matches more than once; include more surrounding text.` };
		}
		next = next.slice(0, first) + entry.replace + next.slice(first + entry.find.length);
	}
	return { ok: true, body: next };
}

function text(value: unknown, max: number): string | null {
	return typeof value === "string" && value.length <= max ? value : null;
}

/** Valida/normaliza o conteúdo do card (usado ao persistir e ao ler do banco). */
export function parseSkillProposal(raw: unknown): SkillProposalData | null {
	if (!raw || typeof raw !== "object") return null;
	const row = raw as Record<string, unknown>;
	const action = row.action;
	if (action !== "create" && action !== "edit" && action !== "delete") return null;
	const proposalId = text(row.proposalId, 120)?.trim();
	const name = text(row.name, SKILL_NAME_MAX_CHARS);
	const description = text(row.description, 600);
	const body = text(row.body, SKILL_BODY_MAX_BYTES * 2);
	const markdown = text(row.markdown, SKILL_DOCUMENT_MAX_BYTES * 2);
	if (!proposalId || !name || description === null || body === null || markdown === null) return null;
	const tools = Array.isArray(row.tools)
		? row.tools.filter((tool): tool is string => typeof tool === "string" && tool.length <= 64).slice(0, 20)
		: [];
	const status = row.status === "approved" || row.status === "rejected" ? row.status : "pending";
	const botId = typeof row.botId === "string" && row.botId.trim() ? row.botId.trim() : null;
	const skillId = typeof row.skillId === "string" && row.skillId.trim() ? row.skillId.trim() : undefined;
	if (action !== "create" && !skillId) return null;
	const expectedRevision =
		typeof row.expectedRevision === "number" && Number.isInteger(row.expectedRevision) && row.expectedRevision >= 0
			? row.expectedRevision
			: undefined;
	return {
		proposalId,
		action,
		status,
		name,
		description,
		tools,
		body,
		markdown,
		botId,
		...(skillId ? { skillId } : {}),
		...(expectedRevision === undefined ? {} : { expectedRevision }),
	};
}

/**
 * Card persistido na timeline (role `skill-proposal`). Fica FORA de
 * `PersistedConversationCard`/`parseConversationCard` de propósito: quem renderiza
 * (web) o trata por `parseSkillProposalCard`, sem mexer nos ramos dos outros cards.
 */
export type PersistedSkillProposalCard = { v: 1; kind: "skill-proposal" } & SkillProposalData;

export function parseSkillProposalCard(content: string): PersistedSkillProposalCard | null {
	let raw: unknown;
	try {
		raw = JSON.parse(content) as unknown;
	} catch {
		return null;
	}
	if (!raw || typeof raw !== "object" || (raw as { v?: unknown }).v !== 1 || (raw as { kind?: unknown }).kind !== "skill-proposal") {
		return null;
	}
	const proposal = parseSkillProposal(raw);
	return proposal ? { v: 1, kind: "skill-proposal", ...proposal } : null;
}
