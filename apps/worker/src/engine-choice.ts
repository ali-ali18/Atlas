/**
 * Motor do run (ADR 0002, F2): escolhe entre o laço atual (v1) e o v2 no começo do run e congela a escolha em
 * `budgetJson.engine`, para a retomada continuar no mesmo motor. O v1 é o padrão. O v2 roda no chat direto de um
 * bot que ligou `policyJson.engine = "v2"` e, com `policyJson.engineScope = "all"`, também em rotina, grupo e
 * bot→bot. Subagente, webhook, e-mail e proativo seguem no v1. O padrão global `ATLAS_ENGINE_V2_DEFAULT`
 * (`off` | `chat` | `all`, desligado) vale para bots que não escolheram o motor; `engine: "v1"` explícito nunca vai ao v2.
 */
import { runComputerUse, runEngineV2, type ComputerUseParams, type RunComputerUseResult } from "@workspace/agent-runtime";
import {
	chooseRunEngine,
	readEngineDefault,
	readEnginePolicy,
	readHelperPolicy,
	readRunEngine,
	readRunProfile,
	resolveRunProfile,
	type EngineDefault,
	type RunEngine,
	type RunProfile,
} from "@workspace/shared";

/** Padrão global do deploy. Única leitura do env: aqui, na borda do worker (a decisão é pura, em `shared`). */
export function engineDefaultFromEnv(env: Record<string, string | undefined> = process.env): EngineDefault {
	return readEngineDefault(env.ATLAS_ENGINE_V2_DEFAULT);
}

/**
 * O run usa recursos que o v2 ainda não tem e por isso fica no v1, qualquer que seja a política do bot:
 * modo proativo do bot, alerta (veredito estruturado), evento de configuração do bot sem mensagem digitada,
 * brief "Seu dia" (rotina sem conversa, só leitura entregue pelo worker) e rotina "só importante" (usa `notify_user`).
 */
export function mustStayOnV1(input: {
	origin: string;
	proactive: boolean;
	alert: boolean;
	botConfigEvent: boolean;
	detachedBrief: boolean;
	routinePush: boolean;
}): boolean {
	if (input.proactive || input.alert || input.botConfigEvent) return true;
	return input.origin === "routine" && (input.detachedBrief || input.routinePush);
}

export type EngineChoice = {
	engine: RunEngine;
	profile: RunProfile;
	longWorkBudgetUsd?: number;
	longWorkMinutes?: number;
	/** Ajudantes do trabalho longo: modelo barato opcional e quantos rodam juntos (`policyJson.helperModel` / `helperMaxParallel`). */
	helperModel?: string | null;
	helperMaxParallel?: number;
	/** Máximo de saída do modelo no catálogo (limita o teto do documento no trabalho longo). */
	modelMaxOutputTokens?: (modelId: string) => Promise<number | null>;
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
	/** Padrão global do deploy (`engineDefaultFromEnv()`); ausente = desligado. */
	globalDefault?: EngineDefault;
	/** Grava a escolha no run de forma atômica e devolve o motor que ficou valendo (o gravado agora ou o que já estava). */
	record: (choice: { engine: RunEngine; profile: RunProfile }) => Promise<RunEngine | null>;
}): Promise<EngineChoice> {
	const policy = readEnginePolicy(input.policyJson);
	const stored = readRunEngine(input.run.budgetJson) ?? (input.hasCheckpoint ? "v1" : undefined);
	const engine = !stored && input.forceV1 ? "v1" : chooseRunEngine({ stored, policy, origin: input.run.origin, isGroupRun: input.isGroupRun, globalDefault: input.globalDefault });
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
			modelMaxOutputTokens: choice.modelMaxOutputTokens,
		});
	}
	return runComputerUse(params);
}
