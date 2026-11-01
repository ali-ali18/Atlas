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
};

export async function pickRunEngine(input: {
	run: { origin: string; budgetJson?: unknown };
	policyJson: unknown;
	isGroupRun: boolean;
	/** O run já tem checkpoint (retomada): sem motor gravado ele nasceu no v1, antes desta fase. */
	hasCheckpoint: boolean;
	lastUserText: string;
	/** Grava a escolha no run (falha nunca derruba o run). */
	record: (choice: { engine: RunEngine; profile: RunProfile }) => Promise<void>;
}): Promise<EngineChoice> {
	const policy = readEnginePolicy(input.policyJson);
	const stored = readRunEngine(input.run.budgetJson) ?? (input.hasCheckpoint ? "v1" : undefined);
	const engine = chooseRunEngine({ stored, policy, origin: input.run.origin, isGroupRun: input.isGroupRun });
	if (engine === "v1") return { engine, profile: "chat" };
	const profile = readRunProfile(input.run.budgetJson) ?? resolveRunProfile({ policy, text: input.lastUserText });
	if (!readRunEngine(input.run.budgetJson)) {
		await input.record({ engine, profile }).catch((error) => console.error("record run engine failed", error));
	}
	return { engine, profile, longWorkBudgetUsd: policy.longWorkBudgetUsd, longWorkMinutes: policy.longWorkMinutes };
}

/** Roda o motor escolhido: mesma entrada e mesma saída nos dois. */
export function runSelectedEngine(choice: EngineChoice, params: ComputerUseParams): Promise<RunComputerUseResult> {
	if (choice.engine === "v2") {
		return runEngineV2(params, { profile: choice.profile, longWorkBudgetUsd: choice.longWorkBudgetUsd, longWorkMinutes: choice.longWorkMinutes });
	}
	return runComputerUse(params);
}
