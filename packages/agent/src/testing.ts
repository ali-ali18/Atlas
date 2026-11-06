import type { Ports } from "./ports/index.js";
import type { ToolContext } from "./tools/types.js";

/** Contexto de teste: as portas ficam vazias; teste que precisar de uma monta a sua. */
export function fakeToolContext(): ToolContext {
	return { runId: "run-1", ownerId: "owner-1", ports: {} as Ports };
}
