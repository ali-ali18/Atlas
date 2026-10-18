// F12/A1 — resolve o alvo de `browser_click`/`browser_type` sem ambiguidade.
// Puro (sem Playwright): o server só executa o plano que sai daqui.

const GENERIC_TAGS = new Set([
	"a", "button", "div", "span", "input", "li", "ul", "ol", "p", "td", "tr",
	"th", "table", "img", "label", "select", "textarea", "form", "section",
	"svg", "i", "b", "strong", "em", "h1", "h2", "h3", "h4", "h5", "h6",
	"body", "html", "*",
]);

export const SNAPSHOT_HINT =
	"Use browser_snapshot e depois browser_act com o ref do elemento.";

/**
 * Seletor que é só uma tag (ou `*`, com ou sem pseudo como `:first-child`)
 * casa com dezenas de elementos: o Playwright clica no primeiro e o agente
 * "acerta" o alvo errado (caso Bling: `a` clicou em "Página inicial").
 */
export function isGenericSelector(selector) {
	const value = String(selector ?? "").trim().toLowerCase();
	if (!value) return false;
	const bare = value.replace(/:(first|last|nth)-(child|of-type)(\([^)]*\))?$/, "");
	return GENERIC_TAGS.has(bare);
}

/**
 * Plano de clique:
 * - `text` (com ou sem `selector`) → busca por texto, restrita ao seletor;
 *   o texto NUNCA é ignorado por causa de um seletor.
 * - `selector` específico sozinho → clique por seletor.
 * - `selector` genérico sozinho → erro com dica.
 */
export function planClickTarget({ selector, text }) {
	const sel = typeof selector === "string" ? selector.trim() : "";
	const txt = typeof text === "string" ? text.trim() : "";
	if (!sel && !txt) {
		throw new Error(`selector ou text é obrigatório. ${SNAPSHOT_HINT}`);
	}
	if (txt) {
		return { mode: "text", text: txt, scope: sel || undefined };
	}
	if (isGenericSelector(sel)) {
		throw new Error(
			`Seletor genérico "${sel}" casa com muitos elementos e clicaria no primeiro. ${SNAPSHOT_HINT}`,
		);
	}
	return { mode: "selector", selector: sel };
}

/** `browser_type` sem seletor digita no foco; com seletor genérico, recusa. */
export function planTypeTarget({ selector }) {
	const sel = typeof selector === "string" ? selector.trim() : "";
	if (!sel) return { mode: "focus" };
	if (isGenericSelector(sel)) {
		throw new Error(
			`Seletor genérico "${sel}" casa com muitos campos e preencheria o primeiro. ${SNAPSHOT_HINT}`,
		);
	}
	return { mode: "selector", selector: sel };
}

const norm = (value) => String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Escolhe entre candidatos já lidos (texto visível de cada um): match exato
 * (ignorando caixa/espaços) vence o parcial; dentro do grupo, o primeiro
 * visível. `ambiguous` avisa o modelo quando sobrou mais de um.
 */
export function pickTextMatch(candidates, wanted) {
	const target = norm(wanted);
	const visible = candidates
		.map((candidate, index) => ({ ...candidate, index }))
		.filter((candidate) => candidate.visible !== false);
	const exact = visible.filter((candidate) => norm(candidate.text) === target);
	const partial = visible.filter((candidate) => norm(candidate.text).includes(target));
	const pool = exact.length > 0 ? exact : partial;
	if (pool.length === 0) return null;
	return { index: pool[0].index, exact: exact.length > 0, ambiguous: pool.length > 1, matches: pool.length };
}

/** Erro de `fill` em alvo que não é campo → mensagem acionável. */
export function explainFillError(message) {
	const text = String(message ?? "");
	if (/not an? <?(input|textarea|select)|not editable|contenteditable/i.test(text)) {
		return `O alvo não é um campo editável. ${SNAPSHOT_HINT}`;
	}
	return text;
}

/**
 * V1 — escolhe o alvo do clique por texto. Os candidatos são os nós de texto
 * achados na página; `interactive` diz se há ancestral clicável (a, button,
 * role=button…) e `group` identifica esse ancestral (vários nós do mesmo card
 * contam como UM alvo). Preferência: exato > parcial; dentro do grupo,
 * interativo antes de não interativo; depois a ordem do DOM.
 */
export function planClick(candidates, wanted) {
	const target = norm(wanted);
	const visible = candidates
		.map((candidate, index) => ({ ...candidate, index }))
		.filter((candidate) => candidate.visible !== false);
	const exact = visible.filter((candidate) => norm(candidate.text) === target);
	const partial = visible.filter((candidate) => norm(candidate.text).includes(target));
	const pool = exact.length > 0 ? exact : partial;
	if (pool.length === 0) return null;
	const ranked = [...pool].sort(
		(a, b) => Number(Boolean(b.interactive)) - Number(Boolean(a.interactive)) || a.index - b.index,
	);
	const groups = new Set(pool.map((candidate) => candidate.group ?? `n${candidate.index}`));
	return {
		index: ranked[0].index,
		exact: exact.length > 0,
		interactive: Boolean(ranked[0].interactive),
		ambiguous: groups.size > 1,
		matches: groups.size,
	};
}

export const ERROR_MAX = 300;

/**
 * V1 — mensagem de erro do Playwright sem o "Call log:" (2 a 4 KB de
 * "waiting for…/retrying…"): só a primeira linha útil, limitada.
 */
export function compactPlaywrightError(message, max = ERROR_MAX) {
	const text = String(message ?? "").split(/\r?\n\s*Call log:/i)[0];
	const line = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(" ");
	return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}
