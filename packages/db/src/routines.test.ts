/**
 * `matchingScheduleState` é o guard central que evita o bug de
 * `triggerJson.scheduleState` (cópia da UI) ficar stale em relação à coluna
 * `schedule` depois de uma edição server-side (ex.: agente via
 * propose_routine mudando só o cron, sem mandar `triggerJson` novo). Runner
 * `node:test` porque `@workspace/db` não tem vitest como dependência (mesmo
 * padrão de `summaries.test.ts`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchingScheduleState } from "./routines.js";

const scheduleStateFor = (time: string) => ({
	frequency: "daily",
	time,
	minute: ":00",
	weekday: "segunda-feira",
	monthDay: "1",
	intervalValue: "30",
	intervalUnit: "minutos",
	expression: "",
});

describe("matchingScheduleState", () => {
	it("mantém o scheduleState quando ele gera o MESMO cron do schedule salvo", () => {
		const state = scheduleStateFor("6:00");
		const triggerJson = { scheduleState: state };
		// "6:00" diário => "0 6 * * *"
		assert.deepEqual(matchingScheduleState(triggerJson, "0 6 * * *"), state);
	});

	it("descarta o scheduleState quando ele ficou stale (agente mudou o schedule por fora)", () => {
		// scheduleState ainda aponta pro horário antigo (3:00) mas o `schedule`
		// já foi atualizado pra 6:00 via propose_routine — não pode reaparecer
		// no painel.
		const staleState = scheduleStateFor("3:00");
		const triggerJson = { scheduleState: staleState };
		assert.equal(matchingScheduleState(triggerJson, "0 6 * * *"), undefined);
	});

	it("retorna undefined sem schedule, sem triggerJson ou sem scheduleState válido", () => {
		assert.equal(matchingScheduleState({ scheduleState: scheduleStateFor("6:00") }, null), undefined);
		assert.equal(matchingScheduleState(null, "0 6 * * *"), undefined);
		assert.equal(matchingScheduleState({ kind: "generic" }, "0 6 * * *"), undefined);
		assert.equal(matchingScheduleState({ scheduleState: { time: "6:00" } }, "0 6 * * *"), undefined);
	});
});

describe("createRoutine com gatilho interval", () => {
	it("persiste triggerType=interval, schedule=null e triggerJson { kind, everyMinutes }", async () => {
		const { prisma } = await import("./client.js");
		const { createRoutine } = await import("./routines.js");
		const originalBot = prisma.bot.findFirst;
		const originalCreate = prisma.routine.create;
		const created: Array<{ data: Record<string, unknown> }> = [];
		prisma.bot.findFirst = (async () => ({
			id: "bot-1",
			conversationId: null,
			openRouterModel: "model-x",
		})) as unknown as typeof prisma.bot.findFirst;
		prisma.routine.create = (async (args: { data: Record<string, unknown> }) => {
			created.push(args);
			return {
				id: "r1",
				botId: "bot-1",
				conversationId: null,
				lastRunAt: null,
				createdAt: new Date(0),
				updatedAt: new Date(0),
				...args.data,
			};
		}) as unknown as typeof prisma.routine.create;
		try {
			const { routine } = await createRoutine("user-a", {
				botId: "bot-1",
				name: "Monitor",
				prompt: "revise",
				triggerType: "interval",
				schedule: "*/50 * * * *",
				trigger: { kind: "interval", everyMinutes: 50 },
			});
			const data = created[0]?.data;
			assert.equal(data?.triggerType, "interval");
			assert.equal(data?.schedule, null);
			assert.equal(data?.userId, "user-a");
			assert.deepEqual(data?.triggerJson, { kind: "interval", everyMinutes: 50 });
			assert.equal(routine.triggerType, "interval");
			assert.deepEqual(routine.interval, { everyMinutes: 50 });
		} finally {
			prisma.bot.findFirst = originalBot;
			prisma.routine.create = originalCreate;
		}
	});
});

describe("URL pública do hook GitHub", () => {
	const saved = { pub: process.env.ATLAS_PUBLIC_URL, url: process.env.ATLAS_URL };
	const restore = () => {
		for (const [key, value] of [["ATLAS_PUBLIC_URL", saved.pub], ["ATLAS_URL", saved.url]] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};

	it("usa ATLAS_URL quando ATLAS_PUBLIC_URL está vazia ou ausente", async () => {
		const { githubHookPublicUrl, isGithubHookUrlPublic } = await import("./routines.js");
		try {
			process.env.ATLAS_PUBLIC_URL = "";
			process.env.ATLAS_URL = "https://agent.example.com/";
			assert.equal(isGithubHookUrlPublic(), true);
			assert.equal(githubHookPublicUrl(), "https://agent.example.com/v1/hooks/github");
			process.env.ATLAS_PUBLIC_URL = "https://api.example.com";
			assert.equal(githubHookPublicUrl(), "https://api.example.com/v1/hooks/github");
			process.env.ATLAS_PUBLIC_URL = "";
			process.env.ATLAS_URL = "http://localhost:3000";
			assert.equal(isGithubHookUrlPublic(), false);
			delete process.env.ATLAS_URL;
			assert.equal(isGithubHookUrlPublic(), false);
		} finally {
			restore();
		}
	});
});

describe("gatilho de e-mail", () => {
	type Prisma = typeof import("./client.js").prisma;
	const fakeRoutineRow = (data: Record<string, unknown>) => ({
		id: "r1",
		botId: "bot-1",
		conversationId: null,
		lastRunAt: null,
		createdAt: new Date(0),
		updatedAt: new Date(0),
		...data,
	});

	async function withFakes<T>(
		fakes: { mailbox: unknown; rows?: Array<Record<string, unknown>> },
		run: (prisma: Prisma, created: Array<{ data: Record<string, unknown> }>, finds: Array<{ where: Record<string, unknown> }>) => Promise<T>,
	): Promise<T> {
		const { prisma } = await import("./client.js");
		const saved = {
			bot: prisma.bot.findFirst,
			create: prisma.routine.create,
			mailbox: prisma.botMailbox.findFirst,
			many: prisma.routine.findMany,
		};
		const created: Array<{ data: Record<string, unknown> }> = [];
		const finds: Array<{ where: Record<string, unknown> }> = [];
		prisma.bot.findFirst = (async () => ({ id: "bot-1", conversationId: null, openRouterModel: "m" })) as unknown as typeof prisma.bot.findFirst;
		prisma.botMailbox.findFirst = (async () => fakes.mailbox) as unknown as typeof prisma.botMailbox.findFirst;
		prisma.routine.create = (async (args: { data: Record<string, unknown> }) => {
			created.push(args);
			return fakeRoutineRow(args.data);
		}) as unknown as typeof prisma.routine.create;
		prisma.routine.findMany = (async (args: { where: Record<string, unknown> }) => {
			finds.push(args);
			return fakes.rows ?? [];
		}) as unknown as typeof prisma.routine.findMany;
		try {
			return await run(prisma, created, finds);
		} finally {
			prisma.bot.findFirst = saved.bot;
			prisma.routine.create = saved.create;
			prisma.botMailbox.findFirst = saved.mailbox;
			prisma.routine.findMany = saved.many;
		}
	}

	it("createRoutine grava event/email com os filtros validados e expõe routine.email", async () => {
		const { createRoutine } = await import("./routines.js");
		await withFakes({ mailbox: { id: "mb1", enabled: true } }, async (_p, created) => {
			const { routine } = await createRoutine("user-a", {
				botId: "bot-1",
				name: "NF",
				prompt: "registre",
				trigger: { kind: "email", fromContains: " fornecedor@x.com ", subjectContains: "NF" },
			});
			assert.equal(created[0]?.data.triggerType, "event");
			assert.equal(created[0]?.data.schedule, null);
			assert.deepEqual(created[0]?.data.triggerJson, { kind: "email", fromContains: "fornecedor@x.com", subjectContains: "NF" });
			assert.deepEqual(routine.email, { fromContains: "fornecedor@x.com", subjectContains: "NF" });
			assert.equal(routine.hook, undefined);
			assert.equal(routine.github, undefined);
		});
	});

	it("createRoutine recusa quando o bot não tem caixa ativa", async () => {
		const { createRoutine } = await import("./routines.js");
		for (const mailbox of [null, { id: "mb1", enabled: false }]) {
			await withFakes({ mailbox }, async (_p, created) => {
				await assert.rejects(
					createRoutine("user-a", { botId: "bot-1", name: "NF", prompt: "x", trigger: { kind: "email" } }),
					/aba E-mail/,
				);
				assert.equal(created.length, 0);
			});
		}
	});

	it("listEmailRoutinesForMailbox filtra por dono+bot da caixa e só devolve gatilhos de e-mail", async () => {
		const { listEmailRoutinesForMailbox } = await import("./routines.js");
		const rows = [
			fakeRoutineRow({ id: "a", userId: "user-a", triggerType: "event", enabled: true, triggerJson: { kind: "email", subjectContains: "NF" } }),
			fakeRoutineRow({ id: "b", userId: "user-a", triggerType: "event", enabled: true, triggerJson: { kind: "generic", hookKey: "k", secretHash: "h" } }),
		];
		await withFakes({ mailbox: null, rows }, async (_p, _c, finds) => {
			const found = await listEmailRoutinesForMailbox({ userId: "user-a", botId: "bot-1" });
			assert.deepEqual(found.map((item) => item.routine.id), ["a"]);
			assert.deepEqual(found[0]?.trigger, { kind: "email", subjectContains: "NF" });
			assert.deepEqual(finds[0]?.where, { userId: "user-a", botId: "bot-1", triggerType: "event", enabled: true });
		});
	});
});
