import type { app as ptBR } from "../pt-BR/app";
import type { NamespaceMessages } from "../../translator";

export const app: NamespaceMessages<typeof ptBR> = {
	"app.configSaved": "Settings saved",
	"app.configSaveFailed": "Couldn't save the settings",
	"app.groupChangeFailed": "Couldn't change the group. Please try again.",
	"app.selectBot": "Select a bot.",
	"app.selectBotFirst": "Select a bot first",
	"app.routineSaveFirst": "Save the routine before turning it on.",
	"app.routineToggleFailed": "Couldn't change the routine.",
	"app.routineNotFound": "Routine not found",
	"app.routineCreateFailed": "Couldn't create the routine",
	"app.triggerSaveFailed": "Couldn't save the trigger",
	"app.routineGroupCreateFailed": "Couldn't create the group.",
	"app.routineGroupRenameFailed": "Couldn't rename the group.",
	"app.routineGroupChangeFailed": "Couldn't change the group.",
	"app.routineGroupDeleteFailed": "Couldn't delete the group.",
	"app.sandboxStopFailed": "I couldn't shut it down right now. Try again in a moment.",
	"app.sandboxStartFailed": "The VM wouldn't start right now. I already tried a few times on my own; try again in a moment.",
	"app.deleteGroupTitle": "Delete group “{name}”?",
	"app.deleteBotTitle": "Delete “{name}”?",
	"app.deleteGroupBody": "This permanently deletes the group and its chat history. The bots in it are not deleted and stay available individually. This can't be undone.",
	"app.deleteBotBody": "The agent and the conversation history will be erased. This can't be undone.",
	"app.deleting": "Deleting…",
};
