/**
 * Motor do run (ADR 0002, F2): escolhe entre o laço atual (v1) e o v2 no começo do run e congela a escolha em
 * `budgetJson.engine`, para a retomada continuar no mesmo motor.
 *
 * Decisão do dono (01/11): o v2 é o PADRÃO. Bot sem `policyJson.engine` roda no v2 em todas as origens suportadas
 * (chat, rotina, grupo, bot→bot, proativo, webhook e e-mail recebido); subagente herda o motor do pai. `engine: "v1"`
 * explícito (escolha "Anterior" na engrenagem ou `set_engine`) nunca vai ao v2. `ATLAS_ENGINE_V2_DEFAULT` é o botão
 * de emergência do deploy: ausente, vazio ou desconhecido = `all`; `off` desliga o motor novo para TODOS os bots
 * (run novo no v1, até com `engine: "v2"` explícito; o run já gravado segue); `chat` limita ao chat os bots sem escolha. O `off` não aparece na UI (ela mostra o padrão, `ENGINE_DEFAULT_SCOPE`).
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
	/** Piso de TEMPO do brief e do lembrete `check` (perfil continua `chat`; sem piso em US$, não há teto em dinheiro por padrão). */
	budgetFloor?: { minutes: number };
	/** Ajudantes do trabalho longo: modelo barato opcional e quantos rodam juntos (`policyJson.helperModel` / `helperMaxParallel`). */
	helperModel?: string | null;
	helperMaxParallel?: number;
	/** Máximo de saída do modelo no catálogo (limita o teto do documento no trabalho longo). */
	modelMaxOutputTokens?: (modelId: string) => Promise<number | null>;
};

/**
 * Tempo do brief "Seu dia" e do lembrete `check` (sem ligar lista de tarefas nem entrega em documento: o perfil segue
 * `chat`). Antes era o piso sobre o chat de 8 min; o chat agora não tem teto de tempo (decisão do dono, 02/11), mas
 * estas execuções são SEM humano (rotina): mantêm o limite de antes (ver `UNATTENDED_WALL_MINUTES`). Não há piso em US$:
 * dinheiro só limita se o dono configurou (conta ou gasto máximo do bot).
 */
export const V1_SHORT_RUN_WALL_MINUTES = 30;

/**
 * Rotina, alerta, proativo e bot→bot rodam sem ninguém olhando e sem botão de parar à mão: um laço lento é custo
 * silencioso. O dono pediu para remover o orçamento de tempo do CHAT (02/11); aqui o limite de antes continua (o do
 * dono, se configurado, vale mais): chat curto 8 min, brief/lembrete `check` 30 min, trabalho longo 30 min (era o teto
 * efetivo de antes, o padrão de relógio da conta) ou os minutos do bot, e 30 min no motor anterior.
 */
export const UNATTENDED_CHAT_WALL_MINUTES = 8;
export const UNATTENDED_LONG_WORK_WALL_MINUTES = 30;
export const UNATTENDED_V1_WALL_MINUTES = 30;

/**
 * Teto de tempo (ms) de um run SEM humano no chat (rotina, alerta, proativo, bot→bot). Puro.
 * Trabalho longo sem humano usa min(minutos do bot, 30): o tempo do bot pensado para o chat do dono (até 180 min) não
 * estende uma rotina. Só um tempo fixado na conta ou no pedido passa de 30 (nesse caso `resolveRunLimits` nem chama esta função).
 */
export function unattendedWallMs(choice: Pick<EngineChoice, "engine" | "profile" | "longWorkMinutes" | "budgetFloor">): number {
	if (choice.engine !== "v2") return UNATTENDED_V1_WALL_MINUTES * 60_000;
	if (choice.profile === "long_work") return Math.round(Math.min(choice.longWorkMinutes ?? UNATTENDED_LONG_WORK_WALL_MINUTES, UNATTENDED_LONG_WORK_WALL_MINUTES) * 60_000);
	return Math.round((choice.budgetFloor?.minutes ?? UNATTENDED_CHAT_WALL_MINUTES) * 60_000);
}

export async function pickRunEngine(input: {
	run: { origin: string; budgetJson?: unknown };
	policyJson: unknown;
	isGroupRun: boolean;
	/** O run já tem checkpoint (retomada): sem motor gravado ele nasceu no v1, antes desta fase. */
	hasCheckpoint: boolean;
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
		readRunProfile(input.run.budgetJson) ?? (input.shortRun ? "chat" : resolveRunProfile({ policy }));
	if (!readRunEngine(input.run.budgetJson)) {
		// Sem a escolha gravada a retomada poderia trocar de motor: se não gravou, o run fica no v1.
		const recorded = await input.record({ engine, profile }).catch((error) => {
			console.error("record run engine failed; running on v1", error);
			return null;
		});
		if (recorded !== "v2") return { engine: "v1", profile: "chat" };
	}
	const helpers = readHelperPolicy(input.policyJson);
	const budgetFloor = input.longerShortRun ? { minutes: policy.longWorkMinutesExplicit ? Math.max(policy.longWorkMinutes, V1_SHORT_RUN_WALL_MINUTES) : V1_SHORT_RUN_WALL_MINUTES } : undefined;
	// `longWorkMinutes` só segue adiante se o dono preencheu: sem isso o trabalho longo não tem teto de tempo.
	return {
		engine,
		profile,
		...(budgetFloor ? { budgetFloor } : {}),
		longWorkBudgetUsd: policy.longWorkBudgetUsd,
		longWorkMinutes: policy.longWorkMinutesExplicit ? policy.longWorkMinutes : undefined,
		longWorkMinutesExplicit: policy.longWorkMinutesExplicit,
		helperModel: helpers.helperModel,
		helperMaxParallel: helpers.helperMaxParallel,
	};
}

/**
 * Sem teto em US$ por padrão em nenhum perfil nem origem (decisão do dono, 01/11): só vale dinheiro que o dono configurou,
 * que são o teto da conta (`execution.maxRunCostUsd`, vale para tudo, trabalho longo incluso), o gasto máximo do bot no
 * trabalho longo (`longWorkBudgetUsd`) e o teto do pedido. Quem protege de erro é o comportamento: repetição, falhas
 * seguidas, teto de passos e tempo máximo.
 *
 * No chat do dono (turno humano: digitado por ele, ou herdado do run pai em continuação automática e em resposta de
 * questionário/cartão) NÃO há teto de tempo (decisão do dono, 02/11); só o tempo máximo do bot (`longWorkMinutes`) vale, se o dono
 * o preencheu. O chat que ainda está no perfil `chat` pode virar trabalho longo no meio do run (`canPromote`) e leva o mesmo teto.
 */
export function longWorkOwnerLimits(
	choice: Pick<EngineChoice, "engine" | "profile" | "longWorkMinutes">,
	context: { origin: string; humanTurn: boolean },
): {
	/** Tempo máximo (ms) do bot, que substitui o da conta; `undefined` = segue o da conta. */
	wallMs?: number;
	/** Run de chat com humano no perfil `chat` do v2: promovível a trabalho longo no meio do run. */
	canPromote: boolean;
} {
	const v2Chat = choice.engine === "v2" && context.origin === "chat" && context.humanTurn;
	const owner = v2Chat && choice.profile === "long_work";
	const canPromote = v2Chat && choice.profile === "chat";
	return {
		canPromote,
		...((owner || canPromote) && choice.longWorkMinutes !== undefined ? { wallMs: Math.round(choice.longWorkMinutes * 60_000) } : {}),
	};
}

/**
 * Prazo provisório para o que roda ANTES da escolha do motor (conferir a sessão da VM herdada): o tempo do run se já houver,
 * senão o teto de run sem humano. Chat com humano sem teto não tem prazo.
 */
export function earlyWallMs(budgetWallMs: number, unattended: boolean): number {
	if (budgetWallMs > 0) return budgetWallMs;
	return unattended ? UNATTENDED_V1_WALL_MINUTES * 60_000 : 0;
}

/** Roda o motor escolhido: mesma entrada e mesma saída nos dois. */
export function runSelectedEngine(
	choice: EngineChoice,
	params: ComputerUseParams,
	promotion: { canPromote: boolean; onPromoted?: () => void | Promise<void>; capSources?: { cost?: "account" | "server" | "bot"; wall?: "account" | "bot" } } = { canPromote: false },
): Promise<RunComputerUseResult> {
	if (choice.engine === "v2") {
		return runEngineV2(params, {
			promotable: promotion.canPromote,
			onPromoted: promotion.onPromoted,
			...(promotion.capSources ? { capSources: promotion.capSources } : {}),
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
	/** `budget.maxCostUsd` já resolvido (pedido > bot; vazio = sem teto). */
	requestOrBotCap: number | undefined;
	snapshot: Pick<RunConfigSnapshot, "maxRunCostUsd" | "maxWallMinutes">;
	/**
	 * O pedido ou a política do bot fixou o tempo: vale mais que o orçamento de minutos do bot. O "Tempo máximo" da conta,
	 * se o dono programou, também é teto duro (chat e promoção nunca passam dele): ver `snapshot.maxWallMinutes`.
	 */
	wallFixed: boolean;
}): { costCapUsd: number | undefined; wallMs?: number; canPromote: boolean } {
	const owner = longWorkOwnerLimits(input.choice, { origin: input.origin, humanTurn: input.humanTurn });
	// Só teto configurado: pedido/bot e conta (o menor). Sem nenhum, sem limite em US$.
	const costCapUsd = effectiveCostCapUsd(input.requestOrBotCap, input.snapshot);
	// Tempo: o que o dono fixou (pedido, bot ou conta) vence; depois o tempo máximo do bot no chat humano; run sem humano
	// mantém o limite de antes (`unattendedWallMs`); chat humano sem nada configurado não tem teto de tempo.
	const ownerFixedWall = input.wallFixed || input.snapshot.maxWallMinutes !== undefined;
	const humanChat = input.origin === "chat" && input.humanTurn;
	const wallMs = ownerFixedWall ? undefined : owner.wallMs ?? (humanChat ? undefined : unattendedWallMs(input.choice));
	return {
		costCapUsd,
		canPromote: owner.canPromote,
		...(wallMs !== undefined ? { wallMs } : {}),
	};
}
