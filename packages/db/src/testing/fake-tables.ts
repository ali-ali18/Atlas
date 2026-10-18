/**
 * Tabelas em memória para testes do db sem banco: implementam só o subconjunto
 * de `where`/`data` do Prisma que `runs.ts` usa (igualdade, null, lt/gt/in/not,
 * OR/AND, increment). Instale com `installFakes` e restaure em `afterEach`.
 * `$transaction` faz rollback das tabelas se a função lançar.
 */
import { prisma } from "../client.js";

export type FakeRow = Record<string, unknown>;
type Where = Record<string, unknown>;

function isOperator(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!(value instanceof Date) &&
		!Array.isArray(value)
	);
}

function compare(a: unknown, b: unknown): number {
	const x = a instanceof Date ? a.getTime() : (a as number);
	const y = b instanceof Date ? b.getTime() : (b as number);
	return x < y ? -1 : x > y ? 1 : 0;
}

function sameValue(a: unknown, b: unknown): boolean {
	if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
	return (a ?? null) === (b ?? null);
}

export function matches(row: FakeRow, where: Where | undefined): boolean {
	if (!where) return true;
	return Object.entries(where).every(([key, cond]) => {
		if (cond === undefined) return true;
		if (key === "OR") return (cond as Where[]).some((w) => matches(row, w));
		if (key === "AND") return (cond as Where[]).every((w) => matches(row, w));
		const value = row[key];
		if (!isOperator(cond)) return sameValue(value, cond);
		return Object.entries(cond).every(([op, arg]) => {
			switch (op) {
				case "lt":
					return value != null && compare(value, arg) < 0;
				case "lte":
					return value != null && compare(value, arg) <= 0;
				case "gt":
					return value != null && compare(value, arg) > 0;
				case "gte":
					return value != null && compare(value, arg) >= 0;
				case "in":
					return (arg as unknown[]).some((item) => sameValue(value, item));
				case "not":
					return !sameValue(value, arg);
				default:
					throw new Error(`operador não suportado no fake: ${op}`);
			}
		});
	});
}

function applyData(row: FakeRow, data: Record<string, unknown>) {
	for (const [key, value] of Object.entries(data)) {
		if (value === undefined) continue;
		if (isOperator(value) && "increment" in value) {
			row[key] = ((row[key] as number) ?? 0) + (value.increment as number);
		} else {
			row[key] = value;
		}
	}
	if ("updatedAt" in row && !("updatedAt" in data)) row.updatedAt = new Date();
}

type OrderBy = Record<string, "asc" | "desc">;

export class FakeTable {
	rows: FakeRow[];
	private nextId = 1;
	/** Chamado depois de cada `findMany` (simula corrida SELECT → UPDATE). */
	afterFindMany?: (rows: FakeRow[]) => void;
	/** Faz o próximo `create` lançar (simula violação de unicidade). */
	failNextCreateWith?: Error;

	/** `defaults` imita os @default do schema nas linhas criadas. */
	constructor(
		rows: FakeRow[] = [],
		private defaults: () => FakeRow = () => ({}),
	) {
		this.rows = rows;
	}

	async findUnique({ where }: { where: Where }) {
		// Chave composta do Prisma (ex.: runId_decisionIndex_subIndex) vira campos soltos.
		const flat: Where = {};
		for (const [key, value] of Object.entries(where)) {
			if (key.includes("_") && isOperator(value)) Object.assign(flat, value);
			else flat[key] = value;
		}
		return this.rows.find((row) => matches(row, flat)) ?? null;
	}
	async findUniqueOrThrow(args: { where: Where }) {
		const row = await this.findUnique(args);
		if (!row) throw new Error("não encontrado");
		return row;
	}
	async findFirst({ where, orderBy }: { where?: Where; orderBy?: OrderBy } = {}) {
		return (await this.findMany({ where, orderBy, take: 1 }))[0] ?? null;
	}
	async findMany({ where, orderBy, take }: { where?: Where; orderBy?: OrderBy; take?: number } = {}) {
		let found = this.rows.filter((row) => matches(row, where));
		if (orderBy) {
			const [key, dir] = Object.entries(orderBy)[0]!;
			found = [...found].sort((a, b) => compare(a[key], b[key]) * (dir === "desc" ? -1 : 1));
		}
		const result = take === undefined ? found : found.slice(0, take);
		this.afterFindMany?.(result);
		return result;
	}
	async count({ where }: { where?: Where } = {}) {
		return this.rows.filter((row) => matches(row, where)).length;
	}
	async updateMany({ where, data }: { where?: Where; data: Record<string, unknown> }) {
		const found = this.rows.filter((row) => matches(row, where));
		for (const row of found) applyData(row, data);
		return { count: found.length };
	}
	async deleteMany({ where }: { where?: Where } = {}) {
		const found = this.rows.filter((row) => matches(row, where));
		this.rows = this.rows.filter((row) => !found.includes(row));
		return { count: found.length };
	}
	async update({ where, data }: { where: Where; data: Record<string, unknown> }) {
		const row = await this.findUnique({ where });
		if (!row) throw new Error("não encontrado");
		applyData(row, data);
		return row;
	}
	async create({ data }: { data: Record<string, unknown> }) {
		if (this.failNextCreateWith) {
			const error = this.failNextCreateWith;
			this.failNextCreateWith = undefined;
			throw error;
		}
		const row: FakeRow = { id: `fake-${this.rows.length + this.nextId++}`, ...this.defaults(), ...data };
		this.rows.push(row);
		return row;
	}
	/** `createMany` do Prisma; `skipDuplicates` ignora (userId, conversationId) já existente. */
	async createMany({ data, skipDuplicates }: { data: Record<string, unknown>[]; skipDuplicates?: boolean }) {
		let count = 0;
		for (const item of data) {
			const duplicate = skipDuplicates && this.rows.some((row) => row.userId === item.userId && row.conversationId === item.conversationId);
			if (duplicate) continue;
			await this.create({ data: item });
			count += 1;
		}
		return { count };
	}
	async upsert({ where, create, update }: { where: Where; create: Record<string, unknown>; update: Record<string, unknown> }) {
		const row = await this.findUnique({ where });
		if (row) return this.update({ where: { id: row.id }, data: update });
		return this.create({ data: create });
	}
	snapshot() {
		return this.rows.map((row) => ({ ...row }));
	}
}

/** Troca `prisma.<modelo>` pelos fakes; `$transaction` com rollback; `$executeRaw` no-op. */
export function installFakes(tables: Record<string, FakeTable>): { restore: () => void } {
	const client = prisma as unknown as Record<string, unknown>;
	const originals: Record<string, unknown> = {};
	for (const [name, table] of Object.entries(tables)) {
		originals[name] = client[name];
		client[name] = table;
	}
	originals.$transaction = client.$transaction;
	originals.$executeRaw = client.$executeRaw;
	originals.$queryRaw = client.$queryRaw;
	client.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => {
		const saved = Object.values(tables).map((table) => table.snapshot());
		try {
			return await fn(prisma);
		} catch (error) {
			Object.values(tables).forEach((table, i) => {
				table.rows = saved[i]!;
			});
			throw error;
		}
	};
	client.$executeRaw = async () => 0;
	// Com leitura + mensagens em memória, dubla a consulta SQL de não lidas de `getUnreadStates`
	// (a SQL de verdade é coberta por bots.list-queries.db.test.ts): fala do assistente depois de
	// lastReadAt; a primeira é a mais antiga por (createdAt, id).
	const { conversationRead: reads, conversationMessage: messages } = tables;
	if (reads && messages) {
		client.$queryRaw = async (_strings: TemplateStringsArray, ...values: unknown[]) => {
			const userId = values[0];
			const ids = values.find(Array.isArray) as string[];
			return reads.rows
				.filter((read) => read.userId === userId && ids.includes(read.conversationId as string))
				.map((read) => {
					const fresh = messages.rows
						.filter((m) => m.conversationId === read.conversationId && m.role === "assistant" && (m.createdAt as Date) > (read.lastReadAt as Date))
						.sort((a, b) => (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime() || ((a.id as string) < (b.id as string) ? -1 : 1));
					return { conversationId: read.conversationId, unreadCount: fresh.length, firstUnreadMessageId: (fresh[0]?.id as string | undefined) ?? null };
				});
		};
	}
	return {
		restore: () => {
			for (const [name, value] of Object.entries(originals)) client[name] = value;
		},
	};
}
export { createMemoryUserEventStore } from "./memory-user-events.js";
