import type { library as ptBR } from "../pt-BR/library";
import type { NamespaceMessages } from "../../translator";

export const library: NamespaceMessages<typeof ptBR> = {
	"library.updatedAgo": "Updated {when}",
	"library.sources.one": "1 source",
	"library.sources.other": "{count} sources",
	"library.public.title": "Shared panel",
	"library.public.goneTitle": "This link is no longer available",
	"library.public.goneBody": "The panel was deleted or whoever shared it turned the link off.",
	"library.public.error": "I couldn't load the panel right now. Try again in a moment.",
	"library.public.footerOf": "Panel by {name}",
	"library.public.readOnly": "read-only",
};
