import type { Judge, JudgeVerdict } from "./checks.js";
import type { StreamChat } from "./mock-model.js";
import { buildJudgePrompt, combineVerdicts, DEFAULT_MAX_GAP, DEFAULT_PASS_SCORE, describeQuality, JUDGE_SYSTEM, parseRubricAnswer, type RubricVerdict } from "./quality.js";
import type { Scenario } from "./scenario.js";
import type { Trajectory } from "./trajectory.js";

/**
 * Juízes LLM opcionais (`--judge a[,b]`), só no eval. Cada juiz vê o pedido, a resposta final, as tools chamadas e os
 * arquivos criados (nunca as verificações esperadas) e dá notas 1-5 por dimensão (`quality.ts`). Com dois juízes vale
 * o teto de discordância; com um, o comportamento antigo (aprova ou reprova) sobre o esquema novo.
 *
 * Prefira juízes de PROVEDORES diferentes (ex.: `anthropic/...` + `opencode-go/...`): dois modelos da mesma família
 * tendem a errar do mesmo jeito e a concordar por viés, não por acerto. O juiz do mesmo modelo que está sendo
 * avaliado também infla a nota (viés de autopreferência): evite.
 */

export type RubricJudge = (input: { rubric: string; scenario: Scenario; trajectory: Trajectory }) => Promise<RubricVerdict>;

/** Um juiz: chama o modelo UMA vez e valida o JSON. Erro de transporte ou JSON ruim viram `invalid`, nunca nota. */
export function createRubricJudge(options: { model: string; apiKey: string; streamChat: StreamChat; timeoutMs?: number }): RubricJudge {
	return async ({ rubric, scenario, trajectory }) => {
		try {
			const result = await options.streamChat({
				model: options.model,
				apiKey: options.apiKey,
				tools: [],
				toolChoice: "none",
				messages: [
					{ role: "system", content: JUDGE_SYSTEM },
					{ role: "user", content: buildJudgePrompt({ rubric, scenario, trajectory }) },
				],
				timeoutMs: options.timeoutMs ?? 60_000,
			});
			return parseRubricAnswer(result.message.content);
		} catch (error) {
			return { status: "invalid", error: `juiz falhou: ${error instanceof Error ? error.message.slice(0, 120) : "erro"}` };
		}
	};
}

/**
 * Junta 1 ou mais juízes na verificação `judge` do cenário. Os juízes rodam em paralelo e não se veem.
 * - passa: nota >= `passScore`;
 * - disputada ou inválida: a verificação fica "pulada" (não reprova nem aprova: sem medida); o resultado vai em `quality`.
 */
export function createJudgePanel(options: { judges: readonly RubricJudge[]; maxGap?: number; passScore?: number }): Judge {
	if (options.judges.length === 0) throw new Error("informe ao menos um juiz");
	const maxGap = options.maxGap ?? DEFAULT_MAX_GAP;
	const passScore = options.passScore ?? DEFAULT_PASS_SCORE;
	return async (input): Promise<JudgeVerdict> => {
		const verdicts = await Promise.all(options.judges.map((judge) => judge(input)));
		const quality = combineVerdicts(verdicts, { maxGap });
		const reason = describeQuality(quality);
		if (quality.status !== "scored") return { pass: true, skipped: true, reason, quality };
		return { pass: quality.score! >= passScore, reason, quality };
	};
}
