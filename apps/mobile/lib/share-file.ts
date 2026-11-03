// Compartilhar o arquivo de verdade (PDF, planilha, imagem…): grava os bytes no cache e abre a folha de compartilhar do
// sistema. `expo-file-system` e `expo-sharing` vêm no Expo Go (SDK 58), então não pedem build nativo. Fica fora dos testes
// (precisa dos módulos nativos); a decisão do que compartilhar é pura, em `document-view.ts`.
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { Share } from "react-native";
import { truncateForShare } from "./document-view";

/** Nome seguro para gravar no cache: sem pasta, sem caracteres reservados. */
export function cacheFileName(filename: string): string {
	const base = filename.split(/[\\/]/).pop() ?? "";
	const clean = base.replace(/[\u0000-\u001f<>:"|?*]/g, "").replace(/^\.+/, "").trim();
	return clean || "documento";
}

/** Texto: `Share.share` do React Native (corta se for gigante). */
export async function shareText(message: string, title: string): Promise<void> {
	await Share.share({ message: truncateForShare(message).text, title }).catch(() => undefined);
}

/** Arquivo: grava no cache e compartilha. Devolve false onde o sistema não oferece compartilhar arquivo (web). */
export async function shareBytes(bytes: Uint8Array, filename: string, mime: string): Promise<boolean> {
	if (!(await Sharing.isAvailableAsync())) return false;
	const file = new File(Paths.cache, cacheFileName(filename));
	file.create({ overwrite: true });
	await file.write(bytes);
	await Sharing.shareAsync(file.uri, { mimeType: mime || undefined, dialogTitle: filename });
	return true;
}
