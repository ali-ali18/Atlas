import type { share as ptBR } from "../pt-BR/share";
import type { NamespaceMessages } from "../../translator";

export const share: NamespaceMessages<typeof ptBR> = {
	"share.publicLinkWarning": "Anyone with the link can see this panel and its updates.",
	"share.publicLink": "Public link",
	"share.linkAddress": "Public link address",
	"share.copied": "Copied",
	"share.copy": "Copy",
	"share.linkHidden": "For security, the address only shows when it's created. Generate a new link to copy it (the previous one stops working).",
	"share.newLink": "Generate new link",
	"share.disableLink": "Turn off link",
	"share.disabled": "Off. Turn it on to generate a read-only link that updates with the panel.",
	"share.readError": "I couldn't read the link right now. Try again.",
	"share.updateError": "I couldn't update the link. Try again.",
	"share.title": "Share “{title}”",
	"share.description": "Read-only link for people without an account.",
	"share.imageError": "I couldn't generate the image right now.",
	"share.imageCopied": "Image copied",
	"share.imageDownloaded": "Your browser can't copy images; I downloaded the PNG",
	"share.pngDownloaded": "PNG downloaded",
	"share.pdfDownloaded": "PDF downloaded",
	"share.menuLabel": "Share {title}",
	"share.copyImage": "Copy image",
	"share.downloadPng": "Download PNG",
	"share.downloadPdf": "Download PDF",
	"share.publicLinkItem": "Public link…",
};
