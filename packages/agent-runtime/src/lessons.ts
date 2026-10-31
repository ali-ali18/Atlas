import {
	LESSONS_HEADER,
	connectorScopeKey,
	renderLessonsBlock,
	selectLessonsForInjection,
	type InjectableLesson,
	type LessonFeedbackEntry,
	type LessonRule,
} from "@workspace/shared";

/**
 * Lições de conector/tool no run. As do bot entram no prompt estável (db, `buildMemoryAugmentedMessages`); estas
 * entram no início do run (conectores já carregados) ou anexadas ao resultado da tool que carregou o conector depois,
 * uma vez por escopo e run, sem mensagem de sistema no meio da tarefa. Numa retomada, a conversa do checkpoint já
 * traz as notas: `seed` as reconhece e não repete.
 */

export type RunLesson = InjectableLesson & { ref?: string; /** Regra que só aperta o comportamento (hooks); ver `hooks/pre-tool.ts`. */ rule?: LessonRule | null };

export type RunLessonsParam = {
	/** Lições ativas do bot (todas as escopos; as de escopo bot só contam para a existência da tool de feedback). */
	items: readonly RunLesson[];
	/** Avisa o inspetor de uma injeção (ids completos das lições) em um escopo. */
	onInjected?: (info: { ids: string[]; key: string }) => void;
	/** Grava o feedback do modelo (padrão: banco). */
	recordFeedback?: (entries: LessonFeedbackEntry[]) => Promise<{ applied: string[]; unknown: string[]; retired: string[] }>;
};

export type LessonScopeRef = { key: string; label: string };

// Limites no título e na chave: sem eles `.*` + `[^\]\n]+` retrocedem de forma quadrática numa linha enorme.
const KEY_IN_HEADER = /^════ LIÇÕES APRENDIDAS .{0,400}\[([^\]\n]{1,200})\] ════$/;

export function createLessonInjector(items: readonly RunLesson[]) {
	const scoped = items.filter((item) => item.scope !== "bot" && item.scopeKey);
	const byKey = new Map<string, RunLesson[]>();
	for (const item of scoped) byKey.set(item.scopeKey!, [...(byKey.get(item.scopeKey!) ?? []), item]);
	const done = new Set<string>();
	return {
		/** Há alguma lição de conector/tool a injetar neste run? */
		get active(): boolean {
			return byKey.size > 0;
		},
		has(key: string): boolean {
			return byKey.has(key);
		},
		/** Marca como já injetadas as notas que a conversa (checkpoint) já contém: no início (system) ou anexadas a um resultado de tool. */
		seed(conversation: ReadonlyArray<{ role: string; content: unknown }>): void {
			for (const message of conversation) {
				if ((message.role !== "system" && message.role !== "tool") || typeof message.content !== "string" || !message.content.includes(LESSONS_HEADER.slice(0, 20))) continue;
				for (const line of message.content.split("\n")) {
					const key = line.replace(/^\[Runtime note\] /, "").match(KEY_IN_HEADER)?.[1];
					if (key) done.add(key);
				}
			}
		},
		/** Notas novas para os escopos dados (cada um no máximo uma vez). */
		notesFor(refs: readonly LessonScopeRef[]): Array<{ key: string; note: string; ids: string[] }> {
			const out: Array<{ key: string; note: string; ids: string[] }> = [];
			for (const ref of refs) {
				if (done.has(ref.key) || !byKey.has(ref.key)) continue;
				done.add(ref.key);
				const picked = selectLessonsForInjection(byKey.get(ref.key)!, { scopeKeys: [ref.key], onlyScopes: ["connector", "tool"] });
				const note = renderLessonsBlock(picked, { title: `${ref.label.replace(/[\[\]\n]/g, " ").slice(0, 60)} [${ref.key}]` });
				if (note) out.push({ key: ref.key, note, ids: picked.map((lesson) => lesson.id) });
			}
			return out;
		},
	};
}

/** Escopos (conector e tool) das tools carregadas agora: o conector MCP da tool e o próprio nome exposto. */
export function lessonScopesForTools(
	toolNames: readonly string[],
	connectorOf: (toolName: string) => { id: string; name: string } | undefined,
	injector: Pick<ReturnType<typeof createLessonInjector>, "has">,
): LessonScopeRef[] {
	const out: LessonScopeRef[] = [];
	const seen = new Set<string>();
	const add = (ref: LessonScopeRef) => {
		if (seen.has(ref.key) || !injector.has(ref.key)) return;
		seen.add(ref.key);
		out.push(ref);
	};
	for (const name of toolNames) {
		const connector = connectorOf(name);
		if (connector) add({ key: connectorScopeKey("mcp", connector.id), label: connector.name });
		add({ key: name, label: name });
	}
	return out;
}
