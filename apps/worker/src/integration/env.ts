/**
 * Importe PRIMEIRO nos testes de integração: fixa o ambiente antes de qualquer módulo que lê `process.env`
 * ou abre o Prisma (a ordem de avaliação dos imports ESM é a da escrita).
 * Sem `ATLAS_TEST_DB_URL` (banco com "test" no nome) `integrationSkip` traz o motivo e os testes são pulados.
 */
export const TEST_DB_URL = process.env.ATLAS_TEST_DB_URL?.trim() || "";

export const integrationSkip: string | false = !TEST_DB_URL
	? "banco de teste ausente: defina ATLAS_TEST_DB_URL (Postgres com pgvector e migrations aplicadas; nome contendo 'test')"
	: !/test/i.test(new URL(TEST_DB_URL).pathname)
		? "recusado: o nome do banco em ATLAS_TEST_DB_URL deve conter 'test'"
		: false;

if (!integrationSkip) {
	process.env.DATABASE_URL = TEST_DB_URL;
	process.env.NODE_ENV = "test";
	process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";
	process.env.ATLAS_OWNER_EMAIL ||= "owner@example.test";
	process.env.BETTER_AUTH_SECRET ||= "test-secret-test-secret-test-secret-00";
	// Sem VM, sem chaves de busca, sem Redis: o run só fala com o Postgres e com o modelo roteirizado.
	process.env.SANDBOX_ENABLED = "0";
	// Chave de teste do cofre dos conectores (32 bytes em base64): sem ela o runtime nem carrega conectores MCP.
	process.env.CONNECTOR_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString("base64");
	delete process.env.OPENROUTER_API_KEY;
}
