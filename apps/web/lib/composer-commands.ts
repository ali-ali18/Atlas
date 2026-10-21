import { COMPACT_COMMAND, COMPACT_COMMAND_DESCRIPTION, parseCompactCommand } from "@workspace/shared";

/** Comando do composer oferecido no `/` ao lado das skills (hoje só `/compact`). */
export type ComposerCommandCandidate = { id: string; name: string; description: string; kind: "command" };

/** Comandos que o `/` oferece: só no chat 1:1 e só se quem monta o composer sabe tratá-los. */
export function composerCommandCandidates(input: { compactAvailable: boolean; groupMode: boolean }): ComposerCommandCandidate[] {
	if (!input.compactAvailable || input.groupMode) return [];
	return [{ id: `command:${COMPACT_COMMAND}`, name: COMPACT_COMMAND, description: COMPACT_COMMAND_DESCRIPTION, kind: "command" }];
}

/**
 * O texto enviado é um comando do composer? `/compact` e `/compact <foco>` viram ação (nunca mensagem). Com anexo,
 * em grupo ou sem tratador, é texto comum e segue o envio normal.
 */
export function resolveComposerCommand(
	text: string,
	input: { compactAvailable: boolean; groupMode: boolean; hasAttachments: boolean },
): { type: "compact"; focus?: string } | null {
	if (!input.compactAvailable || input.groupMode || input.hasAttachments) return null;
	const compact = parseCompactCommand(text);
	return compact ? { type: "compact", ...(compact.focus ? { focus: compact.focus } : {}) } : null;
}
