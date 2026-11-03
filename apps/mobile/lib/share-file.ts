// Compartilhar o arquivo de verdade (PDF, planilha, imagem…): grava os bytes no cache e abre a folha de compartilhar do
// sistema. `expo-file-system` e `expo-sharing` vêm no Expo Go (SDK 58), então não pedem build nativo. Fica fora dos testes
// (precisa dos módulos nativos); a decisão do que compartilhar é pura, em `document-view.ts`.
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { Share } from "react-native";
import { cacheFileName } from "./document-view";

/** Texto: `Share.share` do React Native. Quem chama só usa para texto que cabe (`textFitsShare`); o resto vai como arquivo. */
export async function shareText(message: string, title: string): Promise<void> {
	await Share.share({ message, title }).catch(() => undefined);
}

/** Falha ao gravar o arquivo no cache ou abrir a folha do sistema (não é problema de rede). */
export class ShareFileError extends Error {
	constructor() {
		super("Não consegui preparar o arquivo.");
	}
}

/**
 * Arquivo: grava no cache, compartilha e APAGA a cópia temporária ao terminar (com ou sem erro; `shareAsync` só volta
 * depois que a pessoa escolhe o destino). Devolve false onde o sistema não oferece compartilhar arquivo (web).
 * Falha local vira `ShareFileError`, para a tela não dizer "sem conexão".
 */
export async function shareBytes(bytes: Uint8Array, filename: string, mime: string): Promise<boolean> {
	if (!(await Sharing.isAvailableAsync().catch(() => false))) return false;
	const file = new File(Paths.cache, cacheFileName(filename));
	try {
		file.create({ overwrite: true });
		await file.write(bytes);
		await Sharing.shareAsync(file.uri, { mimeType: mime || undefined, dialogTitle: filename });
		return true;
	} catch {
		throw new ShareFileError();
	} finally {
		try {
			if (file.exists) file.delete();
		} catch {
			// O cache é limpo pelo sistema se faltar espaço; apagar é só boa educação.
		}
	}
}
