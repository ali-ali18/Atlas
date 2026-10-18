/**
 * Testes de integração com Postgres+pgvector de verdade (`pnpm --filter @workspace/db test:db`).
 * Sem `ATLAS_TEST_DB_URL` os testes que usam estes helpers são PULADOS (com a mensagem abaixo), nunca falham.
 */
import { randomUUID } from "node:crypto";
import { prisma } from "../client.js";

export const TEST_DB_URL = process.env.ATLAS_TEST_DB_URL?.trim() || "";

/** Passe como `{ skip: dbSkip }` ao `describe`/`test`: `false` com banco, mensagem sem. */
export const dbSkip: string | false = !TEST_DB_URL
	? "banco de teste ausente: defina ATLAS_TEST_DB_URL ou rode `pnpm --filter @workspace/db test:db`"
	: !/test/i.test(new URL(TEST_DB_URL).pathname)
		? "recusado: o nome do banco em ATLAS_TEST_DB_URL deve conter 'test'"
		: process.env.DATABASE_URL !== TEST_DB_URL
			? "DATABASE_URL difere de ATLAS_TEST_DB_URL (use o script test:db)"
			: false;

/** Cria um usuário descartável (ids únicos: os testes não dependem de tabelas vazias). */
export async function createTestUser(label = "u"): Promise<{ id: string }> {
	const id = `${label}-${randomUUID()}`;
	await prisma.user.create({ data: { id, name: id, email: `${id}@test.local` } });
	return { id };
}

export async function createTestBot(
	ownerId: string,
	over: { isPrimary?: boolean; name?: string } = {},
): Promise<{ id: string }> {
	return prisma.bot.create({
		data: { ownerId, name: over.name ?? "bot", isPrimary: over.isPrimary ?? false },
		select: { id: true },
	});
}
