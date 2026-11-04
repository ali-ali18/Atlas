import * as React from "react";
import { useAtlasSession } from "@/lib/atlas-session";
import { IMAGE_NOTICE, imageDownloadErrorText, saveOutcomeText } from "@/lib/image-actions";
import { downloadImageBytes } from "@/lib/image-source";
import { imageFileName, type ViewerImage } from "@/lib/image-viewer";
import { SaveImageError, saveImageBytes } from "@/lib/save-image";
import { ShareFileError, shareBytes } from "@/lib/share-file";

/**
 * O que o menu do "…" faz com a imagem. Cada ação devolve o aviso curto para mostrar (ou `null` quando não há o que dizer,
 * como depois de a folha de compartilhar do sistema fechar). Os visualizadores de teste e de prévia passam as suas.
 */
export type ImageViewerActions = {
	forward: (image: ViewerImage) => Promise<string | null>;
	share: (image: ViewerImage) => Promise<string | null>;
	save: (image: ViewerImage) => Promise<string | null>;
};

/**
 * Encaminhar e Compartilhar usam a folha de compartilhar do sistema, com o ARQUIVO da imagem (baixado com a sessão e
 * gravado no cache): o app ainda não tem anexo no composer nem rota de servidor para reenviar uma imagem a outro bot.
 * Salvar entrega à galeria (só a permissão de escrever).
 */
export function useImageActions(): ImageViewerActions {
	const { apiFetch } = useAtlasSession();
	return React.useMemo(() => {
		const shareFile = async (image: ViewerImage): Promise<string | null> => {
			try {
				const { bytes, mime } = await downloadImageBytes(apiFetch, image.artifactId);
				const shared = await shareBytes(bytes, imageFileName(image), image.mime || mime);
				return shared ? null : IMAGE_NOTICE.shareUnavailable;
			} catch (error) {
				return error instanceof ShareFileError ? IMAGE_NOTICE.prepareFailed : imageDownloadErrorText(error);
			}
		};
		return {
			forward: shareFile,
			share: shareFile,
			save: async (image) => {
				try {
					const { bytes } = await downloadImageBytes(apiFetch, image.artifactId);
					return saveOutcomeText(await saveImageBytes(bytes, imageFileName(image)));
				} catch (error) {
					return error instanceof SaveImageError ? IMAGE_NOTICE.saveFailed : imageDownloadErrorText(error);
				}
			},
		};
	}, [apiFetch]);
}
