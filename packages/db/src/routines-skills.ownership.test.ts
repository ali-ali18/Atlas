import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { prisma } from "./client.js";
import { deleteRoutine, getRoutine, listRecentRoutineRunsForBot, listRoutines, rotateRoutineHookSecret } from "./routines.js";
import { getSkillDetail, listBotSkills, setSkillEnabled } from "./skills.js";

const restores: Array<() => void> = [];
// Delegates Prisma são proxies; o mock nativo não os intercepta (mesmo padrão de ownership.test.ts).
function stubMethod(target: object, name: string, implementation: (...args: never[]) => unknown) {
	const original = Reflect.get(target, name);
	const replacement = mock.fn(implementation);
	Object.assign(target, { [name]: replacement });
	restores.push(() => Object.assign(target, { [name]: original }));
	return replacement;
}
afterEach(() => {
	for (const restore of restores.splice(0).reverse()) restore();
	mock.restoreAll();
});

type Row = Record<string, unknown>;

/** Avalia o `where` de verdade (igualdade, `in`, `not`): um where sem dono devolve a linha dos outros. */
function matches(row: Row, where: Row = {}): boolean {
	return Object.entries(where).every(([key, expected]) => {
		if (expected === undefined) return true;
		const actual = row[key];
		if (expected && typeof expected === "object" && !Array.isArray(expected) && !(expected instanceof Date)) {
			const cond = expected as { in?: unknown[]; not?: unknown; equals?: unknown };
			if (cond.in) return cond.in.includes(actual);
			if ("not" in cond) return actual !== cond.not;
			if ("equals" in cond) return true;
			return true; // filtros de relação/JSON não são relevantes aqui
		}
		return actual === expected;
	});
}

const NOW = new Date("2026-10-11T12:00:00.000Z");
const A = "user-a";
const B = "user-b";

const ids = (list: Array<{ id: string }>) => list.map((item) => item.id).sort();

// --- rotinas e skills do bot: o botId vem da URL, o dono vem da sessão ---

function routineRow(id: string, botId: string, userId: string | null): Row {
	return {
		id, botId, userId, conversationId: null, name: id, prompt: "p", model: null, allowChatgptPlan: false,
		enabled: true, triggerType: "cron", schedule: "0 9 * * *", timezone: "UTC", triggerJson: null,
		lastRunAt: null, createdAt: NOW, updatedAt: NOW,
	};
}

test("rotinas por botId: usuário B não lista, lê, rotaciona nem apaga as do bot de A", async () => {
	const routines = [routineRow("r-a", "bot-a1", A), routineRow("r-legacy", "bot-a1", "default")];
	stubMethod(prisma.routine, "findMany", async ({ where }: { where?: Row }) => routines.filter((row) => matches(row, where)).map((row) => ({ ...row, runs: [] })));
	stubMethod(prisma.routine, "findFirst", async ({ where }: { where?: Row }) => routines.find((row) => matches(row, where)) ?? null);
	stubMethod(prisma.routine, "deleteMany", async ({ where }: { where?: Row }) => {
		const index = routines.findIndex((row) => matches(row, where));
		if (index >= 0) routines.splice(index, 1);
		return { count: index >= 0 ? 1 : 0 };
	});
	stubMethod(prisma.routineRun, "findFirst", async () => null);
	stubMethod(prisma.routineRun, "findMany", async () => []);

	assert.deepEqual(ids(await listRoutines(A, "bot-a1")), ["r-a"]);
	assert.deepEqual(await listRoutines(B, "bot-a1"), []);
	assert.deepEqual(await listRoutines(undefined, "bot-a1"), []);
	assert.deepEqual(await listRoutines("default", "bot-a1"), []);
	assert.deepEqual(await listRecentRoutineRunsForBot(B, "bot-a1"), []);
	assert.equal((await getRoutine(A, "bot-a1", "r-a"))?.id, "r-a");
	assert.equal(await getRoutine(B, "bot-a1", "r-a"), null);
	assert.equal(await getRoutine(undefined, "bot-a1", "r-a"), null);
	assert.equal(await getRoutine(B, "bot-a1", "r-legacy"), null);
	assert.equal(await rotateRoutineHookSecret(B, "bot-a1", "r-a"), null);
	assert.equal(await deleteRoutine(B, "bot-a1", "r-a"), false);
	assert.equal(routines.length, 2);
	assert.equal(await deleteRoutine(A, "bot-a1", "r-a"), true);
});

test("skills por botId: usuário B não lista, lê nem liga/desliga as do bot de A", async () => {
	const skills: Row[] = [
		{ id: "s-a", botId: "bot-a1", userId: A, enabled: true, versions: [] },
		{ id: "s-legacy", botId: "bot-a1", userId: "default", enabled: true, versions: [] },
	];
	stubMethod(prisma.skill, "findMany", async ({ where }: { where?: Row }) => skills.filter((row) => matches(row, where)));
	stubMethod(prisma.skill, "findFirst", async ({ where }: { where?: Row }) => skills.find((row) => matches(row, where)) ?? null);
	const updateMany = stubMethod(prisma.skill, "updateMany", async ({ where }: { where?: Row }) => ({ count: skills.filter((row) => matches(row, where)).length }));

	assert.deepEqual(ids((await listBotSkills(A, "bot-a1")) as Array<{ id: string }>), ["s-a"]);
	assert.deepEqual(await listBotSkills(B, "bot-a1"), []);
	assert.deepEqual(await listBotSkills(undefined, "bot-a1"), []);
	assert.equal((await getSkillDetail(A, "bot-a1", "s-a"))?.id, "s-a");
	assert.equal(await getSkillDetail(B, "bot-a1", "s-a"), null);
	assert.equal(await getSkillDetail(undefined, "bot-a1", "s-a"), null);
	assert.equal(await getSkillDetail(B, "bot-a1", "s-legacy"), null);
	assert.deepEqual(await setSkillEnabled({ userId: B, botId: "bot-a1", skillId: "s-a", enabled: false }), { count: 0 });
	assert.equal(updateMany.mock.callCount(), 0);
	assert.deepEqual(await setSkillEnabled({ userId: A, botId: "bot-a1", skillId: "s-a", enabled: false }), { count: 1 });
});
