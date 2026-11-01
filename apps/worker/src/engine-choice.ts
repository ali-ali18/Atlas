/**
 * Motor do run (ADR 0002, F2): escolhe entre o laço atual (v1) e o v2 no começo do run e congela a escolha em
 * `budgetJson.engine`, para a retomada continuar no mesmo motor. O v1 é o padrão; o v2 só roda no chat direto
 * de um bot que ligou `policyJson.engine = "v2"` (rotina, webhook, proativo, e-mail, bot→bot, subagente e grupo
 * seguem no v1 nesta fase).
 */
import { runComputerUse, runEngineV2, type ComputerUseParams, type RunComputerUseResult } from "@workspace/agent-runtime";
import {
	chooseRunEngine,
	readEnginePolicy,
	readHelperPolicy,
	readRunEngine,
	readRunProfile,
	resolveRunProfile,
	type RunEngine,
	type RunProfile,
} from "@workspace/shared";

export type EngineChoice = {
	engine: RunEngine;
	profile: RunProfile;
	longWorkBudgetUsd?: number;
	longWorkMinutes?: number;
	/** Ajudantes do trabalho longo: modelo barato opcional e quantos rodam juntos (`policyJson.helperModel` / `helperMaxParallel`). */
	helperModel?: string | null;
	helperMaxParallel?: number;
};

export async function pickRunEngine(input: {
	run: { origin: string; budgetJson?: unknown };
	policyJson: unknown;
	isGroupRun: boolean;
	/** O run já tem checkpoint (retomada): sem motor gravado ele nasceu no v1, antes desta fase. */
	hasCheckpoint: boolean;
	lastUserText: string;
	/**
	 * O run usa recursos que o v2 ainda não tem (modo proativo do bot, alerta, evento de configuração do bot sem
	 * mensagem digitada): fica no v1. Só vale para run novo; o motor já gravado vence.
	 */
	forceV1?: boolean;
	/** Grava a escolha no run de forma atômica e devolve o motor que ficou valendo (o gravado agora ou o que já estava). */
	record: (choice: { engine: RunEngine; profile: RunProfile }) => Promise<RunEngine | null>;
}): Promise<EngineChoice> {
	const policy = readEnginePolicy(input.policyJson);
	const stored = readRunEngine(input.run.budgetJson) ?? (input.hasCheckpoint ? "v1" : undefined);
	const engine = !stored && input.forceV1 ? "v1" : chooseRunEngine({ stored, policy, origin: input.run.origin, isGroupRun: input.isGroupRun });
	if (engine === "v1") return { engine, profile: "chat" };
	const profile = readRunProfile(input.run.budgetJson) ?? resolveRunProfile({ policy, text: input.lastUserText });
	if (!readRunEngine(input.run.budgetJson)) {
		// Sem a escolha gravada a retomada poderia trocar de motor: se não gravou, o run fica no v1.
		const recorded = await input.record({ engine, profile }).catch((error) => {
			console.error("record run engine failed; running on v1", error);
			return null;
		});
		if (recorded !== "v2") return { engine: "v1", profile: "chat" };
	}
	const helpers = readHelperPolicy(input.policyJson);
	return { engine, profile, longWorkBudgetUsd: policy.longWorkBudgetUsd, longWorkMinutes: policy.longWorkMinutes, helperModel: helpers.helperModel, helperMaxParallel: helpers.helperMaxParallel };
}

/** Roda o motor escolhido: mesma entrada e mesma saída nos dois. */
export function runSelectedEngine(choice: EngineChoice, params: ComputerUseParams): Promise<RunComputerUseResult> {
	if (choice.engine === "v2") {
		return runEngineV2(params, {
			profile: choice.profile,
			longWorkBudgetUsd: choice.longWorkBudgetUsd,
			longWorkMinutes: choice.longWorkMinutes,
			helpers: { model: choice.helperModel, maxParallel: choice.helperMaxParallel },
		});
	}
	return runComputerUse(params);
}
