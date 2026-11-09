// Rotinas do v4 no worker (F9, partes 1 e 2): a porta `Routines` sobre `@workspace/db` (a tabela `routines` e os grupos, as mesmas
// que a Biblioteca mostra). NÃO importa o agent-runtime: o gatilho em frase vem de `@workspace/shared`
// (`describeRoutineTrigger`), a lógica de dados, do db.
//
// Escopo: o `userId` é o do RUN (nunca do modelo) e o bot já está fixo no adaptador. Toda leitura e escrita do db filtra por
// dono e bot; rotina ou grupo de outro dono volta como "não existe" (`null`). Escrita sincroniza o agendador (`onMutated`:
// pausar/apagar tira o cron, retomar volta) e mostra o cartão da rotina no chat (o mesmo evento `routine` do legado).
// Parte 2: criar e editar (gatilho já validado pela tool; aqui só se grava, sincroniza o agendador e o webhook do GitHub e mostra o
// cartão com a mesma identidade `routineId`), webhooks (só o endereço: o segredo do webhook nunca sai do db), sugestão proativa (cartão
// de proposta; só o bot principal com o modo proativo ligado), o veredito do alerta e o push da rotina "só importante".
import type { AlertRunPort, RoutinePush, RoutineCreateSpec, RoutineGroupView, RoutineSaved, RoutineSuggestOutcome, RoutineSuggestSpec, RoutineTriggerSpec, RoutineUpdateSpec, RoutineView, RoutineWebhookView, Routines } from "@workspace/agent";
import { randomBytes } from "node:crypto";
import {
	appendRoutineProposalCard,
	convertRoutineToGenericWebhook,
	createRoutineFromProposal,
	createRoutine,
	createRoutineGroup,
	deleteRoutine,
	deleteRoutineGroup,
	findOrCreateRoutineGroup,
	findRecentProposalByName,
	getBotConversationId,
	getBotPolicy,
	hookPublicUrl,
	listBots,
	listRoutineGroups,
	listUserRoutineWebhooks,
	listRoutines,
	persistConversationCardFromEvent,
	recordProactiveEvent,
	setRoutineGroupEnabled,
	updateRoutine,
	updateRoutineGroup,
} from "@workspace/db";
import { findDuplicateRoutine, isInQuietHours, parseRoutineProposalSpec, readProactiveSettings, type AlertVerdict, type PersistedRoutineProposalCard, type ProactiveSettings, describeRoutineAlertSentence, describeRoutineTrigger, parseGithubWebhookTrigger, routineNextRunAt, type ComputerUseEvent, type RoutineGroupRecord, type GithubTriggerEvent, type RoutineRecord, type UpdateRoutineInput } from "@workspace/shared";

/** Funções do db e do relógio; injetáveis para o teste (sem banco). */
export type V4RoutinesDeps = {
	list: typeof listRoutines;
	update: typeof updateRoutine;
	remove: typeof deleteRoutine;
	listGroups: typeof listRoutineGroups;
	createGroup: typeof createRoutineGroup;
	updateGroup: typeof updateRoutineGroup;
	deleteGroup: typeof deleteRoutineGroup;
	setGroupEnabled: typeof setRoutineGroupEnabled;
	/** F9 parte 2: criar, mesmo grupo por nome, virar webhook e a URL pública (sem segredo). */
	create: typeof createRoutine;
	findOrCreateGroup: typeof findOrCreateRoutineGroup;
	convertToWebhook: typeof convertRoutineToGenericWebhook;
	hookUrl: (hookKey: string) => string;
	listWebhooks: typeof listUserRoutineWebhooks;
	/** Sugestão proativa (F9 parte 2): bot principal, política do bot, conversa, propostas e eventos do modo proativo. */
	listBots: typeof listBots;
	getBotPolicy: typeof getBotPolicy;
	getBotConversationId: typeof getBotConversationId;
	findRecentProposalByName: typeof findRecentProposalByName;
	createFromProposal: typeof createRoutineFromProposal;
	appendProposalCard: typeof appendRoutineProposalCard;
	recordEvent: typeof recordProactiveEvent;
	randomId: () => string;
	persistCard: (conversationId: string, event: ComputerUseEvent) => Promise<void>;
	now: () => Date;
};

export const realV4RoutinesDeps: V4RoutinesDeps = {
	list: listRoutines,
	update: updateRoutine,
	remove: deleteRoutine,
	listGroups: listRoutineGroups,
	createGroup: createRoutineGroup,
	updateGroup: updateRoutineGroup,
	deleteGroup: deleteRoutineGroup,
	setGroupEnabled: setRoutineGroupEnabled,
	create: createRoutine,
	findOrCreateGroup: findOrCreateRoutineGroup,
	convertToWebhook: convertRoutineToGenericWebhook,
	hookUrl: hookPublicUrl,
	listWebhooks: listUserRoutineWebhooks,
	listBots,
	getBotPolicy,
	getBotConversationId,
	findRecentProposalByName,
	createFromProposal: createRoutineFromProposal,
	appendProposalCard: appendRoutineProposalCard,
	recordEvent: recordProactiveEvent,
	randomId: () => randomBytes(4).toString("hex"),
	persistCard: (conversationId, event) => persistConversationCardFromEvent(conversationId, event),
	now: () => new Date(),
};

export type V4RoutinesScope = {
	/** O bot do run: as rotinas e os grupos são dele. */
	botId: string;
	conversationId?: string | null;
	/** Evento ao vivo (o cartão na tela agora). */
	emit: (event: ComputerUseEvent) => void | Promise<void>;
	/** Sincroniza o agendador depois de mudar uma rotina (o mesmo gancho do legado: `syncRoutineScheduler`). Ausente = não sincroniza. */
	onMutated?: (routine: RoutineRecord) => Promise<unknown>;
	/**
	 * Reconcilia o webhook do repositório no GitHub com as rotinas que sobraram (o `ensureGithubRepoHook` do legado: cria, atualiza
	 * a união de eventos ou apaga o hook). Sem ele pausar/retomar/apagar uma rotina de GitHub muda o banco, mas o hook no GitHub fica
	 * como estava. Quem monta o run injeta o real (o adaptador não importa o agent-runtime).
	 */
	ensureGithubHook?: (userId: string, repo: string) => Promise<unknown>;
	log?: (message: string) => void;
};

const TASK_MAX = 280;

function oneLine(text: string): string {
	return text.split(/\s+/).filter(Boolean).join(" ");
}

export function toRoutineView(row: RoutineRecord, now: Date): RoutineView {
	const task = oneLine(row.prompt ?? "");
	const alert = describeRoutineAlertSentence(row);
	const next = routineNextRunAt(row, now);
	return {
		id: row.id,
		name: row.name,
		trigger: describeRoutineTrigger(row),
		kind: row.triggerType,
		enabled: row.enabled,
		...(row.group?.name && { group: row.group.name }),
		...(alert && { alert }),
		task: task.length > TASK_MAX ? `${task.slice(0, TASK_MAX - 1)}…` : task,
		...(next && { nextRunAt: next }),
		...(row.lastRunAt && { lastRunAt: row.lastRunAt }),
		...(row.lastRun?.status && { lastStatus: row.lastRun.status }),
		...(row.pageId && { panelId: row.pageId }),
		...(row.loginPermission && { loginAccess: { login: row.loginPermission.login, site: row.loginPermission.site } }),
	};
}

const toGroupView = (g: RoutineGroupRecord): RoutineGroupView => ({ id: g.id, name: g.name, routineCount: g.routineCount, enabledCount: g.enabledCount });

export function createV4Routines(input: { scope: V4RoutinesScope; deps?: V4RoutinesDeps }): Routines {
	const deps = input.deps ?? realV4RoutinesDeps;
	const { scope } = input;
	const log = scope.log ?? console.warn;

	const rows = (userId: string) => deps.list(userId, scope.botId);
	const own = async (userId: string, routineId: string) => (await rows(userId)).find((row) => row.id === routineId) ?? null;

	/** Cartão da rotina no chat: o mesmo evento `routine` do legado. `persist` grava na conversa (pausar/retomar/apagar, como no legado). */
	async function showCard(routine: RoutineRecord, line: string, opts: { persist: boolean; gone?: boolean; created?: boolean; hookUrl?: string }) {
		const sentence = describeRoutineAlertSentence(routine);
		const event: ComputerUseEvent = {
			type: "routine",
			action: opts.created ? "created" : "updated",
			...(!opts.gone && { routineId: routine.id }),
			title: routine.name,
			triggerType: routine.triggerType,
			detail: [line, sentence, ...(opts.gone ? [routine.name] : [])].filter(Boolean).join("\n"),
			// Só o endereço; o segredo do webhook nunca vai a um evento (nem ao vivo, nem gravado na conversa).
			...(opts.hookUrl && { hookUrl: opts.hookUrl }),
		};
		if (opts.persist && scope.conversationId) {
			await deps.persistCard(scope.conversationId, event).catch(() => log("[engine-v4] não consegui gravar o cartão da rotina na conversa"));
		}
		await scope.emit(event);
	}

	async function sync(routine: RoutineRecord) {
		// O agendador é melhor esforço (como no legado): a rotina já mudou no banco, e o worker reconcilia no boot.
		try {
			await scope.onMutated?.(routine);
		} catch {
			log("[engine-v4] não consegui sincronizar o agendador da rotina");
		}
	}

	/** Melhor esforço e uma chamada por repositório, mesmo que várias rotinas do grupo apontem para o mesmo. Só rotina com gatilho de GitHub. */
	async function syncHooks(userId: string, routines: readonly RoutineRecord[]) {
		if (!scope.ensureGithubHook) return;
		const repos = new Set<string>();
		for (const routine of routines) {
			// O db não expõe o `triggerJson` de rotina de evento (traz segredo/estado): o repositório vem da visão `github`. O `triggerJson` fica de reserva.
			const repo = routine.github?.repo ?? parseGithubWebhookTrigger(routine.triggerJson)?.repo;
			if (repo) repos.add(repo);
		}
		for (const repo of repos) {
			try {
				await scope.ensureGithubHook(userId, repo);
			} catch {
				log("[engine-v4] não consegui sincronizar o webhook do GitHub da rotina");
			}
		}
	}


	/** Erro de terceiros/db para o modelo: a mensagem real, com a dica do que o dono pode fazer quando é a caixa de e-mail. */
	function saveError(error: unknown): Error {
		const message = error instanceof Error ? error.message : "The routine could not be saved.";
		return new Error(message.includes("aba E-mail") ? `${message}. Ask the owner to turn on the bot's e-mail in the E-mail tab, then try again.` : message);
	}

	/** Falha do gancho do GitHub: o real devolve `{ error }` (não lança). */
	function hookError(result: unknown): string | null {
		if (result && typeof result === "object" && "error" in result && typeof (result as { error: unknown }).error === "string") return (result as { error: string }).error;
		return null;
	}

	/** Cria ou atualiza o webhook do repositório. Lança com o motivo real: quem chama decide desfazer. */
	async function ensureHook(userId: string, repo: string): Promise<void> {
		if (!scope.ensureGithubHook) throw new Error("GitHub triggers are not available in this run.");
		let result: unknown;
		try {
			result = await scope.ensureGithubHook(userId, repo);
		} catch (error) {
			throw new Error(error instanceof Error ? error.message : "The GitHub webhook could not be set up.");
		}
		const failed = hookError(result);
		if (failed) throw new Error(failed);
	}

	/** Gatilho do spec no formato do db (criação). */
	function createTriggerFields(trigger: RoutineTriggerSpec): Partial<Parameters<typeof createRoutine>[1]> {
		switch (trigger.kind) {
			case "cron":
				return { triggerType: "cron", schedule: trigger.schedule };
			case "once":
				return { triggerType: "once", trigger: { kind: "once", runAt: trigger.runAt } };
			case "interval":
				return { triggerType: "interval", trigger: { kind: "interval", everyMinutes: trigger.everyMinutes } };
			case "email":
				return { triggerType: "event", trigger: { kind: "email", ...(trigger.fromContains && { fromContains: trigger.fromContains }), ...(trigger.subjectContains && { subjectContains: trigger.subjectContains }) } };
			case "github":
				return { triggerType: "event", trigger: { kind: "github", repo: trigger.repo, events: trigger.events as GithubTriggerEvent[], ...(trigger.prNumber !== undefined && { prNumber: trigger.prNumber }), ...(trigger.users && { users: trigger.users }), ...(trigger.branch && { branch: trigger.branch }) } };
			case "webhook":
				return { triggerType: "event", trigger: { kind: "generic" } };
		}
	}

	/** Gatilho do spec no formato do db (edição). Webhook que já é webhook não muda (o segredo atual continua valendo). */
	function updateTriggerFields(trigger: RoutineTriggerSpec): UpdateRoutineInput {
		switch (trigger.kind) {
			case "cron":
				return { triggerType: "cron", schedule: trigger.schedule };
			case "once":
				return { triggerType: "once", onceTrigger: { runAt: trigger.runAt } };
			case "interval":
				return { triggerType: "interval", intervalTrigger: { everyMinutes: trigger.everyMinutes } };
			case "email":
				return { triggerType: "event", emailTrigger: { fromContains: trigger.fromContains ?? null, subjectContains: trigger.subjectContains ?? null } };
			case "github":
				return { triggerType: "event", githubTrigger: { repo: trigger.repo, events: trigger.events as GithubTriggerEvent[], prNumber: trigger.prNumber ?? null, users: trigger.users ?? null, branch: trigger.branch ?? null } };
			case "webhook":
				return {};
		}
	}

	/** Volta ao gatilho de antes quando o webhook do GitHub não pôde ser ligado (o legado também revertia). Webhook genérico antigo não tem volta (o segredo não é recuperável). */
	function restoreFields(previous: RoutineRecord): UpdateRoutineInput | null {
		if (previous.github) return { triggerType: "event", githubTrigger: { repo: previous.github.repo, events: previous.github.events, prNumber: previous.github.prNumber ?? null, users: previous.github.users ?? null, branch: previous.github.branch ?? null } };
		if (previous.once) return { triggerType: "once", onceTrigger: { runAt: previous.once.runAt } };
		if (previous.interval) return { triggerType: "interval", intervalTrigger: { everyMinutes: previous.interval.everyMinutes } };
		if (previous.email) return { triggerType: "event", emailTrigger: { fromContains: previous.email.fromContains ?? null, subjectContains: previous.email.subjectContains ?? null } };
		if (previous.triggerType === "cron") return { triggerType: "cron", schedule: previous.schedule };
		return null;
	}

	const hookUrlOf = (routine: RoutineRecord): string | undefined => (routine.hook?.hookKey ? (routine.hook.url ?? deps.hookUrl(routine.hook.hookKey)) : undefined);

	return {
		async list(userId) {
			const now = deps.now();
			return (await rows(userId)).map((row) => toRoutineView(row, now));
		},
		async groups(userId) {
			return (await deps.listGroups(userId, scope.botId)).map(toGroupView);
		},
		async setEnabled(userId, routineId, enabled) {
			if (!(await own(userId, routineId))) return null;
			const updated = await deps.update(userId, scope.botId, routineId, { enabled });
			if (!updated) return null;
			await sync(updated);
			await syncHooks(userId, [updated]);
			await showCard(updated, enabled ? "Retomada" : "Pausada", { persist: true });
			return toRoutineView(updated, deps.now());
		},
		async remove(userId, routineId) {
			const existing = await own(userId, routineId);
			if (!existing) return null;
			if (!(await deps.remove(userId, scope.botId, routineId))) throw new Error("The routine could not be deleted right now.");
			await sync({ ...existing, enabled: false });
			await syncHooks(userId, [existing]);
			await showCard(existing, "Apagada", { persist: true, gone: true });
			return toRoutineView(existing, deps.now());
		},
		async createGroup(userId, name) {
			return toGroupView(await deps.createGroup(userId, scope.botId, { name }));
		},
		async renameGroup(userId, groupId, name) {
			const groups = await deps.listGroups(userId, scope.botId);
			if (!groups.some((g) => g.id === groupId)) return null;
			const renamed = await deps.updateGroup(userId, scope.botId, groupId, { name });
			return renamed ? toGroupView(renamed) : null;
		},
		async deleteGroup(userId, groupId) {
			const group = (await deps.listGroups(userId, scope.botId)).find((g) => g.id === groupId);
			if (!group) return null;
			const result = await deps.deleteGroup(userId, scope.botId, groupId);
			if (!result) return null;
			const first = result.routines[0];
			if (first) await showCard({ ...first, groupId: null, group: null }, "Grupo desfeito", { persist: false });
			return { name: group.name, routines: result.routines.length };
		},
		async setGroupEnabled(userId, groupId, enabled) {
			const group = (await deps.listGroups(userId, scope.botId)).find((g) => g.id === groupId);
			if (!group) return null;
			const before = (await rows(userId)).filter((row) => row.groupId === groupId);
			const updated = await deps.setGroupEnabled(userId, scope.botId, groupId, enabled);
			if (!updated) return null;
			for (const routine of updated) await sync(routine);
			await syncHooks(userId, updated);
			const changed = updated.filter((routine) => routine.enabled === enabled && before.find((b) => b.id === routine.id)?.enabled !== enabled).length;
			const first = updated[0];
			if (first) await showCard(first, enabled ? "Grupo retomado" : "Grupo pausado", { persist: false });
			return { name: group.name, total: updated.length, changed };
		},
		async moveToGroup(userId, routineId, groupId) {
			if (!(await own(userId, routineId))) return null;
			if (groupId !== null && !(await deps.listGroups(userId, scope.botId)).some((g) => g.id === groupId)) return null;
			const updated = await deps.update(userId, scope.botId, routineId, { groupId });
			if (!updated) return null;
			await showCard(updated, groupId === null ? "Fora do grupo" : `Movida para o grupo ${updated.group?.name ?? ""}`.trim(), { persist: false });
			return toRoutineView(updated, deps.now());
		},

		async create(userId, spec: RoutineCreateSpec): Promise<RoutineSaved> {
			if (spec.trigger.kind === "github" && !scope.ensureGithubHook) throw new Error("GitHub triggers are not available in this run, so nothing was created. Tell the owner plainly.");
			const groupId = spec.group ? (await deps.findOrCreateGroup(userId, scope.botId, spec.group)).group.id : undefined;
			let created: Awaited<ReturnType<typeof createRoutine>>;
			try {
				created = await deps.create(userId, {
					botId: scope.botId,
					name: spec.name,
					prompt: spec.task,
					enabled: spec.enabled,
					timezone: spec.timezone,
					...(groupId && { groupId }),
					...(spec.panelId && { pageId: spec.panelId }),
					...(spec.notify && { notify: spec.notify }),
					...(spec.alert && { alert: spec.alert }),
					...(spec.loginAccess && { loginPermission: spec.loginAccess }),
					...createTriggerFields(spec.trigger),
				});
			} catch (error) {
				throw saveError(error);
			}
			const { routine } = created;
			await sync(routine);
			if (spec.trigger.kind === "github") {
				try {
					await ensureHook(userId, spec.trigger.repo);
				} catch (error) {
					// A rotina apontaria para um webhook que não existe: desfaz (como o legado) e diz o motivo real.
					await deps.remove(userId, scope.botId, routine.id).catch(() => false);
					await sync({ ...routine, enabled: false });
					throw new Error(`The GitHub trigger could not be activated, so the routine was not created: ${error instanceof Error ? error.message : "unknown error"}. Do not create the webhook any other way: only the app's own webhook is accepted.`);
				}
			}
			const webhook = spec.trigger.kind === "webhook" ? hookUrlOf(routine) : undefined;
			await showCard(routine, describeRoutineTrigger(routine), { persist: true, created: true, ...(webhook && { hookUrl: webhook }) });
			return { routine: toRoutineView(routine, deps.now()), ...(webhook && { webhook: { url: webhook } }) };
		},
		async update(userId, routineId, spec: RoutineUpdateSpec): Promise<RoutineSaved | null> {
			const previous = await own(userId, routineId);
			if (!previous) return null;
			if (spec.trigger?.kind === "github" && !scope.ensureGithubHook) throw new Error("GitHub triggers are not available in this run, so nothing was changed. Tell the owner plainly.");
			let groupId: string | null | undefined;
			if (spec.group !== undefined) groupId = spec.group === "" ? null : (await deps.findOrCreateGroup(userId, scope.botId, spec.group)).group.id;
			// Virar webhook (ainda não era): o db troca o gatilho e gera o segredo, que fica só no db (o modelo nunca o vê).
			let current: RoutineRecord = previous;
			const alreadyWebhook = previous.triggerType === "event" && Boolean(previous.hook?.hookKey) && !previous.github && !previous.email;
			if (spec.trigger?.kind === "webhook" && !alreadyWebhook) {
				try {
					const converted = await deps.convertToWebhook(userId, scope.botId, routineId, {});
					if (!converted) return null;
					current = converted.routine;
				} catch (error) {
					throw saveError(error);
				}
			}
			const patch: UpdateRoutineInput = {
				...(spec.name !== undefined && { name: spec.name }),
				...(spec.task !== undefined && { prompt: spec.task }),
				...(spec.timezone !== undefined && { timezone: spec.timezone }),
				...(spec.notify !== undefined && { notify: spec.notify }),
				...(spec.enabled !== undefined && { enabled: spec.enabled }),
				...(groupId !== undefined && { groupId }),
				...(spec.panelId !== undefined && { pageId: spec.panelId === "" ? null : spec.panelId }),
				...(spec.alert !== undefined && { alert: spec.alert }),
				...(spec.loginAccess !== undefined && { loginPermission: spec.loginAccess }),
				...(spec.trigger ? updateTriggerFields(spec.trigger) : {}),
			};
			let updated: RoutineRecord | null = current;
			if (Object.keys(patch).length > 0) {
				try {
					updated = await deps.update(userId, scope.botId, routineId, patch);
				} catch (error) {
					throw saveError(error);
				}
			}
			if (!updated) return null;
			if (spec.trigger?.kind === "github") {
				try {
					await ensureHook(userId, spec.trigger.repo);
				} catch (error) {
					const restore = restoreFields(previous);
					const back = restore ? await deps.update(userId, scope.botId, routineId, restore).catch(() => null) : null;
					if (back) await sync(back);
					const note = back ? "The previous trigger was kept." : "The previous trigger could not be restored automatically; check the routine.";
					throw new Error(`The GitHub trigger could not be activated: ${error instanceof Error ? error.message : "unknown error"}. ${note}`);
				}
			}
			await sync(updated);
			// Saiu de GitHub, trocou de repositório ou foi pausada/retomada: o hook do repositório antigo encolhe (ou some).
			const leftRepo = previous.github && (spec.trigger ? spec.trigger.kind !== "github" || spec.trigger.repo.toLowerCase() !== previous.github.repo.toLowerCase() : spec.enabled !== undefined);
			if (previous.github && leftRepo) await syncHooks(userId, [previous]);
			const webhook = spec.trigger?.kind === "webhook" ? hookUrlOf(updated) : undefined;
			await showCard(updated, describeRoutineTrigger(updated), { persist: false, ...(webhook && { hookUrl: webhook }) });
			return { routine: toRoutineView(updated, deps.now()), ...(webhook && { webhook: { url: webhook } }) };
		},
		async webhooks(userId): Promise<RoutineWebhookView[]> {
			const hooks = (await deps.listWebhooks(userId)).filter((hook) => hook.botId === scope.botId);
			return hooks.map((hook) => ({ routineId: hook.routineId, name: hook.name, enabled: hook.enabled, url: deps.hookUrl(hook.hookKey) }));
		},

		async suggest(userId, spec: RoutineSuggestSpec, context): Promise<RoutineSuggestOutcome> {
			// Só o bot principal do dono, com o modo proativo ligado (o mesmo portão do legado, `resolveProactiveForRun`).
			const bot = (await deps.listBots(userId)).find((b) => b.id === scope.botId);
			if (!bot?.isPrimary) throw new Error("Suggestions are only available in the owner's main bot. If the owner asked for this routine, use routine_create.");
			const settings = readProactiveSettings(await deps.getBotPolicy(scope.botId, userId), null);
			if (!settings.enabled) throw new Error("Proactive mode is off for this bot, so suggestions are not available. If the owner asked for this routine, use routine_create.");
			const proposal = parseRoutineProposalSpec({
				name: spec.name.slice(0, 80),
				prompt: spec.task,
				timezone: spec.timezone ?? settings.timezone,
				...(spec.trigger.kind === "cron" ? { schedule: spec.trigger.schedule } : { everyMinutes: spec.trigger.everyMinutes }),
			});
			if (!proposal) throw new Error("The suggestion is not valid: check the name, the instruction and the schedule.");
			const existing = await rows(userId);
			const duplicate = findDuplicateRoutine(existing, { name: proposal.name, prompt: proposal.prompt, schedule: proposal.schedule ?? null });
			if (duplicate) return { status: "duplicate_routine", routine: duplicate.name };
			const conversationId = scope.conversationId ?? (await deps.getBotConversationId(scope.botId, userId));
			if (!conversationId) throw new Error("This bot has no conversation yet, so the suggestion cannot be shown.");
			const previous = await deps.findRecentProposalByName(conversationId, proposal.name);
			if (previous) return { status: "already_proposed", proposal: previous.status };
			const mode = settings.routineMode;
			let card: PersistedRoutineProposalCard = { v: 1, kind: "routine-proposal", proposalId: `proposal-${context.runId}-${deps.randomId()}`, mode, status: "pending", spec: proposal };
			if (mode === "auto") {
				const outcome = await deps.createFromProposal(userId, scope.botId, proposal);
				if ("duplicate" in outcome) return { status: "duplicate_routine", routine: outcome.duplicate.name };
				await sync(outcome.routine);
				card = { ...card, routineId: outcome.routine.id };
			}
			await deps.appendProposalCard(conversationId, card);
			await deps.recordEvent({ userId, botId: scope.botId, kind: "routine", runId: context.runId, detail: mode }).catch(() => undefined);
			return { status: mode === "auto" ? "created" : "proposed" };
		},
	};
}

/** O veredito do `report_alert` fica no objeto do run (`report.verdict`): o processador o lê depois do loop e decide o aviso, com debounce. Um por run. */
export function createAlertRunPort(report: { verdict: AlertVerdict | null }): AlertRunPort {
	return {
		record(verdict) {
			if (report.verdict) return "already_reported";
			report.verdict = verdict;
			return "recorded";
		},
	};
}

/**
 * `notify_user` do run de rotina "só importante": push avulso ao dono do run. Um por run e nunca no horário de silêncio do dono (só vale se ele
 * ligou o modo proativo, que é onde configura os horários), como o `executeUserPush` do legado. `send` é o notificador do worker, já preso ao dono do run.
 */
export function createRoutinePush(input: { send: (text: string) => Promise<void>; quiet?: ProactiveSettings; now?: () => Date; log?: (message: string) => void }): RoutinePush {
	let used = false;
	return {
		async send(text) {
			if (used) return { sent: false, reason: "one_per_run" };
			if (input.quiet && isInQuietHours((input.now ?? (() => new Date()))(), input.quiet)) {
				input.log?.("[engine-v4] notify_user não enviado: horário de silêncio");
				return { sent: false, reason: "quiet_hours" };
			}
			used = true;
			await input.send(text);
			return { sent: true };
		},
	};
}
