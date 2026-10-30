import type { botActions as ptBR } from "../pt-BR/botActions";
import type { NamespaceMessages } from "../../translator";

export const botActions: NamespaceMessages<typeof ptBR> = {
	"botActions.pinFailed": "No se pudo fijar a {name}. Inténtalo de nuevo.",
	"botActions.unpinFailed": "No se pudo desfijar a {name}. Inténtalo de nuevo.",
	"botActions.reorderFailed": "No se pudo reordenar a {name}. Inténtalo de nuevo.",
	"botActions.sectionMoveFailed": "No se pudo mover a {name} de sección. Inténtalo de nuevo.",
	"botActions.modelFailed": "No se pudo cambiar el modelo de {name}. Inténtalo de nuevo.",
	"botActions.primarySetFailed": "No se pudo definir a {name} como principal. Inténtalo de nuevo.",
	"botActions.primaryUnsetFailed": "No se pudo quitar a {name} como principal. Inténtalo de nuevo.",
	"botActions.notifyFailed": "No se pudieron guardar las notificaciones de {name}. Inténtalo de nuevo.",
	"botActions.markUnreadFailed": "No se pudo marcar la conversación de {name} como no leída.",
	"botActions.markReadFailed": "No se pudo marcar la conversación de {name} como leída.",
	"botActions.deleteFailed": "No se pudo eliminar a {name}. Inténtalo de nuevo.",
	"botActions.section.createFailed": "No se pudo crear la sección. Inténtalo de nuevo.",
	"botActions.section.renameFailed": "No se pudo renombrar la sección. Inténtalo de nuevo.",
	"botActions.section.reorderFailed": "No se pudo cambiar el orden de las secciones. Inténtalo de nuevo.",
	"botActions.section.deleteFailed": "No se pudo eliminar la sección. Inténtalo de nuevo.",
	"botActions.avatar.working": "Trabajando",
	"botActions.avatar.unread": "Sin leer",
	"botActions.avatar.labeled": "{label}: {status}",
};
