import { PROFILE_IMAGE_MAX_BYTES, PROFILE_IMAGE_SIZE } from "@workspace/shared";
import { activeT } from "@/lib/i18n/active";

/** Quadrado central da imagem: origem e lado em pixels da imagem original. */
export function centerSquare(width: number, height: number): { sx: number; sy: number; side: number } {
	const side = Math.max(1, Math.min(width, height));
	return { sx: Math.floor((width - side) / 2), sy: Math.floor((height - side) / 2), side };
}

/** Acima disso nem tentamos abrir (a API também recusa; evita travar o celular com um arquivo enorme). */
export const PROFILE_PICK_MAX_BYTES = 25 * 1024 * 1024;

export type ProfileImagePick = { ok: true } | { ok: false; error: string };

/** Valida o arquivo escolhido antes de decodificar: precisa ser imagem raster (SVG não). */
export function checkPickedFile(file: { type: string; size: number }): ProfileImagePick {
	if (!/^image\/(jpeg|png|webp|heic|heif|avif|bmp)$/i.test(file.type)) {
		return { ok: false, error: activeT("errors.choosePhoto") };
	}
	if (file.size > PROFILE_PICK_MAX_BYTES) return { ok: false, error: activeT("errors.photoTooBig") };
	return { ok: true };
}

/** Recorta o quadrado central, reduz para 256x256 e codifica em WebP (ou JPEG) abaixo de 60 KB. Devolve um data URL. */
export async function prepareProfileImage(file: Blob): Promise<string> {
	const bitmap = await createImageBitmap(file);
	try {
		const { sx, sy, side } = centerSquare(bitmap.width, bitmap.height);
		const canvas = document.createElement("canvas");
		canvas.width = PROFILE_IMAGE_SIZE;
		canvas.height = PROFILE_IMAGE_SIZE;
		const context = canvas.getContext("2d");
		if (!context) throw new Error(activeT("errors.preparePhoto"));
		context.imageSmoothingQuality = "high";
		context.drawImage(bitmap, sx, sy, side, side, 0, 0, PROFILE_IMAGE_SIZE, PROFILE_IMAGE_SIZE);
		for (const type of ["image/webp", "image/jpeg"]) {
			for (const quality of [0.85, 0.7, 0.55, 0.4]) {
				const url = canvas.toDataURL(type, quality);
				if (!url.startsWith(`data:${type}`)) break; // o navegador não codifica esse tipo
				if (dataUrlBytes(url) <= PROFILE_IMAGE_MAX_BYTES) return url;
			}
		}
		throw new Error(activeT("errors.shrinkPhoto"));
	} finally {
		bitmap.close();
	}
}

function dataUrlBytes(url: string): number {
	const base64 = url.slice(url.indexOf(",") + 1);
	return Math.floor((base64.length * 3) / 4) - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
}
