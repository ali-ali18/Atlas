import { validateProfileName } from "@workspace/shared";

/** Estado do campo Nome: o que mostrar e se há o que salvar. */
export function nameDraftState(draft: string, saved: string): { dirty: boolean; error: string | null; value: string | null } {
	const result = validateProfileName(draft);
	const trimmed = draft.trim().replace(/\s+/g, " ");
	const dirty = trimmed !== saved.trim();
	if (!result.ok) return { dirty, error: draft.length === 0 && !dirty ? null : result.error, value: null };
	return { dirty, error: null, value: result.name };
}
