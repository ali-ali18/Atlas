// Foto do perfil: contas puras (recorte quadrado, tamanho do data URL, escada de qualidade). O web faz o mesmo em
// `apps/web/lib/profile-image.ts`; o app reduz com o Skia (`profile-photo.ts`). Limites vêm de `@workspace/shared`.
import { PROFILE_IMAGE_MAX_BYTES, PROFILE_IMAGE_SIZE } from "@workspace/shared";

export { PROFILE_IMAGE_MAX_BYTES, PROFILE_IMAGE_SIZE };

/** Qualidades tentadas, da melhor para a menor, até a foto caber em `PROFILE_IMAGE_MAX_BYTES`. */
export const JPEG_QUALITIES = [85, 70, 55, 40] as const;

/** Quadrado central da imagem: origem e lado em pixels da imagem original (o servidor guarda foto quadrada). */
export function centerSquare(width: number, height: number): { sx: number; sy: number; side: number } {
	const side = Math.max(1, Math.min(width, height));
	return { sx: Math.floor((width - side) / 2), sy: Math.floor((height - side) / 2), side };
}

/** Bytes que um base64 (com ou sem `=` no fim) representa. */
export function base64Bytes(base64: string): number {
	const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
	return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

export const jpegDataUrl = (base64: string): string => `data:image/jpeg;base64,${base64}`;

/**
 * Primeira qualidade cujo resultado cabe no limite da foto guardada (`encode` devolve o base64 para a qualidade).
 * `null` se nem a menor couber (foto cheia de detalhe demais): quem chama avisa em vez de enviar algo que o servidor recusa.
 */
export function fitJpeg(encode: (quality: number) => string, maxBytes: number = PROFILE_IMAGE_MAX_BYTES): string | null {
	for (const quality of JPEG_QUALITIES) {
		const base64 = encode(quality);
		if (base64 && base64Bytes(base64) <= maxBytes) return jpegDataUrl(base64);
	}
	return null;
}
