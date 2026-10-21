import { LESSON_RULE_KINDS, describeLessonRule, lessonRef, parseLessonRule, type LessonEvidence, type LessonOrigin, type LessonRule, type LessonRuleKind, type LessonView } from "@workspace/shared";

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

// ---------------------------------------------------------------------------------------------------------------------
// Regra da lição (hooks): o bot passa a cumprir, não só lembrar
// ---------------------------------------------------------------------------------------------------------------------

export const RULE_KIND_LABELS: Record<LessonRuleKind, string> = {
	required_args: "Exigir campos na chamada",
	require_prior_call: "Exigir uma chamada antes",
	confirm_always: "Sempre pedir confirmação",
};

/** Texto de ajuda de cada tipo (o que o bot passa a cumprir). */
export const RULE_KIND_HELP: Record<LessonRuleKind, string> = {
	required_args: "A chamada só segue se trouxer os campos indicados; senão o bot recebe o motivo e corrige.",
	require_prior_call: "Antes da ferramenta escolhida, a outra precisa ter dado certo neste mesmo atendimento.",
	confirm_always: "A ferramenta sempre mostra o cartão de confirmação, mesmo com a autonomia liberada.",
};

export const RULE_TIGHTEN_NOTE = "Regras só deixam o bot mais cuidadoso: não liberam aprovações nem mudam destinatários.";

export type LessonToolOption = { value: string; label: string; group: string; connectorKey?: string };

/** Ferramentas que a lição pode regular: as do conector (escopo conector), só a própria (escopo ferramenta) ou todas. */
export function toolOptionsForLesson(lesson: Pick<LessonView, "scope" | "scopeKey" | "rule">, options: readonly LessonToolOption[]): LessonToolOption[] {
	let list = options.filter((option) => (lesson.scope === "connector" ? option.connectorKey === lesson.scopeKey : lesson.scope === "tool" ? option.value === lesson.scopeKey : true));
	// A regra já gravada continua escolhível mesmo que a ferramenta tenha saído da lista (conector desligado).
	for (const name of lesson.rule ? [lesson.rule.tool, lesson.rule.kind === "require_prior_call" ? lesson.rule.requires : ""] : []) {
		if (name && !list.some((option) => option.value === name)) list = [...list, { value: name, label: name, group: "Atual" }];
	}
	return list;
}

export type RuleFormValues = { kind: LessonRuleKind; tool: string; requires: string; fields: string; note: string };

export function ruleToFormValues(rule: LessonRule | null | undefined): RuleFormValues {
	if (!rule) return { kind: LESSON_RULE_KINDS[0], tool: "", requires: "", fields: "", note: "" };
	return {
		kind: rule.kind,
		tool: rule.tool,
		requires: rule.kind === "require_prior_call" ? rule.requires : "",
		fields: rule.kind === "required_args" ? rule.fields.join(", ") : "",
		note: rule.kind === "required_args" ? (rule.note ?? "") : "",
	};
}

/** Monta e valida a regra do formulário com o mesmo validador estrito do servidor. */
export function ruleFromFormValues(values: RuleFormValues): { ok: true; rule: LessonRule } | { ok: false; error: string } {
	if (!values.tool.trim()) return { ok: false, error: "Escolha a ferramenta." };
	const raw =
		values.kind === "required_args"
			? { kind: values.kind, tool: values.tool.trim(), fields: values.fields.split(/[,\n]/).map((item) => item.trim()).filter(Boolean), ...(values.note.trim() ? { note: values.note.trim() } : {}) }
			: values.kind === "require_prior_call"
				? { kind: values.kind, tool: values.tool.trim(), requires: values.requires.trim(), within: "run" }
				: { kind: values.kind, tool: values.tool.trim() };
	if (values.kind === "require_prior_call" && !values.requires.trim()) return { ok: false, error: "Escolha a chamada que precisa vir antes." };
	if (values.kind === "required_args" && (raw as { fields: string[] }).fields.length === 0) return { ok: false, error: "Informe ao menos um campo, separado por vírgula (ex.: cliente.id, pagamento)." };
	const parsed = parseLessonRule(raw, { userAuthored: true });
	return parsed.ok ? parsed : { ok: false, error: parsed.reason };
}

export { describeLessonRule };
