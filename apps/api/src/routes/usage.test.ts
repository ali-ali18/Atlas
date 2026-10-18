import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import type { AuthEnv } from "../middleware/auth.js";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";

const { prisma } = await import("@workspace/db");
const { createUsageRoutes } = await import("./usage.js");

const USER_A = "user-a-ficticio";
const USER_B = "user-b-ficticio";

type Group = {
	owner: string;
	botId: string | null;
	model: string;
	runs: number;
	cost: number | null;
	unknownCalls: number;
	planCalls: number;
};

/** Linhas agregadas "do banco"; o dublê filtra pelo `userId` recebido como parâmetro da consulta. */
const GROUPS: Group[] = [
	{ owner: USER_A, botId: "bot-a", model: "openai/gpt-x", runs: 3, cost: 1.5, unknownCalls: 1, planCalls: 0 },
	{ owner: USER_A, botId: "bot-a", model: "chatgpt/y", runs: 2, cost: null, unknownCalls: 0, planCalls: 4 },
	{ owner: USER_B, botId: "bot-b", model: "openai/gpt-x", runs: 9, cost: 99, unknownCalls: 0, planCalls: 0 },
];

function installFakePrisma() {
	const seen: Array<{ userId: unknown; from: unknown; to: unknown }> = [];
	const original = { queryRaw: prisma.$queryRaw, botFindMany: prisma.bot.findMany };
	prisma.$queryRaw = (async (_strings: TemplateStringsArray, ...values: unknown[]) => {
		seen.push({ userId: values[0], from: values[1], to: values[2] });
		return GROUPS.filter((group) => group.owner === values[0]).map((group) => ({
			botId: group.botId,
			model: group.model,
			runs: group.runs,
			cost: group.cost,
			unknownCalls: group.unknownCalls,
			planCalls: group.planCalls,
			promptTokens: 100,
			completionTokens: 50,
			cachedTokens: 0,
		}));
	}) as unknown as typeof prisma.$queryRaw;
	prisma.bot.findMany = (async (args: { where: { id: { in: string[] }; ownerId: string } }) =>
		[
			{ id: "bot-a", ownerId: USER_A, name: "Bot da A" },
			{ id: "bot-b", ownerId: USER_B, name: "Bot da B" },
		].filter((bot) => args.where.id.in.includes(bot.id) && bot.ownerId === args.where.ownerId)) as unknown as typeof prisma.bot.findMany;
	return {
		seen,
		restore: () => {
			prisma.$queryRaw = original.queryRaw;
			prisma.bot.findMany = original.botFindMany;
		},
	};
}

function appFor(userId: string) {
	const outer = new Hono<AuthEnv>();
	outer.use("*", async (c, next) => {
		c.set("session", { user: { id: userId, email: "x@example.com" } } as AuthEnv["Variables"]["session"]);
		await next();
	});
	outer.route("/", createUsageRoutes({ clock: () => new Date("2026-10-05T15:00:00Z") }));
	return outer;
}

test("GET /v1/usage: totais, por bot e por modelo do próprio usuário", async () => {
	const fake = installFakePrisma();
	try {
		const res = await appFor(USER_A).request("/v1/usage?period=7d&tz=America/Sao_Paulo");
		assert.equal(res.status, 200);
		const body = await res.json();
		assert.equal(body.period, "7d");
		assert.equal(body.from, "2026-09-29T03:00:00.000Z");
		assert.equal(body.to, "2026-10-06T03:00:00.000Z");
		assert.equal(body.totals.runs, 5);
		assert.equal(body.totals.costUsd, 1.5);
		assert.equal(body.totals.costUnknownCalls, 1);
		assert.equal(body.totals.planCalls, 4);
		assert.deepEqual(body.byBot.map((row: { name: string }) => row.name), ["Bot da A"]);
		assert.deepEqual(body.byModel.map((row: { model: string }) => row.model), ["openai/gpt-x", "chatgpt/y"]);
		assert.equal(body.byModel[1].costUsd, null, "plano sem custo continua ausente");
	} finally {
		fake.restore();
	}
});

test("IDOR: B nunca vê números de A e `userId` na query é ignorado", async () => {
	const fake = installFakePrisma();
	try {
		const res = await appFor(USER_B).request(`/v1/usage?period=30d&userId=${USER_A}&ownerId=${USER_A}`);
		assert.equal(res.status, 200);
		const text = await res.text();
		const body = JSON.parse(text);
		assert.equal(fake.seen.at(-1)?.userId, USER_B, "a consulta usa o usuário da sessão");
		assert.equal(body.totals.runs, 9);
		assert.equal(body.totals.costUsd, 99);
		assert.ok(!text.includes("Bot da A") && !text.includes("chatgpt/y"));
	} finally {
		fake.restore();
	}
});

test("usuário sem runs recebe zeros, não erro", async () => {
	const fake = installFakePrisma();
	try {
		const res = await appFor("user-sem-uso").request("/v1/usage?period=today");
		assert.equal(res.status, 200);
		const body = await res.json();
		assert.equal(body.totals.runs, 0);
		assert.equal(body.totals.costUsd, null);
		assert.deepEqual(body.byBot, []);
		assert.deepEqual(body.byModel, []);
	} finally {
		fake.restore();
	}
});

test("período ou fuso inválido vira 400 e não consulta o banco", async () => {
	const fake = installFakePrisma();
	try {
		const app = appFor(USER_A);
		for (const url of [
			"/v1/usage?period=90d",
			"/v1/usage?period=",
			"/v1/usage?period=7d&tz=Marte/Olympus",
			"/v1/usage?tz=UTC';DROP",
		]) {
			const res = await app.request(url);
			assert.equal(res.status, 400, url);
			assert.ok(typeof (await res.json()).error === "string");
		}
		assert.equal(fake.seen.length, 0);
	} finally {
		fake.restore();
	}
});

test("sem period usa 7d e sem tz usa UTC", async () => {
	const fake = installFakePrisma();
	try {
		const body = await (await appFor(USER_A).request("/v1/usage")).json();
		assert.equal(body.period, "7d");
		assert.equal(body.tz, "UTC");
		assert.equal(body.from, "2026-09-29T00:00:00.000Z");
	} finally {
		fake.restore();
	}
});
