// Motor v2 — "o que mudou" na árvore de acessibilidade depois de uma ação.
// Módulo PURO. A chave é a ref (estável por elemento); `[active]` é ignorado
// (foco muda a cada clique e não é mudança de conteúdo). Roda na árvore SEM
// colapso, para um item novo dentro de uma lista de 5.000 não sumir no "similares".
// Nunca lê valor de campo: textbox entra só com papel e nome.

import { isInteractive, isValueRole } from "./ax-prune.mjs";

export const DIFF_MAX_LINES = 25;
const TEXT_MAX = 80;
const LINE_MAX = 140;

const squash = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const clip = (value, max) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

/** Árvore crua (`byRef` do parse) -> mapa ref -> fatos comparáveis. */
export function flattenForDiff(byRef) {
	const flat = new Map();
	for (const node of byRef.values()) {
		if (!node.ref) continue;
		const own = node.children.filter((c) => c.role === "text").map((c) => c.text);
		if (node.text && !isValueRole(node.role)) own.unshift(node.text);
		flat.set(node.ref, {
			role: node.role,
			name: clip(squash(node.name), 100),
			attrs: [...node.attrs].sort().join(" "),
			text: isValueRole(node.role) ? "" : clip(squash(own.join(" ")), TEXT_MAX),
			parent: nearestRef(node.parent),
		});
	}
	return flat;
}

function nearestRef(node) {
	for (let up = node; up; up = up.parent) if (up.ref) return up.ref;
	return "";
}

const meaningful = (f) => Boolean(f.name || f.text || isInteractive(f.role));

function line(sign, ref, f, extra = "") {
	const role = f.role === "generic" ? "text" : f.role;
	const parts = [`${sign} ${role}`];
	if (f.name) parts.push(JSON.stringify(f.name));
	if (isInteractive(f.role)) parts.push(`[${ref}]`);
	if (f.attrs) parts.push(`[${f.attrs.split(" ").join("] [")}]`);
	if (extra) parts.push(extra);
	let text = parts.join(" ");
	if (f.text && !f.name) text += `: ${JSON.stringify(f.text)}`;
	return clip(text, LINE_MAX);
}

function topMost(refs, flat, other) {
	const set = new Set(refs);
	return refs.filter((ref) => {
		for (let up = flat.get(ref)?.parent; up; up = flat.get(up)?.parent) {
			if (set.has(up) && meaningful(flat.get(up))) return false;
		}
		return meaningful(flat.get(ref)) && !(other.has(ref));
	});
}

/** Linhas de mudança entre dois mapas planos; `[]` quando nada de relevante mudou. */
export function diffAxTrees(before, after, { max = DIFF_MAX_LINES } = {}) {
	if (!before || !after) return [];
	const added = [];
	const removed = [];
	const changed = [];
	for (const [ref, f] of after) {
		const old = before.get(ref);
		if (!old) added.push(ref);
		else if (old.role !== f.role || old.name !== f.name || old.attrs !== f.attrs || old.text !== f.text) changed.push(ref);
	}
	for (const ref of before.keys()) if (!after.has(ref)) removed.push(ref);
	const lines = [];
	for (const ref of topMost(added, after, new Set())) lines.push(line("+", ref, after.get(ref)));
	for (const ref of topMost(removed, before, new Set())) lines.push(line("-", ref, before.get(ref)));
	for (const ref of changed) {
		const f = after.get(ref);
		const old = before.get(ref);
		if (!meaningful(f) && !meaningful(old)) continue;
		const what = [];
		if (old.attrs !== f.attrs) what.push(`estado: ${old.attrs || "—"} → ${f.attrs || "—"}`);
		if (old.name !== f.name) what.push(`nome era ${JSON.stringify(old.name)}`);
		if (old.text !== f.text && !what.length) what.push(`texto era ${JSON.stringify(clip(old.text, 40))}`);
		lines.push(line("~", ref, f, what.join("; ")));
	}
	if (lines.length <= max) return lines;
	return [...lines.slice(0, max - 1), `… +${lines.length - (max - 1)} mudanças`];
}
