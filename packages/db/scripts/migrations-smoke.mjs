#!/usr/bin/env node
// Smoke das migrations: `prisma migrate deploy` do ZERO contra o banco de DATABASE_URL e checagem de que
// TODAS aplicaram sem erro (nenhuma pendente, falha ou revertida) e que `migrate status` está em dia.
// Cobre migrations com funções/gatilhos SQL (um erro de sintaxe ali só aparece ao aplicar). O banco deve ser
// descartável (o nome precisa conter "test"); `pnpm test:db` roda isto antes dos testes.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const url = process.env.DATABASE_URL;
if (!url || !/test/i.test(new URL(url).pathname)) {
	console.error("[migrations-smoke] recusado: defina DATABASE_URL de um banco descartável (nome contendo 'test').");
	process.exit(2);
}
const prismaCli = resolve(pkgDir, "node_modules/prisma/build/index.js");
const run = (args) => spawnSync(process.execPath, [prismaCli, ...args], { cwd: pkgDir, env: process.env, stdio: "inherit" });

if (run(["migrate", "deploy"]).status !== 0) {
	console.error("[migrations-smoke] FALHA: migrate deploy não concluiu.");
	process.exit(1);
}
const expected = readdirSync(resolve(pkgDir, "prisma/migrations"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
const prisma = new PrismaClient();
try {
	const rows = await prisma.$queryRaw`SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY migration_name`;
	const applied = rows.filter((row) => row.finished_at && !row.rolled_back_at).map((row) => row.migration_name);
	const broken = rows.filter((row) => !row.finished_at || row.rolled_back_at).map((row) => row.migration_name);
	const missing = expected.filter((name) => !applied.includes(name));
	if (broken.length || missing.length) {
		console.error(`[migrations-smoke] FALHA: com erro/revertidas=${JSON.stringify(broken)} não aplicadas=${JSON.stringify(missing)}`);
		process.exit(1);
	}
	console.log(`[migrations-smoke] ok: ${applied.length}/${expected.length} migrations aplicadas do zero.`);
} finally {
	await prisma.$disconnect();
}
if (run(["migrate", "status"]).status !== 0) {
	console.error("[migrations-smoke] FALHA: migrate status acusou divergência.");
	process.exit(1);
}
