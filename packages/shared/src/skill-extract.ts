import type { SkillRecipe } from "./skills.js";

/** Ferramentas que uma skill declarativa pode referenciar (fonte única). */
export const SKILL_AVAILABLE_TOOLS = [
	"navigate",
	"browser_text",
	"browser_links",
	"browser_click",
	"browser_type",
	"screenshot",
	"click",
	"type",
	"key",
	"scroll",
	"memory",
	"session_search",
	"memory_search",
	"checkpoint_read",
	"artifact_read",
	"web_search",
	"web_extract",
] as const;

export function normalizedLower(value: string): string {
	return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

const STOPWORDS = new Set([
	"para", "com", "esse", "essa", "este", "esta", "estes", "estas",
	"uma", "isso", "disso", "mas", "que", "nao", "sim", "como",
	"muito", "mais", "foi", "sao", "tem", "ser", "ter", "meu",
	"minha", "seu", "sua", "dos", "das", "nos", "nas", "por",
	"the", "and", "for", "with", "are", "was",
]);

export function keywordsOf(value: string, max = 6): string[] {
	const words = normalizedLower(value).split(/[^a-z0-9]+/).filter(w => w.length > 2 && !STOPWORDS.has(w));
	const seen = new Set<string>();
	const out: string[] = [];
	for (const w of words) {
		if (!seen.has(w)) { seen.add(w); out.push(w); }
		if (out.length >= max) break;
	}
	return out;
}

export function slugOf(value: string, max = 60): string {
	const slug = normalizedLower(value).split(/[^a-z0-9]+/).filter(Boolean).join("-").slice(0, max).replace(/^-+|-+$/g, "");
	return /^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/.test(slug) ? slug : "";
}

/**
 * Remove amaciante inicial ("tenta", "vai", "pode", "por favor") para detectar
 * a intenção real: "tenta limpar os rascunhos" => "limpar os rascunhos".
 * Só remove; a frase resultante ainda precisa casar um comando completo.
 */
export function stripCommandSofteners(text: string): string {
	const cleaned = text.trim().replace(/^(por favor,?\s*)?(tenta|tentar|tente|vai|vamos|pode|consegue|faz|fazer)\s+/i, "").trim();
	return cleaned.length > 0 ? cleaned : text.trim();
}
/** Garante triggers específicos (>=2 termos) E recuperáveis (frases curtas). */
export function withExplicitTriggers(recipe: SkillRecipe, cleaned: string): SkillRecipe {
	const keys = keywordsOf(cleaned, 5);
	const short = keys.slice(0, 3).join(" ");
	const triggers = short.includes(" ")
		? [short, `skill ${short}`.slice(0, 160)]
		: [`skill ${cleaned}`.trim().slice(0, 160), cleaned.slice(0, 160)].filter(
				(t, i, arr) => t.length > 0 && arr.indexOf(t) === i,
			);
	return { ...recipe, triggers: triggers.map((t) => t.slice(0, 160)) };
}
/** Extrator determinístico para qualquer repetição (web ou padrão de texto). Sem LLM, sem segredos. */
export function buildRepetitiveRecipe(objective: string, usedTools: string[], capabilityKeyOverride?: string): SkillRecipe {
	const keys = keywordsOf(objective, 5);
	const keyBase = keys.slice(0, 4).join("-") || "tarefa";
	const capabilityKey = (capabilityKeyOverride && slugOf(capabilityKeyOverride)) || slugOf(`rep-${keyBase}`) || "rep-tarefa-repetitiva";
	const title = objective.trim().slice(0, 120) || "Procedimento repetitivo";
	const description = `Procedimento repetitivo aprendido: ${objective.trim().slice(0, 400)}`;
	const triggerShort = keys.slice(0, 3).join(" ");
	const triggers = triggerShort && triggerShort.includes(" ")
		? [triggerShort, objective.trim().slice(0, 120)]
		: [objective.trim().slice(0, 120)];
	const tools = usedTools.length > 0 ? [...new Set(usedTools)].slice(0, 8) : ["memory_search"];
	const steps = tools.map(tool => ({
		instruction: tool === "memory_search" && usedTools.length === 0
			? "Consultar a memória por preferências e fatos relevantes; aplicar o padrão de texto observado (formato, tom e estrutura) à tarefa atual; conferir o resultado antes de concluir."
			: `Executar ${tool} conforme observado no run de origem; verificar a observação antes de concluir; interromper em falha ou autenticação.`,
		tool,
	}));
	return {
		capabilityKey,
		title,
		description,
		triggers: triggers.map(t => t.slice(0, 160)),
		preconditions: ["A tarefa atual autoriza executar este procedimento repetitivo.", "Os inputs necessários foram fornecidos na tarefa."],
		inputs: [],
		steps,
		postconditions: ["Resultado confere com o padrão observado e os inputs da tarefa."],
		failureModes: ["Inputs ausentes ou diferentes do padrão: não aplicar.", "Ferramenta indisponível ou observação divergente: não declarar sucesso."],
		requiredTools: tools,
	};
}
