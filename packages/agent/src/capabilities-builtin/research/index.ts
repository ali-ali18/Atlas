// Capacidade `research` (F3.2): pesquisa em plano, com ajudantes em paralelo. Lazy: uma linha no índice; a tool e as
// instruções só chegam quando o modelo chama `use_capability`. Fala só com a porta `Helpers`.
import { defineCapability } from "../../capabilities/define-capability.js";
import type { Helpers } from "../../ports/helpers.js";
import { RESEARCH_INSTRUCTIONS } from "./instructions.js";
import { createResearchTool } from "./research.js";

export { RESEARCH_INSTRUCTIONS } from "./instructions.js";
export { INLINE_RESULT_CHARS, MAX_RESEARCH_QUESTIONS, RESEARCH_HELPER_CAPABILITIES, RESEARCH_OUTPUT_FORMATS, type ResearchOutputFormat } from "./research.js";

export function createResearchCapability(helpers: Helpers) {
	return defineCapability({
		id: "research",
		title: "Pesquisa",
		summary: "Plan a broad or comparative research: parallel helpers, one source per claim, findings kept in a work note.",
		tools: [createResearchTool(helpers)],
		instructions: RESEARCH_INSTRUCTIONS,
	});
}
