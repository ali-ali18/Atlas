// Seletores nativos de anexo (câmera, fotos, arquivos) devolvendo a forma comum `PickedFile`. Fino de propósito: a decisão
// (limites, rota, nome) é de `attachments.ts`; aqui só se fala com os módulos do Expo.
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import type { PickedFile } from "./attachments";

export type PickOutcome = { kind: "picked"; files: PickedFile[] } | { kind: "canceled" } | { kind: "denied"; what: "camera" | "photos" } | { kind: "failed" };

function fromImageAsset(asset: ImagePicker.ImagePickerAsset): PickedFile {
	return { uri: asset.uri, name: asset.fileName, mime: asset.mimeType, size: asset.fileSize, width: asset.width, height: asset.height };
}

// JPEG com qualidade 0.8 e a representação "compatível" (no iOS evita HEIC, que o servidor não aceita).
const IMAGE_OPTIONS = { mediaTypes: ["images"], quality: 0.8, preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible } satisfies ImagePicker.ImagePickerOptions;

export async function pickFromCamera(): Promise<PickOutcome> {
	try {
		const permission = await ImagePicker.requestCameraPermissionsAsync();
		if (!permission.granted) return { kind: "denied", what: "camera" };
		const result = await ImagePicker.launchCameraAsync(IMAGE_OPTIONS);
		return result.canceled ? { kind: "canceled" } : { kind: "picked", files: result.assets.map(fromImageAsset) };
	} catch {
		return { kind: "failed" };
	}
}

/** `limit` = quantas imagens ainda cabem na mensagem. */
export async function pickPhotos(limit: number): Promise<PickOutcome> {
	try {
		const result = await ImagePicker.launchImageLibraryAsync({ ...IMAGE_OPTIONS, allowsMultipleSelection: limit > 1, selectionLimit: Math.max(1, limit) });
		return result.canceled ? { kind: "canceled" } : { kind: "picked", files: result.assets.map(fromImageAsset) };
	} catch {
		return { kind: "failed" };
	}
}

export async function pickDocuments(): Promise<PickOutcome> {
	try {
		const result = await DocumentPicker.getDocumentAsync({ type: "*/*", multiple: true, copyToCacheDirectory: true });
		if (result.canceled) return { kind: "canceled" };
		return { kind: "picked", files: result.assets.map((asset) => ({ uri: asset.uri, name: asset.name, mime: asset.mimeType, size: asset.size })) };
	} catch {
		return { kind: "failed" };
	}
}
