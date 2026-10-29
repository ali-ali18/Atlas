import type { botActions as ptBR } from "../pt-BR/botActions";
import type { NamespaceMessages } from "../../translator";

export const botActions: NamespaceMessages<typeof ptBR> = {
	"botActions.pinFailed": "Couldn't pin {name}. Try again.",
	"botActions.unpinFailed": "Couldn't unpin {name}. Try again.",
	"botActions.reorderFailed": "Couldn't reorder {name}. Try again.",
	"botActions.sectionMoveFailed": "Couldn't move {name} to another section. Try again.",
	"botActions.modelFailed": "Couldn't change the model for {name}. Try again.",
	"botActions.primarySetFailed": "Couldn't make {name} your main bot. Try again.",
	"botActions.primaryUnsetFailed": "Couldn't remove {name} as your main bot. Try again.",
	"botActions.notifyFailed": "Couldn't save notifications for {name}. Try again.",
	"botActions.markUnreadFailed": "Couldn't mark {name}'s conversation as unread.",
	"botActions.markReadFailed": "Couldn't mark {name}'s conversation as read.",
	"botActions.deleteFailed": "Couldn't delete {name}. Try again.",
	"botActions.section.createFailed": "Couldn't create the section. Try again.",
	"botActions.section.renameFailed": "Couldn't rename the section. Try again.",
	"botActions.section.reorderFailed": "Couldn't change the order of the sections. Try again.",
	"botActions.section.deleteFailed": "Couldn't delete the section. Try again.",
	"botActions.avatar.working": "Working",
	"botActions.avatar.unread": "Unread",
	"botActions.avatar.labeled": "{label}: {status}",
};
