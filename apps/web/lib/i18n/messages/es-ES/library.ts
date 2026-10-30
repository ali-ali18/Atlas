import type { library as ptBR } from "../pt-BR/library";
import type { NamespaceMessages } from "../../translator";

export const library: NamespaceMessages<typeof ptBR> = {
	"library.updatedAgo": "Actualizado {when}",
	"library.sources.one": "1 fuente",
	"library.sources.other": "{count} fuentes",
	"library.public.title": "Panel compartido",
	"library.public.goneTitle": "Este enlace ya no está disponible",
	"library.public.goneBody": "El panel se ha eliminado o quien lo compartió desactivó el enlace.",
	"library.public.error": "No he podido cargar el panel ahora. Inténtalo de nuevo en unos instantes.",
	"library.public.footerOf": "Panel de {name}",
	"library.public.readOnly": "solo lectura",
};
