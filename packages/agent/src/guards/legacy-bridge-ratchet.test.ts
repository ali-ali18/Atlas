import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Catraca da ponte do legado (03 §0; 05-fases, guardas permanentes #3).
// A ponte `legacy-bridge/` é temporária: uma tool por arquivo, só para o que o legado ainda faz e o
// motor v4 não. Ela só pode ENCOLHER. Hoje não existe (0 arquivos).
//
// Regra: o número de arquivos em `packages/agent/src/legacy-bridge/` nunca passa de BASELINE.
// - Cresceu? Falha. A solução é migrar a capacidade para o motor, não subir o número.
// - Caiu? Baixe BASELINE no mesmo commit (o número só desce). Não suba nunca.
// - Chegou a 0 na F9: apague a pasta e este teste continua valendo como trava contra a volta.
export const LEGACY_BRIDGE_BASELINE = 0;

const BRIDGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "legacy-bridge");

export function countFiles(dir: string): number {
	if (!existsSync(dir)) return 0;
	return readdirSync(dir).reduce((total, name) => {
		const full = join(dir, name);
		return total + (statSync(full).isDirectory() ? countFiles(full) : 1);
	}, 0);
}

describe("catraca: legacy-bridge só encolhe", () => {
	it("a contagem de arquivos não passa do baseline", () => {
		const count = countFiles(BRIDGE_DIR);
		expect(
			count,
			`legacy-bridge/ tem ${count} arquivo(s); o teto é ${LEGACY_BRIDGE_BASELINE}. A ponte só pode encolher (03 §0): migre a capacidade para o motor em vez de ampliar a ponte. Se saiu arquivo, baixe LEGACY_BRIDGE_BASELINE no mesmo commit.`,
		).toBeLessThanOrEqual(LEGACY_BRIDGE_BASELINE);
	});

	it("o baseline nunca é negativo nem fracionário", () => {
		expect(Number.isInteger(LEGACY_BRIDGE_BASELINE) && LEGACY_BRIDGE_BASELINE >= 0).toBe(true);
	});

	it("auto-teste: a contagem enxerga arquivos em subpastas", () => {
		const here = dirname(fileURLToPath(import.meta.url));
		expect(countFiles(here)).toBeGreaterThan(0);
		expect(countFiles(join(here, "nao-existe"))).toBe(0);
	});
});
