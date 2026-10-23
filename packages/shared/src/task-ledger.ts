/**
 * Task Ledger (V3/V3b): a lista explícita de itens de uma tarefa que se repete
 * (disciplinas x semanas, linhas, seções), com fatos dados, o que falta
 * descobrir e o plano. Vive dentro do `TaskState` (checkpoint JSON, sem
 * migration) e é reinjetado de forma compacta a cada passo. Tudo puro: sem
 * I/O, sem relógio. Os reducers devolvem um ledger novo.
 */

export type LedgerItemStatus = "pending" | "in_progress" | "done" | "failed";

/** `failed` só vale com um motivo de classe real; "o usuário pode colar" não é motivo. */
export const LEDGER_FAIL_REASONS = ["login", "captcha", "permission", "not_found"] as const;
/**
 * Motivo gravado pelo runtime quando um subagente de navegador não leu o item (V8). Fora de
 * `LEDGER_FAIL_REASONS`: o modelo não o escolhe, só `updateLedgerItem(..., { trusted: true })`.
 */
export const LEDGER_SUBAGENT_FAIL_REASON = "subagent" as const;
export type LedgerFailReason = (typeof LEDGER_FAIL_REASONS)[number] | typeof LEDGER_SUBAGENT_FAIL_REASON;

export type LedgerItem = {
	id: string;
	label: string;
	status: LedgerItemStatus;
	/** Item pai (ex.: a disciplina de uma semana); sempre visível na reinjeção. */
	scope?: string;
	/** O que foi lido (<= 200). Obrigatório para `done`. */
	evidence?: string;
	/** Referência curta ao resultado (id de `research_note`, artefato). */
	ref?: string;
	reason?: LedgerFailReason;
	detail?: string;
	/**
	 * Veio de um run anterior e ainda não foi tocado neste run. Adotar a lista (atualizar um
	 * item) não torna os demais herdados obrigação: só `set` com o item ou `update` nele o adota.
	 */
	carried?: true;
};

/** `offered`: ledger herdado de um run anterior da conversa, ainda não adotado neste run. */
export type LedgerCarry = "offered" | "asked" | "adopted";

export type TaskLedger = {
	v: 1;
	factsGiven: string[];
	factsToLookup: string[];
	plan: string[];
	items: LedgerItem[];
	/** Passos seguidos sem progresso (zera com progresso ou replanejamento). */
	stalled: number;
	replans: number;
	/** Interceptações do portão de entrega neste run. */
	gateBlocks: number;
	/** Respostas finais recusadas pelo portão neste run (a resposta é refeita no máximo uma vez). */
	answerBlocks?: number;
	carry?: LedgerCarry;
	/** O orquestrador desistiu depois de M replans: fecha com a entrega parcial. */
	stopped?: boolean;
	/** Entrega parcial declarada: o que faltou e o motivo real (a UI mostra). */
	partial?: { missing: Array<{ id: string; label: string; reason: string }> };
};

export const MAX_LEDGER_ITEMS = 40;
export const MAX_LEDGER_PLAN = 8;
export const MAX_LEDGER_FACTS = 10;
export const LEDGER_LABEL_CHARS = 120;
export const LEDGER_SCOPE_CHARS = 80;
export const LEDGER_TEXT_CHARS = 200;
/** Teto da camada reinjetada a cada passo (caracteres). */
export const LEDGER_LAYER_CHARS = 600;

const STATUSES: readonly LedgerItemStatus[] = ["pending", "in_progress", "done", "failed"];
const CARRIES: readonly LedgerCarry[] = ["offered", "asked", "adopted"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clean(value: unknown, max: number): string {
	return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function cleanList(value: unknown, maxItems: number, maxChars: number): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const item of value) {
		const text = clean(item, maxChars);
		if (text) out.push(text);
		if (out.length >= maxItems) break;
	}
	return out;
}

export function createTaskLedger(): TaskLedger {
	return { v: 1, factsGiven: [], factsToLookup: [], plan: [], items: [], stalled: 0, replans: 0, gateBlocks: 0 };
}

function parseItem(raw: unknown): LedgerItem | null {
	if (!isRecord(raw)) return null;
	const id = clean(raw.id, 40);
	const label = clean(raw.label, LEDGER_LABEL_CHARS);
	if (!id || !label) return null;
	const status = STATUSES.find((value) => value === raw.status) ?? "pending";
	const scope = clean(raw.scope, LEDGER_SCOPE_CHARS);
	const evidence = clean(raw.evidence, LEDGER_TEXT_CHARS);
	const ref = clean(raw.ref, 120);
	const reason = [...LEDGER_FAIL_REASONS, LEDGER_SUBAGENT_FAIL_REASON].find((value) => value === raw.reason);
	const detail = clean(raw.detail, LEDGER_TEXT_CHARS);
	const carried = raw.carried === true;
	return {
		id,
		label,
		status,
		...(scope ? { scope } : {}),
		...(evidence ? { evidence } : {}),
		...(ref ? { ref } : {}),
		...(reason ? { reason } : {}),
		...(detail ? { detail } : {}),
		...(carried ? { carried: true as const } : {}),
	};
}

/** Lê o ledger de um checkpoint sem confiar no formato. `undefined` = sem ledger. */
export function parseTaskLedger(raw: unknown): TaskLedger | undefined {
	if (!isRecord(raw) || raw.v !== 1) return undefined;
	const seen = new Set<string>();
	const items: LedgerItem[] = [];
	for (const entry of Array.isArray(raw.items) ? raw.items : []) {
		const item = parseItem(entry);
		if (!item || seen.has(item.id)) continue;
		seen.add(item.id);
		items.push(item);
		if (items.length >= MAX_LEDGER_ITEMS) break;
	}
	const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0);
	const carry = CARRIES.find((value) => value === raw.carry);
	const missing: Array<{ id: string; label: string; reason: string }> = [];
	if (isRecord(raw.partial) && Array.isArray(raw.partial.missing)) {
		for (const entry of raw.partial.missing) {
			if (!isRecord(entry)) continue;
			const id = clean(entry.id, 40);
			const label = clean(entry.label, LEDGER_LABEL_CHARS);
			if (id && label) missing.push({ id, label, reason: clean(entry.reason, LEDGER_TEXT_CHARS) });
		}
	}
	return {
		v: 1,
		factsGiven: cleanList(raw.factsGiven, MAX_LEDGER_FACTS, LEDGER_TEXT_CHARS),
		factsToLookup: cleanList(raw.factsToLookup, MAX_LEDGER_FACTS, LEDGER_TEXT_CHARS),
		plan: cleanList(raw.plan, MAX_LEDGER_PLAN, LEDGER_TEXT_CHARS),
		items,
		stalled: count(raw.stalled),
		replans: count(raw.replans),
		gateBlocks: count(raw.gateBlocks),
		...(count(raw.answerBlocks) > 0 ? { answerBlocks: count(raw.answerBlocks) } : {}),
		...(carry ? { carry } : {}),
		...(raw.stopped === true ? { stopped: true } : {}),
		...(missing.length ? { partial: { missing } } : {}),
	};
}

export const isOpenItem = (item: LedgerItem) => item.status === "pending" || item.status === "in_progress";

export function openItems(ledger: TaskLedger): LedgerItem[] {
	return ledger.items.filter(isOpenItem);
}

/**
 * Itens abertos que este run deve fechar antes de entregar (portão, estagnação, parcial).
 * Lista só oferecida não obriga; numa lista adotada, herdado não tocado também não.
 */
export function obligatedOpenItems(ledger: TaskLedger): LedgerItem[] {
	if (ledger.carry === "offered" || ledger.carry === "asked") return [];
	return ledger.items.filter((item) => isOpenItem(item) && !item.carried);
}

/** Marca todos os itens como herdados (início de um run que recebe a lista de outro). */
export function markItemsCarried(ledger: TaskLedger): TaskLedger {
	return { ...ledger, items: ledger.items.map((item) => ({ ...item, carried: true as const })) };
}

export function countDone(ledger: TaskLedger): number {
	return ledger.items.filter((item) => item.status === "done").length;
}

/** Satisfeito = há itens e nenhum está aberto (todos `done` ou `failed` com motivo de classe). */
export function isLedgerSatisfied(ledger: TaskLedger): boolean {
	return ledger.items.length > 0 && openItems(ledger).length === 0;
}

/** Item corrente: o `in_progress` mais antigo ou, sem ele, o primeiro `pending`. */
export function currentItem(ledger: TaskLedger): LedgerItem | undefined {
	return ledger.items.find((item) => item.status === "in_progress") ?? ledger.items.find((item) => item.status === "pending");
}

/** Usar a lista neste run (set/update) adota o ledger herdado. */
function adopt(ledger: TaskLedger): TaskLedger {
	return ledger.carry ? { ...ledger, carry: "adopted" } : ledger;
}

const normalizeLabel = (label: string) => label.toLowerCase().replace(/\s+/g, " ").trim();

export type ItemInput = { id?: unknown; label?: unknown; scope?: unknown };

/**
 * Declara a lista. Itens já conhecidos (mesmo id ou mesmo rótulo) mantêm status,
 * evidência e motivo: um segundo `set` do modelo não apaga o que já foi lido.
 * Itens que sumiram da nova lista saem (a lista nova manda). Lança com dica.
 */
export function setLedgerItems(
	ledger: TaskLedger,
	inputs: readonly ItemInput[],
	extras?: { factsGiven?: unknown; factsToLookup?: unknown; plan?: unknown },
): TaskLedger {
	if (inputs.length === 0) throw new Error("items is empty: list at least one item (label, optional scope).");
	if (inputs.length > MAX_LEDGER_ITEMS) throw new Error(`Too many items (${inputs.length}). Keep at most ${MAX_LEDGER_ITEMS}: group the smallest ones.`);
	const byId = new Map(ledger.items.map((item) => [item.id, item]));
	const byLabel = new Map(ledger.items.map((item) => [normalizeLabel(item.label), item]));
	const used = new Set<string>();
	const items: LedgerItem[] = inputs.map((input, index) => {
		const label = clean(input.label, LEDGER_LABEL_CHARS);
		if (!label) throw new Error(`Item ${index + 1} has no label: every item needs a short label.`);
		const scope = clean(input.scope, LEDGER_SCOPE_CHARS);
		const wantedId = clean(input.id, 40);
		const known = (wantedId ? byId.get(wantedId) : undefined) ?? byLabel.get(normalizeLabel(label));
		let id = known?.id ?? wantedId ?? "";
		if (!id || used.has(id)) {
			let n = index + 1;
			while (used.has(String(n)) || (byId.has(String(n)) && byId.get(String(n)) !== known)) n += 1;
			id = String(n);
		}
		used.add(id);
		// Item listado de novo num `set` é adotado explicitamente: deixa de ser só herdado.
		if (known) {
			const { carried: _carried, ...rest } = known;
			return { ...rest, id, label, ...(scope ? { scope } : {}) };
		}
		return { id, label, status: "pending", ...(scope ? { scope } : {}) };
	});
	const factsGiven = extras?.factsGiven === undefined ? ledger.factsGiven : cleanList(extras.factsGiven, MAX_LEDGER_FACTS, LEDGER_TEXT_CHARS);
	const factsToLookup = extras?.factsToLookup === undefined ? ledger.factsToLookup : cleanList(extras.factsToLookup, MAX_LEDGER_FACTS, LEDGER_TEXT_CHARS);
	const plan = extras?.plan === undefined ? ledger.plan : cleanList(extras.plan, MAX_LEDGER_PLAN, LEDGER_TEXT_CHARS);
	return adopt({ ...ledger, items, factsGiven, factsToLookup, plan });
}

export type ItemUpdate = {
	id: string;
	status: LedgerItemStatus;
	evidence?: unknown;
	ref?: unknown;
	reason?: unknown;
	detail?: unknown;
};

/** Atualiza um item. `done` exige evidência; `failed` exige motivo de classe real. Lança com dica. */
export function updateLedgerItem(ledger: TaskLedger, update: ItemUpdate, options: { trusted?: boolean } = {}): TaskLedger {
	const index = ledger.items.findIndex((item) => item.id === update.id);
	if (index < 0) {
		const known = ledger.items.slice(0, 12).map((item) => item.id).join(", ");
		throw new Error(`Unknown item id "${update.id}". Known ids: ${known || "none"}. Use action "get" to see the list.`);
	}
	if (!STATUSES.includes(update.status)) throw new Error(`status must be one of: ${STATUSES.join(", ")}.`);
	const current = ledger.items[index]!;
	const evidence = clean(update.evidence, LEDGER_TEXT_CHARS);
	const ref = clean(update.ref, 120);
	const detail = clean(update.detail, LEDGER_TEXT_CHARS);
	let next: LedgerItem;
	if (update.status === "done") {
		if (!evidence) throw new Error("Marking an item done needs evidence: a short note of what you actually read (max 200 chars).");
		next = { id: current.id, label: current.label, status: "done", evidence, ...(current.scope ? { scope: current.scope } : {}), ...(ref ? { ref } : current.ref ? { ref: current.ref } : {}) };
	} else if (update.status === "failed") {
		const reason: LedgerFailReason | undefined = [...LEDGER_FAIL_REASONS, ...(options.trusted ? [LEDGER_SUBAGENT_FAIL_REASON] : [])].find((value) => value === update.reason);
		if (!reason) {
			throw new Error(`An item can only be marked failed for a real blocker: reason must be one of ${LEDGER_FAIL_REASONS.join(", ")}. Content you can reach in the browser is not a blocker: read it.`);
		}
		next = { id: current.id, label: current.label, status: "failed", reason, ...(detail ? { detail } : {}), ...(current.scope ? { scope: current.scope } : {}) };
	} else {
		next = { id: current.id, label: current.label, status: update.status, ...(current.scope ? { scope: current.scope } : {}), ...(current.evidence ? { evidence: current.evidence } : {}) };
	}
	const items = ledger.items.slice();
	items[index] = next;
	return adopt({ ...ledger, items, stalled: 0 });
}

const quote = (label: string) => `"${label.length > 40 ? `${label.slice(0, 39)}…` : label}"`;

/** Itens abertos em uma linha (rótulos curtos), com teto de caracteres. */
export function describeOpenItems(ledger: TaskLedger, maxChars = 300): string {
	const parts: string[] = [];
	let used = 0;
	const open = openItems(ledger);
	for (const item of open) {
		const text = `${item.id} ${quote(item.label)}${item.scope ? ` (${item.scope})` : ""}`;
		if (used + text.length + 2 > maxChars) {
			parts.push(`+${open.length - parts.length} more`);
			break;
		}
		parts.push(text);
		used += text.length + 2;
	}
	return parts.join("; ");
}

/**
 * Camada reinjetada a cada passo (<= 600 caracteres): progresso, item corrente
 * com o pai sempre à vista, e o que ainda está aberto. Null sem itens.
 */
export function renderLedgerLayer(ledger: TaskLedger, maxChars = LEDGER_LAYER_CHARS): string | null {
	if (ledger.items.length === 0) return null;
	const done = countDone(ledger);
	const failed = ledger.items.filter((item) => item.status === "failed").length;
	const head = `Items: ${done}/${ledger.items.length} done${failed ? `, ${failed} failed` : ""}.`;
	if (ledger.carry === "offered" || ledger.carry === "asked") {
		// Oferta, não obrigação: a resposta ao pedido atual nunca espera por esta lista.
		const guide =
			" Old checklist from an earlier run, not adopted. Answer the user's current request fully first; never clear the list on your own. If the request is unrelated, end your reply with one short question, in the user's language, asking whether to close the old list. If the user continues it, resume with track_items update.";
		const text = `${head}${guide} Open: ${describeOpenItems(ledger, Math.max(40, maxChars - head.length - guide.length - 10))}.`;
		return text.slice(0, maxChars);
	}
	const current = currentItem(ledger);
	const now = current
		? ` Now: item ${current.id} ${quote(current.label)}${current.scope ? ` (parent: ${current.scope})` : ""}.`
		: " All items are closed.";
	const base = `${head}${now}`;
	const open = openItems(ledger).filter((item) => item !== current);
	const room = maxChars - base.length - " Open: ".length - 1;
	if (open.length === 0 || room < 20) return base.slice(0, maxChars);
	const rest = describeOpenItems({ ...ledger, items: open }, room);
	return `${base} Open: ${rest}.`.slice(0, maxChars);
}

/** Entrega parcial honesta: o que faltou e o motivo (campo estruturado). */
export function buildPartial(ledger: TaskLedger, fallbackReason: string): NonNullable<TaskLedger["partial"]> {
	const missing = ledger.items
		.filter((item) => item.status !== "done" && !(item.carried && isOpenItem(item)))
		.map((item) => ({
			id: item.id,
			label: item.label,
			reason: item.status === "failed" ? `${item.reason ?? "failed"}${item.detail ? `: ${item.detail}` : ""}` : fallbackReason,
		}));
	return { missing };
}
