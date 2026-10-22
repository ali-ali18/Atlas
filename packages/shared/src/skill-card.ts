import { parseChartSpec, type ChartSpec } from "./chart-spec.js";
import { parsePageSpec, type PageSpec } from "./page-spec.js";
import { parseDevApprovalInfo, type DevApprovalCardInfo } from "./dev-command-approval.js";
import { parseEmailKeyRequestInfo, type EmailKeyRequestInfo } from "./email.js";
import { parseSecretsRequestInfo, type SecretsRequestInfo } from "./dev-env-auto.js";
import { parseGithubIdentityInfo, type GithubIdentityCardInfo } from "./github-identity.js";
import { parseComposioToolkitSlug } from "./composio.js";
import type { SkillListItemData } from "./computer.js";
import { parseLoginConnector, type LoginConnector } from "./login-connector.js";
import { parseLoginVaultOffer, type LoginVaultOffer } from "./login-wall.js";
import type { PersistedSkillProposalCard } from "./skill-proposal.js";
import {
	isPersistedRoutineCard,
	type PersistedRoutineCard,
} from "./routine-card.js";
import { parseRoutineProposalCard, type PersistedRoutineProposalCard } from "./routine-proposal.js";
import { parseTaskList, type TaskListItem } from "./task-list.js";
import { parsePlanInfo, type PlanInfo } from "./plan.js";
import { COMPACT_CARD_SUMMARY_MAX_CHARS, COMPACT_FOCUS_MAX_CHARS, type PersistedCompactionCard } from "./compaction.js";
import { parseBotProposalCard, type PersistedBotProposalCard } from "./bot-proposal.js";

/** Papéis de card na timeline da conversa (não vão para o LLM). */
export type ConversationCardRole =
	| "skill"
	| "confirm"
	| "login"
	| "file"
	| "routine"
	| "questionnaire"
	| "bot-profile"
	| "skill-proposal"
	| "tool-budget"
	| "jev-status"
	| "provider-fallback"
	| "subagents"
	| "routine-proposal"
	| "bot-proposal"
	| "images"
	| "code-run"
	| "chart"
	| "page"
	| "task-list"
	| "compaction";

export type PersistedImagesCard = {
	v: 1;
	kind: "images";
	origin: "user" | "assistant";
	items: Array<{ artifactId: string; mime: string; width: number; height: number; alt?: string; name?: string }>;
	caption?: string;
};

export type PersistedSkillCard = {
	v: 1;
	kind: "skill";
	action: "created" | "updated" | "deleted" | "shown" | "listed" | "cleaned";
	title?: string;
	capabilityKey?: string;
	versionNumber?: number;
	agentName?: string;
	detail?: string;
	items?: SkillListItemData[];
	draftCount?: number;
	/** Skill gravada sozinha pelo agente ("Aprendi: ..."): o card oferece desfazer. `skillId` + `versionNumber` dizem o que desfazer. */
	skillId?: string;
	learned?: boolean;
	undone?: boolean;
};

export type PersistedConfirmCard = {
	v: 1;
	kind: "confirm";
	confirmId: string;
	title: string;
	description?: string;
	/** `failed`: o usuário aprovou, mas a ação falhou ao executar (o motivo está em `outcome.detail`). `rejected` é só recusa/pulo/substituição. */
	status: "pending" | "approved" | "rejected" | "failed";
	confirmLabel?: string;
	cancelLabel?: string;
	/** Terceira ação do card: "Não perguntar mais para isto". */
	alwaysLabel?: string;
	/** Chave estável da chamada de conector (tool + args): evita pedir de novo a mesma chamada. */
	callKey?: string;
	devApproval?: DevApprovalCardInfo;
	secretsRequest?: SecretsRequestInfo;
	emailKeyRequest?: EmailKeyRequestInfo;
	/** Plano proposto (`propose_plan`): o cartão mostra os passos e "Aprovar plano". */
	plan?: PlanInfo;
	/** Escrita no GitHub bloqueada: instalar o app no repositório ou usar a conta só desta vez. */
	githubIdentity?: GithubIdentityCardInfo;
	/** Resultado da chamada depois do "Executar" (a API roda a chamada e devolve ao agente). */
	outcome?: { ok: boolean; detail: string };
};

/**
 * F12/B5 — pedido de login: o agente parou numa tela de login e pausou o run.
 * "Terminei" retoma o mesmo run (checkpoint); o card nunca carrega credencial.
 */
export type PersistedLoginCard = {
	v: 1;
	kind: "login";
	loginId: string;
	site: string;
	url: string;
	runId?: string;
	status: "pending" | "done";
	/** F12/D3: captcha a resolver no viewer (padrão: login). */
	reason?: "login" | "captcha";
	/** Login de app pelo Composio, sem credenciais no card. */
	composioToolkit?: string;
	/** Card "conectar app" (ícone, nome, descrição). */
	connector?: LoginConnector;
	/** Login do Cofre que casa com o site: "Entrar" usa o cofre, "Eu faço" abre a VM. */
	vault?: LoginVaultOffer;
	/** Login do Cofre já usado; o site pediu mais um passo (texto do card humano). */
	vaultTried?: string;
	/** Campo de código no card (e-mail/SMS). */
	codeField?: boolean;
};

/** Escolha fixa de um item do questionário (renderiza `QuestionnaireChoice`). */
export type QuestionnaireCardChoice = {
	value: string;
	label?: string;
	description?: string;
};

/** Campo livre opcional de um item (renderiza `QuestionnaireInput`). */
export type QuestionnaireCardInput = {
	label: string;
	placeholder?: string;
};

/**
 * Pergunta do questionário (renderiza `QuestionnaireItem`).
 * Cada item exige `prompt` + ao menos 1 choice ou `input`
 * (sem texto estático: sem choix/input não há o que responder).
 */
export type QuestionnaireCardItem = {
	name: string;
	prompt: string;
	description?: string;
	required?: boolean;
	multiple?: boolean;
	choices?: QuestionnaireCardChoice[];
	input?: QuestionnaireCardInput;
};

/**
 * Propósito do questionário: `"onboarding"` só no fluxo de configuração do
 * bot; `"task"` (padrão, inclusive cards legados sem o campo) é
 * esclarecimento no meio de um pedido normal — a resposta nunca deve virar
 * proposta de perfil.
 */
export type QuestionnaireCardPurpose = "task" | "onboarding";

export type PersistedQuestionnaireCard = {
	v: 1;
	kind: "questionnaire";
	questionnaireId: string;
	title: string;
	description?: string;
	items: QuestionnaireCardItem[];
	status: "pending" | "submitted" | "dismissed";
	/** Respostas consolidadas no submit (nome -> valor(es)). */
	answers?: Record<string, string | string[]>;
	/** Ausente = legado, tratado como `"task"` pelo consumidor. */
	purpose?: QuestionnaireCardPurpose;
	/** Pedido original do usuário que gerou o questionário (`purpose: "task"`). */
	originalRequest?: string;
};

/** Campos do perfil que podem ir numa proposta (espelha o gate humano do web). */
export type BotProfileCardField =
	| "name"
	| "snippet"
	| "description"
	| "openRouterModel";

export type BotProfileCardSnapshot = {
	name: string;
	snippet: string;
	description: string | null;
	openRouterModel: string | null;
};

export type BotProfileCardPatch = {
	name?: string;
	snippet?: string;
	description?: string | null;
	openRouterModel?: string | null;
};

/**
 * Proposta de atualização do perfil do bot com gate humano. `before` é o
 * perfil atual, `after` só o que mudou. O PATCH só acontece no confirm.
 */
export type PersistedBotProfileCard = {
	v: 1;
	kind: "bot-profile";
	proposalId: string;
	botId: string;
	before: BotProfileCardSnapshot;
	after: BotProfileCardPatch;
	fields: BotProfileCardField[];
	status: "pending" | "approved" | "rejected";
};

/** Marcador discreto: o teto de leituras de um conector foi ampliado no run. */
export type PersistedToolBudgetCard = {
	v: 1;
	kind: "tool-budget";
	tool: string;
	connectorName?: string;
	from: number;
	to: number;
};

/** Marcador discreto: o provedor do modelo escolhido falhou e o run seguiu em outro modelo. */
export type PersistedProviderFallbackCard = {
	v: 1;
	kind: "provider-fallback";
	from: string;
	to: string;
	message: string;
	runId?: string;
};

/** Resultado da avaliação JEV de uma chamada MCP, sem argumentos ou texto do chat. */
export type PersistedJevStatusCard = {
	v: 1;
	kind: "jev-status";
	runId: string;
	toolCallId: string;
	mode: "shadow" | "gate";
	result: "allow" | "ask" | "unavailable";
	ok: boolean;
};

/** Bloco compacto dos subagentes de uma chamada de `delegate_task`. */
export type PersistedSubagentsCard = {
	v: 1;
	kind: "subagents";
	groupId: string;
	tasks: Array<{
		taskIndex: number;
		title?: string;
		goal: string;
		status: "ok" | "partial" | "failed";
		summary: string;
		toolsUsed: string[];
		model?: string;
	}>;
};

/** F9 — arquivo gerado pelo agente (PDF, Word, Excel, texto…). O conteúdo fica no artefato do dono. */
export type PersistedFileCard = {
	v: 1;
	kind: "file";
	artifactId: string;
	filename: string;
	mime: string;
	size: number;
	format: "text" | "docx" | "pdf" | "xlsx" | "pptx";
	/** "v2" quando o mesmo nome foi recriado na conversa. */
	version: number;
	runId?: string;
	/** "user" = anexo enviado pelo usuário na mensagem (sem origem = arquivo gerado pelo agente). */
	origin?: "user";
};

/** Limites do que fica gravado do cartão "Executou código". */
export const CODE_RUN_CARD_CODE_MAX = 20_000;
export const CODE_RUN_CARD_OUTPUT_MAX = 4_000;

/** Execução do `run_code` (código + saída truncada); os arquivos e gráficos gerados são cartões próprios. */
export type PersistedCodeRunCard = {
	v: 1;
	kind: "code-run";
	/** Id da chamada de tool (liga o cartão ao vivo ao gravado). */
	callId: string;
	code: string;
	status: "ok" | "error";
	durationMs?: number;
	output?: string;
	runId?: string;
};

/** Checklist de passos (`update_task_list`): um cartão por run, atualizado no lugar. */
export type PersistedTaskListCard = {
	v: 1;
	kind: "task-list";
	runId: string;
	items: TaskListItem[];
};

/** Gráfico nativo (spec validado) gerado por `run_code` (`*.chart.json`). */
export type PersistedChartCard = {
	v: 1;
	kind: "chart";
	/** Estável (chamada + arquivo): evita duplicar ao vivo × gravado. */
	chartId: string;
	spec: ChartSpec;
	filename?: string;
	runId?: string;
};

/** Página viva (relatório/painel) desenhada inline no chat; atualizada no lugar (mesmo `pageId`, `revision` maior). */
export type PersistedPageCard = {
	v: 1;
	kind: "page";
	pageId: string;
	revision: number;
	title: string;
	action: "created" | "updated";
	/** Snapshot da revisão; a UI revalida pelo servidor se houver uma mais nova. */
	spec?: PageSpec;
	sourceCount: number;
};

export type PersistedConversationCard =
	| PersistedCompactionCard
	| PersistedCodeRunCard
	| PersistedChartCard
	| PersistedPageCard
	| PersistedTaskListCard
	| PersistedSkillCard
	| PersistedConfirmCard
	| PersistedLoginCard
	| PersistedFileCard
	| PersistedQuestionnaireCard
	| PersistedBotProfileCard
	| PersistedToolBudgetCard
	| PersistedJevStatusCard
	| PersistedProviderFallbackCard
	| PersistedSubagentsCard
	| PersistedRoutineCard
	| PersistedRoutineProposalCard
	| PersistedBotProposalCard
	| PersistedImagesCard;

const SKILL_ACTIONS: ReadonlySet<PersistedSkillCard["action"]> = new Set([
	"created",
	"updated",
	"deleted",
	"shown",
	"listed",
	"cleaned",
]);

export function isConversationCardRole(role: string): role is ConversationCardRole {
	return (
		role === "skill" ||
		role === "confirm" ||
		role === "login" ||
		role === "file" ||
		role === "routine" ||
		role === "questionnaire" ||
		role === "bot-profile" ||
		role === "skill-proposal" ||
		role === "tool-budget" ||
		role === "jev-status" ||
		role === "provider-fallback" ||
		role === "subagents" ||
		role === "routine-proposal" ||
		role === "bot-proposal" ||
		role === "images" ||
		role === "task-list" ||
		role === "compaction"
	);
}

/** Aceita também o card de proposta de skill, que tem parse próprio (`parseSkillProposalCard`). */
export function serializeConversationCard(card: PersistedConversationCard | PersistedSkillProposalCard): string {
	return JSON.stringify(card);
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asOptionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseSkillItems(value: unknown): SkillListItemData[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const items: SkillListItemData[] = [];
	for (const item of value.slice(0, 25)) {
		if (!item || typeof item !== "object") continue;
		const row = item as Record<string, unknown>;
		if (typeof row.capabilityKey !== "string" || typeof row.title !== "string") continue;
		const status = row.status === "draft" ? "draft" : "active";
		items.push({
			capabilityKey: row.capabilityKey,
			title: row.title,
			versionNumber: typeof row.versionNumber === "number" ? row.versionNumber : 0,
			...(typeof row.description === "string" ? { description: row.description } : {}),
			status,
		});
	}
	return items;
}

function parseQuestionnaireChoices(value: unknown): QuestionnaireCardChoice[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) return undefined;
	const choices: QuestionnaireCardChoice[] = [];
	for (const item of value.slice(0, 10)) {
		if (!item || typeof item !== "object") continue;
		const row = item as Record<string, unknown>;
		if (typeof row.value !== "string" || row.value.trim().length === 0) continue;
		choices.push({
			value: row.value.trim().slice(0, 120),
			...(asOptionalString(row.label) ? { label: asOptionalString(row.label)!.slice(0, 120) } : {}),
			...(asOptionalString(row.description)
				? { description: asOptionalString(row.description)!.slice(0, 200) }
				: {}),
		});
	}
	return choices;
}

function parseQuestionnaireInput(value: unknown): QuestionnaireCardInput | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object") return undefined;
	const row = value as Record<string, unknown>;
	const label = asOptionalString(row.label);
	if (!label) return undefined;
	return {
		label: label.slice(0, 120),
		...(asOptionalString(row.placeholder)
			? { placeholder: asOptionalString(row.placeholder)!.slice(0, 200) }
			: {}),
	};
}

function parseQuestionnaireAnswers(value: unknown): Record<string, string | string[]> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const answers: Record<string, string | string[]> = {};
	for (const [key, raw] of Object.entries(value as Record<string, unknown>).slice(0, 20)) {
		if (!key || key.length > 64) continue;
		if (typeof raw === "string") {
			const trimmed = raw.trim().slice(0, 2000);
			if (trimmed) answers[key] = trimmed;
		} else if (Array.isArray(raw)) {
			const list = raw
				.filter((entry): entry is string => typeof entry === "string")
				.map((entry) => entry.trim().slice(0, 2000))
				.filter(Boolean)
				.slice(0, 20);
			if (list.length > 0) answers[key] = list.length > 1 ? list : (list[0] ?? "");
		}
	}
	return Object.keys(answers).length > 0 ? answers : undefined;
}

const BOT_PROFILE_FIELDS: ReadonlySet<BotProfileCardField> = new Set([
	"name",
	"snippet",
	"description",
	"openRouterModel",
]);

const BOT_PROFILE_MAX_LEN: Record<BotProfileCardField, number> = {
	name: 80,
	snippet: 140,
	description: 2000,
	openRouterModel: 120,
};

function parseBotProfileSnapshot(value: unknown): BotProfileCardSnapshot | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const row = value as Record<string, unknown>;
	if (typeof row.name !== "string") return null;
	return {
		name: row.name.slice(0, 80),
		snippet: typeof row.snippet === "string" ? row.snippet.slice(0, 140) : "",
		description:
			typeof row.description === "string"
				? row.description.slice(0, 2000)
				: null,
		openRouterModel:
			typeof row.openRouterModel === "string"
				? row.openRouterModel.slice(0, 120)
				: null,
	};
}

function parseBotProfilePatch(
	value: unknown,
	fields: BotProfileCardField[],
): BotProfileCardPatch | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const row = value as Record<string, unknown>;
	const patch: BotProfileCardPatch = {};
	for (const field of fields) {
		const max = BOT_PROFILE_MAX_LEN[field];
		if (field === "description") {
			if (row.description === null) {
				patch.description = null;
			} else if (typeof row.description === "string" && row.description.trim()) {
				patch.description = row.description.trim().replace(/\s+/g, " ").slice(0, max);
			}
			continue;
		}
		if (typeof row[field] === "string" && (row[field] as string).trim()) {
			const normalized = (row[field] as string).trim().replace(/\s+/g, " ").slice(0, max);
			(patch as Record<string, string>)[field] = normalized;
		}
	}
	return patch;
}

function parseQuestionnaireItems(value: unknown): QuestionnaireCardItem[] | null {
	if (!Array.isArray(value) || value.length === 0) return null;
	const items: QuestionnaireCardItem[] = [];
	for (const entry of value.slice(0, 10)) {
		if (!entry || typeof entry !== "object") continue;
		const row = entry as Record<string, unknown>;
		const name = asOptionalString(row.name);
		const prompt = asOptionalString(row.prompt);
		if (!name || !prompt) continue;
		const choices = parseQuestionnaireChoices(row.choices);
		const input = parseQuestionnaireInput(row.input);
		// Sem texto estático: todo item precisa de ao menos 1 choice ou input.
		if ((!choices || choices.length === 0) && !input) continue;
		items.push({
			name: name.slice(0, 64),
			prompt: prompt.slice(0, 500),
			...(asOptionalString(row.description)
				? { description: asOptionalString(row.description)!.slice(0, 300) }
				: {}),
			...(typeof row.required === "boolean" ? { required: row.required } : {}),
			...(typeof row.multiple === "boolean" ? { multiple: row.multiple } : {}),
			...(choices && choices.length > 0 ? { choices } : {}),
			...(input ? { input } : {}),
		});
	}
	return items.length > 0 ? items : null;
}

export function parseConversationCard(content: string): PersistedConversationCard | null {
	let raw: unknown;
	try {
		raw = JSON.parse(content) as unknown;
	} catch {
		return null;
	}
	if (!raw || typeof raw !== "object") return null;
	const row = raw as Record<string, unknown>;
	if (row.v !== 1) return null;
	if (row.kind === "images") {
		if ((row.origin !== "user" && row.origin !== "assistant") || !Array.isArray(row.items)) return null;
		const items: PersistedImagesCard["items"] = [];
		for (const raw of row.items.slice(0, 6)) {
			if (!raw || typeof raw !== "object") continue;
			const item = raw as Record<string, unknown>;
			if (typeof item.artifactId !== "string" || !item.artifactId.trim() || typeof item.mime !== "string" || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(item.mime) || typeof item.width !== "number" || !Number.isFinite(item.width) || item.width <= 0 || typeof item.height !== "number" || !Number.isFinite(item.height) || item.height <= 0) continue;
			items.push({ artifactId: item.artifactId, mime: item.mime, width: item.width, height: item.height, ...(asOptionalString(item.alt) ? { alt: asOptionalString(item.alt)?.slice(0, 200) } : {}), ...(asOptionalString(item.name) ? { name: asOptionalString(item.name)?.slice(0, 120) } : {}) });
		}
		if (items.length === 0) return null;
		return { v: 1, kind: "images", origin: row.origin, items, ...(asOptionalString(row.caption) ? { caption: asOptionalString(row.caption)?.slice(0, 300) } : {}) };
	}
	if (row.kind === "skill") {
		if (typeof row.action !== "string" || !SKILL_ACTIONS.has(row.action as PersistedSkillCard["action"])) {
			return null;
		}
		const items = parseSkillItems(row.items);
		return {
			v: 1,
			kind: "skill",
			action: row.action as PersistedSkillCard["action"],
			...(asOptionalString(row.title) ? { title: asOptionalString(row.title) } : {}),
			...(asOptionalString(row.capabilityKey)
				? { capabilityKey: asOptionalString(row.capabilityKey) }
				: {}),
			...(asOptionalNumber(row.versionNumber)
				? { versionNumber: asOptionalNumber(row.versionNumber) }
				: {}),
			...(asOptionalString(row.agentName) ? { agentName: asOptionalString(row.agentName) } : {}),
			...(asOptionalString(row.detail) ? { detail: asOptionalString(row.detail) } : {}),
			...(items ? { items } : {}),
			...(asOptionalNumber(row.draftCount) ? { draftCount: asOptionalNumber(row.draftCount) } : {}),
			...(asOptionalString(row.skillId) ? { skillId: asOptionalString(row.skillId) } : {}),
			...(row.learned === true ? { learned: true } : {}),
			...(row.learned === true && row.undone === true ? { undone: true } : {}),
		};
	}
	if (row.kind === "confirm") {
		if (typeof row.confirmId !== "string" || row.confirmId.trim().length === 0) return null;
		if (typeof row.title !== "string" || row.title.trim().length === 0) return null;
		const status =
			row.status === "approved" || row.status === "rejected" || row.status === "failed" || row.status === "pending"
				? row.status
				: "pending";
		return {
			v: 1,
			kind: "confirm",
			confirmId: row.confirmId,
			title: row.title,
			status,
			...(asOptionalString(row.description) ? { description: asOptionalString(row.description) } : {}),
			...(asOptionalString(row.confirmLabel) ? { confirmLabel: asOptionalString(row.confirmLabel) } : {}),
			...(asOptionalString(row.cancelLabel) ? { cancelLabel: asOptionalString(row.cancelLabel) } : {}),
			...(asOptionalString(row.alwaysLabel) ? { alwaysLabel: asOptionalString(row.alwaysLabel) } : {}),
			...(asOptionalString(row.callKey) ? { callKey: asOptionalString(row.callKey) } : {}),
			...(parseDevApprovalInfo(row.devApproval) ? { devApproval: parseDevApprovalInfo(row.devApproval) } : {}),
			...(parseSecretsRequestInfo(row.secretsRequest) ? { secretsRequest: parseSecretsRequestInfo(row.secretsRequest) } : {}),
			...(parseEmailKeyRequestInfo(row.emailKeyRequest) ? { emailKeyRequest: parseEmailKeyRequestInfo(row.emailKeyRequest) } : {}),
			...(parsePlanInfo(row.plan) ? { plan: parsePlanInfo(row.plan) } : {}),
			...(parseGithubIdentityInfo(row.githubIdentity) ? { githubIdentity: parseGithubIdentityInfo(row.githubIdentity) } : {}),
			...(isRecordLike(row.outcome) && typeof row.outcome.ok === "boolean" && typeof row.outcome.detail === "string"
				? { outcome: { ok: row.outcome.ok, detail: row.outcome.detail.slice(0, 2000) } }
				: {}),
		};
	}
	if (row.kind === "login") {
		if (typeof row.loginId !== "string" || row.loginId.trim().length === 0) return null;
		if (typeof row.site !== "string" || typeof row.url !== "string") return null;
		const toolkit = parseComposioToolkitSlug(row.composioToolkit);
		const connector = parseLoginConnector(row.connector);
		return {
			v: 1,
			kind: "login",
			loginId: row.loginId,
			site: row.site.slice(0, 120),
			url: row.url.slice(0, 500),
			status: row.status === "done" ? "done" : "pending",
			...(asOptionalString(row.runId) ? { runId: asOptionalString(row.runId) } : {}),
			...(row.reason === "captcha" ? { reason: "captcha" as const } : {}),
			...(toolkit ? { composioToolkit: toolkit } : {}),
			...(connector ? { connector } : {}),
			...(parseLoginVaultOffer(row.vault) ? { vault: parseLoginVaultOffer(row.vault)! } : {}),
			...(asOptionalString(row.vaultTried) ? { vaultTried: asOptionalString(row.vaultTried)!.slice(0, 400) } : {}),
			...(row.codeField === true ? { codeField: true as const } : {}),
		};
	}
	if (row.kind === "file") {
		const artifactId = asOptionalString(row.artifactId);
		const filename = asOptionalString(row.filename);
		if (!artifactId || !filename || artifactId.length > 120) return null;
		const size = asOptionalNumber(row.size);
		if (size === undefined || size < 0) return null;
		const format =
			row.format === "docx" || row.format === "pdf" || row.format === "xlsx" || row.format === "pptx"
				? row.format
				: "text";
		const version = asOptionalNumber(row.version);
		return {
			v: 1,
			kind: "file",
			artifactId,
			filename: filename.slice(0, 120),
			mime: typeof row.mime === "string" ? row.mime.slice(0, 120) : "application/octet-stream",
			size,
			format,
			version: version !== undefined && version >= 1 ? Math.floor(version) : 1,
			...(asOptionalString(row.runId) ? { runId: asOptionalString(row.runId) } : {}),
			...(row.origin === "user" ? { origin: "user" as const } : {}),
		};
	}
	if (row.kind === "code-run") {
		const callId = asOptionalString(row.callId);
		const code = typeof row.code === "string" ? row.code : "";
		if (!callId || !code.trim()) return null;
		const durationMs = asOptionalNumber(row.durationMs);
		const output = typeof row.output === "string" ? row.output.slice(0, CODE_RUN_CARD_OUTPUT_MAX) : "";
		return {
			v: 1,
			kind: "code-run",
			callId: callId.slice(0, 120),
			code: code.slice(0, CODE_RUN_CARD_CODE_MAX),
			status: row.status === "error" ? "error" : "ok",
			...(durationMs !== undefined && durationMs >= 0 ? { durationMs: Math.round(durationMs) } : {}),
			...(output ? { output } : {}),
			...(asOptionalString(row.runId) ? { runId: asOptionalString(row.runId) } : {}),
		};
	}
	if (row.kind === "compaction") {
		const before = asOptionalNumber(row.before);
		const after = asOptionalNumber(row.after);
		const summary = asOptionalString(row.summary);
		if (before === undefined || after === undefined || before < 0 || after < 0 || !summary) return null;
		const focus = asOptionalString(row.focus);
		return {
			v: 1,
			kind: "compaction",
			before: Math.round(before),
			after: Math.round(after),
			summary: summary.slice(0, COMPACT_CARD_SUMMARY_MAX_CHARS),
			...(focus ? { focus: focus.slice(0, COMPACT_FOCUS_MAX_CHARS) } : {}),
		};
	}
	if (row.kind === "task-list") {
		const runId = asOptionalString(row.runId);
		const items = parseTaskList(row.items);
		if (!runId || !items) return null;
		return { v: 1, kind: "task-list", runId: runId.slice(0, 120), items };
	}
	if (row.kind === "chart") {
		const chartId = asOptionalString(row.chartId);
		const parsed = parseChartSpec(row.spec);
		if (!chartId || !parsed.ok) return null;
		return {
			v: 1,
			kind: "chart",
			chartId: chartId.slice(0, 160),
			spec: parsed.spec,
			...(asOptionalString(row.filename) ? { filename: asOptionalString(row.filename)!.slice(0, 120) } : {}),
			...(asOptionalString(row.runId) ? { runId: asOptionalString(row.runId) } : {}),
		};
	}
	if (row.kind === "page") {
		const pageId = asOptionalString(row.pageId);
		const title = asOptionalString(row.title);
		const revision = asOptionalNumber(row.revision);
		if (!pageId || !title || revision === undefined || !Number.isInteger(revision) || revision < 1) return null;
		const parsed = row.spec === undefined ? undefined : parsePageSpec(row.spec);
		if (parsed && !parsed.ok) return null;
		const sourceCount = asOptionalNumber(row.sourceCount);
		return {
			v: 1,
			kind: "page",
			pageId: pageId.slice(0, 160),
			revision,
			title: title.slice(0, 120),
			action: row.action === "updated" ? "updated" : "created",
			...(parsed ? { spec: parsed.spec } : {}),
			sourceCount: sourceCount !== undefined && sourceCount > 0 ? Math.min(Math.round(sourceCount), 20) : 0,
		};
	}
	if (row.kind === "questionnaire") {
		if (typeof row.questionnaireId !== "string" || row.questionnaireId.trim().length === 0) return null;
		if (typeof row.title !== "string" || row.title.trim().length === 0) return null;
		const items = parseQuestionnaireItems(row.items);
		if (!items) return null;
		const status =
			row.status === "submitted" || row.status === "dismissed" || row.status === "pending"
				? row.status
				: "pending";
		const purpose =
			row.purpose === "onboarding" || row.purpose === "task" ? row.purpose : undefined;
		return {
			v: 1,
			kind: "questionnaire",
			questionnaireId: row.questionnaireId,
			title: row.title,
			status,
			...(asOptionalString(row.description) ? { description: asOptionalString(row.description) } : {}),
			items,
			...(parseQuestionnaireAnswers(row.answers)
				? { answers: parseQuestionnaireAnswers(row.answers) }
				: {}),
			...(purpose ? { purpose } : {}),
			...(asOptionalString(row.originalRequest)
				? { originalRequest: asOptionalString(row.originalRequest)!.slice(0, 500) }
				: {}),
		};
	}
	if (row.kind === "bot-profile") {
		if (typeof row.proposalId !== "string" || row.proposalId.trim().length === 0) return null;
		if (typeof row.botId !== "string" || row.botId.trim().length === 0) return null;
		if (!Array.isArray(row.fields) || row.fields.length === 0) return null;
		const fields = row.fields.filter(
			(field): field is BotProfileCardField =>
				typeof field === "string" && BOT_PROFILE_FIELDS.has(field as BotProfileCardField),
		);
		if (fields.length === 0) return null;
		const before = parseBotProfileSnapshot(row.before);
		if (!before) return null;
		const after = parseBotProfilePatch(row.after, fields);
		if (!after) return null;
		const status =
			row.status === "approved" || row.status === "rejected" || row.status === "pending"
				? row.status
				: "pending";
		return {
			v: 1,
			kind: "bot-profile",
			proposalId: row.proposalId,
			botId: row.botId,
			before,
			after,
			fields,
			status,
		};
	}
	if (row.kind === "tool-budget") {
		const from = asOptionalNumber(row.from);
		const to = asOptionalNumber(row.to);
		const tool = asOptionalString(row.tool);
		if (!tool || from === undefined || to === undefined || to <= from) return null;
		const connectorName = asOptionalString(row.connectorName);
		return {
			v: 1,
			kind: "tool-budget",
			tool: tool.slice(0, 120),
			from,
			to,
			...(connectorName ? { connectorName: connectorName.slice(0, 80) } : {}),
		};
	}
	if (row.kind === "jev-status") {
		const runId = asOptionalString(row.runId);
		const toolCallId = asOptionalString(row.toolCallId);
		if (!runId || runId.length > 120 || !toolCallId || toolCallId.length > 120) return null;
		if (row.mode !== "shadow" && row.mode !== "gate") return null;
		if (row.result !== "allow" && row.result !== "ask" && row.result !== "unavailable") return null;
		if (typeof row.ok !== "boolean") return null;
		return { v: 1, kind: "jev-status", runId, toolCallId, mode: row.mode, result: row.result, ok: row.ok };
	}
	if (row.kind === "provider-fallback") {
		const from = asOptionalString(row.from);
		const to = asOptionalString(row.to);
		const message = asOptionalString(row.message);
		if (!from || !to || !message) return null;
		const runId = asOptionalString(row.runId);
		return { v: 1, kind: "provider-fallback", from: from.slice(0, 160), to: to.slice(0, 160), message: message.slice(0, 200), ...(runId ? { runId: runId.slice(0, 120) } : {}) };
	}
	if (row.kind === "subagents") {
		const groupId = asOptionalString(row.groupId);
		if (!groupId || !Array.isArray(row.tasks)) return null;
		const tasks: PersistedSubagentsCard["tasks"] = [];
		for (const item of row.tasks.slice(0, 3)) {
			if (!item || typeof item !== "object") continue;
			const task = item as Record<string, unknown>;
			const goal = asOptionalString(task.goal);
			const taskIndex = asOptionalNumber(task.taskIndex);
			if (!goal || taskIndex === undefined) continue;
			tasks.push({
				taskIndex,
				...(asOptionalString(task.title) ? { title: asOptionalString(task.title)!.slice(0, 40) } : {}),
				goal: goal.slice(0, 300),
				status: task.status === "ok" || task.status === "partial" ? task.status : "failed",
				summary: typeof task.summary === "string" ? task.summary : "",
				toolsUsed: Array.isArray(task.toolsUsed)
					? task.toolsUsed.filter((t): t is string => typeof t === "string").slice(0, 20).map((t) => t.slice(0, 120))
					: [],
				...(asOptionalString(task.model) ? { model: asOptionalString(task.model)!.slice(0, 200) } : {}),
			});
		}
		if (tasks.length === 0) return null;
		return { v: 1, kind: "subagents", groupId: groupId.slice(0, 120), tasks };
	}
	if (isPersistedRoutineCard(raw)) {
		return raw;
	}
	if (row.kind === "routine-proposal") return parseRoutineProposalCard(raw);
	if (row.kind === "bot-proposal") return parseBotProposalCard(raw);
	return null;
}

/**
 * Encaixa o card no turno do último user: depois dele e dos cards já
 * daquele turno, antes de qualquer assistant/tool que tenha nascido depois.
 * Não vai para o fim da conversa inteira.
 */
export function insertCardAfterCurrentTurn<T extends { kind: string }>(
	messages: readonly T[],
	card: T,
): T[] {
	let lastUser = -1;
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		if (messages[i]?.kind === "user") {
			lastUser = i;
			break;
		}
	}
	if (lastUser < 0) return [...messages, card];
	let insertAt = lastUser + 1;
	while (
		insertAt < messages.length &&
		(messages[insertAt]?.kind === "skill" ||
			messages[insertAt]?.kind === "confirm" ||
			messages[insertAt]?.kind === "login" ||
			messages[insertAt]?.kind === "file" ||
			messages[insertAt]?.kind === "code-run" ||
			messages[insertAt]?.kind === "chart" ||
			messages[insertAt]?.kind === "page" ||
			messages[insertAt]?.kind === "task-list" ||
			messages[insertAt]?.kind === "compaction" ||
			messages[insertAt]?.kind === "routine" ||
			messages[insertAt]?.kind === "questionnaire" ||
			messages[insertAt]?.kind === "bot-profile" ||
			messages[insertAt]?.kind === "skill-proposal" ||
			messages[insertAt]?.kind === "tool-budget" ||
			messages[insertAt]?.kind === "jev-status" ||
			messages[insertAt]?.kind === "provider-fallback" ||
			messages[insertAt]?.kind === "subagents" ||
			messages[insertAt]?.kind === "routine-proposal" ||
			messages[insertAt]?.kind === "bot-proposal")
	) {
		insertAt += 1;
	}
	return [...messages.slice(0, insertAt), card, ...messages.slice(insertAt)];
}

/** Detalhe gravado no cartão de aprovação que um pedido mais novo da mesma conversa substituiu (a UI mostra "Expirado"). */
export const SUPERSEDED_CARD_DETAIL = "substituído por um pedido mais novo";
