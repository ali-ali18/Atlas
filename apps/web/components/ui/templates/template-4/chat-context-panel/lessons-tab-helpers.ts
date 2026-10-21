import { lessonRef, type LessonEvidence, type LessonOrigin, type LessonView } from "@workspace/shared";

/** De onde veio a lição, em palavras do usuário. */
export function lessonOriginLabel(origin: LessonOrigin): string {
	if (origin === "correction") return "Você corrigiu";
	if (origin === "failure_recovery") return "Erro que se resolveu";
	if (origin === "failed_action") return "Ação que falhou";
	if (origin === "user") return "Você pediu";
	return "Reflexão do bot";
}

/** "Ajudou 3 · Atrapalhou 1 · Usada 5 vezes"; nada quando ainda não foi usada nem avaliada. */
export function lessonCounters(lesson: Pick<LessonView, "helpful" | "harmful" | "uses">): string | null {
	const parts: string[] = [];
	if (lesson.helpful > 0) parts.push(`Ajudou ${lesson.helpful}`);
	if (lesson.harmful > 0) parts.push(`Atrapalhou ${lesson.harmful}`);
	if (lesson.uses > 0) parts.push(lesson.uses === 1 ? "Usada 1 vez" : `Usada ${lesson.uses} vezes`);
	return parts.length > 0 ? parts.join(" · ") : null;
}

/** Texto da evidência para a lista expandida; null se a lição não guardou nenhuma. */
export function lessonEvidenceText(evidence: LessonEvidence | null): { kind: string; quote: string } | null {
	if (!evidence?.quote) return null;
	return { kind: evidence.source === "user" ? "O que você disse" : "O que aconteceu na execução", quote: evidence.quote };
}

export type LessonGroup = { id: string; title: string; note?: string; lessons: LessonView[] };

function toolLabel(key: string): string {
	return key.replace(/^mcp__.+?__/, "") || key;
}

/**
 * Agrupa por escopo: "Geral do bot" primeiro, depois um grupo por conector (nome vindo das conexões; sem nome, "Conector")
 * e por ferramenta. Dentro do grupo, a ordem recebida (as mais recentes primeiro) é mantida.
 */
export function groupLessons(lessons: readonly LessonView[], connectorNames: Readonly<Record<string, string>> = {}): LessonGroup[] {
	const groups = new Map<string, LessonGroup>();
	const add = (id: string, title: string, note: string | undefined, lesson: LessonView) => {
		const group = groups.get(id) ?? { id, title, ...(note ? { note } : {}), lessons: [] };
		group.lessons.push(lesson);
		groups.set(id, group);
	};
	for (const lesson of lessons) {
		if (lesson.scope === "bot" || !lesson.scopeKey) add("bot", "Geral do bot", "Vale em qualquer conversa", lesson);
		else if (lesson.scope === "connector") add(`connector:${lesson.scopeKey}`, `Conector · ${connectorNames[lesson.scopeKey] ?? "sem nome"}`, "Vale quando este conector é usado", lesson);
		else add(`tool:${lesson.scopeKey}`, `Ferramenta · ${toolLabel(lesson.scopeKey)}`, "Vale quando esta ferramenta é usada", lesson);
	}
	const order = (group: LessonGroup) => (group.id === "bot" ? 0 : group.id.startsWith("connector:") ? 1 : 2);
	return [...groups.values()].sort((a, b) => order(a) - order(b) || a.title.localeCompare(b.title, "pt-BR"));
}

/** Mensagem para falhas das ações da aba. */
export function lessonErrorMessage(cause: unknown, fallback: string): string {
	return cause instanceof Error && cause.message ? cause.message : fallback;
}

export { lessonRef };
