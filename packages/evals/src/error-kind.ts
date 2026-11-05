import type { Trajectory } from "./trajectory.js";

/**
 * Natureza do erro que encerrou uma execução do matrix, para a matriz não culpar o modelo por falha de infraestrutura:
 * - `runtime_timeout`: corte de tempo do runtime (primeiro evento/ocioso, prazo da decisão) ou o prazo do próprio eval.
 *   É defeito do harness (v2), não do modelo, e fica visível no relatório com esse nome.
 * - `provider`: erro de transporte/HTTP do provedor (429, 5xx, rede, chave).
 * Sem erro, ou erro que não veio de uma chamada ao modelo: `undefined` (conta como execução do modelo).
 *
 * A classificação é determinística: usa o `name` do erro (`TimeoutError`) e os identificadores conhecidos que o próprio
 * runtime lança (`packages/llm/src/decision-budget.ts`), nunca texto do modelo nem do usuário.
 */
export type ErrorKind = "runtime_timeout" | "provider";

export const ERROR_KINDS: readonly ErrorKind[] = ["runtime_timeout", "provider"];

export const ERROR_KIND_LABELS: Record<ErrorKind, string> = { runtime_timeout: "corte de tempo do runtime", provider: "erro do provedor" };

/** Mensagens fixas dos cortes de tempo do runtime (`DOMException` `TimeoutError` em `decision-budget.ts`). */
export const RUNTIME_TIMEOUT_MESSAGES: ReadonlySet<string> = new Set(["First event or idle timeout", "Decision deadline exceeded"]);

export function classifyRunError(trajectory: Pick<Trajectory, "error" | "errorName" | "timedOut" | "modelCalls">): ErrorKind | undefined {
	if (trajectory.timedOut) return "runtime_timeout";
	const error = trajectory.error;
	if (!error) return undefined;
	if (trajectory.errorName === "TimeoutError" || RUNTIME_TIMEOUT_MESSAGES.has(error)) return "runtime_timeout";
	// O erro do run é o da chamada ao modelo que falhou (a mensagem do run é a da chamada, só que menos truncada).
	const origin = trajectory.modelCalls.find((call) => call.error && error.startsWith(call.error));
	if (!origin) return undefined;
	return origin.errorName === "TimeoutError" || RUNTIME_TIMEOUT_MESSAGES.has(origin.error!) ? "runtime_timeout" : "provider";
}
