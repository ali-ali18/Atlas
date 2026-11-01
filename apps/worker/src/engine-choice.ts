/**
 * Motor do run (ADR 0002, F2): escolhe entre o laço atual (v1) e o v2 no começo do run e congela a escolha em
 * `budgetJson.engine`, para a retomada continuar no mesmo motor.
 *
 * Decisão do dono (01/11): o v2 é o PADRÃO. Bot sem `policyJson.engine` roda no v2 em todas as origens suportadas
 * (chat, rotina, grupo, bot→bot, proativo, webhook e e-mail recebido); subagente herda o motor do pai. `engine: "v1"`
 * explícito (escolha "Anterior" na engrenagem ou `set_engine`) nunca vai ao v2. `ATLAS_ENGINE_V2_DEFAULT` é o botão
 * de emergência do deploy: ausente, vazio ou desconhecido = `all`; `off` devolve ao v1 todo bot sem escolha explícita;
 * `chat` limita ao chat direto. O `off` não aparece na UI (ela mostra o padrão, `ENGINE_DEFAULT_SCOPE`).
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

/** Padrão do deploy (`all` sem a variável). Única leitura do env: aqui, na borda do worker (a decisão é pura, em `shared`). */
export function engineDefaultFromEnv(env: Record<string, string | undefined> = process.env): EngineDefault {
	return readEngineDefault(env.ATLAS_ENGINE_V2_DEFAULT);
}

export type EngineChoice = {
	engine: RunEngine;
	profile: RunProfile;
	longWorkBudgetUsd?: number;
	longWorkMinutes?: number;
	/** Gasto máximo opcional por tarefa longa (vazio = sem limite em US$); tempo máximo da tarefa em minutos. */
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
/** Piso de custo (US$) do brief e do `check` quando o bot não definiu gasto máximo (o trabalho longo não tem mais padrão em US$). */
export const V1_SHORT_RUN_BUDGET_USD = 0.5;

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
	/** Padrão do deploy (`engineDefaultFromEnv()`); ausente = o padrão novo (`all`). */
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
	const budgetFloor = input.longerShortRun ? { costUsd: policy.longWorkBudgetUsd ?? V1_SHORT_RUN_BUDGET_USD, minutes: policy.longWorkMinutesExplicit ? Math.max(policy.longWorkMinutes, V1_SHORT_RUN_WALL_MINUTES) : V1_SHORT_RUN_WALL_MINUTES } : undefined;
	return {
		engine,
		profile,
		...(budgetFloor ? { budgetFloor } : {}),
		longWorkBudgetUsd: policy.longWorkBudgetUsd,
		longWorkMinutes: policy.longWorkMinutes,
		longWorkMinutesExplicit: policy.longWorkMinutesExplicit,
		helperModel: helpers.helperModel,
		helperMaxParallel: helpers.helperMaxParallel,
	};
}

/** Piso de segurança (US$ por execução) do trabalho longo sem dono quando nem a conta nem o bot definem teto. */
export const UNATTENDED_LONG_WORK_COST_FLOOR_USD = 0.5;

/**
 * Trabalho longo no v2 não tem teto em US$ por padrão e o teto por execução da conta (`execution.maxRunCostUsd`, padrão 0,25)
 * NÃO se aplica a ele no chat do dono (turno humano: digitado por ele, ou herdado do run pai em continuação automática e em
 * resposta de questionário/cartão): lá o árbitro é progresso e tempo (o preço varia demais entre modelos), e o tempo máximo é o
 * do bot (padrão 60 min). Rotina, bot→bot, proativo, webhook, e-mail e chat curto seguem com o teto da conta. O gasto máximo
 * opcional do bot (`longWorkBudgetUsd`) e o teto do pedido continuam valendo como teto duro.
 */
export function longWorkOwnerLimits(
	choice: Pick<EngineChoice, "engine" | "profile" | "longWorkMinutes">,
	context: { origin: string; humanTurn: boolean },
): {
	ignoreAccountCostCap: boolean;
	/** Tempo máximo (ms) do bot, que substitui o da conta; `undefined` = segue o da conta. */
	wallMs?: number;
} {
	const longWork = choice.engine === "v2" && choice.profile === "long_work";
	const owner = longWork && context.origin === "chat" && context.humanTurn;
	return {
		ignoreAccountCostCap: owner,
		...(owner && choice.longWorkMinutes ? { wallMs: Math.round(choice.longWorkMinutes * 60_000) } : {}),
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
	let costCapUsd = effectiveCostCapUsd(input.requestOrBotCap, input.snapshot, { ignoreAccountCap: owner.ignoreAccountCostCap });
	// Origem sem dono (rotina, bot→bot, proativo, webhook, e-mail) em trabalho longo sem nenhum teto em US$ (conta "sem limite" e
	// bot sem gasto máximo): piso de segurança por execução, porque ninguém está olhando.
	const longWork = input.choice.engine === "v2" && input.choice.profile === "long_work";
	if (longWork && !owner.ignoreAccountCostCap && costCapUsd === undefined && input.choice.longWorkBudgetUsd === undefined) costCapUsd = UNATTENDED_LONG_WORK_COST_FLOOR_USD;
	return {
		costCapUsd,
		...(owner.wallMs !== undefined && !input.wallFixed ? { wallMs: owner.wallMs } : {}),
	};
}
