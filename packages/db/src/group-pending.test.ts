/**
 * Grupos de bots: o bot principal aceita sozinho os pedidos seguros dos membros (e só eles).
 * Prisma em memória; sem rede. Runner: `pnpm exec tsx --test src/group-pending.test.ts` em packages/db.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBotAutoDecisionCard, toolDefinitionHash } from "@workspace/shared";

process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";
const { prisma } = await import("./client.js");
const { autoDecideGroupPending } = await import("./group-pending.js");

type Row = Record<string, unknown>;

function matches(row: Row, where: Row | undefined): boolean {
	if (!where) return true;
	return Object.entries(where).every(([key, cond]) => {
		const value = row[key];
		if (cond && typeof cond === "object" && !(cond instanceof Date)) {
			const c = cond as Record<string, unknown>;
			if ("in" in c) return (c.in as unknown[]).includes(value);
			if ("gt" in c) return (value as Date) > (c.gt as Date);
			if ("has" in c) return (value as unknown[]).includes(c.has);
			if ("isEmpty" in c) return ((value as unknown[]).length === 0) === c.isEmpty;
			if ("contains" in c) return typeof value === "string" && value.includes(c.contains as string);
			return false;
		}
		return value === cond;
	});
}

function table(rows: Row[]) {
	const sort = (list: Row[], orderBy?: Record<string, "asc" | "desc">) => {
		if (!orderBy) return list;
		const [key, dir] = Object.entries(orderBy)[0]!;
		return [...list].sort((a, b) => {
			const x = (a[key] as Date | number) ?? 0;
			const y = (b[key] as Date | number) ?? 0;
			return (x < y ? -1 : x > y ? 1 : 0) * (dir === "desc" ? -1 : 1);
		});
	};
	let seq = 0;
	return {
		rows,
		findMany: async ({ where, orderBy, take }: { where?: Row; orderBy?: Record<string, "asc" | "desc">; take?: number }) => sort(rows.filter((row) => matches(row, where)), orderBy).slice(0, take),
		findFirst: async ({ where, orderBy }: { where?: Row; orderBy?: Record<string, "asc" | "desc"> }) => sort(rows.filter((row) => matches(row, where)), orderBy)[0] ?? null,
		findUnique: async ({ where }: { where: Row }) => rows.find((row) => matches(row, where)) ?? null,
		create: async ({ data }: { data: Row }) => {
			const row = { id: `m${rows.length + 1}`, createdAt: new Date(2026, 0, 1, 0, 0, seq++), ...data };
			rows.push(row);
			return row;
		},
	};
}

const bot = (id: string, name: string, extra: Row = {}): Row => ({
	id, ownerId: "u1", name, description: null, snippet: "", isPrimary: false, memberIds: [], conversationId: `c-${id}`, ...extra,
});

const TOOL = { name: "search_market_prices", description: "Busca preços", inputSchema: { type: "object", properties: { q: { type: "string" } } } };
const NOTE = { name: "create_note", description: "Cria nota", inputSchema: { type: "object", properties: {} } };

function connection(id: string, userId: string, confirmWrites: boolean) {
	return {
		id, userId, catalogId: null, slug: "x", name: "Mercado", url: "https://x.test", authType: "none", status: "connected",
		toolsCacheJson: [TOOL, NOTE], disabledTools: [], confirmWrites, lastError: null, accountLabel: null, guideJson: null,
		toolMarksJson: { [TOOL.name]: { mark: "read", hash: toolDefinitionHash(TOOL) } },
		createdAt: new Date(0), updatedAt: new Date(0), secretsEnc: null, oauthStateHash: null,
	};
}

type CardSpec = { botId: string; confirmId: string; userId?: string; conversationId?: string; origin?: string; card?: Row; payload?: Row };

// Ids de cartão únicos por instalação (o módulo lembra cartões já escalados neste processo).
let world = 0;

function install(cards: CardSpec[]) {
	world += 1;
	const bots = table([
		bot("cookie", "Cookie", { isPrimary: true }),
		bot("radar", "Radar de Mercado"),
		bot("inspetor", "Inspetor"),
		bot("team", "Time", { memberIds: ["cookie", "radar", "inspetor"], conversationId: "c-team" }),
		bot("eva", "Eva", { ownerId: "u2", isPrimary: true }),
		bot("zed", "Zed", { ownerId: "u2" }),
		bot("team2", "Time B", { ownerId: "u2", memberIds: ["eva", "zed"], conversationId: "c-team2" }),
	]);
	const messages = table([]);
	const intents = table([]);
	const runs = table([]);
	for (const [index, spec] of cards.entries()) {
		const conversationId = spec.conversationId ?? "c-team";
		const userId = spec.userId ?? "u1";
		runs.rows.push({ id: `run${index}`, userId, botId: spec.botId, origin: spec.origin ?? "chat" });
		messages.rows.push({
			id: `card${world}-${index}`, conversationId, role: "confirm", runId: `run${index}`, createdAt: new Date(2026, 0, 1, 0, index),
			content: JSON.stringify({ v: 1, kind: "confirm", confirmId: spec.confirmId, title: "Executar este comando?", status: "pending", ...spec.card }),
		});
		intents.rows.push({
			id: `i${index}`, userId, conversationId, kind: "confirm", expiresAt: new Date(Date.now() + 60_000),
			payload: { kind: "confirm", confirmId: spec.confirmId, botId: spec.botId, ...spec.payload },
		});
	}
	const connections = table([connection("conn-ro", "u1", true), connection("conn-open", "u1", false), connection("conn-b", "u2", false)]);
	Object.assign(prisma.bot as object, { findMany: bots.findMany, findFirst: bots.findFirst });
	Object.assign(prisma.conversationMessage as object, { findMany: messages.findMany, create: messages.create });
	Object.assign(prisma.skillPendingIntent as object, { findMany: intents.findMany });
	Object.assign(prisma.agentRun as object, { findUnique: runs.findUnique });
	Object.assign(prisma.groupReply as object, { findFirst: async () => ({ turnId: "turn1" }) });
	Object.assign(prisma.mcpConnection as object, { findFirst: connections.findFirst });
	return { messages };
}

const decisions = (world: ReturnType<typeof install>) => world.messages.rows.map((row) => parseBotAutoDecisionCard(row.content as string)).filter((card) => card !== null);
const command = (cmd: string) => ({ card: { devApproval: { kind: "command", command: cmd, cwd: "/workspace" } }, payload: { action: "dev-command" } });
const mcpCall = (connectionId: string, toolName: string, extra: Row = {}) => ({
	payload: { action: "mcp-call", mcpCall: { connectionId, connectorName: "Mercado", toolName, exposedName: `mcp__x__${toolName}`, actionClass: "write", args: { q: "tênis" }, ...extra } },
	card: {},
});

test("replay: Radar para num MCP de leitura -> o principal aceita sozinho, com nota visível", async () => {
	const world = install([{ botId: "radar", confirmId: "c1", ...mcpCall("conn-ro", TOOL.name) }]);
	const result = await autoDecideGroupPending();
	assert.deepEqual(result, { scanned: 1, approved: 1, escalated: 0 });
	const [note] = decisions(world);
	assert.equal(note!.status, "queued");
	assert.equal(note!.viaGroup, true);
	assert.equal(note!.decision, "approved");
	assert.equal(note!.deciderName, "Cookie");
	assert.equal(note!.botId, "radar");
	assert.equal(note!.reason, "leitura");
	assert.equal(note!.botMessageId, "turn1");
	assert.equal(note!.need.cardId, "card1-0");
	assert.equal(note!.need.conversationId, "c-team");
	// Idempotente: a segunda varredura não duplica a nota.
	assert.deepEqual(await autoDecideGroupPending(), { scanned: 1, approved: 0, escalated: 0 });
	assert.equal(decisions(world).length, 1);
});

test("replay: Radar pede envio de e-mail -> escala (nenhuma nota, o cartão espera o usuário)", async () => {
	const world = install([{ botId: "radar", confirmId: "c1", ...mcpCall("conn-open", "send_email", { args: { to: "a@b.co", subject: "oi" } }) }]);
	assert.deepEqual(await autoDecideGroupPending(), { scanned: 1, approved: 0, escalated: 1 });
	assert.equal(decisions(world).length, 0);
});

test("escrita reversível só em conector sem confirmWrites; com confirmWrites escala", async () => {
	const open = install([{ botId: "radar", confirmId: "c1", ...mcpCall("conn-open", NOTE.name) }]);
	assert.equal((await autoDecideGroupPending()).approved, 1);
	assert.equal(decisions(open)[0]!.reason, "escrita reversível");
	const closed = install([{ botId: "inspetor", confirmId: "c2", ...mcpCall("conn-ro", NOTE.name) }]);
	assert.equal((await autoDecideGroupPending()).escalated, 1);
	assert.equal(decisions(closed).length, 0);
});

test("comando de leitura é aceito; comando que escreve escala", async () => {
	const ok = install([{ botId: "inspetor", confirmId: "c1", ...command("git status") }]);
	assert.equal((await autoDecideGroupPending()).approved, 1);
	assert.equal(decisions(ok)[0]!.reason, "comando de leitura");
	const bad = install([{ botId: "inspetor", confirmId: "c2", ...command("pnpm install") }]);
	assert.equal((await autoDecideGroupPending()).escalated, 1);
	assert.equal(decisions(bad).length, 0);
});

test("o próprio principal não se autoaprova; origem sem pessoa escala", async () => {
	const self = install([{ botId: "cookie", confirmId: "c1", ...command("git status") }]);
	assert.deepEqual(await autoDecideGroupPending(), { scanned: 1, approved: 0, escalated: 0 });
	assert.equal(decisions(self).length, 0);
	const routine = install([{ botId: "radar", confirmId: "c2", origin: "routine", ...command("git status") }]);
	assert.equal((await autoDecideGroupPending()).escalated, 1);
	assert.equal(decisions(routine).length, 0);
});

test("IDOR: a intenção de A nunca vira aceite em grupo de B, nem com membro/principal de B", async () => {
	// Cartão do usuário B na conversa do grupo de B, pedido por bot de B: o principal de B (Eva) decide, nunca o Cookie de A.
	const b = install([{ botId: "zed", confirmId: "c1", userId: "u2", conversationId: "c-team2", ...command("git status") }]);
	assert.equal((await autoDecideGroupPending()).approved, 1);
	const [noteB] = decisions(b);
	assert.equal(noteB!.deciderName, "Eva");
	assert.equal(noteB!.need.conversationId, "c-team2");

	// Intenção de B apontando a conversa do grupo de A: o grupo não é de B, nada acontece.
	const cross = install([{ botId: "radar", confirmId: "c2", userId: "u2", conversationId: "c-team", ...command("git status") }]);
	assert.deepEqual(await autoDecideGroupPending(), { scanned: 0, approved: 0, escalated: 0 });
	assert.equal(decisions(cross).length, 0);

	// Intenção de A, mas o "membro" que pediu é bot de B (fora do grupo): não aceita.
	const foreign = install([{ botId: "zed", confirmId: "c3", ...command("git status") }]);
	assert.deepEqual(await autoDecideGroupPending(), { scanned: 1, approved: 0, escalated: 0 });
	assert.equal(decisions(foreign).length, 0);

	// Conector de B no cartão de A: não é achado para o dono (A), então o conector fica sem fatos e escala.
	const conn = install([{ botId: "radar", confirmId: "c4", ...mcpCall("conn-b", NOTE.name) }]);
	assert.equal((await autoDecideGroupPending()).escalated, 1);
	assert.equal(decisions(conn).length, 0);
});

test("run de outro bot ou de outro dono não vale como origem do cartão", async () => {
	const world = install([{ botId: "radar", confirmId: "c1", ...command("git status") }]);
	(prisma.agentRun as unknown as { findUnique: unknown }).findUnique = async () => ({ userId: "u2", botId: "radar", origin: "chat" });
	assert.equal((await autoDecideGroupPending()).escalated, 1);
	assert.equal(decisions(world).length, 0);
});
