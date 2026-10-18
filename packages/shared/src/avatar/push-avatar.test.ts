import { describe, expect, it } from "vitest";
import { SHAPE_IDS } from "./geometry/shapes.js";
import { identityFor } from "./identity.js";
import {
	PUSH_AVATAR_VERSION,
	decodePushAvatarKey,
	encodePushAvatarKey,
	normalizeHexColor,
	pushAvatarLook,
	pushAvatarUrl,
	pushPublicOrigin,
	renderAvatarSvg,
	renderPushAvatarScene,
} from "./push-avatar.js";

describe("renderAvatarSvg", () => {
	it("é determinístico e devolve um SVG bem formado", () => {
		const a = renderAvatarSvg({ shape: "pebble", color: "#0086ff" });
		expect(renderAvatarSvg({ shape: "pebble", color: "#0086ff" })).toBe(a);
		expect(a.startsWith("<svg ")).toBe(true);
		expect(a.endsWith("</svg>")).toBe(true);
		expect(a).toContain('viewBox="0 0 250 250"');
		expect(a).toContain('fill="#0086ff"');
		expect(a).toContain('fill="#09090b"');
		expect(a.split("<svg").length).toBe(2);
	});

	it("cada forma desenha um contorno diferente; cor preta ganha olho claro", () => {
		const svgs = new Set(SHAPE_IDS.map((shape) => renderAvatarSvg({ shape, color: "#ff6700" })));
		expect(svgs.size).toBe(SHAPE_IDS.length);
		expect(renderAvatarSvg({ shape: "blob", color: "#000000" })).toContain("#f9f9f9");
	});

	it("a cena do PNG tem o disco escuro e um único avatar centrado", () => {
		const scene = renderPushAvatarScene({ shape: "blob", color: "#ff6700" });
		expect(scene).toContain('<circle cx="96" cy="96" r="96" fill="#09090b"/>');
		expect(scene).toContain('width="192" height="192" viewBox="0 0 192 192"');
	});
});

describe("chave do avatar", () => {
	it("codifica e decodifica forma + cor", () => {
		const key = encodePushAvatarKey({ shape: "pebble", color: "#0086FF" });
		expect(key).toBe(`pebble-0086ff-v${PUSH_AVATAR_VERSION}`);
		expect(decodePushAvatarKey(key)).toEqual({ shape: "pebble", color: "#0086ff" });
		for (const shape of SHAPE_IDS) expect(decodePushAvatarKey(encodePushAvatarKey({ shape, color: "#123456" }))?.shape).toBe(shape);
	});

	it("rejeita chave inválida", () => {
		for (const key of ["", "pebble", "pebble-0086ff", "pebble-0086ff-v2", "pebble-0086ff-v0", "nope-0086ff-v1", "pebble-0086f-v1", "pebble-0086fff-v1", "pebble-00zzff-v1", "PEBBLE-0086ff-v1", "../pebble-0086ff-v1", "pebble-0086ff-v1.png", "pebble-0086ff-v1 "]) {
			expect(decodePushAvatarKey(key), key).toBeNull();
		}
		expect(() => encodePushAvatarKey({ shape: "pebble", color: "red" })).toThrow();
		expect(() => encodePushAvatarKey({ shape: "nope" as never, color: "#000000" })).toThrow();
	});
});

describe("aparência do bot", () => {
	it("usa o que o bot escolheu (inclusive formas e hex antigos)", () => {
		expect(pushAvatarLook({ id: "b1", shape: "galet", color: "#ABC" })).toEqual({ shape: "pebble", color: "#aabbcc" });
	});

	it("sem escolha, sorteia pelo id como a web", () => {
		const id = identityFor("bot-xyz");
		expect(pushAvatarLook({ id: "bot-xyz", shape: null, color: null })).toEqual({ shape: id.shape, color: id.color.toLowerCase() });
		expect(pushAvatarLook({ id: "bot-xyz", shape: "", color: "  " })).toEqual(pushAvatarLook({ id: "bot-xyz" }));
	});

	it("cor que não é hex cai na cor do id", () => {
		expect(pushAvatarLook({ id: "bot-xyz", shape: "blob", color: "red" }).color).toBe(identityFor("bot-xyz").color.toLowerCase());
		expect(normalizeHexColor("rgb(0,0,0)")).toBeNull();
	});
});

describe("URL pública", () => {
	const look = { shape: "blob" as const, color: "#ff6700" };
	it("monta a URL absoluta sem id de bot nem de usuário", () => {
		expect(pushAvatarUrl("https://app.example.com/", look)).toBe("https://app.example.com/v1/avatars/blob-ff6700-v1.png");
		expect(pushAvatarUrl(null, look)).toBeNull();
		expect(pushAvatarUrl("app.example.com", look)).toBeNull();
	});

	it("origem: ATLAS_URL, depois ATLAS_PUBLIC_URL", () => {
		expect(pushPublicOrigin({ ATLAS_URL: "https://a.io/", ATLAS_PUBLIC_URL: "https://b.io" })).toBe("https://a.io");
		expect(pushPublicOrigin({ ATLAS_URL: " ", ATLAS_PUBLIC_URL: "https://b.io" })).toBe("https://b.io");
		expect(pushPublicOrigin({})).toBeNull();
	});
});
