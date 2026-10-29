import type { share as ptBR } from "../pt-BR/share";
import type { NamespaceMessages } from "../../translator";

export const share: NamespaceMessages<typeof ptBR> = {
	"share.publicLinkWarning": "Cualquiera con el enlace ve este panel y sus actualizaciones.",
	"share.publicLink": "Enlace público",
	"share.linkAddress": "Dirección del enlace público",
	"share.copied": "Copiado",
	"share.copy": "Copiar",
	"share.linkHidden": "Por seguridad, la dirección solo aparece al crearse. Genera un nuevo enlace para copiarlo (el anterior deja de valer).",
	"share.newLink": "Generar nuevo enlace",
	"share.disableLink": "Desactivar enlace",
	"share.disabled": "Desactivado. Actívalo para generar un enlace de solo lectura que se actualiza con el panel.",
	"share.readError": "No pude leer el enlace ahora. Inténtalo de nuevo.",
	"share.updateError": "No pude actualizar el enlace. Inténtalo de nuevo.",
	"share.title": "Compartir «{title}»",
	"share.description": "Enlace de solo lectura para quien no tiene cuenta.",
	"share.imageError": "No pude generar la imagen ahora.",
	"share.imageCopied": "Imagen copiada",
	"share.imageDownloaded": "Tu navegador no copia imágenes; descargué el PNG",
	"share.pngDownloaded": "PNG descargado",
	"share.pdfDownloaded": "PDF descargado",
	"share.menuLabel": "Compartir {title}",
	"share.copyImage": "Copiar imagen",
	"share.downloadPng": "Descargar PNG",
	"share.downloadPdf": "Descargar PDF",
	"share.publicLinkItem": "Enlace público…",
};
