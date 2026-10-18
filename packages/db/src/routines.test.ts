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
