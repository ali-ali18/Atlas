// Motor v2 — tabela de refs do snapshot de acessibilidade e resolução na ação.
//
// Uma ref `aria-ref=eN` morre quando o framework recria o elemento, e clicar
// numa ref morta espera o timeout inteiro. Por isso a ação resolve ANTES:
// 1) `aria-ref` com count() (≈50 ms); 2) se a ref venceu, procura por papel +
// nome nos frames; um achado -> age e avisa; vários -> erro rápido com as
// candidatas, sem adivinhar. A ref é opaca: o prefixo de frame pode mudar.

import { isInteractive } from "./ax-prune.mjs";

export const MAX_TABLE = 20_000;
const MAX_CANDIDATES = 5;
// Papéis que o getByRole do Playwright entende; generic/iframe ficam só com aria-ref.
const NOT_ROLE_QUERYABLE = new Set(["generic", "iframe", "text", "none", "presentation", "clickable"]);

const squash = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

/** ref -> { engine, frame, role, name, nth, of, anchor } só de nós acionáveis ou nomeados. */
export function buildRefTable(byRef) {
	const table = new Map();
	const seen = new Map();
	const totals = new Map();
	for (const node of byRef.values()) {
		const name = squash(node.name);
		if (!node.ref || (!name && !isInteractive(node.role))) continue;
		totals.set(`${node.frame}|${node.role}|${name}`, (totals.get(`${node.frame}|${node.role}|${name}`) ?? 0) + 1);
	}
	for (const node of byRef.values()) {
		const name = squash(node.name);
		if (!node.ref || (!name && !isInteractive(node.role))) continue;
		if (table.size >= MAX_TABLE) break;
		const key = `${node.frame}|${node.role}|${name}`;
		const nth = seen.get(key) ?? 0;
		seen.set(key, nth + 1);
		table.set(node.ref, {
			engine: "ax",
			frame: node.frame ?? "",
			role: node.role,
			name,
			nth,
			of: totals.get(key) ?? 1,
			anchor: anchorOf(node),
		});
	}
	return table;
}

/** Ancestral nomeado mais próximo (landmark, diálogo, grupo): ajuda a distinguir candidatas. */
function anchorOf(node) {
	for (let up = node.parent; up; up = up.parent) {
		const name = squash(up.name);
		if (name && up.role !== "root") return `${up.role} "${name.slice(0, 50)}"`;
		if (up.role === "complementary" || up.role === "dialog" || up.role === "main" || up.role === "navigation") return up.role;
	}
	return "";
}

/** Guarda por página (aba): motor do último snapshot, tabela e mapa plano para o diff. */
export function createAxStore() {
	const states = new WeakMap();
	return {
		get: (page) => states.get(page),
		engineOf: (page) => states.get(page)?.engine,
		/** Snapshot AX novo: a tabela antiga continua valendo para refs que o modelo ainda lembra (mescla). */
		setAx(page, { table, flat, viewport, via }) {
			const previous = states.get(page);
			const merged = previous?.engine === "ax" ? new Map(previous.table) : new Map();
			for (const [ref, entry] of table) merged.set(ref, entry);
			while (merged.size > MAX_TABLE) merged.delete(merged.keys().next().value);
			states.set(page, { engine: "ax", table: merged, flat, viewport, via, rendered: previous?.rendered ?? null });
		},
		/** Snapshot v1/read/find: as refs agora são as do DOM (`data-atlas-ref`). */
		setDom(page) {
			states.set(page, { engine: "dom" });
		},
		setRendered(page, rendered) {
			const state = states.get(page);
			if (state) state.rendered = rendered;
		},
		setFlat(page, flat) {
			const state = states.get(page);
			if (state) state.flat = flat;
		},
	};
}

export class StaleRefError extends Error {}

function describe(entry) {
	return `${entry.role}${entry.name ? ` "${entry.name.slice(0, 60)}"` : ""}`;
}

async function candidateNotes(matches) {
	const notes = [];
	for (const [index, locator] of matches.slice(0, MAX_CANDIDATES).entries()) {
		const near = await locator
			.evaluate((el) => {
				const holder = el.closest("article,li,tr,section,aside,[role=dialog],[role=listitem]") ?? el.parentElement;
				return String(holder?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
			})
			.catch(() => "");
		notes.push(`${index + 1}${near ? ` perto de "${near}"` : ""}`);
	}
	return notes;
}

/**
 * `{ locator, resolved }` pronto para agir. `resolved` só vem quando a ref
 * venceu e achamos o elemento por papel+nome (o chamador avisa o modelo).
 * Lança StaleRefError (mensagem pt-BR acionável) quando não dá para agir sem adivinhar.
 */
export async function resolveAxRef(page, table, ref) {
	const direct = page.locator(`aria-ref=${ref}`);
	let count = 0;
	try {
		count = await direct.count();
	} catch {
		count = 0;
	}
	if (count >= 1) return { locator: direct.first() };

	const entry = table?.get(ref);
	if (!entry || NOT_ROLE_QUERYABLE.has(entry.role) || (!entry.name && !isInteractive(entry.role))) {
		throw new StaleRefError(`Ref ${ref} venceu: a página mudou desde o último browser_snapshot. Tire um novo browser_snapshot e use a ref nova.`);
	}
	const main = typeof page.mainFrame === "function" ? page.mainFrame() : page;
	const frames = entry.frame ? (typeof page.frames === "function" ? page.frames().filter((f) => f !== main) : []) : [main];
	const matches = [];
	for (const frame of frames) {
		if (frame.isDetached?.()) continue;
		const located = frame.getByRole(entry.role, entry.name ? { name: entry.name, exact: true } : {});
		const found = await located.count().catch(() => 0);
		for (let i = 0; i < found && matches.length < 50; i += 1) matches.push(located.nth(i));
	}
	if (matches.length === 1) {
		return { locator: matches[0], resolved: `A ref ${ref} tinha vencido; agi no único ${describe(entry)} da página. Use refs do próximo browser_snapshot.` };
	}
	if (matches.length === 0) {
		throw new StaleRefError(`Ref ${ref} venceu e ${describe(entry)} não está mais na página. Tire um novo browser_snapshot.`);
	}
	const notes = await candidateNotes(matches);
	throw new StaleRefError(
		`Ref ${ref} venceu e há ${matches.length} ${describe(entry)} na página (era a ${entry.nth + 1}ª de ${entry.of}${entry.anchor ? `, em ${entry.anchor}` : ""}). ` +
			`Candidatas: ${notes.join("; ")}. Tire um novo browser_snapshot e use a ref certa.`,
	);
}
