import type { ChatTool } from "@workspace/llm";
import {
	LEDGER_FAIL_REASONS,
	MAX_LEDGER_ITEMS,
	createTaskLedger,
	isLedgerSatisfied,
	renderLedgerLayer,
	setLedgerItems,
	updateLedgerItem,
	type ItemInput,
	type ItemUpdate,
	type LedgerItemStatus,
	type TaskLedger,
} from "@workspace/shared";

/**
 * `track_items` (V3): o modelo declara e atualiza a lista de itens de uma
 * tarefa que se repete (semanas, páginas, linhas). A lista vive no ledger da
 * tarefa (checkpoint) e volta compacta a cada passo; o portão de entrega a usa.
 * Tudo aqui é puro: o loop só injeta o armazenamento.
 */

export const TRACK_ITEMS_TOOL_NAME = "track_items";
const BATCH_UPDATES_MAX = 10;

export const TRACK_ITEMS_TOOL: ChatTool = {
	type: "function",
	function: {
		name: TRACK_ITEMS_TOOL_NAME,
		description:
			"Keeps a checklist for work that repeats over several similar things (sections, pages, rows, records). USE WHEN the task covers 3 or more similar items, or the request says all or each: declare the list first, then work through it. DO NOT USE for a single lookup. " +
			"set: write the list from what you saw (label, and scope = the parent the item belongs to), plus optional facts_given, facts_to_lookup and a short plan (max 8 steps). " +
			"update: mark an item in_progress when you start it, done with a short evidence of what you read, or failed only with a real reason (login, captcha, permission, not_found); several updates can go in one call. " +
			"get: show the list. clear: drop the list when the request changed. Files and the final answer are held back while items are open.",
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["set", "update", "get", "clear"] },
				items: {
					type: "array",
					description: `set: the items (up to ${MAX_LEDGER_ITEMS}).`,
					items: {
						type: "object",
						properties: {
							id: { type: "string", description: "Optional short id; numbered automatically if omitted." },
							label: { type: "string", description: "Short label (max 120 chars)." },
							scope: { type: "string", description: "Parent of the item, e.g. the course a week belongs to (max 80 chars)." },
						},
						required: ["label"],
					},
				},
				facts_given: { type: "array", items: { type: "string" }, description: "set: what the user already told you." },
				facts_to_lookup: { type: "array", items: { type: "string" }, description: "set: what is still unknown." },
				plan: { type: "array", items: { type: "string" }, description: "set: up to 8 short steps." },
				id: { type: "string", description: "update: the item id." },
				status: { type: "string", enum: ["pending", "in_progress", "done", "failed"], description: "update: new status." },
				evidence: { type: "string", description: "update done: what you read (max 200 chars)." },
				ref: { type: "string", description: "update done: optional research_note source or artifact id." },
				reason: { type: "string", enum: [...LEDGER_FAIL_REASONS], description: "update failed: the real blocker." },
				detail: { type: "string", description: "update failed: one short sentence." },
				updates: {
					type: "array",
					description: `update: several updates at once (up to ${BATCH_UPDATES_MAX}); each has id, status and the fields above.`,
					items: { type: "object" },
				},
			},
			required: ["action"],
		},
	},
};

/** Onde a lista mora: o orquestrador implementa sobre o `TaskState`. */
export type LedgerStore = {
	get(): TaskLedger | undefined;
	set(next: TaskLedger | undefined): void;
};

const ACTIONS = ["set", "update", "get", "clear"] as const;

function itemInputs(value: unknown): ItemInput[] {
	if (!Array.isArray(value)) throw new Error("items must be a list of { label, scope? }.");
	return value.map((entry) => {
		if (typeof entry === "string") return { label: entry };
		if (entry && typeof entry === "object" && !Array.isArray(entry)) return entry as ItemInput;
		throw new Error("Each item must be an object { label, scope? }.");
	});
}

function toUpdate(raw: Record<string, unknown>): ItemUpdate {
	const id = typeof raw.id === "string" ? raw.id.trim() : "";
	if (!id) throw new Error("update needs the item id.");
	if (typeof raw.status !== "string") throw new Error("update needs a status: pending, in_progress, done or failed.");
	return { id, status: raw.status as LedgerItemStatus, evidence: raw.evidence, ref: raw.ref, reason: raw.reason, detail: raw.detail };
}

/** Resumo para o modelo: a camada compacta + o que fazer a seguir. */
function summarize(ledger: TaskLedger): string {
	const layer = renderLedgerLayer(ledger);
	if (!layer) return "No items.";
	if (isLedgerSatisfied(ledger)) {
		return `${layer} Every item is closed: you can deliver now. List any failed item and its reason.`;
	}
	return layer;
}

export function executeTrackItems(args: Record<string, unknown>, ctx: { ledgerStore?: LedgerStore }): { summary: string } {
	const store = ctx.ledgerStore;
	if (!store) throw new Error("track_items is not available in this run.");
	const action = ACTIONS.find((value) => value === args.action);
	if (!action) throw new Error(`action must be one of: ${ACTIONS.join(", ")}.`);
	const current = store.get();

	if (action === "get") {
		return { summary: current ? summarize(current) : "No items yet. Use action set to declare them." };
	}
	if (action === "clear") {
		store.set(undefined);
		return { summary: "Items cleared." };
	}
	if (action === "set") {
		const next = setLedgerItems(current ?? createTaskLedger(), itemInputs(args.items), {
			factsGiven: args.facts_given,
			factsToLookup: args.facts_to_lookup,
			plan: args.plan,
		});
		store.set(next);
		return { summary: `Saved ${next.items.length} items. ${summarize(next)}` };
	}
	// update
	if (!current || current.items.length === 0) throw new Error("There are no items yet: declare them first with action set.");
	const rawUpdates = Array.isArray(args.updates) && args.updates.length > 0 ? args.updates : [args];
	if (rawUpdates.length > BATCH_UPDATES_MAX) throw new Error(`Too many updates in one call (max ${BATCH_UPDATES_MAX}).`);
	let next = current;
	for (const raw of rawUpdates) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Each update must be an object { id, status, ... }.");
		next = updateLedgerItem(next, toUpdate(raw as Record<string, unknown>));
	}
	store.set(next);
	return { summary: summarize(next) };
}
