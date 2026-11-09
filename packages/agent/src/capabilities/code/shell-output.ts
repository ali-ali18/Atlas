// Formatação comum da saída de comando (shell e teste): sempre redigida, nunca cortada sem dizer onde está o resto.
import { redact } from "./call.js";
import type { CodeResultOf } from "./kinds.js";

export function describeRun(label: string, run: CodeResultOf<"shell">): string {
	const status = run.timedOut ? "timed out" : run.exitCode === 0 ? "exit 0" : `exit ${run.exitCode ?? "unknown"}`;
	const head = `${label}: ${status}${run.durationMs !== undefined ? ` in ${Math.round(run.durationMs / 100) / 10}s` : ""}.`;
	const spill = run.spillPath ? `\nThe output was long: the full text is in ${redact(run.spillPath)} (read it with code_read, in parts).` : "";
	return `${head}\n${redact(run.output)}${spill}`;
}
