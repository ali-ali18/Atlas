// Avatar do bot nas notificações push: chave pública (forma + cor, sem id de bot nem de usuário),
// SVG estático de repouso e a URL absoluta do PNG servido pela API (GET /v1/avatars/:key.png).
import { SHAPE_IDS, isShape, type Shape } from "./geometry/shapes.js";
import { eyeColorFor, identityFor, resolveColor, resolveShape } from "./identity.js";
import { toSvg } from "./render/still.js";

/** Sobe quando o desenho muda: as URLs (imutáveis, cache de 1 ano) deixam de coincidir. */
export const PUSH_AVATAR_VERSION = 1;
export const PUSH_AVATAR_SIZE = 192;
/** Lado da caixa do avatar em relação ao PNG; a caixa de 250 do motor já tem margem, então o corpo ocupa ~67% (legível no recorte circular). */
export const PUSH_AVATAR_FILL = 1;
export const PUSH_AVATAR_BACKGROUND = "#09090b";
export const PUSH_AVATAR_EYE = "#09090b";

export type PushAvatarLook = { shape: Shape; color: string };

const HEX6 = /^#[0-9a-f]{6}$/;

/** `#abc`/`#AABBCC` → `#aabbcc`; null se não for hex de 3 ou 6 dígitos. */
export function normalizeHexColor(value: string | null | undefined): string | null {
	let hex = (value ?? "").trim().toLowerCase();
	if (/^#[0-9a-f]{3}$/.test(hex)) hex = `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
	return HEX6.test(hex) ? hex : null;
}

/** Forma e cor efetivas do bot, exatamente como a web decide (escolha do AvatarEditor ou sorteio pelo id). */
export function pushAvatarLook(bot: { id: string; shape?: string | null; color?: string | null }): PushAvatarLook {
	return {
		shape: resolveShape(bot.shape, bot.id),
		color: normalizeHexColor(resolveColor(bot.color, bot.id)) ?? identityFor(bot.id).color.toLowerCase(),
	};
}

/** `pebble-0086ff-v1`: tudo o que o servidor precisa para desenhar, nada que identifique alguém. */
export function encodePushAvatarKey(look: PushAvatarLook): string {
	const color = normalizeHexColor(look.color);
	if (!isShape(look.shape) || !color) throw new Error("invalid avatar look");
	return `${look.shape}-${color.slice(1)}-v${PUSH_AVATAR_VERSION}`;
}

/** null para qualquer chave que não seja forma conhecida + 6 dígitos hex + a versão atual. */
export function decodePushAvatarKey(key: string): PushAvatarLook | null {
	const match = /^([a-z]+)-([0-9a-f]{6})-v(\d{1,3})$/.exec(key);
	if (!match) return null;
	const [, shape, hex, version] = match;
	if (Number(version) !== PUSH_AVATAR_VERSION || !shape || !hex) return null;
	if (!(SHAPE_IDS as readonly string[]).includes(shape)) return null;
	return { shape: shape as Shape, color: `#${hex}` };
}

/** SVG de repouso (sem animação, expressão neutra) do avatar: mesmo motor do componente. */
export function renderAvatarSvg(options: { shape: string; color: string; eyeColor?: string; size?: number }): string {
	const color = normalizeHexColor(options.color) ?? "#777777";
	// Olho sempre pintado (sem recorte): o PNG não tem o fundo do app atrás. Escuro, salvo em corpo preto.
	const eyeColor = options.eyeColor ?? (eyeColorFor(color) === "#f9f9f9" ? "#f9f9f9" : PUSH_AVATAR_EYE);
	return toSvg({ shape: options.shape, expression: "neutral", color, eyeColor, size: options.size });
}

/** Cena do PNG: disco #09090b (o Android recorta o ícone grande em círculo) com o personagem centrado. */
export function renderPushAvatarScene(look: PushAvatarLook): string {
	const size = PUSH_AVATAR_SIZE;
	const inner = Math.round(size * PUSH_AVATAR_FILL);
	const offset = (size - inner) / 2;
	const avatar = renderAvatarSvg({ shape: look.shape, color: look.color, size: inner }).replace("<svg ", `<svg x="${offset}" y="${offset}" `);
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
		`<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="${PUSH_AVATAR_BACKGROUND}"/>${avatar}</svg>`
	);
}

/** URL absoluta do PNG; null se não houver origem pública configurada. */
export function pushAvatarUrl(origin: string | null | undefined, look: PushAvatarLook): string | null {
	const base = (origin ?? "").trim().replace(/\/+$/, "");
	if (!/^https?:\/\/[^/\s]+$/.test(base)) return null;
	return `${base}/v1/avatars/${encodePushAvatarKey(look)}.png`;
}

/** Origem pública do app (o navegador do aparelho alcança `/v1` por ela): ATLAS_URL, senão ATLAS_PUBLIC_URL. */
export function pushPublicOrigin(env: Record<string, string | undefined>): string | null {
	for (const raw of [env.ATLAS_URL, env.ATLAS_PUBLIC_URL]) {
		const value = raw?.trim().replace(/\/+$/, "");
		if (value && /^https?:\/\/[^/\s]+$/.test(value)) return value;
	}
	return null;
}
