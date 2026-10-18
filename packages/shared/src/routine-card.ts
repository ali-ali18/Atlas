import type { RoutineTriggerType } from "./routines.js";

/** Item de rotina para listagem na UI. */
export type RoutineListItemData = {
	id: string;
	name: string;
	triggerType: RoutineTriggerType;
	enabled: boolean;
	schedule?: string | null;
	hookKey?: string;
	/** "bot" = criada pelo bot no modo proativo. */
	createdBy?: "user" | "bot";
};

export type PersistedRoutineCard = {
	v: 1;
	kind: "routine";
	action: "created" | "listed" | "updated";
	title?: string;
	routineId?: string;
	triggerType?: RoutineTriggerType;
	detail?: string;
	/** URL pública do webhook (sem secret). */
	hookUrl?: string;
	/** Secret plaintext — só no card de create, uma vez. */
	hookSecret?: string;
	items?: RoutineListItemData[];
};

const ROUTINE_ACTIONS: ReadonlySet<PersistedRoutineCard["action"]> = new Set([
	"created",
	"listed",
	"updated",
]);

export function isPersistedRoutineCard(
	value: unknown,
): value is PersistedRoutineCard {
	if (!value || typeof value !== "object") return false;
	const row = value as Record<string, unknown>;
	return (
		row.v === 1 &&
		row.kind === "routine" &&
		typeof row.action === "string" &&
		ROUTINE_ACTIONS.has(row.action as PersistedRoutineCard["action"])
	);
}
