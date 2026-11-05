// Escolher e preparar a foto do perfil no aparelho: seletor de fotos com recorte quadrado (expo-image-picker) e redução
// para 256x256 JPEG com o Skia (já no app; sem módulo nativo novo). A conta é em `profile-image.ts`.
import * as ImagePicker from "expo-image-picker";
import { centerSquare, fitJpeg, PROFILE_IMAGE_SIZE } from "./profile-image";

export type PhotoOutcome = { kind: "ready"; dataUrl: string } | { kind: "canceled" } | { kind: "denied" } | { kind: "failed" };

/** Reduz a imagem em `uri` ao quadrado central de 256 px e codifica em JPEG abaixo do limite. `null` se não deu. */
export async function prepareProfileImage(uri: string): Promise<string | null> {
	// require tardio: o Skia só carrega quando o dono troca a foto, nunca na abertura do app (nem ao importar a tela Perfil)
	const { ImageFormat, Skia } = require("@shopify/react-native-skia") as typeof import("@shopify/react-native-skia");
	const data = await Skia.Data.fromURI(uri);
	const image = Skia.Image.MakeImageFromEncoded(data);
	if (!image) return null;
	const { sx, sy, side } = centerSquare(image.width(), image.height());
	const surface = Skia.Surface.MakeOffscreen(PROFILE_IMAGE_SIZE, PROFILE_IMAGE_SIZE);
	if (!surface) return null;
	surface.getCanvas().drawImageRect(image, Skia.XYWHRect(sx, sy, side, side), Skia.XYWHRect(0, 0, PROFILE_IMAGE_SIZE, PROFILE_IMAGE_SIZE), Skia.Paint());
	surface.flush();
	const snapshot = surface.makeImageSnapshot();
	return fitJpeg((quality) => snapshot.encodeToBase64(ImageFormat.JPEG, quality));
}

/** Abre a galeria com o recorte quadrado do sistema e devolve a foto já pronta para enviar. */
export async function pickProfilePhoto(): Promise<PhotoOutcome> {
	try {
		const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
		if (!permission.granted) return { kind: "denied" };
		const result = await ImagePicker.launchImageLibraryAsync({
			mediaTypes: ["images"],
			allowsEditing: true,
			aspect: [1, 1],
			quality: 1,
			preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
		});
		const asset = result.canceled ? null : result.assets[0];
		if (!asset) return { kind: "canceled" };
		const dataUrl = await prepareProfileImage(asset.uri);
		return dataUrl ? { kind: "ready", dataUrl } : { kind: "failed" };
	} catch {
		return { kind: "failed" };
	}
}
