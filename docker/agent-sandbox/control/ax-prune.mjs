// Motor v2 — árvore de acessibilidade: parse do YAML do Playwright, poda e
// renderização compacta. Módulo PURO (sem página): tudo testável com texto.
//
// Fluxo: parseAxYaml -> pruneNodes (achata o ruído) -> selectViewport (só o que
// cruza a janela) -> collapseRuns (irmãos repetidos) -> renderAx (linhas).
// Valores de campo (textbox etc.) só saem se a ref estiver em `okValues`:
// o chamador decide depois da sonda (senha, código de uso único). Padrão = nunca.
import { toTreeRef } from "./ax-ref-names.mjs";


export const NAME_MAX = 200;
// Texto corrido (resposta do chat num painel com rolagem) não pode perder o fim: a página do snapshot já limita o custo por chamada.
export const TEXT_MAX = 4000;
export const RUN_MIN_COMPOUND = 5;
export const RUN_MIN_LEAF = 10;
export const RUN_KEEP = 2;
export const DEFAULT_LIMIT = 6000;
export const MAX_LIMIT = 20_000;

const INTERACTIVE = new Set([
	"button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "slider",
	"spinbutton", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "treeitem", "clickable",
]);
const VALUE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider"]);
// Sem nome, só atrapalham: o filho sobe um nível.
const FLATTEN_WHEN_UNNAMED = new Set([
	"generic", "group", "rowgroup", "none", "presentation", "paragraph", "emphasis", "strong", "code",
	"mark", "subscript", "superscript", "deletion", "insertion", "time", "span",
]);
const KEEP_ATTRS = ["checked", "mixed", "disabled", "expanded", "selected", "pressed", "required", "readonly", "invalid"];

export const isInteractive = (role) => INTERACTIVE.has(role);
export const isValueRole = (role) => VALUE_ROLES.has(role);

// ---------------------------------------------------------------- parse

function unquote(value) {
	const text = value.trim();
	if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
		try {
			return JSON.parse(text);
		} catch {
			return text.slice(1, -1);
		}
	}
	if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replace(/''/g, "'");
	return text;
}

/** Uma linha `- ...` já sem indentação; devolve o nó cru ou null. */
function parseLine(content) {
	let body = content;
	let tail = "";
	// Escalar YAML com aspas simples (nome com aspas duplas dentro): `'role "x" [ref=e1]':`.
	if (body.startsWith("'")) {
		const match = /^'((?:[^']|'')*)'(.*)$/s.exec(body);
		if (match) {
			body = match[1].replace(/''/g, "'");
			tail = match[2];
		}
	}
	const prop = /^\/([\w-]+):\s*(.*)$/s.exec(body);
	if (prop) return { prop: prop[1], value: unquote(prop[2]) };
	const text = /^text:\s?(.*)$/s.exec(body);
	if (text) return { role: "text", text: unquote(text[1]) };
	const head = /^([\w-]+)/.exec(body);
	if (!head) return null;
	const node = { role: head[1], name: "", ref: "", attrs: [], pointer: false, box: null, text: "" };
	let rest = body.slice(head[0].length);
	const named = /^\s+("(?:[^"\\]|\\.)*")/.exec(rest);
	if (named) {
		node.name = unquote(named[1]);
		rest = rest.slice(named[0].length);
	}
	const attrPattern = /^\s*\[([^\]=]+)(?:=([^\]]*))?\]/;
	for (let m = attrPattern.exec(rest); m; m = attrPattern.exec(rest)) {
		const [, key, val] = m;
		if (key === "ref") node.ref = toTreeRef(val ?? "");
		else if (key === "box") {
			const nums = String(val).split(",").map(Number);
			if (nums.length === 4 && nums.every(Number.isFinite)) node.box = nums;
		} else if (key === "cursor") node.pointer = val === "pointer";
		else if (key === "level") node.attrs.push(`level=${val}`);
		else if (key === "active") node.active = true;
		else if (KEEP_ATTRS.includes(key)) node.attrs.push(val === undefined || val === "true" ? key : `${key}=${val}`);
		rest = rest.slice(m[0].length);
	}
	const after = (rest + tail).trim();
	const colon = /^:\s?(.*)$/s.exec(after);
	if (colon) node.text = unquote(colon[1]);
	return node;
}

/** YAML do ariaSnapshot -> { roots, byRef, count }. Cada nó guarda `parent`, `abs` (caixa absoluta) e `frame`. */
export function parseAxYaml(yaml) {
	const root = { role: "root", name: "", ref: "", attrs: [], text: "", children: [], parent: null, abs: null, depth: -1 };
	const byRef = new Map();
	const stack = [root];
	let count = 0;
	for (const line of String(yaml).split("\n")) {
		const match = /^(\s*)- (.*)$/.exec(line);
		if (!match) continue;
		const depth = match[1].length / 2;
		const parsed = parseLine(match[2]);
		if (!parsed) continue;
		while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop();
		const parent = stack[stack.length - 1];
		if (parsed.prop) {
			if (parsed.prop === "url") parent.url = parsed.value;
			continue;
		}
		const node = { ...parsed, children: [], parent, depth, url: "" };
		if (node.role === "text") {
			node.name = "";
			node.ref = "";
			node.attrs = [];
		}
		// Caixa absoluta: filhos de um iframe são relativos a ele (cadeia somada).
		const origin = parent.role === "iframe" && parent.abs ? parent.abs : parent.origin ?? [0, 0];
		node.origin = origin;
		if (node.box) node.abs = [node.box[0] + origin[0], node.box[1] + origin[1], node.box[2], node.box[3]];
		node.frame = /^(f\d+)a/.exec(node.ref)?.[1] ?? parent.frame ?? "";
		parent.children.push(node);
		stack.push(node);
		count += 1;
		if (node.ref) byRef.set(node.ref, node);
	}
	return { roots: root.children, byRef, count };
}

// ---------------------------------------------------------------- poda

const squash = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const clip = (value, max) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

function textNode(text, via = "") {
	const value = clip(squash(text), TEXT_MAX);
	// `via`: ref do elemento de onde o texto veio; a sonda de recorte usa para esconder texto de acordeão fechado.
	return value ? { role: "text", text: value, via, children: [] } : null;
}

/** Junta textos vizinhos e tira o que repete o nome do pai ou do irmão (rótulo ao lado de checkbox). */
function mergeTexts(list, parentName = "") {
	const same = (a, b) => Boolean(b) && a.toLowerCase() === b.toLowerCase();
	const out = [];
	list.forEach((item, index) => {
		if (item.role !== "text") {
			out.push(item);
			return;
		}
		if (same(item.text, parentName)) return;
		if (same(item.text, list[index - 1]?.name) || same(item.text, list[index + 1]?.name)) return;
		const last = out[out.length - 1];
		// Passou do teto: abre outro bloco em vez de cortar (o fim da resposta não some).
		if (last && last.role === "text" && last.text.length + item.text.length < TEXT_MAX) last.text = `${last.text} ${item.text}`;
		else out.push({ ...item });
	});
	return out;
}

const hasInteractive = (list) => list.some((n) => isInteractive(n.role) || hasInteractive(n.children ?? []));

/** Nó cru -> lista de nós podados (0, 1 ou vários quando achata). Não colapsa irmãos. */
export function pruneNode(node) {
	if (node.role === "text") {
		const t = textNode(node.text);
		return t ? [t] : [];
	}
	let children = [];
	for (const child of node.children) {
		for (const pruned of pruneNode(child)) {
			// Texto não tem caixa no YAML: herda a do elemento de onde veio.
			if (pruned.role === "text" && !pruned.abs) pruned.abs = node.abs ?? null;
			if (pruned.role === "text" && !pruned.via) pruned.via = node.ref || node.via || "";
			children.push(pruned);
		}
	}
	const name = clip(squash(node.name), NAME_MAX);
	const own = node.text && !isValueRole(node.role) ? textNode(node.text, node.ref) : null;
	if (own) {
		own.abs = node.abs ?? null;
		children = [own, ...children];
	}
	children = mergeTexts(children, name);
	const interactive = isInteractive(node.role);

	if (!name && FLATTEN_WHEN_UNNAMED.has(node.role)) {
		// div com onclick (cursor: pointer) e sem filho interativo: é um alvo de clique de verdade.
		if (node.pointer && node.ref && children.length > 0 && !hasInteractive(children)) {
			const label = children.filter((c) => c.role === "text").map((c) => c.text).join(" ");
			return [{ ...base(node, "clickable"), name: clip(label, NAME_MAX), children: children.filter((c) => c.role !== "text") }];
		}
		// Quem sobe herda o contêiner de origem: é nele que `ref=` abre a lista inteira.
		return children.map((child) => (child.parentRef || !node.ref ? child : { ...child, parentRef: node.ref }));
	}
	if (!interactive && !name && children.length === 0 && !node.text) {
		return node.role === "iframe" ? [base(node, node.role)] : []; // estrutura vazia some; iframe vazio ainda é um alvo de leitura
	}
	if (node.role === "img" && !name) return [];
	const out = base(node, node.role);
	out.name = name;
	out.children = children;
	// Botão só-ícone cujo nome vem da imagem de dentro: o nome sobe para o botão.
	if (interactive && !name && children.length === 1 && children[0].role === "img" && children[0].name) {
		out.name = children[0].name;
		out.children = [];
	}
	if (isValueRole(node.role) && node.text) out.value = node.text;
	return [out];
}

function base(node, role) {
	return {
		role,
		name: "",
		ref: node.ref || "",
		attrs: node.attrs,
		href: node.url ? clip(node.url, 120) : "",
		abs: node.abs ?? null,
		active: Boolean(node.active),
		children: [],
		frame: node.frame ?? "",
	};
}

export function pruneNodes(roots) {
	const out = [];
	for (const root of roots) out.push(...pruneNode(root));
	return mergeTexts(out);
}

// ---------------------------------------------------------------- viewport

function intersects(abs, viewport) {
	if (!abs) return true; // sem caixa (display: contents): decide pelos filhos
	const [x, y, w, h] = abs;
	if (w <= 0 && h <= 0) return false;
	return x < viewport.width && y < viewport.height && x + w > 0 && y + h > 0;
}

/**
 * Só o que cruza a janela (+ ancestrais de contexto). `dropped` lista, por
 * contêiner, quantos filhos ficaram de fora, para o rodapé dizer onde pedir.
 */
export function selectViewport(nodes, viewport, container = { ref: "", role: "", name: "" }) {
	const kept = [];
	const dropped = [];
	const lost = [];
	let omitted = 0;
	for (const node of nodes) {
		if (node.role === "text") {
			if (intersects(node.abs, viewport)) kept.push(node);
			continue;
		}
		const sub = selectViewport(node.children, viewport, { ref: node.ref, role: node.role, name: node.name });
		const hasReal = sub.nodes.some((n) => n.role !== "text");
		const hasText = sub.nodes.some((n) => n.role === "text");
		const selfIn = intersects(node.abs, viewport);
		const useful = isInteractive(node.role) || node.name || node.role === "iframe";
		if (!(hasReal || (selfIn && (useful || hasText)))) {
			omitted += 1;
			lost.push(node);
			continue;
		}
		dropped.push(...sub.dropped);
		omitted += sub.omitted;
		kept.push({ ...node, children: sub.nodes });
	}
	const groups = new Map();
	for (const node of lost) {
		const ref = node.parentRef || container.ref;
		const group = groups.get(ref) ?? { ref, role: ref === container.ref ? container.role : "", name: ref === container.ref ? container.name : "", roles: new Map(), count: 0 };
		group.roles.set(node.role, (group.roles.get(node.role) ?? 0) + 1);
		group.count += 1;
		groups.set(ref, group);
	}
	for (const { roles, ...group } of groups.values()) {
		dropped.push({ ...group, dominant: [...roles.entries()].sort((a, b) => b[1] - a[1])[0] });
	}
	return { nodes: kept, omitted, dropped };
}

// ---------------------------------------------------------------- colapso

function firstRef(node) {
	if (node.ref) return node.ref;
	for (const child of node.children ?? []) {
		const ref = firstRef(child);
		if (ref) return ref;
	}
	return "";
}
function lastRef(node) {
	const kids = node.children ?? [];
	for (let i = kids.length - 1; i >= 0; i -= 1) {
		const ref = lastRef(kids[i]);
		if (ref) return ref;
	}
	return node.ref || "";
}
const isCompound = (node) => (node.children ?? []).some((c) => c.role !== "text") || (node.children ?? []).length >= 2;

/** Irmãos repetidos (mesmo papel, em sequência) viram 2 exemplos + um marcador. `expandTop` deixa a lista de cima intacta (ref=). */
export function collapseRuns(nodes, { containerRef = "", expandTop = false } = {}) {
	const out = [];
	let i = 0;
	while (i < nodes.length) {
		const node = nodes[i];
		let j = i;
		while (j + 1 < nodes.length && nodes[j + 1].role === node.role && node.role !== "text") j += 1;
		const length = j - i + 1;
		const min = isCompound(node) ? RUN_MIN_COMPOUND : RUN_MIN_LEAF;
		const group = nodes.slice(i, j + 1);
		const shown = !expandTop && length >= min ? RUN_KEEP : length;
		for (let k = 0; k < shown; k += 1) {
			const item = group[k];
			out.push({ ...item, children: collapseRuns(item.children ?? [], { containerRef: item.ref || containerRef }) });
		}
		if (shown < length) {
			const hidden = group.slice(shown);
			out.push({
				role: "__similar",
				itemRole: node.role,
				count: hidden.length,
				firstRef: firstRef(hidden[0]),
				lastRef: lastRef(hidden[hidden.length - 1]),
				containerRef: hidden[0].parentRef || containerRef,
				children: [],
			});
		}
		i = j + 1;
	}
	return out;
}

// ---------------------------------------------------------------- render

const q = (value) => JSON.stringify(String(value));

/**
 * Linhas indentadas. `refs` = refs que merecem aparecer (além dos interativos).
 * `values`: ref -> "ok" (mostra) | "secret" (campo de senha/código). Sem entrada, o valor some.
 * `hidden`: refs recortadas/ocultas (nó e subárvore somem). `ariaHidden`: refs marcadas.
 */
export function renderAx(nodes, { values = new Map(), hidden = new Set(), ariaHidden = new Set(), showRefs = new Set(), depth = 0, lines = [] } = {}) {
	const pad = "  ".repeat(depth);
	for (const node of nodes) {
		if (node.ref && hidden.has(node.ref)) continue;
		if (node.role === "text") {
			if (node.via && hidden.has(node.via)) continue;
			lines.push(`${pad}${node.text}`);
			continue;
		}
		if (node.role === "__similar") {
			const range = node.firstRef && node.lastRef ? ` (${node.firstRef}..${node.lastRef})` : "";
			const where = node.containerRef ? ` — browser_snapshot ref=${node.containerRef}` : "";
			lines.push(`${pad}… +${node.count} ${node.itemRole} similares${range}${where}`);
			continue;
		}
		const parts = [node.role];
		if (node.name) parts.push(q(node.name));
		if (node.ref && (isInteractive(node.role) || showRefs.has(node.ref) || node.role === "iframe")) parts.push(`[${node.ref}]`);
		for (const attr of node.attrs ?? []) parts.push(`[${attr}]`);
		if (node.active && isInteractive(node.role)) parts.push("[focused]");
		if (node.href) parts.push(`[href=${node.href}]`);
		if (node.ref && ariaHidden.has(node.ref)) parts.push("[aria-hidden]");
		let tail = "";
		const state = values.get(node.ref);
		// Mesmas frases do snapshot v1: o muro de login e o prompt já reconhecem.
		if (state === "secret") parts.push("(campo de senha: nunca preencha)");
		else if (state === "otp") parts.push("(campo de código de uso único: nunca preencha)");
		else if (state === "ok" && node.value !== undefined && node.value !== "") tail = `: ${q(clip(squash(node.value), 120))}`;
		lines.push(`${pad}${parts.join(" ")}${tail}`);
		// O Chromium põe o valor digitado como texto FILHO do campo: em campo secreto (ou sem sonda) a subárvore não sai.
		const valueLeaks = state === "secret" || state === "otp" || (isValueRole(node.role) && state !== "ok");
		if (node.children?.length && !valueLeaks) renderAx(node.children, { values, hidden, ariaHidden, showRefs, depth: depth + 1, lines });
	}
	return lines;
}

/** Refs a mostrar além dos interativos: contêineres citados por marcadores. */
export function referencedRefs(nodes, found = new Set()) {
	for (const node of nodes) {
		if (node.role === "__similar" && node.containerRef) found.add(node.containerRef);
		if (node.children?.length) referencedRefs(node.children, found);
	}
	return found;
}

/**
 * O que a sonda de recorte precisa olhar no chunk emitido: refs de nós nomeados
 * ou interativos, refs de origem do texto (`via`) e TODO campo de valor
 * (para achar senha/código mesmo vazio).
 */
export function probeTargets(nodes, found = { refs: new Set(), fields: new Set() }) {
	for (const node of nodes) {
		if (node.role === "__similar") continue;
		if (node.role === "text") {
			if (node.via) found.refs.add(node.via);
			continue;
		}
		if (node.ref && isValueRole(node.role)) found.fields.add(node.ref);
		else if (node.ref && (isInteractive(node.role) || node.name)) found.refs.add(node.ref);
		if (node.children?.length) probeTargets(node.children, found);
	}
	return found;
}

/** Percorre os nós emitidos: refs de nós visíveis na saída. */
export function emittedNodes(nodes, out = []) {
	for (const node of nodes) {
		if (node.role === "text" || node.role === "__similar") continue;
		out.push(node);
		if (node.children?.length) emittedNodes(node.children, out);
	}
	return out;
}

/** Fatia por caracteres cortando em fim de linha; `nextOffset` null quando acabou. */
export function paginateLines(lines, { offset, limit } = {}) {
	const text = lines.join("\n");
	const off = Number.isFinite(Number(offset)) ? Math.max(0, Math.floor(Number(offset))) : 0;
	const lim = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.min(MAX_LIMIT, Math.floor(Number(limit))) : DEFAULT_LIMIT;
	if (off >= text.length && text.length > 0) return { text: "", offset: off, limit: lim, totalLength: text.length, nextOffset: null };
	let end = Math.min(text.length, off + lim);
	if (end < text.length) {
		const cut = text.lastIndexOf("\n", end);
		if (cut > off) end = cut;
	}
	const next = end < text.length ? end + (text[end] === "\n" ? 1 : 0) : null;
	return { text: text.slice(off, end), offset: off, limit: lim, totalLength: text.length, nextOffset: next };
}

/** Rodapé do chunk de viewport: o que ficou de fora e como pedir. */
export function footerFor(dropped, omittedTotal) {
	if (omittedTotal <= 0) return [];
	const rows = dropped
		.filter((d) => d.ref && d.count > 0)
		.sort((a, b) => b.count - a.count)
		.slice(0, 3)
		.map((d) => `+${d.count} ${d.dominant?.[0] ?? "itens"} fora da janela${d.role ? ` em ${d.role}${d.name ? ` ${q(clip(d.name, 40))}` : ""}` : ""}: browser_snapshot ref=${d.ref}`);
	return [`[fora da janela: ${omittedTotal} blocos; area=page mostra a página toda]`, ...rows];
}
