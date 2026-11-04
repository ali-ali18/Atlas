import { parseTaskList, type TaskListItem } from "@workspace/shared";
import { continuedWorkNote } from "../engine-v2/prompt.js";
import { openItems } from "../engine-v2/task-list.js";

/**
 * Trabalho anterior da conversa no motor v3 (PR8e, lacuna do PR9), pelo ESTADO do run anterior e nunca pelo texto
 * (decisão do dono, 03/11), do mesmo jeito que o v2:
 * - mensagem digitada depois de um run que parou com itens abertos (`continuedWork`, sem `autoContinued`): os itens
 *   abertos entram como nota de CONTEXTO; a lista deste run só nasce se o modelo chamar `update_task_list`;
 * - continuação automática ou plano aprovado (o worker só passa `priorTaskList` aí): a lista segue com o run, e a nota
 *   diz de onde continuar (sem refazer o que já foi feito).
 * Puro: quem chama põe a nota no bloco volátil do 1º passo.
 */
export function priorWorkContext(input: { continuedWork?: boolean; autoContinued?: boolean; priorOpenItems?: unknown; priorTaskList?: unknown }): { note: string; seed?: TaskListItem[] } {
	if (input.continuedWork === true && input.autoContinued !== true) {
		const open = openItems(parseTaskList(input.priorOpenItems)).map((item) => item.content);
		if (open.length > 0) return { note: continuedWorkNote(open) };
	}
	const seed = parseTaskList(input.priorTaskList);
	if (!seed?.length || openItems(seed).length === 0) return { note: "" };
	const lines = seed.slice(0, 30).map((item) => `- [${item.status}] ${item.content.slice(0, 160)}`);
	return {
		note: `Task list of this task, carried from its previous run:\n${lines.join("\n")}\nContinue from the first item that is not completed; do not redo completed ones. Keep the list current with update_task_list.`,
		seed,
	};
}
