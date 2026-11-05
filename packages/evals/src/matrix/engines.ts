import type { Scenario } from "../scenario.js";
import type { RunScenarioOptions } from "../run-scenario.js";

/**
 * Eixo "motor" do `matrix`. UM mapa: id → adaptador. Hoje o runtime oferece v1 (`runComputerUse`) e v2 (`runEngineV2`),
 * escolhidos por `scenario.run.engine`.
 *
 * Como plugar um motor/preset novo (v3, v4, `v4:minimal`…): acrescente uma entrada em `ENGINE_ADAPTERS`. O adaptador
 * troca o que for preciso por `patchScenario` (campos do cenário) e/ou `runOptions` (opções do `runScenario`, ex.:
 * `engineV2` ou `runtimeOverrides` para um preset). O resto do `matrix` (orçamento, relatório, agregação) só vê o id.
 * O v3 vive num branch congelado e o v4 ainda não existe: ficam de fora até o runtime exportá-los.
 */

export type EngineAdapter = {
	id: string;
	description: string;
	patchScenario: (scenario: Scenario) => Scenario;
	runOptions?: () => Partial<RunScenarioOptions>;
};

const byRunEngine = (id: "v1" | "v2", description: string): EngineAdapter => ({
	id,
	description,
	patchScenario: (scenario) => ({ ...scenario, run: { ...scenario.run, engine: id } }),
});

export const ENGINE_ADAPTERS: Record<string, EngineAdapter> = {
	v1: byRunEngine("v1", "motor atual (runComputerUse)"),
	v2: byRunEngine("v2", "motor v2 (runEngineV2, perfil chat)"),
};

export function resolveEngines(ids: readonly string[], table: Record<string, EngineAdapter> = ENGINE_ADAPTERS): EngineAdapter[] {
	if (ids.length === 0) throw new Error("informe --engines (ex.: v2 ou v1,v2)");
	const unknown = ids.filter((id) => !table[id]);
	if (unknown.length > 0) throw new Error(`motor desconhecido: ${unknown.join(", ")} (disponíveis: ${Object.keys(table).join(", ")})`);
	return [...new Set(ids)].map((id) => table[id]!);
}
