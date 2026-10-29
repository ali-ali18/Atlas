import type { RoutineRunRecord } from "@workspace/shared";

import { defaultTranslator, type MessageKey, type Translator } from "@/lib/i18n/translator";

export type RoutineActionError = "pause" | "resume" | "run";

/** Chave da mensagem de cada erro de ação (o texto sai de `t(...)` no idioma da tela). */
export const ROUTINE_ACTION_ERROR_KEY = {
	pause: "routines.action.pause",
	resume: "routines.action.resume",
	run: "routines.action.run",
} as const satisfies Record<RoutineActionError, MessageKey>;

export function routineActionErrorText(error: RoutineActionError, { t }: Translator = defaultTranslator): string {
	return t(ROUTINE_ACTION_ERROR_KEY[error]);
}

/**
 * Toggle otimista: aplica `next` já, chama o servidor e, se falhar
 * (string de erro ou exceção), devolve ao valor anterior.
 */
export async function runOptimisticToggle({
	current,
	apply,
	request,
}: {
	current: boolean;
	apply: (value: boolean) => void;
	request: (next: boolean) => Promise<string | null | undefined>;
}): Promise<{ ok: boolean; error: RoutineActionError | null }> {
	const next = !current;
	apply(next);
	try {
		const error = await request(next);
		if (error) throw new Error(error);
		return { ok: true, error: null };
	} catch {
		apply(current);
		return { ok: false, error: next ? "resume" : "pause" };
	}
}

/** "Em execução…" enquanto o clique está pendente, o pai roda, ou a última run está ativa. */
export function isRoutineRunning({
	pending,
	running,
	runs,
}: {
	pending: boolean;
	running: boolean;
	runs: Pick<RoutineRunRecord, "status">[];
}): boolean {
	const latest = runs[0]?.status;
	return pending || running || latest === "running" || latest === "queued";
}

/** Dispara o teste; `false`/exceção = falha. */
export async function runTest(
	run: (() => unknown) | undefined,
): Promise<boolean> {
	try {
		const result = await run?.();
		return result !== false;
	} catch {
		return false;
	}
}

/** Copia texto; devolve se funcionou. */
export async function copyFieldText(
	text: string,
	writeText: ((value: string) => Promise<void>) | undefined,
): Promise<boolean> {
	if (!writeText) return false;
	try {
		await writeText(text);
		return true;
	} catch {
		return false;
	}
}

export type RoutineMenuItemId =
	| "toggle"
	| "edit"
	| "run"
	| "history"
	| "webhook"
	| "github"
	| "delete";

export type RoutineMenuItem = {
	id: RoutineMenuItemId;
	label: string;
	disabled?: boolean;
	destructive?: boolean;
	separatorBefore?: boolean;
};

/** Itens do menu de contexto da rotina (botão direito, long-press ou "…"). */
export function buildRoutineMenu({
	active,
	persisted,
	kind,
	running,
}: {
	active: boolean;
	persisted: boolean;
	kind: "webhook" | "github" | "other";
	running: boolean;
}, { t }: Translator = defaultTranslator): RoutineMenuItem[] {
	const items: RoutineMenuItem[] = [
		{ id: "toggle", label: active ? t("routines.menu.pause") : t("routines.menu.resume"), disabled: !persisted },
		{ id: "edit", label: t("routines.menu.edit") },
		{ id: "run", label: running ? t("routines.menu.running") : t("routines.menu.run"), disabled: !persisted || running },
		{ id: "history", label: t("routines.menu.history"), disabled: !persisted },
	];
	if (kind === "webhook") items.push({ id: "webhook", label: t("routines.menu.webhook"), disabled: !persisted });
	if (kind === "github") items.push({ id: "github", label: t("routines.menu.github"), disabled: !persisted });
	items.push({ id: "delete", label: t("routines.menu.delete"), destructive: true, separatorBefore: true, disabled: !persisted });
	return items;
}
