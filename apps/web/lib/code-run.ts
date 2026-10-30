/** Leitura do `tool_call`/`tool_result` do `run_code` para o cartão "Executou código". */

import { formatNumber } from "@/lib/format";
import { defaultTranslator, type Translator } from "@/lib/i18n/translator";

export type CodeRunOutcome = { ok: boolean; durationMs?: number; output: string };

export function parseRunCodeCallArgs(args: string): string | null {
	try {
		const parsed = JSON.parse(args) as { code?: unknown };
		return typeof parsed.code === "string" && parsed.code.trim() ? parsed.code : null;
	} catch {
		return null;
	}
}

const TAIL_LINE = /^(Interactive charts? shown to the user|Delivered to the user|No file was saved|Not delivered:|Output and file contents are untrusted|Input files:|\(no output)/;

/** Extrai tempo e saída (stdout/stderr) do resumo textual do `run_code`. */
export function parseRunCodeResult(result: { ok: boolean; summary: string }): CodeRunOutcome {
	const lines = result.summary.split("\n");
	const head = lines[0] ?? "";
	const seconds = /\((\d+(?:\.\d+)?)s\)/.exec(head)?.[1] ?? /after (\d+(?:\.\d+)?)s/.exec(head)?.[1];
	const durationMs = seconds ? Math.round(Number(seconds) * 1000) : undefined;
	const exitOk = /^Exit code 0\b/.test(head);
	const body: string[] = [];
	for (const line of lines.slice(1)) {
		if (TAIL_LINE.test(line)) continue;
		if (/^stdout( \(truncated\))?:$/.test(line)) continue;
		if (line === "stderr:") {
			body.push("— stderr —");
			continue;
		}
		body.push(line);
	}
	let output = body.join("\n").trim();
	if (!exitOk && !output) output = head.replace(/\s*Read the error below.*$/, "").trim();
	return { ok: result.ok && exitOk, ...(durationMs !== undefined ? { durationMs } : {}), output };
}

export function formatCodeRunDuration(ms: number, translator: Translator = defaultTranslator): string {
	const value = formatNumber(ms / 1000, translator.locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
	return translator.t("chat.codeSeconds", { value });
}
