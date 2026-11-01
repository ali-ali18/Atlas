/**
 * Motor do run (ADR 0002, F2): escolhe entre o laço atual (v1) e o v2 no começo do run e congela a escolha em
 * `budgetJson.engine`, para a retomada continuar no mesmo motor. O v1 é o padrão. O v2 roda no chat direto de um
 * bot que ligou `policyJson.engine = "v2"` e, com `policyJson.engineScope = "all"`, também em rotina, grupo,
 * bot→bot, proativo (reflexão e lembrete), webhook e e-mail recebido. Subagente herda o motor do pai. O padrão global `ATLAS_ENGINE_V2_DEFAULT`
 * (`off` | `chat` | `all`, desligado) vale para bots que não escolheram o motor; `engine: "v1"` explícito nunca vai ao v2.
 */
import { effectiveCostCapUsd } from "./run-config.js";
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
	type RunConfigSnapshot,
	type RunProfile,
} from "@workspace/shared";

/** Padrão global do deploy. Única leitura do env: aqui, na borda do worker (a decisão é pura, em `shared`). */
export function engineDefaultFromEnv(env: Record<string, string | undefined> = process.env): EngineDefault {
	return readEngineDefault(env.ATLAS_ENGINE_V2_DEFAULT);
}

export type EngineChoice = {
	engine: RunEngine;
	profile: RunProfile;
	longWorkBudgetUsd?: number;
	longWorkMinutes?: number;
	/** O bot gravou o valor: no trabalho longo ele vale mais que o teto por execução da conta (ver `longWorkOwnerLimits`). */
	longWorkBudgetExplicit?: boolean;
	longWorkMinutesExplicit?: boolean;
	/** Piso de orçamento do brief e do lembrete `check` (perfil continua `chat`); ver `SHORT_RUN_LONGER_FLOOR`. */
	budgetFloor?: { costUsd: number; minutes: number };
	/** Ajudantes do trabalho longo: modelo barato opcional e quantos rodam juntos (`policyJson.helperModel` / `helperMaxParallel`). */
	helperModel?: string | null;
	helperMaxParallel?: number;
	/** Máximo de saída do modelo no catálogo (limita o teto do documento no trabalho longo). */
	modelMaxOutputTokens?: (modelId: string) => Promise<number | null>;
};

/**
 * Piso do brief "Seu dia" e do lembrete `check`. No v1 essas execuções não têm teto de custo e correm até
 * `BUDGET_WALL_DEFAULT_MS` (30 min); o v2 precisa de um número, então usa o `long_work` configurado do bot
 * (padrão US$ 0,50) e 30 min, sem ligar lista de tarefas nem entrega em documento (o perfil segue `chat`).
 * Os tetos de custo e tempo da conta/bot continuam valendo por cima.
 */
export const V1_SHORT_RUN_WALL_MINUTES = 30;

export async function pickRunEngine(input: {
	run: { origin: string; budgetJson?: unknown };
	policyJson: unknown;
	isGroupRun: boolean;
	/** O run já tem checkpoint (retomada): sem motor gravado ele nasceu no v1, antes desta fase. */
	hasCheckpoint: boolean;
	lastUserText: string;
	/** Gancho para um recurso novo do v1 que o v2 ainda não cobre: o run novo fica no v1 (hoje o worker não o usa). O motor já gravado vence. */
	forceV1?: boolean;
	/**
	 * Verificação curta que nunca é trabalho longo (alerta, brief "Seu dia", reflexão/lembrete proativo, evento de
	 * configuração do bot): perfil `chat`, mesmo que o pedido pareça relatório ou o bot force `long_work`.
	 */
	shortRun?: boolean;
	/** Brief "Seu dia" e lembrete `check`: perfil `chat`, mas com o piso de orçamento do v1 (`budgetFloor`). */
	longerShortRun?: boolean;
	/** Padrão global do deploy (`engineDefaultFromEnv()`); ausente = desligado. */
	globalDefault?: EngineDefault;
	/** Grava a escolha no run de forma atômica e devolve o motor que ficou valendo (o gravado agora ou o que já estava). */
	record: (choice: { engine: RunEngine; profile: RunProfile }) => Promise<RunEngine | null>;
}): Promise<EngineChoice> {
	const policy = readEnginePolicy(input.policyJson);
	const stored = readRunEngine(input.run.budgetJson) ?? (input.hasCheckpoint ? "v1" : undefined);
	const engine = !stored && input.forceV1 ? "v1" : chooseRunEngine({ stored, policy, origin: input.run.origin, isGroupRun: input.isGroupRun, globalDefault: input.globalDefault });
	if (engine === "v1") return { engine, profile: "chat" };
	const profile =
		readRunProfile(input.run.budgetJson) ?? (input.shortRun ? "chat" : resolveRunProfile({ policy, text: input.lastUserText, origin: input.run.origin }));
	if (!readRunEngine(input.run.budgetJson)) {
		// Sem a escolha gravada a retomada poderia trocar de motor: se não gravou, o run fica no v1.
		const recorded = await input.record({ engine, profile }).catch((error) => {
			console.error("record run engine failed; running on v1", error);
			return null;
		});
		if (recorded !== "v2") return { engine: "v1", profile: "chat" };
	}
	const helpers = readHelperPolicy(input.policyJson);
	const budgetFloor = input.longerShortRun ? { costUsd: policy.longWorkBudgetUsd, minutes: Math.max(policy.longWorkMinutes, V1_SHORT_RUN_WALL_MINUTES) } : undefined;
	return {
		engine,
		profile,
		...(budgetFloor ? { budgetFloor } : {}),
		longWorkBudgetUsd: policy.longWorkBudgetUsd,
		longWorkMinutes: policy.longWorkMinutes,
		longWorkBudgetExplicit: policy.longWorkBudgetExplicit,
		longWorkMinutesExplicit: policy.longWorkMinutesExplicit,
		helperModel: helpers.helperModel,
		helperMaxParallel: helpers.helperMaxParallel,
	};
}

/**
 * Trabalho longo no v2: o orçamento (US$ e minutos) que o dono pôs NO BOT vale mais que o teto por execução da conta
 * (padrão 0,25; o `min` antigo transformava o US$ 1 do bot em 0,50). Sem valor gravado no bot, nada muda (a conta limita).
 * Chat curto sempre fica com o teto da conta. O teto do pedido (retomada com o que sobrou) continua valendo.
 */
export function longWorkOwnerLimits(
	choice: Pick<EngineChoice, "engine" | "profile" | "longWorkBudgetExplicit" | "longWorkMinutesExplicit" | "longWorkMinutes">,
	/** Só o chat com o dono digitando vale: rotina, bot→bot, webhook e e-mail ficam com o teto da conta. */
	context: { origin: string; humanTurn: boolean },
): {
	ignoreAccountCostCap: boolean;
	/** Tempo ativo (ms) que o bot definiu e que substitui o da conta; `undefined` = segue o da conta. */
	wallMs?: number;
} {
	const longWork = choice.engine === "v2" && choice.profile === "long_work" && context.origin === "chat" && context.humanTurn;
	return {
		ignoreAccountCostCap: longWork && choice.longWorkBudgetExplicit === true,
		...(longWork && choice.longWorkMinutesExplicit === true && choice.longWorkMinutes ? { wallMs: Math.round(choice.longWorkMinutes * 60_000) } : {}),
	};
}

/** Roda o motor escolhido: mesma entrada e mesma saída nos dois. */
export function runSelectedEngine(choice: EngineChoice, params: ComputerUseParams): Promise<RunComputerUseResult> {
	if (choice.engine === "v2") {
		return runEngineV2(params, {
			profile: choice.profile,
			longWorkBudgetUsd: choice.longWorkBudgetUsd,
			longWorkMinutes: choice.longWorkMinutes,
			budgetFloor: choice.budgetFloor,
			helpers: { model: choice.helperModel, maxParallel: choice.helperMaxParallel },
			modelMaxOutputTokens: choice.modelMaxOutputTokens,
		});
	}
	return runComputerUse(params);
}

/**
 * Tetos finais do run: custo (US$) e tempo ativo (ms) que o runtime recebe. Junta o teto do pedido/bot, o da conta e o
 * orçamento do bot no trabalho longo (ver `longWorkOwnerLimits`). Puro: o worker só repassa.
 */
export function resolveRunLimits(input: {
	choice: EngineChoice;
	origin: string;
	humanTurn: boolean;
	/** `budget.maxCostUsd` já resolvido (pedido > bot > conta do código). */
	requestOrBotCap: number | undefined;
	snapshot: Pick<RunConfigSnapshot, "maxRunCostUsd">;
	/** O pedido ou a política do bot fixou o tempo: vale mais que o orçamento de minutos do bot. */
	wallFixed: boolean;
}): { costCapUsd: number | undefined; wallMs?: number } {
	const owner = longWorkOwnerLimits(input.choice, { origin: input.origin, humanTurn: input.humanTurn });
	return {
		costCapUsd: effectiveCostCapUsd(input.requestOrBotCap, input.snapshot, { ignoreAccountCap: owner.ignoreAccountCostCap }),
		...(owner.wallMs !== undefined && !input.wallFixed ? { wallMs: owner.wallMs } : {}),
	};
}
