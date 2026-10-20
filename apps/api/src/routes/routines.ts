import { Hono } from "hono";
import { ensureGithubRepoHook } from "@workspace/agent-runtime";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";
import {
	isCronFive,
	normalizeGithubEvents,
	normalizeGithubRepo,
	normalizeGithubUsers,
	parseGithubTriggerInput,
	parseOnceRunAt,
	parseIntervalEveryMinutes,
	type CreateRoutineInput,
	type UpdateRoutineInput,
} from "@workspace/shared";
import {
	createRoutine,
	createRoutineGroup,
	deleteRoutine,
	deleteRoutineGroup,
	getRoutine,
	getRoutineGithubTrigger,
	hookPublicUrl,
	listRecentRoutineRunsForBot,
	listRoutineGroups,
	listRoutineRuns,
	listRoutines,
	rotateRoutineHookSecret,
	setRoutineGroupEnabled,
	updateRoutine,
	updateRoutineGroup,
} from "@workspace/db";
import {
	enqueueRoutineNow,
	removeRoutineScheduler,
	syncRoutineScheduler,
	type RoutineQueue,
} from "@workspace/queue";

const DEFAULT_TIMEZONE = "America/Sao_Paulo";

function parseId(value: unknown): string | null {
	if (typeof value !== "string" || value.trim().length === 0) return null;
	return value.trim();
}

function parseOptionalString(value: unknown): string | null | undefined {
	if (value === undefined) return undefined;
	if (value === null) return null;
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function parseEnabled(value: unknown): boolean | undefined {
	if (typeof value !== "boolean") return undefined;
	return value;
}

export function parseCreateBody(
	botId: string,
	json: unknown,
): CreateRoutineInput | { error: string } {
	const parsed = parseCreateBodyBase(botId, json);
	if ("error" in parsed) return parsed;
	const groupRaw = (json as Record<string, unknown>).groupId;
	if (groupRaw === undefined || groupRaw === null) return parsed;
	if (typeof groupRaw !== "string" || groupRaw.trim().length === 0) return { error: "groupId inválido" };
	return { ...parsed, groupId: groupRaw.trim() };
}

function parseCreateBodyBase(
	botId: string,
	json: unknown,
): CreateRoutineInput | { error: string } {
	if (!json || typeof json !== "object") {
		return { error: "Invalid JSON body" };
	}
	const body = json as Record<string, unknown>;
	if (body.allowChatgptPlan !== undefined && typeof body.allowChatgptPlan !== "boolean") return { error: "allowChatgptPlan deve ser boolean" };
	if (typeof body.name !== "string" || body.name.trim().length === 0) {
		return { error: "Nome obrigatório" };
	}
	if (typeof body.prompt !== "string") {
		return { error: "Instrução obrigatória" };
	}

	const rawTrigger =
		body.trigger && typeof body.trigger === "object"
			? (body.trigger as Record<string, unknown>)
			: undefined;

	const enabledRaw = parseEnabled(body.enabled) ?? true;
	const name = body.name.trim();
	const model =
		typeof body.model === "string" && body.model.trim()
			? body.model.trim()
			: undefined;
	const timezone =
		typeof body.timezone === "string" && body.timezone.trim()
			? body.timezone.trim()
			: DEFAULT_TIMEZONE;

	// Lembrete de uma vez só: sem schedule (BullMQ delayed job, não repeatable).
	if (rawTrigger?.kind === "once" || body.triggerType === "once") {
		const parsedOnce = parseOnceRunAt(
			{ runAt: rawTrigger?.runAt, timezone },
			new Date(),
		);
		if (!parsedOnce.ok) return { error: parsedOnce.error };
		return {
			botId,
			name,
			prompt: body.prompt,
			triggerType: "once",
			trigger: { kind: "once", runAt: parsedOnce.runAtIso },
			model,
			allowChatgptPlan: body.allowChatgptPlan === true,
			schedule: null,
			enabled: enabledRaw,
			timezone,
		};
	}

	// Intervalo ("a cada N min"): BullMQ `every`, sem cron.
	if (rawTrigger?.kind === "interval" || body.triggerType === "interval") {
		const parsedInterval = parseIntervalEveryMinutes({ everyMinutes: rawTrigger?.everyMinutes });
		if (!parsedInterval.ok) return { error: parsedInterval.error };
		return {
			botId,
			name,
			prompt: body.prompt,
			triggerType: "interval",
			trigger: { kind: "interval", everyMinutes: parsedInterval.everyMinutes },
			model,
			allowChatgptPlan: body.allowChatgptPlan === true,
			schedule: null,
			enabled: enabledRaw,
			timezone,
		};
	}

	// GitHub: webhook único do Atlas, secret compartilhado via env var — nada
	// por-rotina pra gerar aqui (validado pelo mesmo schema Zod da tool do agente).
	if (rawTrigger?.kind === "github") {
		const parsedGithub = parseGithubTriggerInput(rawTrigger);
		if ("error" in parsedGithub) return { error: parsedGithub.error };
		return {
			botId,
			name,
			prompt: body.prompt,
			triggerType: "event",
			trigger: { kind: "github", ...parsedGithub.value },
			model,
			allowChatgptPlan: body.allowChatgptPlan === true,
			schedule: null,
			enabled: enabledRaw,
			timezone,
		};
	}

	const triggerType =
		body.triggerType === "event"
			? "event"
			: rawTrigger?.kind === "generic"
				? "event"
				: "cron";

	const schedule = parseOptionalString(body.schedule);
	if (schedule && !isCronFive(schedule)) {
		return { error: "Cron inválido (esperado 5 campos)" };
	}
	const enabled = enabledRaw;

	if (triggerType === "cron") {
		if (enabled && !schedule) {
			return { error: "Rotina ativa precisa de um agendamento cron" };
		}
		return {
			botId,
			name: body.name.trim(),
			prompt: body.prompt,
			triggerType: "cron",
			allowChatgptPlan: body.allowChatgptPlan === true,
		model:
				typeof body.model === "string" && body.model.trim()
					? body.model.trim()
					: undefined,
			schedule: schedule ?? null,
			enabled,
			timezone:
				typeof body.timezone === "string" && body.timezone.trim()
					? body.timezone.trim()
					: DEFAULT_TIMEZONE,
			triggerJson: "triggerJson" in body ? body.triggerJson : undefined,
		};
	}

	// event / generic webhook
	return {
		botId,
		name: body.name.trim(),
		prompt: body.prompt,
		triggerType: "event",
		trigger: { kind: "generic" },
		allowChatgptPlan: body.allowChatgptPlan === true,
		model:
			typeof body.model === "string" && body.model.trim()
				? body.model.trim()
				: undefined,
		schedule: null,
		enabled,
		timezone:
			typeof body.timezone === "string" && body.timezone.trim()
				? body.timezone.trim()
				: DEFAULT_TIMEZONE,
	};
}

export function parseUpdateBody(json: unknown): UpdateRoutineInput | { error: string } {
	if (!json || typeof json !== "object") {
		return { error: "Invalid JSON body" };
	}
	const body = json as Record<string, unknown>;
	const patch: UpdateRoutineInput = {};
	if (body.allowChatgptPlan !== undefined) {
		if (typeof body.allowChatgptPlan !== "boolean") return { error: "allowChatgptPlan deve ser boolean" };
		patch.allowChatgptPlan = body.allowChatgptPlan;
	}
	if (typeof body.name === "string") {
		if (body.name.trim().length === 0) return { error: "Nome inválido" };
		patch.name = body.name.trim();
	}
	if (typeof body.prompt === "string") patch.prompt = body.prompt;
	if ("groupId" in body) {
		if (body.groupId === null) patch.groupId = null;
		else if (typeof body.groupId === "string" && body.groupId.trim().length > 0) patch.groupId = body.groupId.trim();
		else return { error: "groupId inválido" };
	}
	if (typeof body.model === "string") {
		if (body.model.trim().length === 0) return { error: "Modelo inválido" };
		patch.model = body.model.trim();
	}
	if (body.triggerType === "cron" || body.triggerType === "event" || body.triggerType === "once" || body.triggerType === "interval") {
		patch.triggerType = body.triggerType;
	}
	if (body.intervalTrigger && typeof body.intervalTrigger === "object") {
		const raw = body.intervalTrigger as Record<string, unknown>;
		const parsedInterval = parseIntervalEveryMinutes({ everyMinutes: raw.everyMinutes });
		if (!parsedInterval.ok) return { error: parsedInterval.error };
		patch.intervalTrigger = { everyMinutes: parsedInterval.everyMinutes };
	}
	if (body.onceTrigger && typeof body.onceTrigger === "object") {
		const raw = body.onceTrigger as Record<string, unknown>;
		const timezone = typeof body.timezone === "string" ? body.timezone : undefined;
		const parsedOnce = parseOnceRunAt({ runAt: raw.runAt, timezone }, new Date());
		if (!parsedOnce.ok) return { error: parsedOnce.error };
		patch.onceTrigger = { runAt: parsedOnce.runAtIso };
	}
	if ("schedule" in body) {
		const schedule = parseOptionalString(body.schedule);
		if (schedule && !isCronFive(schedule)) {
			return { error: "Cron inválido (esperado 5 campos)" };
		}
		patch.schedule = schedule ?? null;
	}
	if ("enabled" in body) {
		const enabled = parseEnabled(body.enabled);
		if (enabled === undefined) return { error: "enabled deve ser boolean" };
		patch.enabled = enabled;
	}
	if (typeof body.timezone === "string") {
		patch.timezone = body.timezone.trim() || DEFAULT_TIMEZONE;
	}
	if ("triggerJson" in body) patch.triggerJson = body.triggerJson;
	if (body.githubTrigger && typeof body.githubTrigger === "object") {
		const raw = body.githubTrigger as Record<string, unknown>;
		const githubPatch: NonNullable<UpdateRoutineInput["githubTrigger"]> = {};
		if (raw.repo !== undefined) {
			const repo = normalizeGithubRepo(raw.repo);
			if (!repo) return { error: "Repositório inválido (esperado owner/repo)" };
			githubPatch.repo = repo;
		}
		if (raw.events !== undefined) {
			const events = normalizeGithubEvents(raw.events);
			if (!events) return { error: "Selecione ao menos um evento do GitHub" };
			githubPatch.events = events;
		}
		if (raw.prNumber !== undefined) {
			if (raw.prNumber === null) {
				githubPatch.prNumber = null;
			} else {
				const num =
					typeof raw.prNumber === "number" ? raw.prNumber : Number.parseInt(String(raw.prNumber), 10);
				if (!Number.isFinite(num) || num <= 0) return { error: "Número do PR inválido" };
				githubPatch.prNumber = Math.trunc(num);
			}
		}
		if (raw.users !== undefined) {
			githubPatch.users = raw.users === null ? null : (normalizeGithubUsers(raw.users) ?? null);
		}
		// `branch` (atual) tem precedência sobre `ciBranch` (alias legado v3).
		const branchRaw = raw.branch !== undefined ? raw.branch : raw.ciBranch;
		if (branchRaw !== undefined) {
			githubPatch.branch = typeof branchRaw === "string" && branchRaw.trim() ? branchRaw.trim() : null;
		}
		patch.githubTrigger = githubPatch;
	}
	return patch;
}

function hookResponse(
	routine: Awaited<ReturnType<typeof getRoutine>>,
	secret?: string,
) {
	if (!routine?.hook) return undefined;
	return {
		hookKey: routine.hook.hookKey,
		url: routine.hook.url || hookPublicUrl(routine.hook.hookKey),
		...(secret ? { secret } : {}),
	};
}

/** Config do gatilho GitHub (sem secret — o segredo é um só, por env, nunca por rotina). */
function githubResponse(routine: Awaited<ReturnType<typeof getRoutine>>) {
	return routine?.github;
}

/**
 * Garante que o webhook único do repo reflita as rotinas GitHub deste
 * usuário — chamado depois de create/update/enable/disable/delete. Nunca
 * lança; devolve a mensagem PT quando falhar (o caller decide se é fatal).
 */
async function syncGithubRepoHook(
	userId: string,
	repo: string,
): Promise<string | undefined> {
	const result = await ensureGithubRepoHook({ userId, repo });
	return "error" in result ? result.error : undefined;
}

export function createRoutineRoutes(routineQueue: RoutineQueue | null) {
	const app = new Hono<AuthEnv>();

	app.get("/v1/bots/:botId/routines", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const botId = parseId(c.req.param("botId"));
		if (!botId) return c.json({ error: "Missing bot id" }, 400);
		try {
			const routines = await listRoutines(userId, botId);
			return c.json({ routines });
		} catch (error) {
			console.error("list routines failed", error);
			return c.json({ error: "Failed to list routines" }, 503);
		}
	});

	app.get("/v1/bots/:botId/routine-groups", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const botId = parseId(c.req.param("botId"));
		if (!botId) return c.json({ error: "Missing bot id" }, 400);
		try {
			const groups = await listRoutineGroups(userId, botId);
			return c.json({ groups });
		} catch (error) {
			console.error("list routine groups failed", error);
			return c.json({ error: "Failed to list routine groups" }, 503);
		}
	});

	app.post("/v1/bots/:botId/routine-groups", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const botId = parseId(c.req.param("botId"));
		if (!botId) return c.json({ error: "Missing bot id" }, 400);
		let json: unknown;
		try {
			json = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}
		const body = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
		if (typeof body.name !== "string" || body.name.trim().length === 0) {
			return c.json({ error: "Nome obrigatório" }, 400);
		}
		if (body.description !== undefined && typeof body.description !== "string") {
			return c.json({ error: "description deve ser texto" }, 400);
		}
		try {
			const group = await createRoutineGroup(userId, botId, {
				name: body.name,
				description: typeof body.description === "string" ? body.description : undefined,
			});
			return c.json({ group }, 201);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Failed to create group";
			if (message === "Bot não encontrado") return c.json({ error: "Not found" }, 404);
			if (message === "Já existe um grupo com esse nome") return c.json({ error: message }, 409);
			console.error("create routine group failed", error);
			return c.json({ error: message }, 400);
		}
	});

	app.patch("/v1/bots/:botId/routine-groups/:groupId", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const botId = parseId(c.req.param("botId"));
		const groupId = parseId(c.req.param("groupId"));
		if (!botId || !groupId) return c.json({ error: "Missing bot id or group id" }, 400);
		let json: unknown;
		try {
			json = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}
		const body = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
		const patch: { name?: string; description?: string } = {};
		if (body.name !== undefined) {
			if (typeof body.name !== "string" || body.name.trim().length === 0) {
				return c.json({ error: "Nome inválido" }, 400);
			}
			patch.name = body.name;
		}
		if (body.description !== undefined) {
			if (typeof body.description !== "string") return c.json({ error: "description deve ser texto" }, 400);
			patch.description = body.description;
		}
		try {
			const group = await updateRoutineGroup(userId, botId, groupId, patch);
			if (!group) return c.json({ error: "Group not found" }, 404);
			return c.json({ group });
		} catch (error) {
			const message = error instanceof Error ? error.message : "Failed to update group";
			if (message === "Já existe um grupo com esse nome") return c.json({ error: message }, 409);
			console.error("update routine group failed", error);
			return c.json({ error: message }, 400);
		}
	});

	// Ativa/pausa todas as rotinas do grupo.
	app.post("/v1/bots/:botId/routine-groups/:groupId/enabled", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const botId = parseId(c.req.param("botId"));
		const groupId = parseId(c.req.param("groupId"));
		if (!botId || !groupId) return c.json({ error: "Missing bot id or group id" }, 400);
		let json: unknown;
		try {
			json = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}
		const enabled = parseEnabled((json as Record<string, unknown> | null)?.enabled);
		if (enabled === undefined) return c.json({ error: "enabled deve ser boolean" }, 400);
		try {
			const routines = await setRoutineGroupEnabled(userId, botId, groupId, enabled);
			if (!routines) return c.json({ error: "Group not found" }, 404);
			if (routineQueue) {
				for (const routine of routines) {
					await syncRoutineScheduler(routineQueue, routine).catch(() => undefined);
				}
			}
			const repos = new Set(routines.flatMap((routine) => (routine.github ? [routine.github.repo] : [])));
			for (const repo of repos) await syncGithubRepoHook(userId, repo).catch(() => undefined);
			return c.json({ routines });
		} catch (error) {
			console.error("set routine group enabled failed", error);
			return c.json({ error: "Failed to update group routines" }, 400);
		}
	});

	app.delete("/v1/bots/:botId/routine-groups/:groupId", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const botId = parseId(c.req.param("botId"));
		const groupId = parseId(c.req.param("groupId"));
		if (!botId || !groupId) return c.json({ error: "Missing bot id or group id" }, 400);
		let deleteRoutines = c.req.query("deleteRoutines") === "true";
		if (!deleteRoutines) {
			const body = await c.req.json().catch(() => null);
			deleteRoutines = (body as Record<string, unknown> | null)?.deleteRoutines === true;
		}
		try {
			const result = await deleteRoutineGroup(userId, botId, groupId, { deleteRoutines });
			if (!result) return c.json({ error: "Group not found" }, 404);
			if (result.deletedRoutines) {
				if (routineQueue) {
					for (const routine of result.routines) {
						await removeRoutineScheduler(routineQueue, routine.id).catch(() => undefined);
					}
				}
				const repos = new Set(result.routines.flatMap((routine) => (routine.github ? [routine.github.repo] : [])));
				for (const repo of repos) await syncGithubRepoHook(userId, repo).catch(() => undefined);
			}
			return c.json({ ok: true, deletedRoutines: result.deletedRoutines ? result.routines.length : 0 });
		} catch (error) {
			console.error("delete routine group failed", error);
			return c.json({ error: "Failed to delete group" }, 400);
		}
	});

	app.get("/v1/bots/:botId/routine-runs", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const botId = parseId(c.req.param("botId"));
		if (!botId) return c.json({ error: "Missing bot id" }, 400);
		try {
			const runs = await listRecentRoutineRunsForBot(userId, botId, 10);
			return c.json({ runs });
		} catch (error) {
			console.error("list bot routine runs failed", error);
			return c.json({ error: "Failed to list routine runs" }, 503);
		}
	});

	app.post("/v1/bots/:botId/routines", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const botId = parseId(c.req.param("botId"));
		if (!botId) return c.json({ error: "Missing bot id" }, 400);
		let json: unknown;
		try {
			json = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}
		const parsed = parseCreateBody(botId, json);
		if ("error" in parsed) return c.json({ error: parsed.error }, 400);

		try {
			const { routine, hookSecret } = await createRoutine(userId, parsed);
			if (routineQueue) {
				// syncRoutineScheduler só cron; event remove scheduler se houver.
				await syncRoutineScheduler(routineQueue, routine);
			}
			if (routine.github) {
				const error = await syncGithubRepoHook(userId, routine.github.repo);
				if (error) {
					// A rotina não pode existir sem um webhook funcionando.
					await deleteRoutine(userId, botId, routine.id);
					if (routineQueue) await removeRoutineScheduler(routineQueue, routine.id);
					return c.json({ error }, 409);
				}
			}
			return c.json(
				{
					routine,
					hook: hookResponse(routine, hookSecret),
					github: githubResponse(routine),
				},
				201,
			);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Failed to create routine";
			if (message === "Bot não encontrado") return c.json({ error: "Not found" }, 404);
			if (message === "Grupo não encontrado") return c.json({ error: "Group not found" }, 404);
			console.error("create routine failed", error);
			return c.json({ error: message }, 400);
		}
	});

	app.get("/v1/bots/:botId/routines/:routineId", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const botId = parseId(c.req.param("botId"));
		const routineId = parseId(c.req.param("routineId"));
		if (!botId || !routineId) {
			return c.json({ error: "Missing bot id or routine id" }, 400);
		}
		const routine = await getRoutine(userId, botId, routineId);
		if (!routine) return c.json({ error: "Routine not found" }, 404);
		const runs = await listRoutineRuns(routine.id, 20);
		return c.json({ routine, runs, hook: hookResponse(routine) });
	});

	app.patch("/v1/bots/:botId/routines/:routineId", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const botId = parseId(c.req.param("botId"));
		const routineId = parseId(c.req.param("routineId"));
		if (!botId || !routineId) {
			return c.json({ error: "Missing bot id or routine id" }, 400);
		}
		let json: unknown;
		try {
			json = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}
		const parsed = parseUpdateBody(json);
		if ("error" in parsed) return c.json({ error: parsed.error }, 400);
		const current = await getRoutine(userId, botId, routineId);
		if (!current) return c.json({ error: "Routine not found" }, 404);
		const nextType = parsed.triggerType ?? current.triggerType;
		const nextEnabled = parsed.enabled ?? current.enabled;
		const nextSchedule =
			parsed.schedule !== undefined ? parsed.schedule : current.schedule;
		if (nextType === "cron" && nextEnabled && !nextSchedule) {
			return c.json(
				{ error: "Rotina ativa precisa de um agendamento cron" },
				400,
			);
		}

		let nextGithubRepo: string | undefined;
		if (current.github && parsed.githubTrigger) {
			const repo = parsed.githubTrigger.repo ?? current.github.repo;
			const events = parsed.githubTrigger.events ?? current.github.events;
			const prNumber =
				parsed.githubTrigger.prNumber !== undefined
					? (parsed.githubTrigger.prNumber ?? undefined)
					: current.github.prNumber;
			const users =
				parsed.githubTrigger.users !== undefined
					? (parsed.githubTrigger.users ?? undefined)
					: current.github.users;
			const branch =
				parsed.githubTrigger.branch !== undefined
					? (parsed.githubTrigger.branch ?? undefined)
					: current.github.branch;
			// Revalida o estado FINAL (merge) com o mesmo schema Zod do create.
			const revalidated = parseGithubTriggerInput({ repo, events, prNumber, users, branch });
			if ("error" in revalidated) {
				return c.json({ error: revalidated.error }, 400);
			}
			nextGithubRepo = revalidated.value.repo;
		}

		try {
			const routine = await updateRoutine(userId, botId, routineId, parsed);
			if (!routine) return c.json({ error: "Routine not found" }, 404);
			if (routineQueue) {
				await syncRoutineScheduler(routineQueue, routine);
			}
			if (routine.github) {
				const error = await syncGithubRepoHook(userId, routine.github.repo);
				if (error) {
					// Update já persistiu; reverter é difícil (e o gatilho anterior já
					// mudou) — devolve 409 com a mensagem e deixa a rotina como está,
					// o usuário decide se corrige a config ou reconecta o GitHub.
					return c.json({ error, routine }, 409);
				}
				// Repo mudou: a rotina não assina mais o repo antigo — encolhe o hook
				// de lá também (best-effort).
				if (
					nextGithubRepo &&
					current.github &&
					current.github.repo.toLowerCase() !== nextGithubRepo.toLowerCase()
				) {
					await syncGithubRepoHook(userId, current.github.repo).catch(() => undefined);
				}
			}
			return c.json({
				routine,
				hook: hookResponse(routine),
				github: githubResponse(routine),
			});
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Failed to update routine";
			if (message === "Grupo não encontrado") return c.json({ error: "Group not found" }, 404);
			console.error("update routine failed", error);
			return c.json({ error: message }, 400);
		}
	});

	app.post("/v1/bots/:botId/routines/:routineId/rotate-secret", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const botId = parseId(c.req.param("botId"));
		const routineId = parseId(c.req.param("routineId"));
		if (!botId || !routineId) {
			return c.json({ error: "Missing bot id or routine id" }, 400);
		}
		try {
			const current = await getRoutine(userId, botId, routineId);
			if (!current) return c.json({ error: "Routine not found" }, 404);

			if (current.github) {
				// Gatilho GitHub não tem secret por-rotina pra rotacionar (é um só,
				// derivado de CONNECTOR_ENCRYPTION_KEY, fora do banco).
				return c.json(
					{
						error:
							"Gatilho GitHub não tem secret próprio pra rotacionar — o segredo é derivado de CONNECTOR_ENCRYPTION_KEY (compartilhado).",
					},
					400,
				);
			}

			const result = await rotateRoutineHookSecret(userId, botId, routineId);
			if (!result) return c.json({ error: "Routine not found" }, 404);
			return c.json({
				routine: result.routine,
				hook: hookResponse(result.routine, result.hookSecret),
			});
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Failed to rotate secret";
			return c.json({ error: message }, 400);
		}
	});

	app.delete("/v1/bots/:botId/routines/:routineId", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const botId = parseId(c.req.param("botId"));
		const routineId = parseId(c.req.param("routineId"));
		if (!botId || !routineId) {
			return c.json({ error: "Missing bot id or routine id" }, 400);
		}
		const trigger = await getRoutineGithubTrigger(userId, botId, routineId);
		const deleted = await deleteRoutine(userId, botId, routineId);
		if (!deleted) return c.json({ error: "Routine not found" }, 404);
		if (routineQueue && routineId) {
			await removeRoutineScheduler(routineQueue, routineId);
		}
		if (trigger) {
			// Best-effort: encolhe/apaga o hook do repo agora que a rotina sumiu.
			await syncGithubRepoHook(userId, trigger.repo).catch(() => undefined);
		}
		return c.json({ ok: true });
	});

	app.post("/v1/bots/:botId/routines/:routineId/run", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const botId = parseId(c.req.param("botId"));
		const routineId = parseId(c.req.param("routineId"));
		if (!botId || !routineId) {
			return c.json({ error: "Missing bot id or routine id" }, 400);
		}
		const routine = await getRoutine(userId, botId, routineId);
		if (!routine) return c.json({ error: "Routine not found" }, 404);
		if (!routineQueue) {
			return c.json({ error: "Fila de rotinas indisponível" }, 503);
		}
		const enqueued = await enqueueRoutineNow(routineQueue, routine.id);
		if (!enqueued) {
			return c.json({ error: "Não foi possível enfileirar a rotina" }, 503);
		}
		return c.json({ ok: true, enqueued: true }, 202);
	});

	app.get("/v1/bots/:botId/routines/:routineId/runs", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const botId = parseId(c.req.param("botId"));
		const routineId = parseId(c.req.param("routineId"));
		if (!botId || !routineId) {
			return c.json({ error: "Missing bot id or routine id" }, 400);
		}
		const routine = await getRoutine(userId, botId, routineId);
		if (!routine) return c.json({ error: "Routine not found" }, 404);
		const runs = await listRoutineRuns(routine.id, 20);
		return c.json({ runs });
	});

	return app;
}
