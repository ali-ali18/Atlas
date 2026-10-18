/** Perfil do usuário: nome e foto. Regras compartilhadas entre a API (valida) e a web (avisa antes de enviar). */

export const PROFILE_NAME_MAX = 60;
/** Lado da foto guardada (quadrada). */
export const PROFILE_IMAGE_SIZE = 256;
/** Tamanho máximo da foto guardada, em bytes (depois de reduzida). */
export const PROFILE_IMAGE_MAX_BYTES = 60 * 1024;
/** Teto do que a API aceita receber antes de reprocessar (a foto do cliente já vem reduzida). */
export const PROFILE_IMAGE_UPLOAD_MAX_BYTES = 120 * 1024;

export type ProfileNameResult = { ok: true; name: string } | { ok: false; error: string };

/** Nome: texto, sem espaços nas pontas, de 1 a 60 caracteres. */
export function validateProfileName(value: unknown): ProfileNameResult {
	if (typeof value !== "string") return { ok: false, error: "Informe o nome." };
	const name = value.trim().replace(/\s+/g, " ");
	if (name.length === 0) return { ok: false, error: "O nome não pode ficar vazio." };
	if ([...name].length > PROFILE_NAME_MAX) return { ok: false, error: `O nome pode ter até ${PROFILE_NAME_MAX} caracteres.` };
	// biome-ignore lint/suspicious/noControlCharactersInRegex: recusa caracteres de controle
	if (/[\u0000-\u001f\u007f]/.test(name)) return { ok: false, error: "O nome tem caracteres inválidos." };
	return { ok: true, name };
}

const DATA_URL = /^data:(image\/(?:webp|jpeg|png));base64,([A-Za-z0-9+/]+={0,2})$/;

export type ProfileImageParse =
	| { ok: true; mime: string; bytes: Uint8Array }
	| { ok: false; error: string; status: 400 | 413 | 415 };

/** Lê o data URL da foto: só WebP/JPEG/PNG (SVG nunca) e no máximo `PROFILE_IMAGE_UPLOAD_MAX_BYTES`. */
export function parseProfileImageDataUrl(value: unknown): ProfileImageParse {
	if (typeof value !== "string") return { ok: false, error: "Envie a foto como data URL.", status: 400 };
	// Teto antes de qualquer regex pesada: base64 de 120 KB tem ~160 mil caracteres.
	if (value.length > Math.ceil((PROFILE_IMAGE_UPLOAD_MAX_BYTES * 4) / 3) + 64) {
		return { ok: false, error: "A foto é grande demais.", status: 413 };
	}
	if (/^data:image\/svg/i.test(value)) return { ok: false, error: "Esse formato de imagem não é aceito.", status: 415 };
	const match = DATA_URL.exec(value);
	if (!match) return { ok: false, error: "Formato de imagem não aceito. Use JPEG, PNG ou WebP.", status: 415 };
	const bytes = Uint8Array.from(atob(match[2]!), (char) => char.charCodeAt(0));
	if (bytes.length > PROFILE_IMAGE_UPLOAD_MAX_BYTES) return { ok: false, error: "A foto é grande demais.", status: 413 };
	return { ok: true, mime: match[1]!, bytes };
}

/** O que a foto salva é mesmo um data URL pequeno de imagem raster (defesa na leitura). */
export function isStoredProfileImage(value: unknown): value is string {
	return typeof value === "string" && value.length <= Math.ceil((PROFILE_IMAGE_MAX_BYTES * 4) / 3) + 64 && /^data:image\/(?:webp|jpeg|png);base64,/.test(value);
}
