import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "./client.js";
import { createConversation, getOwnedConversation, ResourceOwnershipError } from "./conversations.js";
import { createAgentRun, createRunInput, getAgentRunForUser, validateAgentRunOwnership } from "./runs.js";
import { claimMcpConnectionByStateHash, claimMcpConnectionOwner, createMcpConnection, getMcpConnection, getMcpConnectionByCatalogId, ownerIds, resolveMcpConnection, updateMcpConnection } from "./mcp-connections.js";

const restores: Array<() => void> = [];
// Delegates Prisma são proxies; o mock de descriptors nativo não os intercepta.
function stubMethod<F extends (...args: never[]) => unknown>(target: object, name: string, implementation: F) {
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

type Where = { id?: string | { not: string }; userId?: string | { in: string[] }; ownerId?: string; conversationId?: string; oauthStateHash?: string; catalogId?: string; memberIds?: { has?: string } };
const conversations = [
	{ id: "conv-a", userId: "user-a", botOwner: "user-a" },
	{ id: "conv-b", userId: "user-b", botOwner: "user-b" },
	{ id: "conv-empty", userId: "user-a", botOwner: null },
	{ id: "conv-legacy", userId: null, botOwner: null },
	{ id: "conv-inconsistent", userId: "user-a", botOwner: "user-b" },
];
const bots: Array<{ id: string; ownerId: string; conversationId: string | null; memberIds?: string[] }> = [
	{ id: "bot-a", ownerId: "user-a", conversationId: "conv-a" },
	{ id: "bot-b", ownerId: "user-b", conversationId: "conv-b" },
	{ id: "bot-unlinked", ownerId: "user-a", conversationId: null },
	{ id: "bot-inconsistent", ownerId: "user-a", conversationId: "conv-b" },
];

function stubRelationships() {
	stubMethod(prisma.conversation, "findFirst", async ({ where }: { where: Where }) => {
		const row = conversations.find((item) => item.id === where.id && item.userId === where.userId && (!item.botOwner || item.botOwner === where.userId));
		return row ? { id: row.id } : null;
	});
	stubMethod(prisma.bot, "findFirst", async ({ where }: { where: Where }) => bots.find((item) =>
		item.ownerId === where.ownerId &&
		(typeof where.id === "string" ? item.id === where.id : item.id !== where.id?.not) &&
		(where.conversationId === undefined || item.conversationId === where.conversationId) &&
		(where.memberIds?.has === undefined || (item.memberIds ?? []).includes(where.memberIds.has)),
	) ?? null);
}

const request = { messages: [{ role: "user" as const, content: "tarefa" }], silent: true as const };

test("run não cria sem dono explícito nem com identidade legada", async () => {
	const create = stubMethod(prisma.agentRun, "create", async () => { throw new Error("não deve gravar"); });
	for (const userId of [undefined, "", "default"]) {
		await assert.rejects(createAgentRun({ request, model: "model", userId }), ResourceOwnershipError);
	}
	assert.equal(create.mock.callCount(), 0);
});

test("conversa nova exige dono explícito", async () => {
	const create = stubMethod(prisma.conversation, "create", async ({ data }: { data: { userId: string } }) => ({ id: "conv-new", ...data }));
	await assert.rejects(createConversation(), ResourceOwnershipError);
	await assert.rejects(createConversation("default"), ResourceOwnershipError);
	assert.deepEqual(await createConversation("user-a"), { id: "conv-new" });
	assert.equal(create.mock.callCount(), 1);
	assert.equal(create.mock.calls[0]?.arguments[0]?.data.userId, "user-a");
});

test("validação resolve conversa do bot sem efeitos e bloqueia recursos cruzados", async () => {
	stubRelationships();
	const update = stubMethod(prisma.bot, "updateMany", async () => { throw new Error("validação não grava"); });
	assert.deepEqual(await validateAgentRunOwnership({ botId: "bot-a" }, "user-a"), { botId: "bot-a", conversationId: "conv-a" });
	assert.deepEqual(await validateAgentRunOwnership({ conversationId: "conv-empty" }, "user-a"), { botId: null, conversationId: "conv-empty" });
	for (const input of [
		{ botId: "bot-a", conversationId: "conv-b" },
		{ botId: "bot-b" },
		{ botId: "bot-inconsistent" },
		{ conversationId: "conv-legacy" },
		{ conversationId: "conv-inconsistent" },
		{ botId: "bot-unlinked", conversationId: "conv-a" },
	]) await assert.rejects(validateAgentRunOwnership(input, "user-a"), ResourceOwnershipError);
	assert.equal(update.mock.callCount(), 0);
});

test("usuário B não usa bot/conversa A e nenhum run é criado", async () => {
	stubRelationships();
	const create = stubMethod(prisma.agentRun, "create", async () => { throw new Error("não deve gravar"); });
	await assert.rejects(createAgentRun({ request: { ...request, botId: "bot-a" }, model: "m", userId: "user-b" }), ResourceOwnershipError);
	await assert.rejects(createAgentRun({ request: { ...request, conversationId: "conv-a" }, model: "m", userId: "user-b" }), ResourceOwnershipError);
	assert.equal(create.mock.callCount(), 0);
});

const now = new Date("2026-10-02T12:00:00Z");
const runA = { id: "run-a", userId: "user-a", botId: "bot-a", conversationId: "conv-a", origin: "chat", objective: "tarefa", status: "running", model: "m", maxSteps: 10, sandboxSessionId: null, error: null, resultText: null, cancelRequested: false, createdAt: now, updatedAt: now, startedAt: now, finishedAt: null };

test("criação válida mantém dono e conversa e não grava default", async () => {
	stubRelationships();
	const create = stubMethod(prisma.agentRun, "create", async ({ data }: { data: Record<string, unknown> }) => ({ ...runA, ...data }));
	const created = await createAgentRun({ request: { ...request, conversationId: "conv-empty" }, model: "m", userId: "user-a" });
	assert.equal(created.userId, "user-a");
	assert.equal(created.conversationId, "conv-empty");
	assert.equal(create.mock.calls[0]?.arguments[0]?.data.userId, "user-a");
});

test("lookup de run só admite dono exato, sem default", async () => {
	stubMethod(prisma.agentRun, "findFirst", async ({ where }: { where: Where }) => {
		const rows = [runA, { ...runA, id: "run-legacy", userId: "default" }];
		return rows.find((row) => row.id === where.id && row.userId === where.userId) ?? null;
	});
	assert.equal((await getAgentRunForUser("run-a", "user-a"))?.id, "run-a");
	assert.equal(await getAgentRunForUser("run-a", "user-b"), null);
	assert.equal(await getAgentRunForUser("run-legacy", "user-a"), null);
	assert.equal(await getAgentRunForUser("run-legacy", "default"), null);
});

test("colisão de conversa não retorna nem steera run de outro usuário", async () => {
	stubRelationships();
	stubMethod(prisma.agentRun, "create", async () => { throw { code: "P2002" }; });
	const lookup = stubMethod(prisma.agentRun, "findFirst", async ({ where }: { where: Where }) => where.userId === "user-b" ? runA : null);
	const write = stubMethod(prisma.runInput, "create", async () => { throw new Error("não deve gravar"); });
	await assert.rejects(createAgentRun({ request: { ...request, conversationId: "conv-a" }, model: "m", userId: "user-a" }), (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "P2002");
	assert.equal(lookup.mock.calls[0]?.arguments[0]?.where?.userId, "user-a");
	assert.equal(write.mock.callCount(), 0);
});

test("input autenticado não escreve em run de outro usuário", async () => {
	stubMethod(prisma.agentRun, "findFirst", async ({ where }: { where: Where }) => typeof where.userId === "object" && where.userId.in.includes(runA.userId) ? runA : null);
	const write = stubMethod(prisma.runInput, "create", async () => { throw new Error("não deve gravar"); });
	await assert.rejects(createRunInput("run-a", { content: "mude a tarefa" }, "user-b"), ResourceOwnershipError);
	assert.equal(write.mock.callCount(), 0);
});

test("colisão só com imagem preserva anexo no steer do próprio dono", async () => {
	stubRelationships();
	const dir = await mkdtemp(join(tmpdir(), "atlas-ownership-"));
	const image = join(dir, "image.png");
	await writeFile(image, Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
	stubMethod(prisma.artifact, "findFirst", async () => ({ id: "image-a", kind: "image", uri: image, metaJson: { mime: "image/png", width: 1, height: 1 } }));
	stubMethod(prisma.artifact, "findMany", async () => []);
	stubMethod(prisma.agentRun, "create", async () => { throw { code: "P2002" }; });
	stubMethod(prisma.agentRun, "findFirst", async () => runA);
	stubMethod(prisma.conversation, "findUnique", async () => ({ id: "conv-a" }));
	stubMethod(prisma, "$transaction", async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma));
	stubMethod(prisma, "$executeRaw", async () => 0);
	stubMethod(prisma.runInput, "findFirst", async () => null);
	const write = stubMethod(prisma.runInput, "create", async ({ data }: { data: Record<string, unknown> }) => ({ id: "input-a", createdAt: now, consumedAt: null, ...data }));
	try {
		assert.equal((await createAgentRun({ request: { messages: [{ role: "user", content: "" }], conversationId: "conv-a", attachments: [{ artifactId: "image-a" }], silent: true }, model: "m", userId: "user-a" })).id, "run-a");
		const data = write.mock.calls[0]?.arguments[0]?.data;
		assert.equal(data?.content, "");
		assert.equal(data?.mode, "join");
		assert.deepEqual(data?.attachmentsJson, [{ artifactId: "image-a" }]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("arquivo anexado no meio do run: o modelo recebe a lista, a conversa mostra o texto e o cartão; imagem segue em attachmentsJson", async () => {
	stubRelationships();
	const dir = await mkdtemp(join(tmpdir(), "atlas-ownership-file-"));
	const image = join(dir, "image.png");
	await writeFile(image, Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
	stubMethod(prisma.artifact, "findFirst", async () => ({ id: "image-a", kind: "image", uri: image, metaJson: { mime: "image/png", width: 1, height: 1 } }));
	stubMethod(prisma.artifact, "findMany", async ({ where }: { where: { userId: { in: string[] } } }) => where.userId.in.includes("user-a") ? [{ id: "file-a", metaJson: { origin: "user", filename: "contrato.pdf", mime: "application/pdf", size: 1234 } }] : []);
	stubMethod(prisma.agentRun, "findFirst", async () => runA);
	stubMethod(prisma.conversation, "findFirst", async () => ({ id: "conv-a" }));
	stubMethod(prisma, "$transaction", async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma));
	stubMethod(prisma, "$executeRaw", async () => 0);
	stubMethod(prisma.runInput, "findFirst", async () => null);
	const write = stubMethod(prisma.runInput, "create", async ({ data }: { data: Record<string, unknown> }) => ({ id: "input-a", createdAt: now, consumedAt: null, ...data }));
	const messages: Array<{ role: string; content: string }> = [];
	stubMethod(prisma.conversationMessage, "create", async ({ data }: { data: { role: string; content: string } }) => { messages.push(data); return { id: `m${messages.length}`, createdAt: now, ...data }; });
	try {
		await createRunInput("run-a", { content: "olha isto", mode: "join", attachments: [{ artifactId: "image-a" }, { artifactId: "file-a" }] }, "user-a");
		const data = write.mock.calls[0]?.arguments[0]?.data;
		assert.equal(String(data?.content), "olha isto\n\n[The user attached a file: \"contrato.pdf\" (attachment id file-a, 1234 bytes). Read with attachment_read.]");
		assert.deepEqual(data?.attachmentsJson, [{ artifactId: "image-a" }]);
		assert.deepEqual(messages.map((message) => message.role), ["user", "images", "file"]);
		assert.equal(messages[0]?.content, "olha isto");
		assert.deepEqual(JSON.parse(messages[2]!.content), { v: 1, kind: "file", artifactId: "file-a", filename: "contrato.pdf", mime: "application/pdf", size: 1234, format: "pdf", version: 1, origin: "user" });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("conversa sem dono ou com bot de outro dono fica invisível antes do claim", async () => {
	stubRelationships();
	assert.deepEqual(await getOwnedConversation("conv-a", "user-a"), { id: "conv-a" });
	assert.equal(await getOwnedConversation("conv-a", "user-b"), null);
	assert.equal(await getOwnedConversation("conv-legacy", "user-a"), null);
	assert.equal(await getOwnedConversation("conv-inconsistent", "user-a"), null);
});

const connections = [
	{ id: "conn-a", userId: "user-a", catalogId: "test", slug: "test", name: "Test", url: "https://example.com", authType: "none", status: "connected", toolsCacheJson: [], disabledTools: [], confirmWrites: true, lastError: null, createdAt: now, updatedAt: now, secretsEnc: null, oauthStateHash: "state-a" },
	{ id: "conn-legacy", userId: "default", catalogId: "test", slug: "legacy", name: "Legacy", url: "https://example.com", authType: "none", status: "connected", toolsCacheJson: [], disabledTools: [], confirmWrites: true, lastError: null, createdAt: now, updatedAt: now, secretsEnc: null, oauthStateHash: "state-legacy" },
];
function stubConnections() {
	stubMethod(prisma.mcpConnection, "findFirst", async ({ where }: { where: Where }) => connections.find((row) =>
		(typeof where.userId === "object" ? where.userId.in.includes(row.userId) : where.userId === row.userId) &&
		(where.id === undefined || row.id === where.id) &&
		(where.catalogId === undefined || row.catalogId === where.catalogId) &&
		(where.oauthStateHash === undefined || row.oauthStateHash === where.oauthStateHash),
	) ?? null);
}

test("MCP não resolve default ou acesso sem identidade", async () => {
	stubConnections();
	assert.deepEqual(ownerIds("user-a"), ["user-a"]);
	assert.deepEqual(ownerIds(), []);
	assert.deepEqual(ownerIds("default"), []);
	assert.equal(resolveMcpConnection(connections, "user-b"), null);
	assert.equal(resolveMcpConnection(connections), null);
	assert.equal((await getMcpConnection("conn-a", "user-a"))?.id, "conn-a");
	assert.equal(await getMcpConnection("conn-a", "user-b"), null);
	assert.equal(await getMcpConnection("conn-a"), null);
	assert.equal(await getMcpConnection("conn-legacy", "user-a"), null);
	assert.equal(await getMcpConnectionByCatalogId("test", "user-b"), null);
	assert.equal(await claimMcpConnectionOwner("conn-legacy", "user-a"), null);
});

test("state OAuth de A não é consumido por B nem permite claim default", async () => {
	stubConnections();
	const consume = stubMethod(prisma.mcpConnection, "updateMany", async (_args: { where: Where }) => ({ count: 1 }));
	assert.equal(await claimMcpConnectionByStateHash("state-a", "user-b"), null);
	assert.equal(await claimMcpConnectionByStateHash("state-legacy", "user-a"), null);
	assert.equal(consume.mock.callCount(), 0);
	assert.equal((await claimMcpConnectionByStateHash("state-a", "user-a"))?.id, "conn-a");
	assert.equal(consume.mock.calls[0]?.arguments[0]?.where?.userId, "user-a");
});

test("atualização de MCP aplica owner na própria escrita", async () => {
	const write = stubMethod(prisma.mcpConnection, "update", async ({ where }: { where: Where }) => {
		const row = connections.find((item) => item.id === where.id && item.userId === where.userId);
		if (!row) throw { code: "P2025" };
		return row;
	});
	assert.equal(await updateMcpConnection("conn-a", { name: "mudança" }, "user-b"), null);
	assert.equal((await updateMcpConnection("conn-a", { name: "mudança" }, "user-a"))?.id, "conn-a");
	assert.equal(write.mock.calls[0]?.arguments[0].where.userId, "user-b");
	await assert.rejects(createMcpConnection({ catalogId: null, slug: "test", name: "Test", url: "https://example.com", authType: "none" }), ResourceOwnershipError);
});

function stubActiveRunCollision() {
	stubRelationships();
	stubMethod(prisma.agentRun, "create", async () => { throw { code: "P2002" }; });
	stubMethod(prisma.agentRun, "findFirst", async ({ where }: { where: Where }) => (typeof where.userId === "object" ? where.userId.in.includes("user-a") : where.userId === "user-a") ? runA : null);
	stubMethod(prisma.conversation, "findUnique", async () => ({ id: "conv-a" }));
	stubMethod(prisma, "$transaction", async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma));
	stubMethod(prisma, "$executeRaw", async () => 0);
	stubMethod(prisma.runInput, "findFirst", async () => null);
	return stubMethod(prisma.runInput, "create", async ({ data }: { data: Record<string, unknown> }) => ({ id: "input-a", createdAt: now, consumedAt: null, ...data }));
}

test("mensagem que vira entrada no run ativo avisa onMergedIntoActiveRun com o id do run do dono", async () => {
	stubActiveRunCollision();
	const merged: string[] = [];
	const run = await createAgentRun({ request: { messages: [{ role: "user", content: "mais uma coisa" }], conversationId: "conv-a", silent: true }, model: "m", userId: "user-a", onMergedIntoActiveRun: (runId) => { merged.push(runId); } });
	assert.equal(run.id, "run-a");
	assert.deepEqual(merged, ["run-a"]);
});

test("onMergedIntoActiveRun não é chamado quando o run ativo é de outro usuário nem em rotina", async () => {
	const write = stubActiveRunCollision();
	const merged: string[] = [];
	const onMergedIntoActiveRun = (runId: string) => { merged.push(runId); };
	await assert.rejects(createAgentRun({ request: { messages: [{ role: "user", content: "oi" }], conversationId: "conv-a", silent: true }, model: "m", userId: "user-b", onMergedIntoActiveRun }));
	await createAgentRun({ request: { messages: [{ role: "user", content: "oi" }], conversationId: "conv-a", origin: "routine", silent: true }, model: "m", userId: "user-a", onMergedIntoActiveRun });
	assert.deepEqual(merged, []);
	assert.equal(write.mock.callCount(), 0);
});

test("colisão do índice único quando o run ativo já terminou: tenta criar de novo em vez de estourar o erro cru", async () => {
	stubRelationships();
	let attempts = 0;
	stubMethod(prisma.agentRun, "create", async () => {
		attempts += 1;
		if (attempts === 1) throw { code: "P2002" };
		return { ...runA, id: "run-new", status: "queued" };
	});
	stubMethod(prisma.agentRun, "findFirst", async () => null);
	stubMethod(prisma.conversation, "findUnique", async () => ({ id: "conv-a" }));
	stubMethod(prisma.conversation, "update", async () => ({}));
	stubMethod(prisma.conversationMessage, "create", async () => ({ id: "m", createdAt: new Date() }));
	const run = await createAgentRun({ request: { messages: [{ role: "user", content: "oi" }], conversationId: "conv-a" }, model: "m", userId: "user-a" });
	assert.equal(run.id, "run-new");
	assert.equal(attempts, 2);
});
