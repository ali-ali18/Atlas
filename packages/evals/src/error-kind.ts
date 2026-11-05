import type { Trajectory } from "./trajectory.js";

/**
 * Natureza do erro que encerrou uma execução do matrix, para a matriz não culpar o modelo por falha de infraestrutura:
 * - `runtime_timeout`: corte de tempo do runtime (primeiro evento/ocioso, prazo da decisão).
 *   É defeito do harness (v2), não do modelo, e fica visível no relatório com esse nome.
 * - `provider`: erro de transporte do provedor (401/403 de chave, 408, 409, 429, 5xx, ou erro sem status, como rede).
 * Fica SEM tipo (conta contra o modelo): pedido recusado pelo provedor (400, 404, 422: modelo incompatível com tools,
 * contexto estourado) e o prazo do próprio eval (laço ou lentidão do modelo, reauditoria F0, N1 e N2).
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

export function classifyRunError(trajectory: Pick<Trajectory, "error" | "errorName" | "modelCalls"> & { timedOut?: boolean }): ErrorKind | undefined {
	const error = trajectory.error;
	if (!error) return undefined;
	if (trajectory.errorName === "TimeoutError" || RUNTIME_TIMEOUT_MESSAGES.has(error)) return "runtime_timeout";
	// O erro do run é o da chamada ao modelo que falhou (a mensagem do run é a da chamada, só que menos truncada).
	const origin = trajectory.modelCalls.find((call) => call.error && error.startsWith(call.error));
	if (!origin) return undefined;
	if (origin.errorName === "TimeoutError" || RUNTIME_TIMEOUT_MESSAGES.has(origin.error!)) return "runtime_timeout";
	return isTransportStatus(origin.errorStatus) ? "provider" : undefined;
}

/** Sem status (rede, DNS, conexão) ou status de transporte/autorização: falha de infraestrutura, não do modelo. */
export function isTransportStatus(status: number | undefined): boolean {
	if (status === undefined) return true;
	return status >= 500 || status === 401 || status === 403 || status === 408 || status === 409 || status === 429;
}
