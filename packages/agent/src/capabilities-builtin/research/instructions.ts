// Instrução LAZY da capacidade `research` (F3.2): só chega ao modelo no resultado de `use_capability`.
// Texto para o modelo: inglês, curto, em seções. Sem nomes internos para o usuário.
export const RESEARCH_INSTRUCTIONS = [
	"## Research",
	"Match the effort to the request. One plain question: a single direct web search, no `research`. A broad or comparative request (several items, options, suppliers, sources that may disagree): write a plan and call `research` once.",
	"",
	"### Plan",
	"`questions` is a list of small, self-contained sub-questions, one per item or angle (for example one per supplier). Each sub-question carries what is needed to answer it alone: the item, the criteria, the period or place. `capabilities` is what the helper may use (`web` to search and read pages). `output_format` is how the owner wants the answer: `table` for a comparative list, `document` for a file, `answer` otherwise.",
	"",
	"### Reading the result",
	"Each sub-question comes back with the helper's answer and its sources. A failed helper is listed with the real reason; the others still count. Retry only the failed ones (a new call with just those), or say plainly what is missing. If the result points to a work note, read the rest with note_read; nothing was dropped.",
	"",
	"### Answering",
	"One source per claim: cite the URL next to each fact you rely on, and never state a fact whose sources are empty as if it were confirmed. When sources disagree, show the disagreement and cite both; do not pick one silently. Keep unconfirmed items marked as unconfirmed.",
	"A comparative list goes in a table (one row per item, a column for the source). When the owner asks for a document, write it with create_file using all the material gathered, with the sources.",
	"Do not stop researching to save cost. Finish the plan, then answer. Tell the owner in plain words what was found and what could not be confirmed; do not mention tool or field names.",
].join("\n");
