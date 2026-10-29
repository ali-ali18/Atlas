import type { app as ptBR } from "../pt-BR/app";
import type { NamespaceMessages } from "../../translator";

export const app: NamespaceMessages<typeof ptBR> = {
	"app.configSaved": "Configuración guardada",
	"app.configSaveFailed": "No se ha podido guardar la configuración",
	"app.groupChangeFailed": "No se ha podido cambiar el grupo. Inténtalo de nuevo.",
	"app.selectBot": "Selecciona un bot.",
	"app.selectBotFirst": "Selecciona un bot primero",
	"app.routineSaveFirst": "Guarda la rutina antes de activarla.",
	"app.routineToggleFailed": "No se ha podido cambiar la rutina.",
	"app.routineNotFound": "Rutina no encontrada",
	"app.routineCreateFailed": "No se ha podido crear la rutina",
	"app.triggerSaveFailed": "No se ha podido guardar el disparador",
	"app.routineGroupCreateFailed": "No se ha podido crear el grupo.",
	"app.routineGroupRenameFailed": "No se ha podido renombrar el grupo.",
	"app.routineGroupChangeFailed": "No se ha podido cambiar el grupo.",
	"app.routineGroupDeleteFailed": "No se ha podido eliminar el grupo.",
	"app.sandboxStopFailed": "No he podido apagarlo ahora. Inténtalo de nuevo en unos instantes.",
	"app.sandboxStartFailed": "La VM no ha querido arrancar ahora. Ya lo he intentado varias veces yo solo; inténtalo de nuevo en unos instantes.",
	"app.deleteGroupTitle": "¿Eliminar el grupo “{name}”?",
	"app.deleteBotTitle": "¿Eliminar “{name}”?",
	"app.deleteGroupBody": "Esto elimina de forma permanente el grupo y su historial de chat. Los bots que forman parte de él no se eliminan y siguen disponibles de forma individual. Esta acción no se puede deshacer.",
	"app.deleteBotBody": "Se borrarán el agente y el historial de la conversación. Esta acción no se puede deshacer.",
	"app.deleting": "Eliminando…",
};
