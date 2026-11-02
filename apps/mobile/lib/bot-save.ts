// "Concluído" do Editar Bot como função pura e testável: uma guarda síncrona (toque duplo = um PATCH só), o PATCH e,
// só no sucesso, a atualização da home. Em erro devolve a frase para a tela e o rascunho fica como está.
import { saveErrorText } from "./bot-api";
import type { BotPatch } from "./bot-edit";
import { isUnauthorized } from "./chat-api";

export type SaveResult = { ok: true } | { ok: false; error: string; unauthorized: boolean } | { ok: "ignored" };

/** Guarda síncrona: enquanto uma chamada roda, as outras são ignoradas (vale antes de qualquer `await`). */
export function createSaveGuard() {
	let busy = false;
	return {
		get busy(): boolean {
			return busy;
		},
		async run(task: () => Promise<SaveResult>): Promise<SaveResult> {
			if (busy) return { ok: "ignored" };
			busy = true;
			try {
				return await task();
			} finally {
				busy = false;
			}
		},
	};
}

export async function saveBot(deps: { patchBot: (patch: BotPatch) => Promise<void>; applyUpdate: (patch: BotPatch) => void }, patch: BotPatch): Promise<SaveResult> {
	try {
		await deps.patchBot(patch);
	} catch (reason) {
		return { ok: false, error: saveErrorText(reason), unauthorized: isUnauthorized(reason) };
	}
	deps.applyUpdate(patch);
	return { ok: true };
}
