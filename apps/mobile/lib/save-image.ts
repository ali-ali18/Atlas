// Salvar a imagem na galeria: grava os bytes no cache, entrega à galeria e APAGA a cópia temporária. `expo-media-library`
// vem no Expo Go (SDK 58), então não pede build nativo; pede só a permissão de ESCREVER (sem ler a galeria). Fica fora
// dos testes (módulos nativos); as frases e a decisão do que fazer em cada caso são puras, em `image-actions.ts`.
import { File, Paths } from "expo-file-system";
import * as MediaLibrary from "expo-media-library";
import { Platform } from "react-native";
import { cacheFileName } from "./document-view";
import type { SaveOutcome } from "./image-actions";

/** Falha ao gravar o arquivo no cache ou entregar à galeria (não é problema de rede). */
export class SaveImageError extends Error {
	constructor() {
		super("Não consegui salvar a imagem.");
	}
}

export async function saveImageBytes(bytes: Uint8Array, filename: string): Promise<SaveOutcome> {
	// No navegador não existe galeria: quem chama oferece "Compartilhar".
	if (Platform.OS === "web") return "unavailable";
	const permission = await MediaLibrary.requestPermissionsAsync(true).catch(() => null);
	if (!permission) return "unavailable";
	if (!permission.granted) return "denied";
	const file = new File(Paths.cache, cacheFileName(filename));
	try {
		file.create({ overwrite: true });
		await file.write(bytes);
		await MediaLibrary.saveToLibraryAsync(file.uri);
		return "saved";
	} catch {
		throw new SaveImageError();
	} finally {
		try {
			if (file.exists) file.delete();
		} catch {
			// O cache é limpo pelo sistema se faltar espaço; apagar é só boa educação.
		}
	}
}
