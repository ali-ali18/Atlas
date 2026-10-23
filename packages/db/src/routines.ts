import { createHash, randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import type {
	RoutineAlert,
	RoutineNotifyMode,
	CreateRoutineInput,
	EmailTriggerJson,
	EventEnvelope,
	GithubTriggerState,
	GithubWebhookTrigger,
	RoutineRecord,
	RoutineRunListItem,
	RoutineRunRecord,
	RoutineRunStatus,
	RoutineTriggeredBy,
	RoutineTriggerType,
	UpdateRoutineInput,
} from "@workspace/shared";
import {
	alertSupportsTrigger,
	applyAlertConfig,
	parseRoutineAlert,
	parseRoutineAlertInput,
	parseRoutineNotifyMode,
	parseEmailTriggerInput,
	emailTriggerToView,
	githubTriggerToView,
	isGenericWebhookTrigger,
	parseRoutineTriggerJson,
	scheduleStateToCron,
	shouldAutoDeleteAfterRun,
} from "@workspace/shared";
import { prisma } from "./client.js";
import { getMailboxForBot } from "./bot-mailbox.js";
import { ownerIds } from "./mcp-connections.js";
import { assertGroupUsable } from "./routine-groups.js";
import { assertPageUsable } from "./pages.js";

const DEFAULT_TIMEZONE = "America/Sao_Paulo";
const ACTIVE_RUN_STATUSES: RoutineRunStatus[] = ["queued", "running"];
const LEGACY_OWNER_ID = "default";


/** Permite quando o dono bate OU a linha é legada (backfill de vínculo pendente). Sem userId, sem filtro (retrocompat). */
function isOwnerAllowed(
	rowUserId: string | null | undefined,
	requestUserId: string | undefined,
): boolean {
	// Estrito: sessão sem usuário válido ou linha legada (sem dono/"default")
	// não casam com ninguém; o legado só aparece depois do claim-default.
	const owners = ownerIds(requestUserId);
	return owners.length > 0 && rowUserId != null && owners.includes(rowUserId);
}

// Fase 0: sem fallback — o boot falha sem pepper (exceto em testes, onde
// suites que nem tocam em webhook precisam importar o módulo).
if (
	!process.env.ATLAS_HOOK_PEPPER?.trim() &&
	process.env.NODE_ENV !== "test" &&
	!process.env.VITEST
) {
	throw new Error(
		"ATLAS_HOOK_PEPPER is required (gere com: node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\")",
	);
}

function jsonValue(value: unknown): Prisma.InputJsonValue | undefined {
	if (value === undefined) return undefined;
	return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function asTriggerType(value: string): RoutineTriggerType {
	if (value === "event") return "event";
	if (value === "once") return "once";
	if (value === "interval") return "interval";
	return "cron";
}

function asTriggeredBy(value: string): RoutineTriggeredBy {
	if (value === "manual" || value === "event") return value;
	return "schedule";
}

function asRunStatus(value: string): RoutineRunStatus {
	if (
		value === "queued" ||
		value === "running" ||
		value === "succeeded" ||
		value === "failed" ||
		value === "skipped"
	) {
		return value;
	}
	return "queued";
}

function toIso(value: Date | null | undefined): string | null {
	return value ? value.toISOString() : null;
}

/**
 * `triggerJson.scheduleState` só é confiável se ele produz o MESMO cron que
 * está (ou vai ficar) salvo em `schedule` — senão é uma cópia da UI que ficou
 * pra trás (ex.: agente mudou o `schedule` via propose_routine sem mandar
 * `triggerJson` novo) e não deve ser persistida/reaproveitada, senão o painel
 * volta a mostrar o horário antigo. `schedule` é sempre a fonte de verdade.
 */
export function matchingScheduleState(triggerJson: unknown, schedule: string | null): unknown {
	if (!schedule || !triggerJson || typeof triggerJson !== "object") return undefined;
	const row = triggerJson as { scheduleState?: unknown };
	const state = row.scheduleState;
	if (!state || typeof state !== "object") return undefined;
	if (typeof (state as { frequency?: unknown }).frequency !== "string") return undefined;
	return scheduleStateToCron(state as Parameters<typeof scheduleStateToCron>[0]) === schedule
		? state
		: undefined;
}

function hookPepper(): string {
	const pepper = process.env.ATLAS_HOOK_PEPPER?.trim();
	if (!pepper) {
		throw new Error(
			"ATLAS_HOOK_PEPPER is required (gere com: node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\")",
		);
	}
	return pepper;
}

export function hashHookSecret(secret: string): string {
	return createHash("sha256")
		.update(`${hookPepper()}:${secret}`)
		.digest("hex");
}

export function generateHookSecret(): string {
	return randomBytes(32).toString("base64url");
}

/**
 * Selagem da cópia recuperável do secret do webhook (envelope por usuário) é
 * registrada pelo agent-runtime (que tem o cofre); sem registro/chave, não guarda cópia.
 */
export type HookSecretSealer = (userId: string, hookKey: string, secret: string) => Promise<string | undefined>;
let hookSecretSealer: HookSecretSealer | null = null;
export function setHookSecretSealer(sealer: HookSecretSealer | null): void {
	hookSecretSealer = sealer;
}
async function sealHookSecretForOwner(userId: string | undefined, hookKey: string, secret: string): Promise<string | undefined> {
	if (!hookSecretSealer || !userId?.trim()) return undefined;
	try {
		return await hookSecretSealer(userId.trim(), hookKey, secret);
	} catch {
		return undefined;
	}
}

export function generateHookKey(): string {
	return randomBytes(12).toString("base64url");
}

export function verifyHookSecret(
	secret: string,
	secretHash: string,
): boolean {
	const got = hashHookSecret(secret);
	if (got.length !== secretHash.length) return false;
	let mismatch = 0;
	for (let i = 0; i < got.length; i++) {
		mismatch |= got.charCodeAt(i) ^ secretHash.charCodeAt(i);
	}
	return mismatch === 0;
}

/** URL pública configurada: `ATLAS_PUBLIC_URL` ou, sem ela, `ATLAS_URL` (o web repassa `/v1/*` à API). */
function configuredPublicUrl(): string | undefined {
	return process.env.ATLAS_PUBLIC_URL?.trim() || process.env.ATLAS_URL?.trim() || undefined;
}

function publicBaseUrl(): string {
	return (
		configuredPublicUrl()?.replace(/\/$/, "") ||
		`http://127.0.0.1:${process.env.PORT?.trim() || "3001"}`
	);
}

export function hookPublicUrl(hookKey: string): string {
	return `${publicBaseUrl()}/v1/hooks/${hookKey}`;
}

/** Endpoint único e fixo do webhook GitHub (secret compartilhado via env var — sem hookKey por rotina). */
export function githubHookPublicUrl(): string {
	return `${publicBaseUrl()}/v1/hooks/github`;
}

/** Só true quando `ATLAS_PUBLIC_URL` (ou `ATLAS_URL`) aponta pra fora do localhost — o
 * hook-sync usa isso pra decidir se dá pra registrar o webhook no GitHub.
 * Sem URL pública não há entrega (webhook-only, sem polling): a criação do
 * gatilho GitHub falha de propósito até configurar `ATLAS_PUBLIC_URL`. */
export function isGithubHookUrlPublic(): boolean {
	const raw = configuredPublicUrl();
	if (!raw) return false;
	try {
		const hostname = new URL(raw).hostname;
		return hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "::1";
	} catch {
		return false;
	}
}

export function githubHookSetupUrl(repo: string): string {
	return `https://github.com/${repo}/settings/hooks/new`;
}

function hookInfoFromTriggerJson(
	triggerJson: unknown,
): RoutineRecord["hook"] | undefined {
	const parsed = parseRoutineTriggerJson(triggerJson);
	if (!parsed) return undefined;
	if (parsed.kind === "generic") {
		return { hookKey: parsed.hookKey, url: hookPublicUrl(parsed.hookKey), ...(parsed.urlSecretAt ? { urlSecretAt: parsed.urlSecretAt } : {}) };
	}
	if (parsed.kind === "once" || parsed.kind === "interval" || parsed.kind === "email") return undefined;
	// GitHub: endpoint único (sem hookKey por rotina) — hookKey aqui é só um
	// placeholder pra satisfazer o shape de RoutineHookInfo, nunca usado de
	// verdade (quem identifica a rotina pro caller é `repo`, via routine.github).
	return {
		hookKey: "",
		url: githubHookPublicUrl(),
		setupUrl: githubHookSetupUrl(parsed.repo),
	};
}

function githubInfoFromTriggerJson(
	triggerJson: unknown,
): RoutineRecord["github"] | undefined {
	const parsed = parseRoutineTriggerJson(triggerJson);
	if (!parsed || parsed.kind !== "github") return undefined;
	return githubTriggerToView(parsed);
}

function emailInfoFromTriggerJson(triggerJson: unknown): RoutineRecord["email"] | undefined {
	const parsed = parseRoutineTriggerJson(triggerJson);
	if (!parsed || parsed.kind !== "email") return undefined;
	return emailTriggerToView(parsed);
}

function onceInfoFromTriggerJson(triggerJson: unknown): RoutineRecord["once"] | undefined {
	const parsed = parseRoutineTriggerJson(triggerJson);
	if (!parsed || parsed.kind !== "once") return undefined;
	return { runAt: parsed.runAt };
}

function intervalInfoFromTriggerJson(triggerJson: unknown): RoutineRecord["interval"] | undefined {
	const parsed = parseRoutineTriggerJson(triggerJson);
	if (!parsed || parsed.kind !== "interval") return undefined;
	return { everyMinutes: parsed.everyMinutes };
}

function toRoutineRun(
	row: Prisma.RoutineRunGetPayload<Record<string, never>>,
): RoutineRunRecord {
	return {
		id: row.id,
		routineId: row.routineId,
		agentRunId: row.agentRunId,
		triggeredBy: asTriggeredBy(row.triggeredBy),
		scheduledFor: toIso(row.scheduledFor),
		status: asRunStatus(row.status),
		startedAt: toIso(row.startedAt),
		finishedAt: toIso(row.finishedAt),
		error: row.error,
		summary: row.summary,
		eventJson: row.eventJson ?? null,
		createdAt: row.createdAt.toISOString(),
	};
}

function toRoutine(
	row: Prisma.RoutineGetPayload<Record<string, never>> & { group?: { id: string; name: string } | null },
	lastRun?: RoutineRunRecord | null,
): RoutineRecord {
	const triggerType = asTriggerType(row.triggerType);
	return {
		id: row.id,
		userId: row.userId,
		botId: row.botId,
		conversationId: row.conversationId,
		groupId: row.groupId ?? null,
		group: row.group ? { id: row.group.id, name: row.group.name } : null,
		pageId: row.pageId ?? null,
		name: row.name,
		prompt: row.prompt,
		model: row.model,
		allowChatgptPlan: row.allowChatgptPlan ?? false,
		notify: parseRoutineNotifyMode(row.notify),
		enabled: row.enabled,
		triggerType,
		schedule: row.schedule,
		timezone: row.timezone,
		// event (generic/github): triggerJson cru nunca sai da API — carrega
		// secretHash/secretEnc/tokenEnc. hook/github abaixo já expõem o que é
		// seguro. Cron continua expondo triggerJson (guarda o scheduleState).
		triggerJson: triggerType === "event" ? null : (row.triggerJson ?? null),
		createdBy: row.createdBy === "bot" ? "bot" : "user",
		lastRunAt: toIso(row.lastRunAt),
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
		lastRun: lastRun ?? null,
		hook: hookInfoFromTriggerJson(row.triggerJson),
		github: githubInfoFromTriggerJson(row.triggerJson),
		email: emailInfoFromTriggerJson(row.triggerJson),
		once: onceInfoFromTriggerJson(row.triggerJson),
		interval: intervalInfoFromTriggerJson(row.triggerJson),
		alert: parseRoutineAlert(row.alertJson) ?? undefined,
	};
}

async function lastRunFor(routineId: string): Promise<RoutineRunRecord | null> {
	const row = await prisma.routineRun.findFirst({
		where: { routineId },
		orderBy: { createdAt: "desc" },
	});
	return row ? toRoutineRun(row) : null;
}

export async function listRoutines(
	userId?: string,
	botId?: string,
): Promise<RoutineRecord[]> {
	const rows = await prisma.routine.findMany({
		where: { ...(botId ? { botId } : {}), userId: { in: ownerIds(userId) } },
		include: { runs: { orderBy: { createdAt: "desc" }, take: 1 }, group: { select: { id: true, name: true } } },
		orderBy: { createdAt: "desc" },
	});
	return rows.map((row) =>
		toRoutine(row, row.runs[0] ? toRoutineRun(row.runs[0]) : null),
	);
}

export async function getRoutine(
	userId: string | undefined,
	botId: string,
	routineId: string,
): Promise<RoutineRecord | null> {
	const row = await prisma.routine.findFirst({
		where: { id: routineId, botId, userId: { in: ownerIds(userId) } },
		include: { group: { select: { id: true, name: true } } },
	});
	if (!row) return null;
	if (!isOwnerAllowed(row.userId, userId)) return null;
	return toRoutine(row, await lastRunFor(row.id));
}

export async function listSchedulableRoutines(): Promise<RoutineRecord[]> {
	const rows = await prisma.routine.findMany({
		where: {
			enabled: true,
			OR: [
				{ triggerType: "cron", schedule: { not: null } },
				{ triggerType: "interval" },
			],
		},
	});
	return rows.map((row) => toRoutine(row));
}

/** Rotinas `once` habilitadas — usado pelo reconcile de boot do worker (re-agenda/roda/limpa). */
export async function listOnceRoutines(): Promise<RoutineRecord[]> {
	const rows = await prisma.routine.findMany({
		where: { enabled: true, triggerType: "once" },
	});
	return rows.map((row) => toRoutine(row));
}

/**
 * Rotina `once` perdida (reconcile de boot achou horário passado há mais de
 * 1h): apaga a rotina e devolve dados pra avisar na conversa (best-effort,
 * nunca lança). `null` se a rotina já não existe/não é `once`.
 */
export async function completeMissedOnceRoutine(
	routineId: string,
): Promise<{ conversationId: string | null; name: string } | null> {
	try {
		const routine = await prisma.routine.findUnique({
			where: { id: routineId },
			select: { id: true, conversationId: true, name: true, triggerType: true },
		});
		if (!routine || routine.triggerType !== "once") return null;
		await prisma.routine.deleteMany({ where: { id: routineId } });
		return { conversationId: routine.conversationId, name: routine.name };
	} catch (error) {
		console.error(`complete missed once routine failed routine=${routineId}`, error);
		return null;
	}
}

/**
 * Apaga a rotina `once` depois que a execução (única) terminou — mesmo
 * padrão de "roda uma vez e some" da babá de PR (`cleanupGithubRoutineIfPendingDelete`),
 * mas sem precisar de um `pendingDelete` prévio: `once` sempre se auto-apaga
 * ao terminar. Nunca lança; devolve `true` se apagou.
 */
export async function cleanupOnceRoutineAfterRun(routineId: string): Promise<boolean> {
	try {
		const routine = await prisma.routine.findUnique({
			where: { id: routineId },
			select: { id: true, triggerType: true },
		});
		if (!routine || !shouldAutoDeleteAfterRun(routine.triggerType)) return false;
		if (await hasOverlappingRoutineRun(routine.id)) return false;
		const result = await prisma.routine.deleteMany({ where: { id: routineId } });
		return result.count === 1;
	} catch (error) {
		console.error(`cleanup once routine after run failed routine=${routineId}`, error);
		return false;
	}
}

/** Diagnóstico do 404 do webhook genérico: chaves de URL existentes (não são segredo; o secret é outro). */
export async function listGenericHookKeysForDiagnostics(): Promise<
	Array<{ routineId: string; hookKey: string; enabled: boolean; triggerType: string }>
> {
	const rows = await prisma.routine.findMany({
		select: { id: true, enabled: true, triggerType: true, triggerJson: true },
		orderBy: { updatedAt: "desc" },
		take: 50,
	});
	return rows.flatMap((row) => {
		const raw = row.triggerJson as unknown;
		const parsed = typeof raw === "string" ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : raw;
		const key = parsed && typeof parsed === "object" ? (parsed as { hookKey?: unknown; kind?: unknown }) : null;
		return key && typeof key.hookKey === "string"
			? [{ routineId: row.id, hookKey: key.hookKey, enabled: row.enabled, triggerType: `${row.triggerType}/${String(key.kind)}${typeof raw === "string" ? "/string" : ""}` }]
			: [];
	});
}

/**
 * Rotinas com webhook genérico desta hookKey — pausadas inclusive (`enabled`
 * vai no record): quem chama decide (pausada → 409 com motivo, não 404).
 * Antes filtrava `enabled` + `triggerType: "event"` no banco: a UI mostrava a
 * URL (e rotacionava a chave) de rotinas que o webhook nunca achava, e a
 * resposta era só "Hook not found". Linha com trigger genérico mas
 * `triggerType` diferente de "event" é reparada aqui (o trigger é a verdade).
 */
export type GenericHookMatch = {
	routine: RoutineRecord;
	/** Do triggerJson cru: o record (toRoutine) zera triggerJson de rotinas event. */
	secretHash: string;
	maxBodyBytes: number;
};

export async function listRoutinesByHookKey(
	hookKey: string,
): Promise<GenericHookMatch[]> {
	const key = hookKey.trim();
	if (!key) return [];
	const rows = await prisma.routine.findMany({
		where: { triggerJson: { path: ["hookKey"], equals: key } },
	});
	// Confere pelo triggerJson cru (row) — toRoutine() zera triggerJson pra
	// rotinas event antes de sair da API, então não dá pra filtrar depois.
	const matched = rows.filter((row) => {
		const trigger = parseRoutineTriggerJson(row.triggerJson);
		return trigger?.kind === "generic" && trigger.hookKey === key;
	});
	for (const row of matched) {
		if (row.triggerType === "event") continue;
		console.warn(`[routine-event] reparando triggerType=${row.triggerType}→event routine=${row.id} (trigger genérico)`);
		await prisma.routine
			.update({ where: { id: row.id }, data: { triggerType: "event", schedule: null } })
			.catch(() => undefined);
		row.triggerType = "event";
		row.schedule = null;
	}
	return matched.flatMap((row) => {
		const trigger = parseRoutineTriggerJson(row.triggerJson);
		if (trigger?.kind !== "generic") return [];
		return [{ routine: toRoutine(row), secretHash: trigger.secretHash, maxBodyBytes: trigger.maxBodyBytes ?? 65_536 }];
	});
}

/**
 * Rotinas GitHub (event, qualquer usuário) cujo `repo` bate (case-insensitive)
 * — junto com o trigger já parseado. Usada pelo endpoint único de webhook
 * (`dispatch.ts`) pra achar todo mundo que assina aquele repo.
 *
 * Inclui rotinas habilitadas E também desabilitadas-mas-`pendingDelete`: a
 * babá de PR desabilita a rotina assim que vê o evento de fechamento
 * (`markRoutinePendingDelete`), mas eventos subsequentes do mesmo PR/repo
 * (ex.: um `ci_passed` que chega logo depois do merge) ainda precisam casar
 * até a limpeza de fato apagar a rotina.
 */
export async function listGithubRoutinesForRepo(
	repo: string,
): Promise<Array<{ routine: RoutineRecord; trigger: GithubWebhookTrigger }>> {
	const key = repo.trim().toLowerCase();
	if (!key) return [];
	const rows = await prisma.routine.findMany({
		where: { triggerType: "event" },
	});
	const matched: Array<{ routine: RoutineRecord; trigger: GithubWebhookTrigger }> = [];
	for (const row of rows) {
		if (!row.enabled) {
			const trigger = parseRoutineTriggerJson(row.triggerJson);
			if (trigger?.kind !== "github" || trigger.state?.pendingDelete !== true) continue;
			if (trigger.repo.toLowerCase() !== key) continue;
			matched.push({ routine: toRoutine(row), trigger });
			continue;
		}
		const trigger = parseRoutineTriggerJson(row.triggerJson);
		if (trigger?.kind === "github" && trigger.repo.toLowerCase() === key) {
			matched.push({ routine: toRoutine(row), trigger });
		}
	}
	return matched;
}

/**
 * (userId, repo) distintos de toda rotina GitHub habilitada — usado no boot
 * da API pra ressincronizar (`ensureGithubRepoHook`) todos os webhooks de
 * uma vez (best-effort: `ATLAS_PUBLIC_URL` pode ter mudado desde a última
 * vez, hooks legados por-rotina de instalações antigas precisam migrar).
 */
export async function listGithubRoutineRepoOwners(): Promise<
	Array<{ userId: string; repo: string }>
> {
	const rows = await prisma.routine.findMany({
		where: { triggerType: "event", enabled: true },
		select: { userId: true, triggerJson: true },
	});
	const seen = new Set<string>();
	const result: Array<{ userId: string; repo: string }> = [];
	for (const row of rows) {
		const trigger = parseRoutineTriggerJson(row.triggerJson);
		if (!trigger || trigger.kind !== "github") continue;
		const key = `${row.userId}::${trigger.repo.toLowerCase()}`;
		if (seen.has(key)) continue;
		seen.add(key);
		result.push({ userId: row.userId, repo: trigger.repo });
	}
	return result;
}

/**
 * Compat: acha a rotina GitHub pelo `hookKey` legado (hooks já cadastrados no
 * repo por uma versão anterior, com secret por-rotina). Lê o `triggerJson` CRU
 * (o shape atual de `GithubWebhookTrigger` não tem mais `hookKey`/`secretEnc` —
 * só sobrevivem no JSON já persistido de rotinas antigas). Só leitura: nunca
 * escreve hookKey/secretEnc de novo. Usado só como fallback de assinatura na
 * rota `/v1/hooks/github/:hookKey` quando o secret compartilhado (env) não bate.
 */
export async function findGithubRoutineByLegacyHookKey(
	hookKey: string,
): Promise<{ routine: RoutineRecord; legacySecretEnc: string } | null> {
	const key = hookKey.trim();
	if (!key) return null;
	const rows = await prisma.routine.findMany({ where: { triggerType: "event" } });
	for (const row of rows) {
		const raw = row.triggerJson;
		if (!raw || typeof raw !== "object") continue;
		const record = raw as Record<string, unknown>;
		if (record.kind !== "github") continue;
		if (typeof record.hookKey !== "string" || record.hookKey !== key) continue;
		if (typeof record.secretEnc !== "string" || !record.secretEnc) continue;
		return { routine: toRoutine(row), legacySecretEnc: record.secretEnc };
	}
	return null;
}

/**
 * Apaga a rotina se a babá de PR já marcou `state.pendingDelete` e não há run
 * ativo (a última execução — se houver — já terminou). Reaproveitado pelo
 * settle de AgentRun (toda passagem que persiste status terminal chama isto)
 * e pela varredura de limpeza do worker; nunca lança. Devolve `true` se apagou.
 */
export async function cleanupGithubRoutineIfPendingDelete(routineId: string): Promise<boolean> {
	try {
		const routine = await prisma.routine.findUnique({
			where: { id: routineId },
			select: { id: true, userId: true, botId: true, triggerJson: true },
		});
		if (!routine) return false;
		const trigger = parseRoutineTriggerJson(routine.triggerJson);
		if (!trigger || trigger.kind !== "github" || trigger.state?.pendingDelete !== true) {
			return false;
		}
		if (await hasOverlappingRoutineRun(routine.id)) return false;
		return await deleteRoutine(routine.userId, routine.botId, routine.id);
	} catch (error) {
		console.error(`cleanup pending-delete github routine failed routine=${routineId}`, error);
		return false;
	}
}

/** Faz merge de campos de `state` no triggerJson do gatilho GitHub (nunca lança). */
export async function updateRoutineGithubState(
	routineId: string,
	patch: Partial<GithubTriggerState>,
): Promise<void> {
	try {
		const existing = await prisma.routine.findUnique({
			where: { id: routineId },
			select: { triggerJson: true },
		});
		if (!existing) return;
		const trigger = parseRoutineTriggerJson(existing.triggerJson);
		if (!trigger || trigger.kind !== "github") return;
		const next: GithubWebhookTrigger = {
			...trigger,
			state: { ...trigger.state, ...patch },
		};
		await prisma.routine.update({
			where: { id: routineId },
			data: { triggerJson: jsonValue(next) },
		});
	} catch (error) {
		console.error(`update github trigger state failed routine=${routineId}`, error);
	}
}

/**
 * Babá de PR: desabilita a rotina e marca `state.pendingDelete=true` (a API/
 * worker apagam de fato quando a última execução terminar — ou de imediato,
 * se não houver run ativo). Reaproveitado pela rota de webhook e pelo worker.
 */
export async function markRoutinePendingDelete(routineId: string): Promise<void> {
	try {
		const existing = await prisma.routine.findUnique({
			where: { id: routineId },
			select: { triggerJson: true },
		});
		if (!existing) return;
		const trigger = parseRoutineTriggerJson(existing.triggerJson);
		const nextTriggerJson =
			trigger && trigger.kind === "github"
				? jsonValue({
						...trigger,
						state: { ...trigger.state, pendingDelete: true },
					} satisfies GithubWebhookTrigger)
				: undefined;
		await prisma.routine.update({
			where: { id: routineId },
			data: {
				enabled: false,
				...(nextTriggerJson !== undefined ? { triggerJson: nextTriggerJson } : {}),
			},
		});
	} catch (error) {
		console.error(`mark routine pending delete failed routine=${routineId}`, error);
	}
}

/**
 * Trigger GitHub completo por routineId — pra API montar a resposta de
 * detalhe/hook-sync (não há mais secret por rotina pra vazar; o trigger todo
 * já é a "view" pública). `toRoutine()`/`getRoutine()` zeram `triggerJson`
 * cru pra rotinas event, então quem precisa do trigger github usa isto.
 */
export async function getRoutineGithubTrigger(
	userId: string | undefined,
	botId: string,
	routineId: string,
): Promise<GithubWebhookTrigger | null> {
	const row = await prisma.routine.findFirst({
		where: { id: routineId, botId, userId: { in: ownerIds(userId) } },
		select: { userId: true, triggerJson: true },
	});
	if (!row) return null;
	if (!isOwnerAllowed(row.userId, userId)) return null;
	const trigger = parseRoutineTriggerJson(row.triggerJson);
	return trigger && trigger.kind === "github" ? trigger : null;
}

const ALERT_TRIGGER_ERROR = "Alerta só funciona em rotina por horário ou por intervalo (a cada N minutos)";

function alertJsonForCreate(raw: unknown, triggerType: RoutineTriggerType): Prisma.InputJsonValue {
	const parsed = parseRoutineAlertInput(raw);
	if (!parsed.ok) throw new Error(parsed.error);
	if (!alertSupportsTrigger(triggerType)) throw new Error(ALERT_TRIGGER_ERROR);
	return jsonValue(applyAlertConfig(null, parsed.alert)) as Prisma.InputJsonValue;
}

const NO_MAILBOX_ERROR = "Este bot ainda não tem e-mail próprio: ative na aba E-mail do bot antes de criar um gatilho de e-mail";

/** O gatilho de e-mail só faz sentido com a caixa do bot ativa (a caixa é do mesmo dono). */
async function assertBotHasMailbox(userId: string, botId: string): Promise<void> {
	const mailbox = await getMailboxForBot(botId, userId);
	if (!mailbox?.enabled) throw new Error(NO_MAILBOX_ERROR);
}

/**
 * Rotinas habilitadas com gatilho de e-mail da caixa de um bot. O dono vem da CAIXA (nunca do e-mail
 * recebido): só rotinas do mesmo `userId` e `botId` da caixa são candidatas.
 */
export async function listEmailRoutinesForMailbox(
	mailbox: { userId: string; botId: string },
): Promise<Array<{ routine: RoutineRecord; trigger: EmailTriggerJson }>> {
	const rows = await prisma.routine.findMany({
		where: { userId: mailbox.userId, botId: mailbox.botId, triggerType: "event", enabled: true },
	});
	const matched: Array<{ routine: RoutineRecord; trigger: EmailTriggerJson }> = [];
	for (const row of rows) {
		const trigger = parseRoutineTriggerJson(row.triggerJson);
		if (trigger?.kind === "email") matched.push({ routine: toRoutine(row), trigger });
	}
	return matched;
}

export async function createRoutine(
	userId: string | undefined,
	input: CreateRoutineInput,
): Promise<{ routine: RoutineRecord; hookSecret?: string }> {
	if (!userId?.trim() || userId === LEGACY_OWNER_ID) throw new Error("Bot não encontrado");
	const bot = await prisma.bot.findFirst({
		where: { id: input.botId, ownerId: userId },
		select: { id: true, conversationId: true, openRouterModel: true },
	});
	if (!bot) {
		throw new Error("Bot não encontrado");
	}
	const model =
		input.model?.trim() || bot.openRouterModel?.trim() || "";
	const groupId = input.groupId ? await assertGroupUsable(userId, input.botId, input.groupId) : null;
	const pageId = input.pageId ? await assertPageUsable(userId, input.botId, input.pageId) : null;

	const wantsGithub = input.trigger?.kind === "github";
	const wantsEmail = !wantsGithub && input.trigger?.kind === "email";
	const wantsOnce = !wantsGithub && !wantsEmail && input.trigger?.kind === "once";
	const wantsInterval = !wantsGithub && !wantsEmail && !wantsOnce && input.trigger?.kind === "interval";
	const wantsGeneric =
		!wantsGithub &&
		!wantsEmail &&
		!wantsOnce &&
		!wantsInterval &&
		(input.triggerType === "event" || input.trigger?.kind === "generic");

	let triggerType: RoutineTriggerType = wantsGithub || wantsEmail || wantsGeneric
		? "event"
		: wantsOnce
			? "once"
			: wantsInterval
				? "interval"
				: "cron";
	let schedule = input.schedule ?? null;
	let triggerJson: unknown = input.triggerJson;
	let hookSecret: string | undefined;

	if (wantsOnce && input.trigger?.kind === "once") {
		triggerType = "once";
		schedule = null;
		triggerJson = { kind: "once", runAt: input.trigger.runAt };
	} else if (wantsInterval && input.trigger?.kind === "interval") {
		triggerType = "interval";
		schedule = null;
		triggerJson = { kind: "interval", everyMinutes: input.trigger.everyMinutes };
	} else if (wantsEmail && input.trigger?.kind === "email") {
		await assertBotHasMailbox(userId, input.botId);
		triggerType = "event";
		schedule = null;
		const parsed = parseEmailTriggerInput(input.trigger);
		if ("error" in parsed) throw new Error(parsed.error);
		triggerJson = { kind: "email", ...parsed.value } satisfies EmailTriggerJson;
	} else if (wantsGithub && input.trigger?.kind === "github") {
		triggerType = "event";
		schedule = null;
		// `branch` (atual) tem precedência sobre `ciBranch` (alias legado v3).
		const branch = input.trigger.branch ?? input.trigger.ciBranch;
		const trigger: GithubWebhookTrigger = {
			kind: "github",
			repo: input.trigger.repo,
			events: input.trigger.events,
			...(input.trigger.prNumber !== undefined ? { prNumber: input.trigger.prNumber } : {}),
			...(input.trigger.users ? { users: input.trigger.users } : {}),
			...(branch ? { branch } : {}),
			state: {},
		};
		triggerJson = trigger;
	} else if (wantsGeneric) {
		triggerType = "event";
		schedule = null;
		const hookKey = generateHookKey();
		hookSecret = generateHookSecret();
		const secretEnc = await sealHookSecretForOwner(userId, hookKey, hookSecret);
		triggerJson = {
			kind: "generic",
			hookKey,
			secretHash: hashHookSecret(hookSecret),
			...(secretEnc ? { secretEnc } : {}),
			maxBodyBytes: 65_536,
		};
	} else {
		triggerType = "cron";
		// Mesma regra de `updateRoutine`: só guarda o scheduleState se ele
		// realmente corresponder ao `schedule` sendo criado — evita nascer já
		// com um triggerJson dessincronizado do cron real.
		const kept = matchingScheduleState(triggerJson, schedule);
		triggerJson = kept !== undefined ? { scheduleState: kept } : undefined;
	}

	const alertJson = input.alert ? alertJsonForCreate(input.alert, triggerType) : undefined;

	const row = await prisma.routine.create({
		data: {
			userId: userId?.trim() ? userId.trim() : LEGACY_OWNER_ID,
			botId: input.botId,
			conversationId: bot.conversationId,
			groupId,
			pageId,
			name: input.name.trim(),
			prompt: input.prompt,
			model,
			allowChatgptPlan: input.allowChatgptPlan === true,
			notify: parseRoutineNotifyMode(input.notify),
			schedule,
			enabled: input.enabled ?? true,
			timezone: input.timezone?.trim() || DEFAULT_TIMEZONE,
			triggerType,
			createdBy: input.createdBy === "bot" ? "bot" : "user",
			triggerJson: jsonValue(triggerJson) ?? undefined,
			...(alertJson ? { alertJson } : {}),
		},
		include: { group: { select: { id: true, name: true } } },
	});
	return { routine: toRoutine(row), hookSecret };
}

export async function updateRoutine(
	userId: string | undefined,
	botId: string,
	routineId: string,
	input: UpdateRoutineInput,
): Promise<RoutineRecord | null> {
	if (!userId?.trim() || userId === LEGACY_OWNER_ID) return null;
	const existing = await prisma.routine.findFirst({
		where: { id: routineId, botId, userId },
		select: { id: true, userId: true, triggerType: true, triggerJson: true, schedule: true, alertJson: true },
	});
	if (!existing) return null;
	if (!isOwnerAllowed(existing.userId, userId)) return null;

	const nextType =
		input.triggerType !== undefined
			? input.triggerType
			: asTriggerType(existing.triggerType);
	const previousAlert = parseRoutineAlert(existing.alertJson);
	let alertPatch: Prisma.InputJsonValue | typeof Prisma.DbNull | undefined;
	if (input.alert === null) {
		alertPatch = Prisma.DbNull;
	} else if (input.alert !== undefined) {
		const parsedAlert = parseRoutineAlertInput(input.alert);
		if (!parsedAlert.ok) throw new Error(parsedAlert.error);
		alertPatch = jsonValue(applyAlertConfig(previousAlert, parsedAlert.alert));
	}
	// Alerta (novo ou já existente) exige gatilho por tempo: trocar para webhook/uma vez com alerta ligado é erro.
	if (alertPatch !== Prisma.DbNull && (alertPatch !== undefined || previousAlert) && !alertSupportsTrigger(nextType)) {
		throw new Error(ALERT_TRIGGER_ERROR);
	}

	const data: Prisma.RoutineUpdateInput = {
		...(alertPatch !== undefined ? { alertJson: alertPatch } : {}),
		...(input.name !== undefined ? { name: input.name.trim() } : {}),
		...(input.groupId === null ? { group: { disconnect: true } } : {}),
		...(input.groupId ? { group: { connect: { id: await assertGroupUsable(userId, botId, input.groupId) } } } : {}),
		...(input.pageId === null ? { page: { disconnect: true } } : {}),
		...(input.pageId ? { page: { connect: { id: await assertPageUsable(userId, botId, input.pageId) } } } : {}),
		...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
		...(input.model !== undefined ? { model: input.model.trim() } : {}),
		...(input.allowChatgptPlan !== undefined ? { allowChatgptPlan: input.allowChatgptPlan } : {}),
		...(input.notify !== undefined ? { notify: parseRoutineNotifyMode(input.notify) } : {}),
		...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
		...(input.timezone !== undefined
			? { timezone: input.timezone.trim() || DEFAULT_TIMEZONE }
			: {}),
	};

	if (input.triggerType !== undefined) {
		data.triggerType = input.triggerType;
	}

	const existingTrigger = parseRoutineTriggerJson(existing.triggerJson);

	if (nextType === "event") {
		if (input.schedule !== undefined) {
			data.schedule = null;
		}
		if (input.emailTrigger) {
			await assertBotHasMailbox(userId, botId);
			const base = existingTrigger && existingTrigger.kind === "email" ? existingTrigger : { kind: "email" as const };
			const patch = input.emailTrigger;
			const merged = {
				fromContains: patch.fromContains === null ? undefined : (patch.fromContains ?? base.fromContains),
				subjectContains: patch.subjectContains === null ? undefined : (patch.subjectContains ?? base.subjectContains),
			};
			const parsed = parseEmailTriggerInput(merged);
			if ("error" in parsed) throw new Error(parsed.error);
			data.triggerJson = jsonValue({ kind: "email", ...parsed.value } satisfies EmailTriggerJson) ?? undefined;
		}
		if (input.githubTrigger) {
			// Base pro merge: o trigger github atual, OU um esqueleto vazio quando
			// a rotina está TROCANDO de tipo pra github (cron/event genérico →
			// github) — quem chama (propose_routine) já validou repo+events com
			// `parseGithubTriggerInput` antes de patchar, então exige-los aqui de
			// novo (defensivo) evita persistir um trigger github incompleto.
			const base: GithubWebhookTrigger =
				existingTrigger && existingTrigger.kind === "github"
					? existingTrigger
					: { kind: "github", repo: "", events: [], state: {} };
			const patch = input.githubTrigger;
			if (patch.repo === undefined && !base.repo) {
				throw new Error("Gatilho GitHub incompleto: repo obrigatório ao trocar o tipo do gatilho");
			}
			if (patch.events === undefined && base.events.length === 0) {
				throw new Error(
					"Gatilho GitHub incompleto: selecione ao menos um evento ao trocar o tipo do gatilho",
				);
			}
			// `branch` (atual) tem precedência sobre `ciBranch` (alias legado v3)
			// quando ambos vêm no mesmo patch.
			const branchPatch = patch.branch !== undefined ? patch.branch : patch.ciBranch;
			const next: GithubWebhookTrigger = {
				...base,
				repo: patch.repo !== undefined ? patch.repo : base.repo,
				events: patch.events !== undefined ? patch.events : base.events,
				prNumber:
					patch.prNumber === null
						? undefined
						: patch.prNumber !== undefined
							? patch.prNumber
							: base.prNumber,
				users:
					patch.users === null
						? undefined
						: patch.users !== undefined
							? patch.users
							: base.users,
				branch:
					branchPatch === null
						? undefined
						: branchPatch !== undefined
							? branchPatch
							: base.branch,
			};
			data.triggerJson = jsonValue(next) ?? undefined;
		}
		// Não permitir sobrescrever triggerJson genérico com lixo do client
		// (secretHash). Só update de campos não-secret via rotate.
	} else if (nextType === "once") {
		data.schedule = null;
		if (input.onceTrigger?.runAt) {
			data.triggerJson = jsonValue({ kind: "once", runAt: input.onceTrigger.runAt });
		} else if (!(existingTrigger && existingTrigger.kind === "once")) {
			// Trocando pra "once" (cron/event → once) sem runAt no patch: sem
			// isso não dá pra persistir um gatilho `once` válido.
			throw new Error("Gatilho 'uma vez' incompleto: informe run_at ao trocar o tipo do gatilho");
		}
	} else if (nextType === "interval") {
		data.schedule = null;
		if (input.intervalTrigger?.everyMinutes) {
			data.triggerJson = jsonValue({
				kind: "interval",
				everyMinutes: input.intervalTrigger.everyMinutes,
			});
		} else if (!(existingTrigger && existingTrigger.kind === "interval")) {
			// Trocando pra "interval" sem every_minutes no patch: sem isso não
			// dá pra persistir um gatilho válido (mesma regra do `once`).
			throw new Error(
				"Gatilho de intervalo incompleto: informe every_minutes ao trocar o tipo do gatilho",
			);
		}
	} else {
		if (input.schedule !== undefined) {
			data.schedule = input.schedule;
		}
		const nextSchedule = input.schedule !== undefined ? input.schedule : existing.schedule;
		if (input.triggerJson !== undefined) {
			// Só guarda o scheduleState que o client mandou se ele bater com o
			// schedule que está sendo salvo — senão fica stale (ver nota em
			// `matchingScheduleState`) e o painel volta a mostrar o horário
			// antigo. `schedule` é sempre quem manda.
			const kept = matchingScheduleState(input.triggerJson, nextSchedule);
			data.triggerJson = kept !== undefined ? jsonValue({ scheduleState: kept }) : Prisma.DbNull;
		} else if (input.schedule !== undefined) {
			// `schedule` mudou (ex.: agente via propose_routine) sem um
			// `triggerJson` novo junto: se o scheduleState que já estava salvo
			// não bate mais com o novo `schedule`, dropa — senão ele fica
			// dessincronizado do cron real (bug original: painel mostrando o
			// horário antigo depois de uma edição server-side).
			const kept = matchingScheduleState(existing.triggerJson, nextSchedule);
			if (kept === undefined) {
				data.triggerJson = Prisma.DbNull;
			}
		} else if (existingTrigger) {
			// Trocando de github/event genérico pra cron sem novo triggerJson:
			// limpa o gatilho antigo — senão `routine.github`/`routine.hook`
			// continuariam expondo a config antiga mesmo com triggerType="cron".
			data.triggerJson = Prisma.DbNull;
		}
	}

	const row = await prisma.routine.update({
		where: { id: routineId, userId, botId },
		data,
		include: { group: { select: { id: true, name: true } } },
	});
	return toRoutine(row, await lastRunFor(row.id));
}

/** Converte uma rotina existente em webhook genérico e devolve o secret uma única vez. */
export async function convertRoutineToGenericWebhook(
	userId: string | undefined,
	botId: string,
	routineId: string,
	input: UpdateRoutineInput,
): Promise<{ routine: RoutineRecord; hookSecret: string } | null> {
	const existing = await prisma.routine.findFirst({
		where: { id: routineId, botId, userId: { in: ownerIds(userId) } },
		select: { id: true, userId: true },
	});
	if (!existing) return null;
	if (!isOwnerAllowed(existing.userId, userId)) return null;
	const hookSecret = generateHookSecret();
	const newHookKey = generateHookKey();
	const newSecretEnc = await sealHookSecretForOwner(existing.userId, newHookKey, hookSecret);
	const row = await prisma.routine.update({
		where: { id: routineId },
		data: {
			...(input.name !== undefined ? { name: input.name.trim() } : {}),
			...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
			...(input.model !== undefined ? { model: input.model.trim() } : {}),
			...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
			...(input.timezone !== undefined
				? { timezone: input.timezone.trim() || DEFAULT_TIMEZONE }
				: {}),
			triggerType: "event",
			schedule: null,
			triggerJson: jsonValue({
				kind: "generic",
				hookKey: newHookKey,
				secretHash: hashHookSecret(hookSecret),
				...(newSecretEnc ? { secretEnc: newSecretEnc } : {}),
				maxBodyBytes: 65_536,
			}),
		},
	});
	return { routine: toRoutine(row, await lastRunFor(row.id)), hookSecret };
}

export async function rotateRoutineHookSecret(
	userId: string | undefined,
	botId: string,
	routineId: string,
): Promise<{ routine: RoutineRecord; hookSecret: string } | null> {
	const existing = await prisma.routine.findFirst({
		where: { id: routineId, botId, userId: { in: ownerIds(userId) } },
	});
	if (!existing) return null;
	if (!isOwnerAllowed(existing.userId, userId)) return null;
	const trigger = parseRoutineTriggerJson(existing.triggerJson);
	if (!trigger || trigger.kind !== "generic") {
		throw new Error("Rotina não é webhook");
	}
	const hookSecret = generateHookSecret();
	const { secretEnc: _old, urlSecretAt: _url, ...rest } = trigger;
	void _old;
	void _url;
	const secretEnc = await sealHookSecretForOwner(existing.userId, trigger.hookKey, hookSecret);
	const nextTrigger = {
		...rest,
		secretHash: hashHookSecret(hookSecret),
		...(secretEnc ? { secretEnc } : {}),
	};
	const row = await prisma.routine.update({
		where: { id: routineId, userId: existing.userId },
		data: { triggerJson: jsonValue(nextTrigger) },
	});
	return { routine: toRoutine(row, await lastRunFor(row.id)), hookSecret };
}

export async function deleteRoutine(
	userId: string | undefined,
	botId: string,
	routineId: string,
): Promise<boolean> {
	const existing = await prisma.routine.findFirst({
		where: { id: routineId, botId, userId: { in: ownerIds(userId) } },
		select: { id: true, userId: true },
	});
	if (!existing) return false;
	if (!isOwnerAllowed(existing.userId, userId)) return false;
	const result = await prisma.routine.deleteMany({
		where: { id: routineId, userId: { in: ownerIds(userId) } },
	});
	return result.count === 1;
}

export async function listRoutineRuns(
	routineId: string,
	take = 20,
): Promise<RoutineRunRecord[]> {
	const rows = await prisma.routineRun.findMany({
		where: { routineId },
		orderBy: { createdAt: "desc" },
		take,
	});
	return rows.map(toRoutineRun);
}

/**
 * Fim do último run `succeeded` da rotina (ISO), ou `null` na primeira
 * execução. Run que falhou/foi pulado não avança a marca: o próximo ainda
 * precisa cobrir o que ficou sem ser lido. Escopado pelo dono da rotina.
 */
export async function getLastCompletedRoutineRunAt(
	userId: string,
	routineId: string,
): Promise<string | null> {
	const row = await prisma.routineRun.findFirst({
		where: {
			routineId,
			status: "succeeded",
			finishedAt: { not: null },
			routine: { is: { userId } },
		},
		orderBy: { finishedAt: "desc" },
		select: { finishedAt: true },
	});
	return toIso(row?.finishedAt);
}

export async function listRecentRoutineRunsForBot(
	userId?: string,
	botId?: string,
	take = 10,
): Promise<RoutineRunListItem[]> {
	const rows = await prisma.routineRun.findMany({
		where: { routine: { is: { ...(botId ? { botId } : {}), userId: { in: ownerIds(userId) } } } },
		include: { routine: { select: { name: true } } },
		orderBy: { createdAt: "desc" },
		take,
	});
	return rows.map((row) => ({
		...toRoutineRun(row),
		routineName: row.routine.name,
	}));
}

/** Execução "queued" que nunca ganhou AgentRun depois disso: o job se perdeu. */
export const STALE_QUEUED_ROUTINE_RUN_MS = 45 * 60 * 1000;

/**
 * Outra execução desta rotina ainda ativa. `excludeRunId`: a execução que o
 * próprio job está processando — o webhook cria a linha "queued" ANTES de
 * enfileirar, e sem excluí-la a rotina via evento achava a si mesma e era
 * sempre pulada. "queued" sem AgentRun há mais de 45 min (> janela de adiamento de 30 min do worker) é job perdido e não
 * bloqueia (senão uma órfã travava a rotina pra sempre).
 */
export async function hasOverlappingRoutineRun(
	routineId: string,
	options: { excludeRunId?: string; now?: Date } = {},
): Promise<boolean> {
	const staleBefore = new Date((options.now ?? new Date()).getTime() - STALE_QUEUED_ROUTINE_RUN_MS);
	// FIFO entre eventos adiados: um "queued" ainda sem AgentRun só bloqueia se for
	// MAIS ANTIGO que a execução em processamento. Sem isso, dois eventos adiados
	// se bloqueavam mutuamente até o fim da janela e nenhum rodava.
	const own = options.excludeRunId
		? await prisma.routineRun.findUnique({
				where: { id: options.excludeRunId },
				select: { createdAt: true },
			})
		: null;
	const existing = await prisma.routineRun.findFirst({
		where: {
			routineId,
			status: { in: ACTIVE_RUN_STATUSES },
			...(options.excludeRunId ? { id: { not: options.excludeRunId } } : {}),
			NOT: [
				{ status: "queued", agentRunId: null, createdAt: { lt: staleBefore } },
				...(own ? [{ status: "queued" as const, agentRunId: null, createdAt: { gt: own.createdAt } }] : []),
			],
		},
		select: { id: true },
	});
	return Boolean(existing);
}

/** Fecha execuções "queued" órfãs (sem AgentRun há mais de 45 min) como puladas, pra não ficarem "em fila" pra sempre no histórico. */
export async function expireStaleQueuedRoutineRuns(
	routineId: string,
	options: { excludeRunId?: string; now?: Date } = {},
): Promise<number> {
	const now = options.now ?? new Date();
	const { count } = await prisma.routineRun.updateMany({
		where: {
			routineId,
			status: "queued",
			agentRunId: null,
			createdAt: { lt: new Date(now.getTime() - STALE_QUEUED_ROUTINE_RUN_MS) },
			...(options.excludeRunId ? { id: { not: options.excludeRunId } } : {}),
		},
		data: { status: "skipped", error: "Execução não chegou a rodar (job perdido)", finishedAt: now },
	});
	return count;
}

export async function findRoutineRunByAgentRunId(
	agentRunId: string,
): Promise<RoutineRunRecord | null> {
	const row = await prisma.routineRun.findFirst({
		where: { agentRunId },
		orderBy: { createdAt: "desc" },
	});
	return row ? toRoutineRun(row) : null;
}

/** Modo de aviso da rotina que originou este run ("always" se não achar a rotina). */
export async function getRoutineNotifyModeForAgentRun(agentRunId: string): Promise<RoutineNotifyMode> {
	const row = await prisma.routineRun.findFirst({
		where: { agentRunId },
		orderBy: { createdAt: "desc" },
		select: { routine: { select: { notify: true } } },
	});
	return parseRoutineNotifyMode(row?.routine?.notify);
}

/** Página que a rotina deste run atualiza no lugar (só se a rotina é do usuário; null = nenhuma). */
export async function getRoutinePageIdForAgentRun(agentRunId: string, userId: string | undefined): Promise<string | null> {
	const owners = ownerIds(userId);
	if (owners.length === 0) return null;
	const row = await prisma.routineRun.findFirst({
		where: { agentRunId, routine: { userId: { in: owners } } },
		orderBy: { createdAt: "desc" },
		select: { routine: { select: { pageId: true } } },
	});
	return row?.routine?.pageId ?? null;
}

/** Alerta da rotina que originou este run (só se a rotina é do usuário; null = não é rotina de alerta). */
export async function getRoutineAlertForAgentRun(
	agentRunId: string,
	userId: string | undefined,
): Promise<{ routineId: string; botId: string; name: string; alert: RoutineAlert; interval?: { everyMinutes: number } } | null> {
	const owners = ownerIds(userId);
	if (owners.length === 0) return null;
	const row = await prisma.routineRun.findFirst({
		where: { agentRunId, routine: { userId: { in: owners } } },
		orderBy: { createdAt: "desc" },
		select: { routine: { select: { id: true, botId: true, name: true, alertJson: true, triggerType: true, triggerJson: true } } },
	});
	const alert = parseRoutineAlert(row?.routine?.alertJson);
	if (!row?.routine || !alert) return null;
	const interval = row.routine.triggerType === "interval" ? intervalInfoFromTriggerJson(row.routine.triggerJson) : undefined;
	return { routineId: row.routine.id, botId: row.routine.botId, name: row.routine.name, alert, ...(interval ? { interval } : {}) };
}

/**
 * Grava o estado do alerta depois de uma verificação. Só do dono, e só se a condição ainda é a que foi
 * avaliada (editada no meio do run = descarta, a condição nova começa de fora). false = nada gravado.
 */
export async function recordRoutineAlertState(
	userId: string | undefined,
	routineId: string,
	next: RoutineAlert,
	/** Novo intervalo (backoff): só vale em rotina `interval`, na mesma gravação do estado. */
	everyMinutes?: number,
): Promise<boolean> {
	const owners = ownerIds(userId);
	if (owners.length === 0) return false;
	const widen = everyMinutes !== undefined && Number.isInteger(everyMinutes) && everyMinutes >= 1;
	const { count } = await prisma.routine.updateMany({
		where: {
			id: routineId,
			userId: { in: owners },
			alertJson: { path: ["condition"], equals: next.condition },
			...(widen ? { triggerType: "interval" } : {}),
		},
		data: { alertJson: jsonValue(next), ...(widen ? { triggerJson: jsonValue({ kind: "interval", everyMinutes }) } : {}) },
	});
	return count === 1;
}

/** Rotina (nome e conversa do bot) de um run: base do aviso quando a rotina não rodou. Só do dono; null = não é rotina dele. */
export async function getRoutineContextForAgentRun(
	agentRunId: string,
	userId: string | undefined,
): Promise<{ routineId: string; name: string; conversationId: string | null } | null> {
	const owners = ownerIds(userId);
	if (owners.length === 0) return null;
	const row = await prisma.routineRun.findFirst({
		where: { agentRunId, routine: { userId: { in: owners } } },
		orderBy: { createdAt: "desc" },
		select: { routine: { select: { id: true, name: true, botId: true } } },
	});
	if (!row?.routine) return null;
	const bot = await prisma.bot.findFirst({
		where: { id: row.routine.botId, ownerId: { in: owners } },
		select: { conversationId: true },
	});
	return { routineId: row.routine.id, name: row.routine.name, conversationId: bot?.conversationId ?? null };
}

export async function findRecentRoutineRunByIdempotency(
	routineId: string,
	idempotencyKey: string,
	withinMs = 24 * 60 * 60 * 1000,
): Promise<RoutineRunRecord | null> {
	const key = idempotencyKey.trim();
	if (!key) return null;
	const since = new Date(Date.now() - withinMs);
	const rows = await prisma.routineRun.findMany({
		where: {
			routineId,
			triggeredBy: "event",
			createdAt: { gte: since },
		},
		orderBy: { createdAt: "desc" },
		take: 40,
	});
	for (const row of rows) {
		const envelope = row.eventJson as EventEnvelope | null;
		if (
			envelope &&
			typeof envelope === "object" &&
			envelope.idempotencyKey === key
		) {
			return toRoutineRun(row);
		}
	}
	return null;
}

export async function createRoutineRun(input: {
	routineId: string;
	triggeredBy: RoutineTriggeredBy;
	status?: RoutineRunStatus;
	error?: string | null;
	summary?: string | null;
	scheduledFor?: Date | null;
	eventJson?: unknown;
}): Promise<RoutineRunRecord> {
	const now = new Date();
	const status = input.status ?? "queued";
	const row = await prisma.routineRun.create({
		data: {
			routineId: input.routineId,
			triggeredBy: input.triggeredBy,
			status,
			error: input.error ?? null,
			summary: input.summary ?? null,
			scheduledFor: input.scheduledFor ?? null,
			eventJson: jsonValue(input.eventJson) ?? undefined,
			startedAt: status === "running" ? now : null,
			finishedAt:
				status === "skipped" || status === "failed" || status === "succeeded"
					? now
					: null,
		},
	});
	return toRoutineRun(row);
}

export async function markRoutineRunSkipped(
	routineRunId: string,
	reason: string,
): Promise<RoutineRunRecord> {
	const row = await prisma.routineRun.update({
		where: { id: routineRunId },
		data: {
			status: "skipped",
			error: reason,
			finishedAt: new Date(),
		},
	});
	return toRoutineRun(row);
}

/**
 * Falha definitiva de um disparo (job esgotou as tentativas). Só transita de
 * queued/running: devolve false se já estava finalizada (evita aviso duplicado).
 */
export async function markRoutineRunFailed(
	routineRunId: string,
	reason: string,
): Promise<boolean> {
	const { count } = await prisma.routineRun.updateMany({
		where: { id: routineRunId, status: { in: ACTIVE_RUN_STATUSES } },
		data: { status: "failed", error: reason, finishedAt: new Date() },
	});
	return count === 1;
}

/** Disparo mais recente ainda "queued" e sem AgentRun, criado a partir de `since` (falha antes de vincular o run). */
export async function findOpenRoutineRunSince(
	routineId: string,
	triggeredBy: RoutineTriggeredBy,
	since: Date,
): Promise<string | null> {
	const row = await prisma.routineRun.findFirst({
		where: { routineId, triggeredBy, status: "queued", agentRunId: null, createdAt: { gte: since } },
		orderBy: { createdAt: "desc" },
		select: { id: true },
	});
	return row?.id ?? null;
}

export async function attachAgentRunToRoutineRun(
	routineRunId: string,
	agentRunId: string,
	routineId: string,
): Promise<RoutineRunRecord> {
	const now = new Date();
	const [row] = await prisma.$transaction([
		prisma.routineRun.update({
			where: { id: routineRunId },
			data: {
				agentRunId,
				status: "running",
				startedAt: now,
			},
		}),
		prisma.routine.update({
			where: { id: routineId },
			data: { lastRunAt: now },
		}),
	]);
	return toRoutineRun(row);
}

export async function settleRoutineRunForAgentRun(
	agentRunId: string,
	input: {
		status: string;
		resultText?: string | null;
		error?: string | null;
	},
): Promise<void> {
	try {
		const mapped = mapAgentRunStatus(input.status);
		if (!mapped) return;
		const now = new Date();
		const summary = input.resultText?.trim() || null;
		// Busca antes de atualizar: precisamos do routineId pra checar a babá de
		// PR (state.pendingDelete) depois que o status terminal for persistido.
		const rows = await prisma.routineRun.findMany({
			where: { agentRunId, status: { in: ACTIVE_RUN_STATUSES } },
			select: { id: true, routineId: true },
		});
		if (rows.length === 0) return;
		await prisma.routineRun.updateMany({
			where: { id: { in: rows.map((row) => row.id) } },
			data: {
				status: mapped,
				summary,
				error: mapped === "failed" ? input.error ?? null : null,
				finishedAt: now,
			},
		});
		// Babá de PR (linha legada com delivery="poll" ou webhook sem execução
		// ativa no momento do fechamento): a execução final acabou de persistir
		// status terminal — se não sobrou run ativo, apaga a rotina agora (best-effort).
		const routineIds = Array.from(new Set(rows.map((row) => row.routineId)));
		for (const routineId of routineIds) {
			await cleanupGithubRoutineIfPendingDelete(routineId);
			await cleanupOnceRoutineAfterRun(routineId);
		}
	} catch (error) {
		console.error(
			`settle routine run failed agentRun=${agentRunId}`,
			error,
		);
	}
}

function mapAgentRunStatus(status: string): "succeeded" | "failed" | null {
	if (status === "completed") return "succeeded";
	if (
		status === "failed" ||
		status === "budget_exhausted" ||
		status === "cancelled"
	) {
		return "failed";
	}
	return null;
}

export { isGenericWebhookTrigger, parseRoutineTriggerJson };


export type UserRoutineWebhook = {
	routineId: string;
	botId: string;
	name: string;
	enabled: boolean;
	hookKey: string;
	/** Secret selado (ou null em rotina antiga: rotacione para habilitar `{{secret:rotina:...}}`). */
	secretEnc: string | null;
};

/** Webhooks genéricos das rotinas do usuário (só dele). */
export async function listUserRoutineWebhooks(userId: string): Promise<UserRoutineWebhook[]> {
	const rows = await prisma.routine.findMany({
		where: { userId, triggerType: "event" },
		select: { id: true, botId: true, name: true, enabled: true, triggerJson: true },
		orderBy: { createdAt: "asc" },
	});
	return rows.flatMap((row) => {
		const trigger = parseRoutineTriggerJson(row.triggerJson);
		if (!trigger || trigger.kind !== "generic") return [];
		return [{ routineId: row.id, botId: row.botId, name: row.name, enabled: row.enabled, hookKey: trigger.hookKey, secretEnc: trigger.secretEnc ?? null }];
	});
}

const URL_SECRET_MARK_EVERY_MS = 60 * 60_000;

/** Marca (no máximo 1x por hora) que a rotina foi autenticada com ?secret= na URL. */
export async function recordHookUrlSecretUse(routineId: string): Promise<void> {
	const row = await prisma.routine.findUnique({ where: { id: routineId }, select: { triggerJson: true } });
	const trigger = parseRoutineTriggerJson(row?.triggerJson);
	if (!trigger || trigger.kind !== "generic") return;
	if (trigger.urlSecretAt && Date.now() - new Date(trigger.urlSecretAt).getTime() < URL_SECRET_MARK_EVERY_MS) return;
	await prisma.routine.update({ where: { id: routineId }, data: { triggerJson: jsonValue({ ...trigger, urlSecretAt: new Date().toISOString() }) } });
}
