import { resolveBudget } from "../budget.js";
import type { ComputerUseParams, RunComputerUseResult } from "../run-types.js";
import type { EngineV2Options } from "../engine-v2/run.js";
import { runEngineV3 } from "./loop.js";

export { runEngineV3, type EngineV3Deps, type EngineV3Options } from "./loop.js";

/**
 * Entrada do v3 com a mesma assinatura do v2 (o worker troca de motor sem mudar o resto). Do que o v2 recebe, o v3 usa
 * o teto de passos do DONO (`capSources.steps` diz que ele configurou) e o perfil de trabalho longo (só para o caderno,
 * PR8e); promoção e ajudantes não existem no v3.
 */
export function runEngineV3WithV2Options(params: ComputerUseParams, options: Pick<EngineV2Options, "capSources" | "profile">): Promise<RunComputerUseResult> {
	const ownerSteps = options.capSources?.steps ? resolveBudget({ maxSteps: params.maxSteps, policy: params.budget }).hardMaxSteps : undefined;
	return runEngineV3(params, { ...(ownerSteps !== undefined ? { ownerSteps } : {}), ...(options.profile === "long_work" ? { longWork: true } : {}) });
}
