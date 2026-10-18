import assert from "node:assert/strict";
import { test } from "node:test";

test("PATCH /v1/bots/:id rejects an unsupported language", async () => {
	process.env.ATLAS_HOOK_PEPPER ??= "test-pepper-for-bot-language-route";
	process.env.ATLAS_OWNER_EMAIL ??= "test@example.com";
	process.env.BETTER_AUTH_SECRET ??= "test-secret-for-bot-language-route";
	const { createBotRoutes } = await import("./bots.js");
	const app = createBotRoutes();
	const response = await app.request("/v1/bots/bot-1", {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ language: "fr-FR" }),
	});

	assert.equal(response.status, 400);
	assert.deepEqual(await response.json(), { error: "Invalid body: no updatable fields" });
});

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";

async function subagentModelApp(userId: string) {
	const { Hono } = await import("hono");
	const { createBotRoutes } = await import("./bots.js");
	const app = new Hono();
	app.use("*", async (c, next) => {
		(c as unknown as { set: (k: string, v: unknown) => void }).set("session", { user: { id: userId } });
		await next();
	});
	app.route(
		"/",
		createBotRoutes({ isKnownModel: async (id) => id === "google/gemini-2.5-flash" }),
	);
	return app;
}

function patchPolicy(app: Awaited<ReturnType<typeof subagentModelApp>>, policyJson: unknown) {
	return app.request("/v1/bots/bot-1", {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ policyJson }),
	});
}

test("PATCH /v1/bots/:id valida o modelo dos subagentes contra o catálogo", async () => {
	const { prisma } = await import("@workspace/db");
	const original = prisma.bot.findFirst;
	prisma.bot.findFirst = (async () => ({ id: "bot-1" })) as typeof prisma.bot.findFirst;
	try {
	const app = await subagentModelApp("user-a");
	assert.equal((await patchPolicy(app, { subagentModel: "foo/nao-existe" })).status, 400);
	assert.equal((await patchPolicy(app, { subagentModel: 42 })).status, 400);
	assert.equal((await patchPolicy(app, { subagentModel: "x".repeat(300) })).status, 400);
	} finally { prisma.bot.findFirst = original; }
});

test("PATCH /v1/bots/:id: outro usuário não altera o modelo dos subagentes (404) e o dono altera", async () => {
	const { prisma } = await import("@workspace/db");
	const row = (ownerId: string, policyJson: unknown) => ({
		id: "bot-1", ownerId, name: "Bot", snippet: "", color: "#f44336", shape: "rond",
		description: null, openRouterModel: null, language: "pt-BR", pinned: false, pinOrder: null,
		sectionId: null, memberIds: [], conversationId: null, policyJson, autonomyJson: null,
		createdAt: new Date(0), updatedAt: new Date(0),
	});
	const bot = prisma.bot as unknown as Record<string, unknown>;
	const originals = { findUnique: bot.findUnique, findFirst: bot.findFirst, update: bot.update };
	let updates = 0;
	bot.findUnique = async () => row("user-a", null);
	bot.findFirst = async (args: { where: { ownerId: string } }) => args.where.ownerId === "user-a" ? { id: "bot-1" } : null;
	bot.update = async (args: { data: { policyJson?: unknown } }) => {
		updates += 1;
		return row("user-a", args.data.policyJson);
	};
	try {
		const policy = { subagentModel: "google/gemini-2.5-flash" };
		const other = await patchPolicy(await subagentModelApp("user-b"), policy);
		assert.equal(other.status, 404);
		assert.equal(updates, 0);
		const owner = await patchPolicy(await subagentModelApp("user-a"), policy);
		assert.equal(owner.status, 200);
		assert.equal(updates, 1);
		for (const value of [42, "chatgpt/luna", "", "a".repeat(513)])
    assert.equal((await patchPolicy(await subagentModelApp("user-a"), { chatgptFallbackModel: value })).status, 400);
   assert.equal((await patchPolicy(await subagentModelApp("user-a"), { chatgptFallbackModel: null })).status, 200);
   assert.equal((await patchPolicy(await subagentModelApp("user-a"), { chatgptFallbackModel: "deepseek/deepseek-v4.1-flash" })).status, 200);
   const cleared = await patchPolicy(await subagentModelApp("user-a"), { subagentModel: null });
		assert.equal(cleared.status, 200);
	} finally {
		bot.findUnique = originals.findUnique;
		bot.findFirst = originals.findFirst;
		bot.update = originals.update;
	}
});

test("modelo ChatGPT só é gravado após validar dono e catálogo; B recebe 404 antes da validação", async () => {
 const { prisma } = await import("@workspace/db");
 const { Hono } = await import("hono");
 const { createBotRoutes } = await import("./bots.js");
 const bot = prisma.bot as unknown as Record<string, unknown>;
 const original = { findFirst: bot.findFirst, findUnique: bot.findUnique, update: bot.update };
 let validations = 0; let updates = 0;
 bot.findFirst = async (args: {where:{ownerId:string}}) => args.where.ownerId === "user-a" ? { id: "bot-1" } : null;
 bot.findUnique = async () => ({id:"bot-1",ownerId:"user-a"});
 bot.update = async () => { updates++; return {id:"bot-1",ownerId:"user-a",name:"Bot",snippet:"",color:"#000",shape:"rond",description:null,openRouterModel:"chatgpt/luna",language:"pt-BR",pinned:false,pinOrder:null,sectionId:null,memberIds:[],conversationId:null,policyJson:null,createdAt:new Date(0),updatedAt:new Date(0)}; };
 const appFor = (userId:string) => {
  const app = new Hono();
  app.use("*", async (c,next) => { (c as unknown as {set(k:string,v:unknown):void}).set("session",{user:{id:userId}}); await next(); });
  app.route("/",createBotRoutes({validateModel:async (id,model) => { validations++; assert.equal(id,"user-a");assert.equal(model,"chatgpt/luna");return {warning:"catalog offline"}; }}));
  return app;
 };
 const patch = (userId:string) => appFor(userId).request("/v1/bots/bot-1",{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({openRouterModel:"chatgpt/luna"})});
 try {
  assert.equal((await patch("user-b")).status,404);assert.equal(validations,0);assert.equal(updates,0);
  const response=await patch("user-a");assert.equal(response.status,200);
  assert.deepEqual((await response.json() as {warnings:string[]}).warnings,["catalog offline"]);assert.equal(updates,1);
 } finally { Object.assign(bot,original); }
});

test("parseShape aceita as formas do motor e as antigas, e recusa o resto", async () => {
	process.env.ATLAS_OWNER_EMAIL ??= "test@example.com";
	process.env.BETTER_AUTH_SECRET ??= "test-secret-for-bot-shape-parse";
	process.env.ATLAS_HOOK_PEPPER ??= "test-pepper-for-bot-shape-parse";
	const { parseShape } = await import("./bots.js");
	for (const shape of ["blob", "wedge", "hex", "teardrop", "star", "rond", "goutte", "galet", " cloud "]) {
		assert.equal(parseShape(shape), shape.trim(), shape);
	}
	for (const shape of ["", "inventada", "<script>", 3, null, undefined, "WEDGE"]) {
		assert.equal(parseShape(shape), undefined, String(shape));
	}
});

test("GET /v1/bots/:botId/exchanges/:peerBotId: 404 quando um bot não é do usuário; devolve a conversa quando é", async () => {
	const { prisma } = await import("@workspace/db");
	const originalBots = prisma.bot.findMany;
	const originalMessages = prisma.botMessage.findMany;
	const owned = new Set(["bot-a", "bot-b"]);
	prisma.bot.findMany = (async ({ where }: { where: { id: { in: string[] } } }) =>
		where.id.in.filter((id) => owned.has(id)).map((id) => ({ id }))) as unknown as typeof prisma.bot.findMany;
	prisma.botMessage.findMany = (async () => [
		{ id: "m1", rootId: "m1", fromBotId: "bot-a", toBotId: "bot-b", title: "T", content: "oi", replyContent: "ola", status: "replied", createdAt: new Date(1000), repliedAt: new Date(2000) },
	]) as unknown as typeof prisma.botMessage.findMany;
	try {
		const app = await subagentModelApp("user-a");
		const ok = await app.request("/v1/bots/bot-a/exchanges/bot-b?limit=10");
		assert.equal(ok.status, 200);
		const body = (await ok.json()) as { messages: Array<{ id: string; replyContent: string }>; nextCursor: string | null };
		assert.equal(body.messages[0]?.replyContent, "ola");
		assert.equal(body.nextCursor, null);
		assert.equal((await app.request("/v1/bots/bot-a/exchanges/bot-x")).status, 404);
		assert.equal((await app.request("/v1/bots/bot-a/exchanges/bot-b?limit=abc")).status, 400);
		assert.equal((await app.request("/v1/bots/bot-a/exchanges/bot-b?cursor=zzz")).status, 400);
	} finally {
		prisma.bot.findMany = originalBots;
		prisma.botMessage.findMany = originalMessages;
	}
});
