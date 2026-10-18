/**
 * Gatilho GitHub para rotinas (dispara rotina quando algo acontece no repo).
 * Distinto do conector MCP GitHub (que o bot usa como ferramenta) — este é
 * só o trigger. Webhook-only: UM endpoint fixo + UM secret compartilhado
 * (derivado de `CONNECTOR_ENCRYPTION_KEY`, fora deste módulo — ver
 * `getGithubWebhookSecret` em `agent-runtime/mcp/secret-box.ts`) — sem
 * polling, sem hook/segredo por rotina. Tipos + validadores/normalizadores
 * puros; nenhuma chamada de rede ou banco aqui.
 *
 * v3: vocabulário de eventos mais enxuto que o v2 (sem `push`/`release`/
 * `issue_opened`/`issue_commented` — fora do escopo de "webhook único, sem
 * polling") e sem os campos decididos por-rotina que só faziam sentido com
 * webhook próprio/polling (`delivery`, `pollIntervalMinutes`, `hookKey`,
 * `secretEnc`, `webhookId`). `parseGithubWebhookTrigger` ainda migra trigger
 * v1 persistido e também tolera ler o v2 já persistido (descarta os campos
 * mortos acima silenciosamente).
 *
 * v4: `push` volta ao vocabulário (endpoint único já cobre qualquer evento,
 * o "sem polling" nunca dependeu de excluir push) e `ciBranch` generaliza
 * pra `branch` (mesmo filtro, agora também usado por `push`/`pr_*` — ver
 * `GithubWebhookTrigger.branch`). `ciBranch` ainda é aceito como alias legado
 * na leitura/validação (persistido ou vindo do client).
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Vocabulário de eventos (v3).
// ---------------------------------------------------------------------------

export const GITHUB_TRIGGER_EVENTS = [
	"push",
	"pr_opened",
	"pr_pushed",
	"pr_merged",
	"pr_closed",
	"pr_review_requested",
	"pr_approved",
	"pr_changes_requested",
	"pr_commented",
	"pr_thread_resolved",
	"pr_thread_unresolved",
	"issue_assigned",
	"ci_passed",
	"ci_failed",
] as const;
export type GithubTriggerEvent = (typeof GITHUB_TRIGGER_EVENTS)[number];

/** Eventos de CI — isentos do filtro `users` (quem fez o commit não é "o autor do evento"). */
export const GITHUB_CI_EVENTS: readonly GithubTriggerEvent[] = ["ci_passed", "ci_failed"];

export function isGithubTriggerEvent(value: unknown): value is GithubTriggerEvent {
	return (
		typeof value === "string" &&
		(GITHUB_TRIGGER_EVENTS as readonly string[]).includes(value)
	);
}

export function isGithubCiEvent(event: GithubTriggerEvent): boolean {
	return (GITHUB_CI_EVENTS as readonly GithubTriggerEvent[]).includes(event);
}

/** Rótulo PT + grupo de cada evento, pro editor da rotina na web renderizar. */
export type GithubTriggerEventGroup =
	| "Commits"
	| "Pull request"
	| "Reviews"
	| "Comentários"
	| "Threads"
	| "CI"
	| "Issues";

export const GITHUB_TRIGGER_EVENT_GROUPS: readonly GithubTriggerEventGroup[] = [
	"Commits",
	"Pull request",
	"Reviews",
	"Comentários",
	"Threads",
	"CI",
	"Issues",
];

export const GITHUB_TRIGGER_EVENT_META: Record<
	GithubTriggerEvent,
	{ label: string; group: GithubTriggerEventGroup }
> = {
	push: { label: "Push na branch", group: "Commits" },
	pr_opened: { label: "PR aberto", group: "Pull request" },
	pr_pushed: { label: "Novo commit no PR", group: "Pull request" },
	pr_merged: { label: "PR mesclado", group: "Pull request" },
	pr_closed: { label: "PR fechado (sem merge)", group: "Pull request" },
	pr_review_requested: { label: "Revisão solicitada", group: "Reviews" },
	pr_approved: { label: "PR aprovado", group: "Reviews" },
	pr_changes_requested: { label: "Mudanças solicitadas", group: "Reviews" },
	pr_commented: { label: "Comentário no PR", group: "Comentários" },
	pr_thread_resolved: { label: "Thread resolvida", group: "Threads" },
	pr_thread_unresolved: { label: "Thread reaberta", group: "Threads" },
	issue_assigned: { label: "Issue atribuída", group: "Issues" },
	ci_passed: { label: "CI passou", group: "CI" },
	ci_failed: { label: "CI falhou", group: "CI" },
};

// ---------------------------------------------------------------------------
// Estado runtime do trigger (persistido, atualizado pelo worker/api).
// ---------------------------------------------------------------------------

export type GithubTriggerState = {
	lastWebhookAt?: string;
	/** Mensagem PT do último erro de entrega (assinatura inválida/etc). */
	lastError?: string;
	/** Babá de PR: o PR fechou; apagar a rotina quando a última execução terminar. */
	pendingDelete?: boolean;
};

/** Trigger persistido em Routine.triggerJson (kind="github"). */
export type GithubWebhookTrigger = {
	kind: "github";
	/** "owner/name". */
	repo: string;
	events: GithubTriggerEvent[];
	/** Babá de um PR específico: só dispara para esse número. */
	prNumber?: number;
	/** Filtro de autor/ator do evento (case-insensitive); eventos ci_* são isentos. */
	users?: string[];
	/**
	 * Filtro de branch — só considerado quando não há `prNumber`. Significado
	 * por evento: `ci_*` → branch do check suite; `push` → branch do push;
	 * `pr_*` → branch BASE (destino) do PR. Obrigatório quando algum evento
	 * `ci_*` está selecionado sem `prNumber`. Renomeado de `ciBranch` (v3) —
	 * `parseGithubWebhookTrigger`/`parseGithubTriggerInput` ainda aceitam
	 * `ciBranch` como alias legado e migram pra `branch`.
	 */
	branch?: string;
	state?: GithubTriggerState;
};

/** Visão exposta na API/UI — mesmo shape do trigger (não há mais secret por rotina pra esconder). */
export type RoutineGithubTriggerView = GithubWebhookTrigger;

// owner/repo: sem protocolo, sem espaços, sem barra dupla.
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98})\/[A-Za-z0-9._-]{1,100}$/;

/** Normaliza/valida "owner/repo" (aceita colar a URL do GitHub por engano). */
export function normalizeGithubRepo(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value
		.trim()
		.replace(/^https?:\/\/github\.com\//i, "")
		.replace(/\.git$/i, "")
		.replace(/\/+$/, "");
	if (!REPO_RE.test(trimmed)) return null;
	return trimmed;
}

/** Valida/normaliza (rejeita se algum item não for reconhecido, ou lista vazia). */
export function normalizeGithubEvents(value: unknown): GithubTriggerEvent[] | null {
	if (!Array.isArray(value)) return null;
	const set = new Set<GithubTriggerEvent>();
	for (const item of value) {
		if (!isGithubTriggerEvent(item)) return null;
		set.add(item);
	}
	if (set.size === 0) return null;
	return GITHUB_TRIGGER_EVENTS.filter((event) => set.has(event));
}

/**
 * Filtra silenciosamente eventos desconhecidos/descontinuados (ao invés de
 * invalidar a lista inteira) — usado só ao ler trigger já persistido, pra não
 * quebrar rotinas antigas que ainda tenham `push`/`release`/etc no JSON.
 */
function filterKnownGithubEvents(value: unknown): GithubTriggerEvent[] {
	if (!Array.isArray(value)) return [];
	const set = new Set<GithubTriggerEvent>();
	for (const item of value) {
		if (isGithubTriggerEvent(item)) set.add(item);
	}
	return GITHUB_TRIGGER_EVENTS.filter((event) => set.has(event));
}

/** Filtro de autor/ator: trim, tira "@" na frente, dedup case-insensitive. */
export function normalizeGithubUsers(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const seen = new Set<string>();
	const users: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") continue;
		const trimmed = item.trim().replace(/^@/, "");
		if (!trimmed) continue;
		const key = trimmed.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		users.push(trimmed);
	}
	return users.length > 0 ? users : undefined;
}

/** `undefined` = não informado; `null` = informado mas inválido. */
function normalizeGithubPrNumber(value: unknown): number | null | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	const num = typeof value === "number" ? value : Number.parseInt(String(value), 10);
	if (!Number.isFinite(num) || num <= 0) return null;
	return Math.trunc(num);
}

function normalizeGithubBranch(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// ---------------------------------------------------------------------------
// Compat v1 (e v2 já persistido) → v3 (persistido em Routine.triggerJson).
// ---------------------------------------------------------------------------

const GITHUB_TRIGGER_EVENTS_V1 = ["push", "pull_request", "issues", "release"] as const;
type GithubTriggerEventV1 = (typeof GITHUB_TRIGGER_EVENTS_V1)[number];

function isGithubTriggerEventV1(value: unknown): value is GithubTriggerEventV1 {
	return typeof value === "string" && (GITHUB_TRIGGER_EVENTS_V1 as readonly string[]).includes(value);
}

const GITHUB_TRIGGER_MODES_V1 = ["webhook", "poll", "both"] as const;
type GithubTriggerModeV1 = (typeof GITHUB_TRIGGER_MODES_V1)[number];

function isGithubTriggerModeV1(value: unknown): value is GithubTriggerModeV1 {
	return typeof value === "string" && (GITHUB_TRIGGER_MODES_V1 as readonly string[]).includes(value);
}

/**
 * v1 "pull_request" virava vários eventos v2/v3. "issues"/"push"/"release" v1
 * miravam eventos que não existem mais no v3 (webhook único não cobre
 * issue/push/release) — migram pra lista vazia, sem quebrar o parse.
 */
function migrateGithubTriggerEventV1(event: GithubTriggerEventV1): GithubTriggerEvent[] {
	switch (event) {
		case "pull_request":
			return ["pr_opened", "pr_pushed", "pr_merged", "pr_closed"];
		case "issues":
		case "push":
		case "release":
			return [];
	}
}

function isGithubTriggerShapeBase(row: Record<string, unknown>): boolean {
	return (
		row.kind === "github" &&
		typeof row.repo === "string" &&
		row.repo.trim().length > 0 &&
		Array.isArray(row.events)
	);
}

/** Aceita tanto o formato atual quanto o v1/v2 legado (migração acontece em `parseGithubWebhookTrigger`). */
export function isGithubWebhookTrigger(value: unknown): value is GithubWebhookTrigger {
	if (!value || typeof value !== "object") return false;
	return isGithubTriggerShapeBase(value as Record<string, unknown>);
}

function sanitizeGithubTriggerState(state: Record<string, unknown>): GithubTriggerState {
	const result: GithubTriggerState = {};
	if (typeof state.lastWebhookAt === "string") result.lastWebhookAt = state.lastWebhookAt;
	if (typeof state.lastError === "string") result.lastError = state.lastError;
	if (typeof state.pendingDelete === "boolean") result.pendingDelete = state.pendingDelete;
	return result;
}

/**
 * Parseia trigger persistido; migra transparentemente o formato v1 e tolera
 * ler linhas do v2 já persistido (ignora `hookKey`/`secretEnc`/`delivery`/
 * `pollIntervalMinutes`/`webhookId`/`tokenEnc`/`mode`/`branches`, nenhum tem
 * equivalente no v3).
 */
export function parseGithubWebhookTrigger(value: unknown): GithubWebhookTrigger | null {
	if (!isGithubWebhookTrigger(value)) return null;
	const row = value as Record<string, unknown>;
	const isV1 = isGithubTriggerModeV1(row.mode);

	let events: GithubTriggerEvent[];
	if (isV1) {
		const set = new Set<GithubTriggerEvent>();
		for (const item of row.events as unknown[]) {
			if (!isGithubTriggerEventV1(item)) continue;
			for (const migrated of migrateGithubTriggerEventV1(item)) set.add(migrated);
		}
		events = GITHUB_TRIGGER_EVENTS.filter((event) => set.has(event));
	} else {
		events = filterKnownGithubEvents(row.events);
	}

	const state =
		row.state && typeof row.state === "object"
			? sanitizeGithubTriggerState(row.state as Record<string, unknown>)
			: undefined;

	return {
		kind: "github",
		repo: String(row.repo).trim(),
		events,
		prNumber: normalizeGithubPrNumber(row.prNumber) ?? undefined,
		users: normalizeGithubUsers(row.users),
		// `branch` (atual) tem precedência; `ciBranch` (v3, legado) é lido só
		// quando `branch` não veio — cobre linhas já persistidas antes da
		// generalização.
		branch: normalizeGithubBranch(row.branch ?? row.ciBranch),
		state,
	};
}

/** Hoje é só um espelho do trigger — mantido como função pra API estável (não há mais secret pra esconder). */
export function githubTriggerToView(trigger: GithubWebhookTrigger): RoutineGithubTriggerView {
	return { ...trigger };
}

// ---------------------------------------------------------------------------
// Configuração validada vinda do cliente (create/update), via Zod.
// ---------------------------------------------------------------------------

// `.optional()` aqui é só pra zod tolerar a CHAVE ausente no objeto de
// entrada (z.unknown() sozinho exige a chave presente, mesmo aceitando
// `undefined` como valor) — quem decide se "ausente" é válido ou erro é a
// função normalizadora dentro do `.transform`.
const repoField = z
	.unknown()
	.optional()
	.transform((raw, ctx) => {
		const normalized = normalizeGithubRepo(raw);
		if (!normalized) {
			ctx.addIssue({ code: "custom", message: "Repositório inválido (esperado owner/repo)" });
			return z.NEVER;
		}
		return normalized;
	});

const eventsField = z
	.unknown()
	.optional()
	.transform((raw, ctx) => {
		const normalized = normalizeGithubEvents(raw);
		if (!normalized) {
			ctx.addIssue({ code: "custom", message: "Selecione ao menos um evento do GitHub" });
			return z.NEVER;
		}
		return normalized;
	});

const prNumberField = z
	.unknown()
	.optional()
	.transform((raw, ctx) => {
		const normalized = normalizeGithubPrNumber(raw);
		if (normalized === null) {
			ctx.addIssue({ code: "custom", message: "Número do PR inválido" });
			return z.NEVER;
		}
		return normalized;
	});

const usersField = z
	.unknown()
	.optional()
	.transform((raw) => normalizeGithubUsers(raw));

const branchField = z
	.unknown()
	.optional()
	.transform((raw) => normalizeGithubBranch(raw));

export const githubTriggerInputSchema = z
	.object({
		repo: repoField,
		events: eventsField,
		prNumber: prNumberField,
		users: usersField,
		branch: branchField,
	})
	.refine(
		(value) => {
			const hasCiEvent = value.events.some((event) => isGithubCiEvent(event));
			if (!hasCiEvent) return true;
			return value.prNumber !== undefined || Boolean(value.branch);
		},
		{
			message: "Selecione a branch (branch) ou informe o número do PR",
			path: ["branch"],
		},
	);

export type GithubTriggerInput = z.infer<typeof githubTriggerInputSchema>;

/** `body.branch` tem precedência; `body.ciBranch` é o alias legado (v3) — migrado antes de validar. */
function withBranchAlias(body: Record<string, unknown>): Record<string, unknown> {
	if (body.branch !== undefined || body.ciBranch === undefined) return body;
	return { ...body, branch: body.ciBranch };
}

export function parseGithubTriggerInput(
	body: unknown,
): { value: GithubTriggerInput } | { error: string } {
	if (!body || typeof body !== "object") {
		return { error: "Configuração do gatilho GitHub inválida" };
	}
	const result = githubTriggerInputSchema.safeParse(
		withBranchAlias(body as Record<string, unknown>),
	);
	if (result.success) return { value: result.data };
	const message = result.error.issues[0]?.message;
	return { error: message || "Configuração do gatilho GitHub inválida" };
}

// ---------------------------------------------------------------------------
// Atalhos de criação rápida (quick-create) e babá de PR.
// ---------------------------------------------------------------------------

/** Conjunto de eventos padrão pra "acompanhar um PR até o merge". */
export const GITHUB_PR_BABYSIT_EVENTS: GithubTriggerEvent[] = [
	"pr_pushed",
	"pr_approved",
	"pr_changes_requested",
	"pr_commented",
	"pr_thread_resolved",
	"pr_thread_unresolved",
	"ci_failed",
	"ci_passed",
	"pr_merged",
	"pr_closed",
];

export type GithubRoutineTemplate = {
	id: string;
	label: string;
	/** "ciBranch" pede a branch (nome legado do ask — vira o filtro `branch` do trigger, não só CI). */
	asks: Array<"repo" | "ciBranch" | "prNumber">;
	events: GithubTriggerEvent[];
	defaultName: string;
	defaultPrompt: string;
};

/** Rótulo curto do evento pro bullet da instrução da rotina (`buildGithubRoutinePromptDetail`). */
const GITHUB_EVENT_INSTRUCTION_LABELS: Record<GithubTriggerEvent, string> = {
	push: "Push",
	pr_opened: "PR aberto",
	pr_pushed: "Novo commit no PR",
	pr_merged: "PR mergeado",
	pr_closed: "PR fechado sem merge",
	pr_review_requested: "Revisão solicitada",
	pr_approved: "PR aprovado",
	pr_changes_requested: "Mudanças solicitadas no PR",
	pr_commented: "Comentário no PR",
	pr_thread_resolved: "Thread de revisão resolvida",
	pr_thread_unresolved: "Thread de revisão reaberta",
	issue_assigned: "Issue atribuída",
	ci_passed: "CI passou",
	ci_failed: "CI falhou",
};

/** O que fazer quando o evento disparar — corpo do bullet (depois de "<Rótulo>: "). */
const GITHUB_EVENT_INSTRUCTION_BODY: Record<GithubTriggerEvent, string> = {
	push: "diga quem fez o push, quantos commits e resuma o que mudou. O evento já traz a lista COMPLETA de commits (push.commit[N]) e o resumo de arquivos: confira que a quantidade listada bate com push.commits antes de resumir e cite todos os commits relevantes; se não bater ou faltar a lista, use github_compare (repo, base, head) em vez de adivinhar (leia o diff pela leitura remota do GitHub, sem clonar o repo).",
	pr_opened:
		"diga o título, quem abriu, a branch de origem e destino, e resuma em 2 ou 3 frases o que o PR muda (o evento já traz a descrição, a contagem de commits e a lista de arquivos com +/-; confira os números e leia o diff pela leitura remota do GitHub só se precisar, sem clonar o repo).",
	pr_pushed: "diga o que mudou no commit mais recente do PR (leia o diff pela leitura remota do GitHub).",
	pr_merged: "diga qual PR entrou, em qual branch, e o que mudou em uma ou duas frases.",
	pr_closed: "diga qual PR fechou sem entrar e, se der pra saber, o motivo.",
	pr_review_requested: "diga quem pediu a revisão e pra quem, com um resumo rápido do PR.",
	pr_approved: "diga quem aprovou e um resumo rápido do PR.",
	pr_changes_requested: "diga quem pediu mudanças e resuma o que foi pedido.",
	pr_commented: "diga quem comentou e resuma o comentário.",
	pr_thread_resolved: "diga qual thread de revisão foi resolvida e por quem.",
	pr_thread_unresolved: "diga qual thread de revisão foi reaberta e por quem.",
	issue_assigned: "diga qual issue foi atribuída e para quem.",
	ci_passed: "diga qual workflow passou.",
	ci_failed:
		"descubra qual workflow e qual job falharam, leia os logs do job e diga qual passo ou teste quebrou e a causa provável, com o trecho de erro mais relevante em código.",
};

/**
 * Gera o `prompt` (detail) padrão de uma rotina GitHub seguindo a estrutura
 * fixa: 1 linha de intro (evento acordou → leia → avise em português, curto
 * e claro) + 1 bullet por evento selecionado (o que dizer/fazer) + regra
 * fixa de só ler (nunca comentar/aprovar/push/alterar) + "avise mesmo assim
 * com o que tiver e o link" quando faltar informação. Não hardcoda repo nem
 * nome do usuário (vêm do contexto do run). Usado tanto como
 * `GITHUB_ROUTINE_TEMPLATES[].defaultPrompt` quanto de referência pro agente
 * (bloco de sistema em `computer-use.ts`) ao escrever o detail de uma rotina
 * GitHub criada via chat. Nunca lança.
 */
export function buildGithubRoutinePromptDetail(
	trigger: Pick<GithubWebhookTrigger, "events" | "branch">,
): string {
	const bullets = trigger.events.map((event) => {
		const needsBranch = event === "push" || isGithubCiEvent(event);
		const label =
			needsBranch && trigger.branch
				? `${GITHUB_EVENT_INSTRUCTION_LABELS[event]} na branch ${trigger.branch}`
				: GITHUB_EVENT_INSTRUCTION_LABELS[event];
		return `- ${label}: ${GITHUB_EVENT_INSTRUCTION_BODY[event]}`;
	});
	return [
		"Um evento do GitHub neste repositório me acordou. Leia o evento que veio junto e avise em português, de forma curta e clara:",
		"",
		...bullets,
		"",
		"Nunca comente, aprove, faça push ou altere nada no GitHub; só leia e avise. Se o evento não tiver informação suficiente, avise mesmo assim com o que tiver e o link.",
	].join("\n");
}

export const GITHUB_ROUTINE_TEMPLATES: GithubRoutineTemplate[] = [
	{
		id: "ci_failed",
		label: "Avisar quando o CI falhar",
		asks: ["repo", "ciBranch"],
		events: ["ci_failed"],
		defaultName: "CI quebrou",
		defaultPrompt: buildGithubRoutinePromptDetail({ events: ["ci_failed"] }),
	},
	{
		id: "pr_babysit",
		label: "Acompanhar um PR até o merge",
		asks: ["repo", "prNumber"],
		events: GITHUB_PR_BABYSIT_EVENTS,
		defaultName: "Babá de PR",
		defaultPrompt:
			"Resuma o que aconteceu no PR desde a última vez (review, comentário, push ou CI) e diga se falta algo pra mergear.",
	},
	{
		id: "pr_activity",
		label: "Avisar sobre PRs novos e merges",
		asks: ["repo"],
		events: ["pr_opened", "pr_merged"],
		defaultName: "Atividade de PRs",
		defaultPrompt: buildGithubRoutinePromptDetail({ events: ["pr_opened", "pr_merged"] }),
	},
	{
		id: "branch_watch",
		label: "Acompanhar uma branch",
		asks: ["repo", "ciBranch"],
		events: ["push", "pr_opened", "pr_merged"],
		defaultName: "Acompanhar branch",
		defaultPrompt: buildGithubRoutinePromptDetail({
			events: ["push", "pr_opened", "pr_merged"],
		}),
	},
];

// ---------------------------------------------------------------------------
// Descrição PT (resumo pro editor da rotina / resposta do bot).
// ---------------------------------------------------------------------------

type GithubEventPhrase = {
	/** Clausula "um PR é <prVerb>" (eventos sobre o estado do PR). */
	prVerb?: string;
	/** Clausula "alguém <actorVerb>" (eventos de interação num PR). */
	actorVerb?: string;
	/** Rótulo curto pro resumo da babá de PR. */
	tag: string;
};

const GITHUB_EVENT_PHRASES: Record<GithubTriggerEvent, GithubEventPhrase> = {
	push: { tag: "push" },
	pr_opened: { prVerb: "aberto", tag: "abertura" },
	pr_pushed: { prVerb: "atualizado com um novo commit", tag: "push" },
	pr_merged: { prVerb: "mergeado", tag: "merge" },
	pr_closed: { prVerb: "fechado sem merge", tag: "fechamento" },
	pr_review_requested: { actorVerb: "solicita uma revisão", tag: "revisão solicitada" },
	pr_approved: { actorVerb: "aprova o PR", tag: "aprovação" },
	pr_changes_requested: { actorVerb: "pede mudanças no PR", tag: "mudanças solicitadas" },
	pr_commented: { actorVerb: "comenta no PR", tag: "comentário" },
	pr_thread_resolved: { actorVerb: "resolve uma thread de revisão", tag: "thread resolvida" },
	pr_thread_unresolved: { actorVerb: "reabre uma thread de revisão", tag: "thread reaberta" },
	issue_assigned: { tag: "issue atribuída" },
	ci_failed: { tag: "CI" },
	ci_passed: { tag: "CI" },
};

function joinPt(items: string[]): string {
	if (items.length === 0) return "";
	if (items.length === 1) return items[0]!;
	return `${items.slice(0, -1).join(", ")} ou ${items[items.length - 1]}`;
}

/** Frase PT pra resumir o gatilho (card da rotina / resposta do bot). Nunca lança. */
export function describeGithubTrigger(
	trigger: Pick<GithubWebhookTrigger, "repo" | "events" | "prNumber" | "users" | "branch">,
): string {
	const { repo, events, prNumber, users, branch } = trigger;
	const usersNote =
		users && users.length > 0 ? ` (só de ${users.map((user) => `@${user}`).join(", ")})` : "";

	if (prNumber !== undefined) {
		const tags: string[] = [];
		for (const event of events) {
			const tag = GITHUB_EVENT_PHRASES[event]?.tag;
			if (tag && !tags.includes(tag)) tags.push(tag);
		}
		const tagsPart = tags.length > 0 ? ` (${tags.join(", ")})` : "";
		return `algo acontece no PR #${prNumber} de \`${repo}\`${tagsPart} — a rotina se apaga quando o PR fechar${usersNote}`;
	}

	const prVerbs: string[] = [];
	const actorVerbs: string[] = [];
	let hasPush = false;
	let hasIssueAssigned = false;
	let hasCiFailed = false;
	let hasCiPassed = false;
	for (const event of events) {
		if (event === "push") {
			hasPush = true;
			continue;
		}
		if (event === "issue_assigned") {
			hasIssueAssigned = true;
			continue;
		}
		if (event === "ci_failed") {
			hasCiFailed = true;
			continue;
		}
		if (event === "ci_passed") {
			hasCiPassed = true;
			continue;
		}
		const phrase = GITHUB_EVENT_PHRASES[event];
		if (phrase.prVerb) prVerbs.push(phrase.prVerb);
		else if (phrase.actorVerb) actorVerbs.push(phrase.actorVerb);
	}

	const clauses: string[] = [];
	if (hasPush) {
		const branchPart = branch ? ` na branch \`${branch}\`` : "";
		clauses.push(`há um push${branchPart}`);
	}
	if (prVerbs.length > 0) {
		const subject = branch ? `um PR para a branch \`${branch}\`` : "um PR";
		clauses.push(`${subject} é ${joinPt(prVerbs)}`);
	}
	if (actorVerbs.length > 0) clauses.push(`alguém ${joinPt(actorVerbs)}`);
	if (hasIssueAssigned) clauses.push("uma issue é atribuída");
	if (hasCiFailed || hasCiPassed) {
		const ciVerbs: string[] = [];
		if (hasCiFailed) ciVerbs.push("falha");
		if (hasCiPassed) ciVerbs.push("passa");
		const branchPart = branch ? ` na branch \`${branch}\`` : "";
		clauses.push(`o CI ${joinPt(ciVerbs)}${branchPart}`);
	}

	if (clauses.length === 0) return `algo acontece em \`${repo}\`${usersNote}`;
	return `${joinPt(clauses)} em \`${repo}\`${usersNote}`;
}

/**
 * Uma frase PT por cláusula lógica do gatilho, cada uma começando com
 * "Quando …" — pro painel de detalhe da rotina renderizar uma linha por
 * cláusula (em vez da frase única de `describeGithubTrigger`). Agrupa:
 * lifecycle de PR, reviews, comentário, threads, issue atribuída, CI.
 * Texto puro (sem crases); nunca lança; array vazio se não houver evento
 * reconhecido.
 */
export function describeGithubTriggerClauses(
	trigger: Pick<GithubWebhookTrigger, "repo" | "events" | "prNumber" | "users" | "branch">,
): string[] {
	const { repo, events, prNumber, users, branch } = trigger;
	const present = new Set(events);
	const usersNote =
		users && users.length > 0 ? ` (só de ${users.map((user) => `@${user}`).join(", ")})` : "";
	const repoTail = ` em ${repo}`;
	const prSubject = prNumber !== undefined ? `o PR #${prNumber}` : "um PR";
	const prSuffix = prNumber !== undefined ? ` no PR #${prNumber}` : "";
	/** Objeto "(n)o PR" — vira "(n)o PR #N" quando há babá de PR. */
	function prObject(prep: "o" | "no"): string {
		if (prNumber === undefined) return prep === "o" ? "o PR" : "no PR";
		return prep === "o" ? `o PR #${prNumber}` : `no PR #${prNumber}`;
	}

	const clauses: string[] = [];

	if (present.has("push")) {
		const branchPart = branch ? ` na branch ${branch}` : "";
		clauses.push(`Quando houver push${branchPart}${repoTail}${usersNote}`);
	}

	const lifecycleVerbs: Array<[GithubTriggerEvent, string]> = [
		["pr_opened", "aberto"],
		["pr_pushed", "atualizado com um novo commit"],
		["pr_merged", "mesclado"],
		["pr_closed", "fechado sem merge"],
	];
	const activeLifecycleVerbs = lifecycleVerbs
		.filter(([event]) => present.has(event))
		.map(([, verb]) => verb);
	if (activeLifecycleVerbs.length > 0) {
		// Sem prNumber e com `branch`: um único sujeito "um PR para a branch X"
		// seguido dos verbos unidos (evita repetir o sujeito por evento).
		if (prNumber === undefined && branch) {
			clauses.push(
				`Quando um PR para a branch ${branch} for ${joinPt(activeLifecycleVerbs)}${repoTail}${usersNote}`,
			);
		} else {
			const lifecyclePhrases = activeLifecycleVerbs.map((verb) => `${prSubject} for ${verb}`);
			clauses.push(`Quando ${joinPt(lifecyclePhrases)}${repoTail}${usersNote}`);
		}
	}

	const reviewPhrases: string[] = [];
	if (present.has("pr_review_requested")) reviewPhrases.push(`solicitar uma revisão${prSuffix}`);
	if (present.has("pr_approved")) reviewPhrases.push(`aprovar ${prObject("o")}`);
	if (present.has("pr_changes_requested")) reviewPhrases.push(`pedir mudanças ${prObject("no")}`);
	if (reviewPhrases.length > 0) {
		clauses.push(`Quando alguém ${joinPt(reviewPhrases)}${repoTail}${usersNote}`);
	}

	if (present.has("pr_commented")) {
		clauses.push(`Quando alguém comentar ${prObject("no")}${repoTail}${usersNote}`);
	}

	const threadPhrases: string[] = [];
	if (present.has("pr_thread_resolved")) {
		threadPhrases.push(`resolver uma thread de revisão${prSuffix}`);
	}
	if (present.has("pr_thread_unresolved")) {
		threadPhrases.push(`reabrir uma thread de revisão${prSuffix}`);
	}
	if (threadPhrases.length > 0) {
		clauses.push(`Quando alguém ${joinPt(threadPhrases)}${repoTail}${usersNote}`);
	}

	if (present.has("issue_assigned")) {
		clauses.push(`Quando uma issue for atribuída${prSuffix}${repoTail}${usersNote}`);
	}

	if (present.has("ci_failed") || present.has("ci_passed")) {
		const ciVerbs: string[] = [];
		if (present.has("ci_failed")) ciVerbs.push("falhar");
		if (present.has("ci_passed")) ciVerbs.push("passar");
		const location = prNumber !== undefined ? prSuffix : branch ? ` na branch ${branch}` : "";
		clauses.push(`Quando o CI ${joinPt(ciVerbs)}${location}${repoTail}`);
	}

	return clauses;
}

// ---------------------------------------------------------------------------
// Evento normalizado (payload do webhook) → dado compacto pro prompt. Nunca
// inclui o payload cru.
// ---------------------------------------------------------------------------

export type GithubNormalizedFailedCheck = { name: string; url?: string };

/** Commit enriquecido (webhook do GitHub App): sem patch, só metadados compactos. */
export type GithubEnrichedCommit = {
	sha: string;
	/** Primeira linha da mensagem. */
	subject: string;
	/** Mensagem completa (limitada), só quando tem mais que a primeira linha. */
	body?: string;
	author?: string;
	url?: string;
	/** Arquivos alterados neste commit (quando consultado). */
	files?: number;
	additions?: number;
	deletions?: number;
};

export type GithubEnrichedFile = {
	path: string;
	status: string;
	additions: number;
	deletions: number;
};

export type NormalizedGithubEvent = {
	type: GithubTriggerEvent;
	repo: string;
	actor?: string;
	url?: string;
	pr?: {
		number: number;
		title: string;
		url?: string;
		author?: string;
		head?: string;
		base?: string;
		headSha?: string;
		/** Enriquecimento (GitHub App): descrição do PR, limitada. */
		body?: string;
		commitsCount?: number;
		changedFiles?: number;
		additions?: number;
		deletions?: number;
		fileList?: GithubEnrichedFile[];
		fileListTruncated?: boolean;
	};
	review?: {
		state: string;
		body?: string;
		url?: string;
	};
	comment?: {
		excerpt: string;
		path?: string;
		line?: number;
		url?: string;
	};
	ci?: {
		conclusion: string;
		branch: string;
		sha: string;
		failedChecks: GithubNormalizedFailedCheck[];
	};
	issue?: {
		number: number;
		title: string;
		url?: string;
		author?: string;
		assignee?: string;
	};
	push?: {
		branch: string;
		commits: number;
		headSha: string;
		compareUrl?: string;
		/** Enriquecimento (GitHub App): lista COMPLETA before..after; `commits` passa a ser o total real. */
		commitList?: GithubEnrichedCommit[];
		commitListTruncated?: boolean;
		summary?: { files: number; additions: number; deletions: number };
		fileList?: GithubEnrichedFile[];
		fileListTruncated?: boolean;
	};
};

/** Corta texto de payload (dado externo, nunca instrução) num tamanho seguro pro prompt. */
export function githubExcerpt(text: unknown, max: number): string | undefined {
	if (typeof text !== "string") return undefined;
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function buildPrSummary(pr: Record<string, unknown>): NonNullable<NormalizedGithubEvent["pr"]> {
	const user = asRecord(pr.user);
	const head = asRecord(pr.head);
	const base = asRecord(pr.base);
	return {
		number: typeof pr.number === "number" ? pr.number : 0,
		title: typeof pr.title === "string" ? pr.title : "",
		url: typeof pr.html_url === "string" ? pr.html_url : undefined,
		author: typeof user.login === "string" ? user.login : undefined,
		head: typeof head.ref === "string" ? head.ref : undefined,
		base: typeof base.ref === "string" ? base.ref : undefined,
		headSha: typeof head.sha === "string" ? head.sha : undefined,
	};
}

function buildIssueSummary(issue: Record<string, unknown>): NonNullable<NormalizedGithubEvent["issue"]> {
	const user = asRecord(issue.user);
	const assignee = asRecord(issue.assignee);
	return {
		number: typeof issue.number === "number" ? issue.number : 0,
		title: typeof issue.title === "string" ? issue.title : "",
		url: typeof issue.html_url === "string" ? issue.html_url : undefined,
		author: typeof user.login === "string" ? user.login : undefined,
		assignee: typeof assignee.login === "string" ? assignee.login : undefined,
	};
}

/** Checks falhos (best-effort — só o que já vier no payload; sem chamada extra à API). */
function extractFailedChecks(suite: Record<string, unknown>): GithubNormalizedFailedCheck[] {
	const runs = Array.isArray(suite.check_runs) ? suite.check_runs : [];
	const failed: GithubNormalizedFailedCheck[] = [];
	for (const raw of runs) {
		const run = asRecord(raw);
		const conclusion = typeof run.conclusion === "string" ? run.conclusion : "";
		if (conclusion !== "failure" && conclusion !== "timed_out" && conclusion !== "cancelled") continue;
		const name = typeof run.name === "string" ? run.name : "";
		if (!name) continue;
		failed.push({ name, url: typeof run.html_url === "string" ? run.html_url : undefined });
		if (failed.length >= 10) break;
	}
	return failed;
}

// ---------------------------------------------------------------------------
// Webhook (`X-GitHub-Event` + payload) → NormalizedGithubEvent[]. Sempre um
// array (0 ou 1 item na prática, nunca mais) — nunca lança.
// ---------------------------------------------------------------------------

export function normalizeGithubWebhook(
	eventHeader: string,
	payload: unknown,
): NormalizedGithubEvent[] {
	const body = asRecord(payload);
	const repository = asRecord(body.repository);
	const repo = typeof repository.full_name === "string" ? repository.full_name : "";
	const sender = asRecord(body.sender);
	const actor = typeof sender.login === "string" ? sender.login : undefined;
	const action = typeof body.action === "string" ? body.action : undefined;

	if (eventHeader === "pull_request") {
		const pr = asRecord(body.pull_request);
		const prSummary = buildPrSummary(pr);
		let type: GithubTriggerEvent | null = null;
		if (action === "opened" || action === "reopened") type = "pr_opened";
		else if (action === "synchronize") type = "pr_pushed";
		else if (action === "closed") type = pr.merged === true ? "pr_merged" : "pr_closed";
		else if (action === "review_requested") type = "pr_review_requested";
		if (!type) return [];
		return [{ type, repo, actor, url: prSummary.url, pr: prSummary }];
	}

	if (eventHeader === "pull_request_review") {
		if (action !== "submitted") return [];
		const review = asRecord(body.review);
		const prSummary = buildPrSummary(asRecord(body.pull_request));
		const state = typeof review.state === "string" ? review.state.toLowerCase() : "";
		const reviewUrl = typeof review.html_url === "string" ? review.html_url : undefined;
		const bodyExcerpt = githubExcerpt(review.body, 500);
		let type: GithubTriggerEvent | null = null;
		if (state === "approved") type = "pr_approved";
		else if (state === "changes_requested") type = "pr_changes_requested";
		else if (state === "commented") type = "pr_commented";
		if (!type) return [];
		const event: NormalizedGithubEvent = {
			type,
			repo,
			actor,
			url: reviewUrl ?? prSummary.url,
			pr: prSummary,
			review: { state, body: bodyExcerpt, url: reviewUrl },
		};
		if (type === "pr_commented") {
			event.comment = { excerpt: bodyExcerpt ?? "", url: reviewUrl };
		}
		return [event];
	}

	if (eventHeader === "pull_request_review_comment") {
		if (action !== "created") return [];
		const comment = asRecord(body.comment);
		const prSummary = buildPrSummary(asRecord(body.pull_request));
		const commentUrl = typeof comment.html_url === "string" ? comment.html_url : undefined;
		return [
			{
				type: "pr_commented",
				repo,
				actor,
				url: commentUrl ?? prSummary.url,
				pr: prSummary,
				comment: {
					excerpt: githubExcerpt(comment.body, 500) ?? "",
					path: typeof comment.path === "string" ? comment.path : undefined,
					line:
						typeof comment.line === "number"
							? comment.line
							: typeof comment.original_line === "number"
								? comment.original_line
								: undefined,
					url: commentUrl,
				},
			},
		];
	}

	if (eventHeader === "pull_request_review_thread") {
		const prSummary = buildPrSummary(asRecord(body.pull_request));
		let type: GithubTriggerEvent | null = null;
		if (action === "resolved") type = "pr_thread_resolved";
		else if (action === "unresolved") type = "pr_thread_unresolved";
		if (!type) return [];
		return [{ type, repo, actor, url: prSummary.url, pr: prSummary }];
	}

	if (eventHeader === "issue_comment") {
		if (action !== "created") return [];
		const issue = asRecord(body.issue);
		// Comentário só numa issue (sem PR) não tem mais evento equivalente
		// (issue_commented saiu do vocabulário) — ignora.
		if (!issue.pull_request) return [];
		const comment = asRecord(body.comment);
		const excerpt = githubExcerpt(comment.body, 500) ?? "";
		const commentUrl = typeof comment.html_url === "string" ? comment.html_url : undefined;
		const user = asRecord(issue.user);
		return [
			{
				type: "pr_commented",
				repo,
				actor,
				url: commentUrl,
				pr: {
					number: typeof issue.number === "number" ? issue.number : 0,
					title: typeof issue.title === "string" ? issue.title : "",
					url: typeof issue.html_url === "string" ? issue.html_url : undefined,
					author: typeof user.login === "string" ? user.login : undefined,
				},
				comment: { excerpt, url: commentUrl },
			},
		];
	}

	if (eventHeader === "issues") {
		// "opened" saiu do vocabulário (issue_opened) — só assigned sobrevive.
		if (action !== "assigned") return [];
		const issue = asRecord(body.issue);
		return [
			{
				type: "issue_assigned",
				repo,
				actor,
				url: typeof issue.html_url === "string" ? issue.html_url : undefined,
				issue: buildIssueSummary(issue),
			},
		];
	}

	if (eventHeader === "check_suite") {
		if (action !== "completed") return [];
		const suite = asRecord(body.check_suite);
		const conclusion = typeof suite.conclusion === "string" ? suite.conclusion : "";
		let type: GithubTriggerEvent | null = null;
		if (conclusion === "success") type = "ci_passed";
		else if (conclusion === "failure" || conclusion === "timed_out") type = "ci_failed";
		if (!type) return [];
		const pullRequests = Array.isArray(suite.pull_requests) ? suite.pull_requests : [];
		const firstPr = asRecord(pullRequests[0]);
		const pr =
			typeof firstPr.number === "number" ? { number: firstPr.number, title: "" } : undefined;
		return [
			{
				type,
				repo,
				actor,
				pr,
				ci: {
					conclusion,
					branch: typeof suite.head_branch === "string" ? suite.head_branch : "",
					sha: typeof suite.head_sha === "string" ? suite.head_sha : "",
					failedChecks: extractFailedChecks(suite),
				},
			},
		];
	}

	if (eventHeader === "push") {
		const ref = typeof body.ref === "string" ? body.ref : "";
		// Deleção de branch ou push de tag (o evento `push` do GitHub também
		// cobre `refs/tags/…`) nunca vira `push` normalizado — `branch` só faz
		// sentido pra branch de verdade.
		if (body.deleted === true || !ref.startsWith("refs/heads/")) return [];
		const branch = ref.slice("refs/heads/".length);
		const commits = Array.isArray(body.commits) ? body.commits.length : 0;
		const headSha = typeof body.after === "string" ? body.after : "";
		const compareUrl = typeof body.compare === "string" ? body.compare : undefined;
		const pusher = asRecord(body.pusher);
		const pusherName = typeof pusher.name === "string" ? pusher.name : undefined;
		return [
			{
				type: "push",
				repo,
				actor: pusherName ?? actor,
				url: compareUrl,
				push: { branch, commits, headSha, compareUrl },
			},
		];
	}

	return [];
}

/** Nomes de evento do webhook do GitHub necessários pra cobrir os eventos selecionados (pra assinar no repo). */
const GITHUB_WEBHOOK_EVENT_NAMES: Record<GithubTriggerEvent, readonly string[]> = {
	push: ["push"],
	pr_opened: ["pull_request"],
	pr_pushed: ["pull_request"],
	pr_merged: ["pull_request"],
	pr_closed: ["pull_request"],
	pr_review_requested: ["pull_request"],
	pr_approved: ["pull_request_review"],
	pr_changes_requested: ["pull_request_review"],
	pr_commented: ["issue_comment", "pull_request_review", "pull_request_review_comment"],
	pr_thread_resolved: ["pull_request_review_thread"],
	pr_thread_unresolved: ["pull_request_review_thread"],
	issue_assigned: ["issues"],
	ci_passed: ["check_suite"],
	ci_failed: ["check_suite"],
};

/** Eventos de webhook do GitHub (`X-GitHub-Event`) a assinar pra cobrir os `events` do trigger. */
export function githubWebhookEventsFor(events: GithubTriggerEvent[]): string[] {
	const set = new Set<string>();
	for (const event of events) {
		for (const name of GITHUB_WEBHOOK_EVENT_NAMES[event] ?? []) set.add(name);
	}
	return Array.from(set);
}

// ---------------------------------------------------------------------------
// Matcher puro.
// ---------------------------------------------------------------------------

/**
 * Um evento normalizado casa com os filtros configurados no trigger?
 * `branch` (sem `prNumber`) filtra por evento: `ci_*` exige branch (igual
 * antes, renomeado); `push` exige `push.branch === branch`; qualquer outro
 * evento com `pr` (lifecycle, review, comentário, thread) exige
 * `pr.base === branch` (branch BASE/destino do PR) quando `pr` está presente
 * no evento normalizado.
 */
export function githubEventMatchesTrigger(
	normalized: Pick<NormalizedGithubEvent, "type" | "repo" | "actor" | "pr" | "ci" | "push">,
	trigger: Pick<GithubWebhookTrigger, "repo" | "events" | "prNumber" | "users" | "branch">,
): boolean {
	if (normalized.repo.toLowerCase() !== trigger.repo.toLowerCase()) return false;
	if (!trigger.events.includes(normalized.type)) return false;

	if (trigger.prNumber !== undefined && normalized.pr?.number !== trigger.prNumber) {
		return false;
	}

	const isCi = isGithubCiEvent(normalized.type);
	if (!isCi && trigger.users && trigger.users.length > 0) {
		const actor = normalized.actor?.toLowerCase();
		if (!actor) return false;
		const allow = trigger.users.map((user) => user.toLowerCase());
		if (!allow.includes(actor)) return false;
	}

	if (trigger.prNumber === undefined) {
		if (isCi) {
			if (!trigger.branch || normalized.ci?.branch !== trigger.branch) return false;
		} else if (trigger.branch) {
			if (normalized.type === "push") {
				if (normalized.push?.branch !== trigger.branch) return false;
			} else if (normalized.pr) {
				if (normalized.pr.base !== trigger.branch) return false;
			}
		}
	}

	return true;
}
