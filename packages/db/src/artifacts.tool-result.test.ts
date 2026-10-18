/**
 * F6/L3 — resultado grande de tool guardado como artefato `tool_result`: tem
 * dono e teto próprio; outro usuário não lê. Prisma stubado, disco temporário.
 * Runner: `pnpm exec tsx --test src/artifacts.tool-result.test.ts` em packages/db.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";
const dir = await mkdtemp(join(tmpdir(), "atlas-tool-result-"));
process.env.ATLAS_ARTIFACT_DIR = dir;
const { prisma } = await import("./client.js");
const { ARTIFACT_MAX_BYTES, loadArtifactForUser, loadArtifactFromConversation, listConversationArtifacts, persistUserArtifact } = await import("./artifacts.js");

type Row = { id: string; userId: string | null; runId: string | null; conversationId?: string | null; kind: string; uri: string; metaJson: unknown; createdAt: Date };

test("tool_result: grava com dono e run, só o dono lê de volta", async () => {
	const rows: Row[] = [];
	const artifact = prisma.artifact as unknown as Record<string, unknown>;
	const agentRun = prisma.agentRun as unknown as Record<string, unknown>;
	const originals = { create: artifact.create, update: artifact.update, findFirst: artifact.findFirst, run: agentRun.findFirst };
	agentRun.findFirst = async ({ where }: { where: { id: string; userId: { in: string[] } } }) =>
		where.id === "run-a" && where.userId.in.includes("user-a") ? { id: "run-a" } : null;
	artifact.create = async ({ data }: { data: Omit<Row, "id" | "createdAt"> }) => {
		const row = { id: `art-${rows.length + 1}`, createdAt: new Date(), ...data } as Row;
		rows.push(row);
		return row;
	};
	artifact.update = async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => Object.assign(rows.find((r) => r.id === where.id)!, data);
	artifact.findFirst = async ({ where }: { where: { id: string; OR: Array<{ userId?: { in: string[] } }> } }) =>
		rows.find((row) => row.id === where.id && where.OR[0]?.userId?.in.includes(row.userId ?? "") === true) ?? null;
	try {
		const text = "linha de resultado grande\n".repeat(1000);
		const saved = await persistUserArtifact({
			userId: "user-a",
			runId: "run-a",
			kind: "tool_result",
			bytes: new TextEncoder().encode(text),
			mime: "text/plain",
			meta: { tool: "web_extract" },
		});
		assert.equal(rows[0]!.kind, "tool_result");
		assert.equal(rows[0]!.userId, "user-a");
		assert.equal(rows[0]!.runId, "run-a");
		assert.equal(await readFile(rows[0]!.uri, "utf8"), text);
		const own = await loadArtifactForUser(saved.id, "user-a");
		assert.equal(own?.bytes.toString("utf8"), text);
		assert.equal(own?.runId, "run-a");
		// Outro usuário: nem lê nem grava no run alheio.
		assert.equal(await loadArtifactForUser(saved.id, "user-b"), null);
		await assert.rejects(
			persistUserArtifact({ userId: "user-b", runId: "run-a", kind: "tool_result", bytes: new Uint8Array([1]), mime: "text/plain" }),
			/run não encontrado/,
		);
	} finally {
		Object.assign(artifact, { create: originals.create, update: originals.update, findFirst: originals.findFirst });
		agentRun.findFirst = originals.run;
	}
});

test("tool_result: teto de 2 MB, vazio e dono ausente são recusados", async () => {
	assert.equal(ARTIFACT_MAX_BYTES.tool_result, 2 * 1024 * 1024);
	await assert.rejects(
		persistUserArtifact({ userId: "user-a", kind: "tool_result", bytes: new Uint8Array(2 * 1024 * 1024 + 1), mime: "text/plain" }),
		/acima do limite de 2 MB/,
	);
	await assert.rejects(persistUserArtifact({ userId: "user-a", kind: "tool_result", bytes: new Uint8Array(0), mime: "text/plain" }), /vazio/);
	await assert.rejects(persistUserArtifact({ userId: "default", kind: "tool_result", bytes: new Uint8Array([1]), mime: "text/plain" }), /dono/);
});

test("loadArtifactFromConversation: lê de outra run da mesma conversa, IDOR user/conversation", async () => {
	const rows: Row[] = [];
	const artifact = prisma.artifact as unknown as Record<string, unknown>;
	const originals = { findFirst: artifact.findFirst };

	const text = "resultado de run anterior na mesma conversa";
	const testFile = join(dir, "test-conv-1.txt");
	await (await import("node:fs/promises")).writeFile(testFile, text);

	const row = {
		id: "art-conv-1",
		createdAt: new Date(),
		userId: "user-a",
		runId: "run-2",
		conversationId: "conv-1",
		kind: "tool_result",
		uri: testFile,
		metaJson: { name: "antigo" },
	} as Row;
	rows.push(row);

	artifact.findFirst = async ({ where }: { where: { id: string; conversationId: string; userId: { in: string[] } } }) => {
		const r = rows.find((row) =>
			row.id === where.id &&
			row.conversationId === where.conversationId &&
			where.userId.in.includes(row.userId ?? ""),
		);
		return r ?? null;
	};
	try {
		// Same conversation, same user: sucesso
		const own = await loadArtifactFromConversation("art-conv-1", "user-a", "conv-1");
		assert(own !== null, "should load from same conversation and user");
		assert.equal(own.runId, "run-2");

		// Another conversation: não lê
		assert.equal(await loadArtifactFromConversation("art-conv-1", "user-a", "conv-2"), null);

		// Another user: não lê (IDOR)
		assert.equal(await loadArtifactFromConversation("art-conv-1", "user-b", "conv-1"), null);
	} finally {
		artifact.findFirst = originals.findFirst;
	}
});

test("listConversationArtifacts: lista IDs recentes, IDOR user/conversation", async () => {
	const rows: Row[] = [];
	const artifact = prisma.artifact as unknown as Record<string, unknown>;
	const originals = { findMany: artifact.findMany };
	artifact.findMany = async (params: Record<string, unknown>) => {
		// Simula filtro DB
		const where = params.where as { conversationId: string; userId: { in: string[] }; kind: string; runId?: { not: string } };
		const orderBy = params.orderBy as { createdAt: string } | undefined;
		const take = params.take as number | undefined;
		const filtered = rows.filter(
			(r) =>
				r.conversationId === where.conversationId && where.userId.in.includes(r.userId ?? "") && r.kind === where.kind && (!where.runId || r.runId !== where.runId.not),
		);
		if (orderBy) {
			// orderBy: { createdAt: "desc" }
			filtered.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
		}
		return filtered.slice(0, take).map((r: Row) => {
			return {
				id: r.id,
				metaJson: r.metaJson,
				kind: r.kind,
			};
		});
	};
	try {
		// Populate test data
		rows.push({
			id: "art-list-1",
			createdAt: new Date("2024-01-01"),
			userId: "user-a",
			runId: "run-1",
			conversationId: "conv-1",
			kind: "tool_result",
			uri: "test",
			metaJson: { name: "primeiro" },
		});
		rows.push({
			id: "art-list-2",
			createdAt: new Date("2024-01-02"),
			userId: "user-a",
			runId: "run-2",
			conversationId: "conv-1",
			kind: "tool_result",
			uri: "test",
			metaJson: { name: "segundo" },
		});

		// Same user, same conversation: lista
		const list = await listConversationArtifacts("user-a", "conv-1", { limit: 5 });
		assert.equal(list.length, 2);
		assert.equal(list[0]?.id, "art-list-2"); // Mais recente primeiro
		assert.equal(list[0]?.name, "segundo");

		// excludeRunId: o run atual não entra na lista
		const withoutRun2 = await listConversationArtifacts("user-a", "conv-1", { limit: 5, excludeRunId: "run-2" });
		assert.deepEqual(withoutRun2.map((a) => a.id), ["art-list-1"]);

		// Another conversation: vazio
		const other = await listConversationArtifacts("user-a", "conv-2", { limit: 5 });
		assert.equal(other.length, 0);

		// Another user: vazio (IDOR)
		const userB = await listConversationArtifacts("user-b", "conv-1", { limit: 5 });
		assert.equal(userB.length, 0);
	} finally {
		artifact.findMany = originals.findMany;
	}
});

test.after(async () => {
	await rm(dir, { recursive: true, force: true });
});

test("biblioteca do bot: só arquivos do dono, do bot (conversa ou run), mais novos primeiro, com cursor", async () => {
	const { listBotArtifactsForUser } = await import("./artifacts.js");
	const bot = prisma.bot as unknown as Record<string, unknown>;
	const artifact = prisma.artifact as unknown as Record<string, unknown>;
	const originals = { bot: bot.findFirst, many: artifact.findMany };
	let lastWhere: Record<string, unknown> = {};
	bot.findFirst = async ({ where }: { where: { id: string; ownerId: string } }) =>
		where.id === "bot-1" && where.ownerId === "user-a" ? { id: "bot-1", conversationId: "conv-1" } : null;
	const now = Date.now();
	const data = [3, 2, 1].map((n) => ({
		id: `f${n}`, createdAt: new Date(now - n * 1000), kind: "file",
		metaJson: { filename: `doc${n}.pdf`, size: n * 100, version: n, mime: "application/pdf" },
	}));
	artifact.findMany = async ({ where, take }: { where: Record<string, unknown>; take: number }) => {
		lastWhere = where;
		return data.slice(0, take);
	};
	try {
		assert.equal(await listBotArtifactsForUser({ userId: "user-b", botId: "bot-1" }), null);
		const page = await listBotArtifactsForUser({ userId: "user-a", botId: "bot-1", limit: 2 });
		assert.equal(page?.files.length, 2);
		assert.equal(page?.files[0]?.filename, "doc3.pdf");
		assert.equal(page?.files[0]?.version, 3);
		assert.ok(page?.nextCursor);
		assert.equal(lastWhere.kind, "file");
		assert.deepEqual(lastWhere.OR, [{ run: { botId: "bot-1" } }, { conversationId: "conv-1" }]);
		const all = await listBotArtifactsForUser({ userId: "user-a", botId: "bot-1", limit: 10 });
		assert.equal(all?.nextCursor, null);
	} finally {
		bot.findFirst = originals.bot;
		artifact.findMany = originals.many;
	}
});
