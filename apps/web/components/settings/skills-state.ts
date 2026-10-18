/**
 * Modelo puro da seção Habilidades: busca/filtro, rótulos, validação do
 * formulário e mapeamento para o payload da API. Sem React nem `fetch`.
 */
import {
	SKILL_BODY_MAX_BYTES,
	SKILL_DESCRIPTION_MAX_CHARS,
	validateSkillFields,
} from "@workspace/shared";
import type { BuiltinSkillView, SkillDocView, SkillWriteInput } from "@/lib/atlas-api";
import { normalizeSearch } from "./settings-registry";

export { SKILL_BODY_MAX_BYTES, SKILL_DESCRIPTION_MAX_CHARS };

/** `all`, `account` (sem bot) ou `bot:<id>`. */
export type SkillScopeFilter = string;
export const SCOPE_ALL = "all";
export const SCOPE_ACCOUNT = "account";

export type BotRef = { id: string; name: string };

export function scopeFilterOptions(bots: readonly BotRef[]): { value: SkillScopeFilter; label: string }[] {
	return [
		{ value: SCOPE_ALL, label: "Todos os escopos" },
		{ value: SCOPE_ACCOUNT, label: "Conta" },
		...bots.map((bot) => ({ value: `bot:${bot.id}`, label: bot.name })),
	];
}

export function scopeLabel(skill: Pick<SkillDocView, "botId">, bots: readonly BotRef[]): string {
	if (!skill.botId) return "Conta";
	return bots.find((bot) => bot.id === skill.botId)?.name ?? "Bot removido";
}

/** Busca (sem acento/caixa) por nome e descrição + filtro de escopo. */
export function filterSkills(
	skills: readonly SkillDocView[],
	{ query, scope }: { query: string; scope: SkillScopeFilter },
): SkillDocView[] {
	const text = normalizeSearch(query);
	return skills.filter((skill) => {
		if (scope === SCOPE_ACCOUNT && skill.botId) return false;
		if (scope.startsWith("bot:") && skill.botId !== scope.slice(4)) return false;
		if (!text) return true;
		return normalizeSearch(`${skill.name} ${skill.description}`).includes(text);
	});
}

/** Ativas (e desativadas pelo dono) numa lista; rascunhos em outra, recolhida. */
export function partitionSkills(skills: readonly SkillDocView[]): {
	active: SkillDocView[];
	drafts: SkillDocView[];
} {
	return {
		active: skills.filter((skill) => skill.status !== "draft"),
		drafts: skills.filter((skill) => skill.status === "draft"),
	};
}

export function statusLabel(skill: Pick<SkillDocView, "status" | "enabled">): string {
	if (skill.status === "draft") return "Rascunho";
	return skill.enabled ? "Ativa" : "Desativada";
}

export function originLabel(createdBy: SkillDocView["createdBy"]): string {
	return createdBy === "agent" ? "Criada pelo agente" : "Criada por você";
}

/** "06/10/2026" no fuso do navegador (ou o informado, nos testes). */
export function formatSkillDate(iso: string, timeZone?: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	return date.toLocaleDateString("pt-BR", { timeZone });
}

/** Troca uma skill na lista (switch otimista e rollback). */
export function patchSkillInList(
	skills: readonly SkillDocView[],
	id: string,
	patch: Partial<SkillDocView>,
): SkillDocView[] {
	return skills.map((skill) => (skill.id === id ? { ...skill, ...patch } : skill));
}

export function sortSkills(skills: readonly SkillDocView[]): SkillDocView[] {
	return [...skills].sort((a, b) => a.name.localeCompare(b.name));
}

/** Rascunho vira ativo ao ligar o switch; ao desligar só desliga. */
export function togglePatch(skill: Pick<SkillDocView, "status">, enabled: boolean) {
	return enabled && skill.status === "draft"
		? { enabled: true, status: "active" as const }
		: { enabled };
}

export const IMPORT_NOTICE =
	"Importada como rascunho e desativada. Ela veio de um arquivo externo: revise o conteúdo antes de ativar.";

export function deleteConfirmText(skill: Pick<SkillDocView, "name">): { title: string; description: string } {
	return {
		title: `Apagar a habilidade "${skill.name}"?`,
		description: "O agente deixa de enxergá-la e não dá para desfazer. Exporte antes se quiser guardar uma cópia.",
	};
}

export function exportFileName(skill: Pick<SkillDocView, "name">): string {
	return `${skill.name}.md`;
}

/** Rascunhos do escopo escolhido (ignora a busca): é o que "Apagar rascunhos" remove. */
export function draftsInScope(skills: readonly SkillDocView[], scope: SkillScopeFilter): SkillDocView[] {
	return partitionSkills(filterSkills(skills, { query: "", scope })).drafts;
}

/** Escopo do filtro → parâmetros da rota de apagar rascunhos em lote. */
export function draftScopeParams(scope: SkillScopeFilter): { botId?: string; account?: boolean } {
	if (scope === SCOPE_ACCOUNT) return { account: true };
	if (scope.startsWith("bot:")) return { botId: scope.slice(4) };
	return {};
}

export function deleteDraftsConfirmText(count: number): { title: string; description: string } {
	const noun = count === 1 ? "1 rascunho" : `${count} rascunhos`;
	return {
		title: `Apagar ${noun}?`,
		description: "Só os rascunhos do filtro atual são apagados. Habilidades ativas não são tocadas e não dá para desfazer.",
	};
}

export const DRAFT_SWITCH_HINT = "Ativar publica este rascunho";

export function emptyListText(total: number, filtered: boolean): string {
	if (total === 0) return "Nenhuma habilidade ainda. Peça ao agente para salvar um procedimento ou crie a sua.";
	return filtered ? "Nenhuma habilidade encontrada para esse filtro." : "";
}

// --- formulário do editor ---

export type SkillForm = {
	name: string;
	description: string;
	body: string;
	/** Lista separada por vírgula (dica, nunca permissão). */
	toolsText: string;
	/** `null` = conta. Fixo depois de criada. */
	botId: string | null;
};

export const EMPTY_SKILL_FORM: SkillForm = { name: "", description: "", body: "", toolsText: "", botId: null };

export function formFromSkill(skill: SkillDocView): SkillForm {
	return {
		name: skill.name,
		description: skill.description,
		body: skill.body ?? "",
		toolsText: skill.tools.join(", "),
		botId: skill.botId,
	};
}

/** Há alterações a perder? Compara o formulário atual com o que o editor abriu. */
export function isSkillFormDirty(initial: SkillForm, current: SkillForm): boolean {
	return (
		initial.name !== current.name ||
		initial.description !== current.description ||
		initial.body !== current.body ||
		parseToolsText(initial.toolsText).join(",") !== parseToolsText(current.toolsText).join(",") ||
		initial.botId !== current.botId
	);
}

export const DISCARD_CONFIRM = {
	title: "Descartar alterações?",
	description: "O que você editou nesta habilidade ainda não foi salvo e será perdido.",
	keep: "Continuar editando",
	discard: "Descartar",
} as const;

export function parseToolsText(text: string): string[] {
	return text
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

export function bodyBytes(body: string): number {
	return new TextEncoder().encode(body).length;
}

export function bodyCounterLabel(body: string): string {
	return `${(bodyBytes(body) / 1024).toFixed(1).replace(".", ",")} de ${SKILL_BODY_MAX_BYTES / 1024} KB`;
}

export type SkillFormErrors = Partial<Record<"name" | "description" | "body" | "tools", string>>;

function fieldOfError(message: string): keyof SkillFormErrors {
	if (message.startsWith("O nome")) return "name";
	if (message.startsWith("A descrição")) return "description";
	if (message.startsWith("O corpo")) return "body";
	return "tools";
}

/** Valida com a mesma regra do servidor (`validateSkillFields`), por campo, em pt-BR. */
export function validateSkillForm(
	form: SkillForm,
): { ok: true; input: SkillWriteInput } | { ok: false; errors: SkillFormErrors } {
	const result = validateSkillFields({
		name: form.name,
		description: form.description,
		body: form.body,
		tools: parseToolsText(form.toolsText),
	});
	if (!result.ok) {
		const errors: SkillFormErrors = {};
		for (const message of result.errors) {
			const field = fieldOfError(message);
			errors[field] = errors[field] ? `${errors[field]} ${message}` : message;
		}
		return { ok: false, errors };
	}
	const { name, description, body, tools } = result.skill;
	return { ok: true, input: { name, description, body, tools, botId: form.botId } };
}

/** Mensagem pt-BR para o erro da API (409 nome repetido/revisão velha, 413 grande, 422 limite). */
export function skillErrorMessage(error: unknown): string {
	const status = typeof error === "object" && error !== null && "status" in error ? Number(error.status) : 0;
	const message = error instanceof Error ? error.message : "";
	switch (status) {
		case 409:
			return message || "Já existe uma habilidade com esse nome ou ela foi alterada em outro lugar. Recarregue e tente de novo.";
		case 413:
			return "O documento é grande demais. O corpo da habilidade aceita até 16 KB.";
		case 422:
			return message || "Limite de habilidades atingido.";
		case 404:
			return "Habilidade não encontrada. Ela pode ter sido apagada.";
		case 400:
			return message || "Dados inválidos.";
		default:
			return "Não foi possível concluir. Tente novamente.";
	}
}

// --- skills de fábrica ---

export const BUILTIN_GROUP_TITLE = "De fábrica";
export const BUILTIN_GROUP_HINT =
	"Vêm com o produto, valem para todos os agentes e não podem ser alteradas. Duplique para criar a sua versão: com o mesmo nome, a sua passa na frente.";

/** Busca (sem acento/caixa) por nome, slug e descrição. */
export function filterBuiltins(builtins: readonly BuiltinSkillView[], query: string): BuiltinSkillView[] {
	const text = normalizeSearch(query);
	if (!text) return [...builtins];
	return builtins.filter((skill) => normalizeSearch(`${skill.name} ${skill.slug} ${skill.description}`).includes(text));
}

/** O filtro de escopo só vale para as do dono: as de fábrica somem quando se filtra por bot. */
export function builtinsVisibleForScope(scope: SkillScopeFilter): boolean {
	return !scope.startsWith("bot:");
}

export function duplicateErrorMessage(error: unknown): string {
	const status = typeof error === "object" && error !== null && "status" in error ? Number(error.status) : 0;
	if (status === 409) return "Você já tem uma habilidade com esse nome na conta. Edite a sua em vez de duplicar.";
	return skillErrorMessage(error);
}
