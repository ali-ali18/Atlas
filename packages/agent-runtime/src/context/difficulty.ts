import type { ModelTier } from "@workspace/shared";
import { routeContextGroups } from "./intent-router.js";
import type { ContextGroup } from "./prompt-blocks.js";

/**
 * Dificuldade do pedido (Fácil, Média, Difícil), só por regras: usa o resultado
 * do roteador de intenção (grupos de ferramenta que o pedido toca) e o formato
 * do pedido. Puro e sem chamada ao modelo. Escolhe o nível de modelo do run no
 * modo Automático.
 */

/** Código, shell/VM, desktop: trabalho que costuma pedir o modelo mais forte. */
const HARD_GROUPS: readonly ContextGroup[] = ["dev", "shell", "desktop"];
/**
 * Ações que pedem ferramentas: consulta de dados, arquivos, navegador, pesquisa e análise.
 * Grupos que só aparecem por uma palavra solta (api, e-mail, cofre, bots, rotinas, imagens)
 * ficam de fora: citar o assunto não torna o pedido mais difícil. Anexos e conectores citados
 * com @ são sinais próprios; na dúvida o nível fica baixo e a subida de nível corrige.
 */
const MEDIUM_GROUPS: readonly ContextGroup[] = ["data", "files", "browser", "web", "code", "presentations"];

/** Pedido longo ou com várias etapas encadeadas. */
const LONG_REQUEST_CHARS = 700;
/** Pedido curto o bastante para ser conversa. */
const SHORT_REQUEST_CHARS = 280;
const SEQUENCE_MARKERS =
	/\b(depois|em seguida|logo apos|na sequencia|por fim|finalmente|passo a passo|etapas?|primeiro|segundo|terceiro|then|after that|next|finally|step by step|steps?)\b/g;
const NUMBERED_STEPS = /(^|\n)\s*(\d+[.)]|[-*•])\s+\S/g;

export type DifficultyInput = {
	/** Texto que o roteador de intenção lê (última fala + objetivo + fala anterior). */
	routerText: string;
	/** Última fala do usuário (mede o tamanho do pedido). */
	lastUserText?: string;
	hasImageAttachments?: boolean;
	/** Arquivos anexados (PDF, planilha, ...). */
	hasFileAttachments?: boolean;
	/** Conectores citados com `@App` neste turno. */
	connectorCount?: number;
	/** Run sem conversa (rotina, e-mail, webhook): sem o tamanho da fala para medir. */
	unattended?: boolean;
};

export type DifficultyResult = {
	tier: ModelTier;
	/** Motivo curto para telemetria (nunca texto do usuário). */
	reason: string;
};

function normalize(text: string): string {
	return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Quantas etapas encadeadas o pedido tem (marcadores de sequência e itens de lista). */
export function countRequestSteps(text: string): number {
	const plain = normalize(text);
	return (plain.match(SEQUENCE_MARKERS)?.length ?? 0) + (text.match(NUMBERED_STEPS)?.length ?? 0);
}

/** Classifica a partir dos grupos já roteados (útil quando o chamador já os tem). */
export function classifyDifficultyFromGroups(
	groups: ReadonlySet<ContextGroup>,
	input: Omit<DifficultyInput, "routerText">,
): DifficultyResult {
	const lastUser = input.lastUserText ?? "";
	const hardHit = HARD_GROUPS.find((group) => groups.has(group));
	if (hardHit) return { tier: "hard", reason: `group:${hardHit}` };

	const steps = countRequestSteps(lastUser);
	if (lastUser.length >= LONG_REQUEST_CHARS) return { tier: "hard", reason: "long_request" };
	if (steps >= 3) return { tier: "hard", reason: "multi_step" };
	if ((input.connectorCount ?? 0) >= 2) return { tier: "hard", reason: "connectors" };

	const mediumHits = MEDIUM_GROUPS.filter((group) => groups.has(group));
	// Navegador já arrasta imagens e pesquisa: só conta como várias ferramentas o que passa disso.
	const independent = mediumHits.filter((group) => !(groups.has("browser") && (group === "images" || group === "web")));
	if (independent.length >= 4) return { tier: "hard", reason: "many_tools" };

	if (mediumHits.length > 0) return { tier: "medium", reason: `group:${mediumHits[0]}` };
	if (input.hasFileAttachments) return { tier: "medium", reason: "file_attachment" };
	if (input.hasImageAttachments) return { tier: "medium", reason: "image_attachment" };
	if ((input.connectorCount ?? 0) >= 1) return { tier: "medium", reason: "connector" };
	if (steps >= 2) return { tier: "medium", reason: "multi_step" };
	if (lastUser.length > SHORT_REQUEST_CHARS && !input.unattended) return { tier: "medium", reason: "long_message" };
	return { tier: "easy", reason: "chat" };
}

export function classifyDifficulty(input: DifficultyInput): DifficultyResult {
	const groups = routeContextGroups({ text: input.routerText, hasImageAttachments: input.hasImageAttachments });
	return classifyDifficultyFromGroups(groups, input);
}
