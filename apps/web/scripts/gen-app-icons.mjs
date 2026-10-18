// Gera todos os ícones do app a partir de public/icons/avatar.svg: o SVG REAL que o
// componente <Avatar shape="pebble" color="#0086ff"> desenhou numa pose fixa do idle
// (sem sombreamento nem rotação nossos). Uso: node scripts/gen-app-icons.mjs
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { toSvg } from "@workspace/shared/avatar/render/still";

const BG = "#09090b";
const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "..", "public", "icons");
mkdirSync(dir, { recursive: true });
const save = (name, buf) => writeFileSync(join(dir, name), buf);

const avatarSvg = readFileSync(join(dir, "avatar.svg"), "utf8");
const VB = 250;

/** Rasteriza o SVG do avatar com `fill` opcional trocando as cores (silhueta). */
const raster = (svg, px) =>
	sharp(Buffer.from(svg.replace(`width="250" height="250"`, `width="${px}" height="${px}"`)), { density: 72 })
		.png()
		.toBuffer();

// Caixa da silhueta (em px de uma rasterização 2048) e glifo recortado.
const BIG = 2048;
const bigPng = await raster(avatarSvg, BIG);
const trimmed = await sharp(bigPng).trim().png().toBuffer({ resolveWithObject: true });
const glyph = trimmed.data;
const gw = trimmed.info.width;
const gh = trimmed.info.height;
globalThis.__glyph = glyph;
globalThis.__gw = gw;
globalThis.__gh = gh;
const { data: alpha } = await sharp(glyph).ensureAlpha().extractChannel(3).raw().toBuffer({ resolveWithObject: true });
/** Maior distância (px do glifo) de um pixel opaco ao centro do glifo. */
let maxR = 0;
for (let y = 0; y < gh; y++) {
	for (let x = 0; x < gw; x++) {
		if (alpha[y * gw + x] > 128) maxR = Math.max(maxR, Math.hypot(x - gw / 2, y - gh / 2));
	}
}

// Quadro parado da tela de abertura da web (o <Avatar animated={false}> pebble #0086ff), pintado com
// os olhos em BG: o MESMO quadro, então os olhos do ícone casam com os da web.
const still = await sharp(Buffer.from(toSvg({ shape: "pebble", color: "#0086ff", eyeColor: BG, size: BIG, id: "still" })))
	.png()
	.trim()
	.toBuffer({ resolveWithObject: true });
const stillGlyph = { data: still.data, w: still.info.width, h: still.info.height };

async function place(px, { bg, width, safeRadius, g: src }) {
	const glyph = src?.data ?? globalThis.__glyph;
	const gw = src?.w ?? globalThis.__gw;
	const gh = src?.h ?? globalThis.__gh;
	let k = (width * px) / gw;
	if (safeRadius) k = Math.min(k, (safeRadius * px) / maxR);
	const w = Math.round(gw * k);
	const h = Math.round(gh * k);
	const g = await sharp(glyph).resize(w, h).png().toBuffer();
	return sharp({ create: { width: px, height: px, channels: 4, background: bg ?? { r: 0, g: 0, b: 0, alpha: 0 } } })
		.composite([{ input: g, left: Math.round((px - w) / 2), top: Math.round((px - h) / 2) }])
		.png()
		.toBuffer();
}

// --- icon.svg: o mesmo avatar num quadrado #09090b (180), ocupando ~82% da largura.
const bbox = {
	x: ((BIG - 0) && (await sharp(bigPng).trim().toBuffer({ resolveWithObject: true })).info.trimOffsetLeft * -1) * (VB / BIG),
	y: (await sharp(bigPng).trim().toBuffer({ resolveWithObject: true })).info.trimOffsetTop * -1 * (VB / BIG),
	w: gw * (VB / BIG),
	h: gh * (VB / BIG),
};
const inner = avatarSvg.slice(avatarSvg.indexOf(">") + 1, avatarSvg.lastIndexOf("</svg>"));

/**
 * Logo "C · Espiando" (escolhida no Figma): o personagem maior que o ícone (112% da largura),
 * levemente inclinado, surgindo de baixo, com só o topo e os olhos visíveis, sobre #09090b.
 * Centro do corpo em (44%, 71%): mantém os olhos dentro do círculo seguro do ícone adaptável do Android.
 */
const LOGO = { width: 1.12, rotate: 6, cx: 0.44, cy: 0.71 };
function logoSvg(S) {
	const k = (LOGO.width * S) / bbox.w;
	const bx = bbox.x + bbox.w / 2;
	const by = bbox.y + bbox.h / 2;
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}">` +
		`<rect width="${S}" height="${S}" fill="${BG}"/>` +
		`<g transform="translate(${(LOGO.cx * S).toFixed(2)} ${(LOGO.cy * S).toFixed(2)}) rotate(${LOGO.rotate}) scale(${k.toFixed(4)}) translate(${(-bx).toFixed(2)} ${(-by).toFixed(2)})">${inner}</g></svg>\n`
	);
}
const logo = (px) => sharp(Buffer.from(logoSvg(px)), { density: 72 }).flatten({ background: BG }).png().toBuffer();
writeFileSync(join(dir, "icon.svg"), logoSvg(180));

// --- PNGs. "any" (192/512): o personagem inteiro, centralizado, em fundo TRANSPARENTE: é o que o
// Android usa na splash, então ela mostra só o avatar sobre #09090b (o mesmo quadro da tela de
// carregamento da web). maskable (ícone da tela inicial) e apple-touch: a logo C, de borda a borda.
// Tamanho: a splash do Chrome/WebAPK desenha o ícone "any" a ~128dp (referência do Chrome; o Android 12+
// pode ajustar). O avatar da web tem corpo de 120px, logo o corpo ocupa 120/128 da tela do ícone.
const SPLASH_ICON_DP = 128;
const WEB_BODY_PX = 120;
const splashWidth = WEB_BODY_PX / SPLASH_ICON_DP;
save("icon-192.png", await place(192, { width: splashWidth, g: stillGlyph }));
save("icon-512.png", await place(512, { width: splashWidth, g: stillGlyph }));
save("maskable-512.png", await logo(512));
save("apple-touch-icon.png", await logo(180));

// Selo de notificação: silhueta branca; os olhos ficam vazados (transparentes).
const eyeRemoved = await raster(avatarSvg.split(BG).join("#000000"), BIG);
{
	const { data, info } = await sharp(eyeRemoved).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	for (let i = 0; i < data.length; i += 4) {
		const eye = data[i] < 60 && data[i + 1] < 60 && data[i + 2] < 60;
		const a = eye ? 0 : data[i + 3];
		data[i] = data[i + 1] = data[i + 2] = 255;
		data[i + 3] = a;
	}
	const sil = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).trim().png().toBuffer();
	const m = await sharp(sil).metadata();
	const kk = (72 * 0.92) / Math.max(m.width, m.height);
	const w = Math.round(m.width * kk);
	const h = Math.round(m.height * kk);
	const g = await sharp(sil).resize(w, h).png().toBuffer();
	save(
		"badge-72.png",
		await sharp({ create: { width: 72, height: 72, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
			.composite([{ input: g, left: Math.round((72 - w) / 2), top: Math.round((72 - h) / 2) }])
			.png()
			.toBuffer(),
	);
}

const f32 = await logo(32);
const f16 = await logo(16);
save("favicon-32.png", f32);
save("favicon-16.png", f16);
const imgs = [f16, f32];
const head = Buffer.alloc(6);
head.writeUInt16LE(1, 2);
head.writeUInt16LE(imgs.length, 4);
let offset = 6 + 16 * imgs.length;
const entries = imgs.map((b, i) => {
	const e = Buffer.alloc(16);
	e[0] = e[1] = i === 0 ? 16 : 32;
	e.writeUInt16LE(1, 4);
	e.writeUInt16LE(32, 6);
	e.writeUInt32LE(b.length, 8);
	e.writeUInt32LE(offset, 12);
	offset += b.length;
	return e;
});
writeFileSync(join(here, "..", "app", "favicon.ico"), Buffer.concat([head, ...entries, ...imgs]));

// Splash do iOS: personagem grande (~62% da largura) sobre #09090b.
const splashes = [[1170, 2532], [1179, 2556], [1284, 2778], [1290, 2796], [1125, 2436], [1242, 2688], [828, 1792], [750, 1334], [1206, 2622], [1320, 2868]];
for (const [w, h] of splashes) {
	const cw = Math.round(w * 0.62);
	const ch = Math.round((cw * gh) / gw);
	const g = await sharp(glyph).resize(cw, ch).png().toBuffer();
	const buf = await sharp({ create: { width: w, height: h, channels: 4, background: BG } })
		.composite([{ input: g, left: Math.round((w - cw) / 2), top: Math.round((h - ch) / 2) }])
		.flatten({ background: BG })
		.png()
		.toBuffer();
	save(`splash-${w}x${h}.png`, buf);
}
console.log("ok", { gw, gh, maxR });
