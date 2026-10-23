import { parseChartSpec } from "@workspace/shared";
import { argsMatch, argsProblem } from "./predicates.js";
import { expectationName, type Expectation, type Scenario } from "./scenario.js";
import { chartBlocks, countQuestions, detectLanguage, endsWithQuestion, findInternals, isUnfulfilledPromise } from "./text.js";
import { mainCalls, offeredTools, type CheckResult, type Trajectory } from "./trajectory.js";

/**
 * Verificações determinísticas de uma trajetória. Cada uma devolve passou/falhou com o motivo curto que vai para a
 * matriz. O juiz LLM é opcional: sem `judge` injetado, a verificação `judge` fica como "pulada" e não conta.
 */

export type Judge = (input: { rubric: string; scenario: Scenario; trajectory: Trajectory }) => Promise<{ pass: boolean; reason: string }>;

const QUESTIONNAIRE_TOOL = "propose_questionnaire";

function toolMatcher(item: { tool?: string; toolPattern?: string }): (name: string) => boolean {
	if (item.tool) return (name) => name === item.tool;
	const pattern = new RegExp(item.toolPattern ?? "^$", "i");
	return (name) => pattern.test(name);
}

function textMatcher(item: { value?: string; pattern?: string; ignoreCase: boolean }): (text: string) => boolean {
	if (item.pattern) {
		const pattern = new RegExp(item.pattern, item.ignoreCase ? "i" : "");
		return (text) => pattern.test(text);
	}
	const value = item.value ?? "";
	return item.ignoreCase ? (text) => text.toLowerCase().includes(value.toLowerCase()) : (text) => text.includes(value);
}

/** Specs de gráfico entregues: eventos `chart` e blocos ```chart da resposta (inválidos entram com o erro). */
export function chartsOf(trajectory: Pick<Trajectory, "events" | "text">): Array<{ raw: unknown; error?: string }> {
	const fromEvents = trajectory.events.filter((event) => event.type === "chart").map((event) => ({ raw: event.spec as unknown }));
	const fromText = chartBlocks(trajectory.text).map((block) => {
		const parsed = parseChartSpec(block);
		let raw: unknown = block;
		try {
			raw = JSON.parse(block) as unknown;
		} catch {
			// mantém o texto cru; o erro já vem do parse
		}
		return parsed.ok ? { raw } : { raw, error: parsed.error };
	});
	return [...fromEvents, ...fromText];
}

/** Texto das mensagens de sistema e de tool enviadas ao modelo (notas e avisos do runtime). */
function runtimeNotes(trajectory: Trajectory): string {
	return mainCalls(trajectory)
		.flatMap((call) => call.messages as Array<{ role?: string; content?: unknown }>)
		.filter((message) => message.role === "system" || message.role === "tool")
		.map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "")))
		.join("\n");
}

function check(name: string, problem: string | null): CheckResult {
	return problem ? { name, pass: false, detail: problem } : { name, pass: true };
}

/** Uma verificação síncrona; `judge` é tratado em `runChecks`. */
export function evaluateExpectation(item: Exclude<Expectation, { type: "judge" }>, scenario: Scenario, trajectory: Trajectory): CheckResult {
	const name = expectationName(item);
	const called = trajectory.toolCalls;
	switch (item.type) {
		case "tool_called": {
			const matches = toolMatcher(item);
			const sameTool = called.filter((call) => matches(call.name));
			const hits = sameTool.filter((call) => argsMatch(call.args, item.args));
			const min = item.min ?? 1;
			if (hits.length < min) {
				if (sameTool.length > 0 && item.args) return check(name, `argumentos: ${argsProblem(sameTool[0]!.args, item.args)}`);
				return check(name, `não chamou (${called.map((call) => call.name).join(",") || "nenhuma tool"})`);
			}
			if (item.max !== undefined && hits.length > item.max) return check(name, `chamou ${hits.length}x (máx ${item.max})`);
			return check(name, null);
		}
		case "tool_not_called": {
			const matches = toolMatcher(item);
			const hit = called.find((call) => matches(call.name) && argsMatch(call.args, item.args));
			return check(name, hit ? `chamou ${hit.name}` : null);
		}
		case "no_question": {
			if (called.some((call) => call.name === QUESTIONNAIRE_TOOL)) return check(name, "abriu questionário");
			return check(name, endsWithQuestion(trajectory.text) ? "terminou com pergunta" : null);
		}
		case "asks_question": {
			const questions = countQuestions(trajectory.text) + (called.some((call) => call.name === QUESTIONNAIRE_TOOL) ? 1 : 0);
			if (questions === 0) return check(name, "não perguntou");
			return check(name, questions > item.max ? `${questions} perguntas (máx ${item.max})` : null);
		}
		case "text_contains":
			return check(name, textMatcher(item)(trajectory.text) ? null : `texto sem ${item.pattern ? `/${item.pattern}/` : `"${item.value}"`}`);
		case "text_not_contains":
			return check(name, textMatcher(item)(trajectory.text) ? `texto com ${item.pattern ? `/${item.pattern}/` : `"${item.value}"`}` : null);
		case "max_model_calls": {
			const count = mainCalls(trajectory).length;
			return check(name, count > item.value ? `${count} passos (máx ${item.value})` : null);
		}
		case "max_discards":
			return check(name, trajectory.discards.length > item.value ? `refez ${trajectory.discards.length}x (${trajectory.discards.join(",")})` : null);
		case "language": {
			const detected = detectLanguage(trajectory.text);
			return check(name, detected && detected !== item.value ? `respondeu em ${detected}` : detected ? null : "idioma indefinido (texto curto)");
		}
		case "no_internals": {
			const visibleText = [trajectory.text, ...trajectory.visible].join("\n");
			const leaked = findInternals(visibleText, offeredTools(trajectory), item.extraTerms);
			return check(name, leaked.length > 0 ? `vazou: ${leaked.join(", ")}` : null);
		}
		case "file_created": {
			const files = trajectory.events.filter((event) => event.type === "file").map((event) => String(event.filename ?? ""));
			if (files.length === 0) return check(name, "nenhum arquivo");
			const extension = item.extension?.toLowerCase();
			return check(name, extension && !files.some((file) => file.toLowerCase().endsWith(`.${extension}`)) ? `arquivo com outra extensão (${files.join(",")})` : null);
		}
		case "chart": {
			const charts = chartsOf(trajectory);
			if (charts.length === 0) return check(name, "nenhum gráfico");
			const valid = charts.filter((chart) => !chart.error);
			if (valid.length === 0) return check(name, `gráfico inválido: ${charts[0]!.error}`);
			const hit = valid.find((chart) => argsMatch(chart.raw, item.spec));
			return check(name, hit ? null : `spec: ${argsProblem(valid[0]!.raw, item.spec)}`);
		}
		case "no_unfulfilled_promise":
			return check(name, isUnfulfilledPromise(trajectory.text) ? "terminou prometendo" : null);
		case "no_model_note": {
			const match = runtimeNotes(trajectory).match(new RegExp(item.pattern, "i"));
			return check(name, match ? `nota do runtime: "${match[0]}"` : null);
		}
		case "steer_delivered": {
			const contents = scenario.steer.map((steer) => steer.content);
			if (contents.length === 0) return check(name, "cenário sem mensagem no meio do run");
			const delivered = mainCalls(trajectory).some((call) =>
				(call.messages as Array<{ role?: string; content?: unknown }>).some((message) => message.role === "user" && contents.some((content) => String(message.content ?? "").includes(content))),
			);
			return check(name, delivered ? null : "mensagem do meio do run não chegou ao modelo");
		}
		case "completed":
			return check(name, trajectory.error ? `run falhou: ${trajectory.error.slice(0, 160)}` : trajectory.text.trim() ? null : "resposta vazia");
	}
}

/** Todas as verificações do cenário. Erro do run (exceção, timeout) falha `completed` mesmo sem ele declarado. */
export async function runChecks(scenario: Scenario, trajectory: Trajectory, options: { judge?: Judge } = {}): Promise<CheckResult[]> {
	const results: CheckResult[] = [];
	if (trajectory.error && !scenario.expect.some((item) => item.type === "completed")) {
		results.push(evaluateExpectation({ type: "completed" }, scenario, trajectory));
	}
	for (const item of scenario.expect) {
		if (item.type !== "judge") {
			results.push(evaluateExpectation(item, scenario, trajectory));
			continue;
		}
		const name = expectationName(item);
		if (!options.judge) {
			results.push({ name, pass: true, skipped: true, detail: "juiz desligado" });
			continue;
		}
		try {
			const verdict = await options.judge({ rubric: item.rubric, scenario, trajectory });
			results.push(verdict.pass ? { name, pass: true, detail: verdict.reason } : { name, pass: false, detail: verdict.reason });
		} catch (error) {
			results.push({ name, pass: false, detail: `juiz falhou: ${error instanceof Error ? error.message.slice(0, 120) : "erro"}` });
		}
	}
	return results;
}

export const passed = (checks: CheckResult[]): boolean => checks.every((item) => item.pass || item.skipped);
