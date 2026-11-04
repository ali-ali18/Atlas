import { describe, expect, it } from "vitest";
import type { ChatImage, ChatItem } from "./chat-types";
import { revalidateIndex, clampIndex, collectViewerImages, fitImage, imageApiPath, imageCaption, imageFileName, fanImages, imagesCountLabel, FAN_MAX, FAN_ROTATIONS, indexFromOffset, isSafeImageUri, localImageUri, shortCaption, singleImageAspect, viewerStartIndex } from "./image-viewer";

const img = (artifactId: string, extra: Partial<ChatImage> = {}): ChatImage => ({ artifactId, mime: "image/png", width: 100, height: 50, ...extra });
const card = (id: string, origin: "user" | "assistant", images: ChatImage[], caption?: string): ChatItem => ({ id, kind: "images", origin, images, ...(caption ? { caption } : {}) });
const user = (id: string, text: string): ChatItem => ({ id, kind: "user", text });
const bot = (id: string, text: string): ChatItem => ({ id, kind: "assistant", text });

describe("shortCaption", () => {
	it("junta espaços e quebras, e vazio vira undefined", () => {
		expect(shortCaption("  Gaveta   de\nedição  ")).toBe("Gaveta de edição");
		expect(shortCaption("   ")).toBeUndefined();
		expect(shortCaption(undefined)).toBeUndefined();
	});
	it("corta no limite com reticências", () => {
		const out = shortCaption("a".repeat(300), 20);
		expect(out).toHaveLength(20);
		expect(out?.endsWith("…")).toBe(true);
	});
});

describe("imageCaption", () => {
	it("prefere a descrição da imagem, depois a legenda do cartão", () => {
		const withAlt = card("c", "assistant", [img("a", { alt: "Gaveta aberta" })], "Legenda do cartão");
		expect(imageCaption(img("a", { alt: "Gaveta aberta" }), withAlt as never)).toBe("Gaveta aberta");
		const noAlt = card("c", "assistant", [img("a")], "Legenda do cartão");
		expect(imageCaption(img("a"), noAlt as never)).toBe("Legenda do cartão");
	});
	it("anexo do usuário sem legenda usa a fala colada (anterior; senão a seguinte)", () => {
		const c = card("c", "user", [img("a")]) as Extract<ChatItem, { kind: "images" }>;
		expect(imageCaption(img("a"), c, user("u", "olha isso"), undefined)).toBe("olha isso");
		expect(imageCaption(img("a"), c, bot("b", "oi"), user("u2", "depois"))).toBe("depois");
		expect(imageCaption(img("a"), c, bot("b", "oi"), bot("b2", "x"))).toBeUndefined();
	});
	it("imagem do bot nunca pega a fala do usuário", () => {
		const c = card("c", "assistant", [img("a")]) as Extract<ChatItem, { kind: "images" }>;
		expect(imageCaption(img("a"), c, user("u", "gera uma imagem"), undefined)).toBeUndefined();
	});
	it("sem legenda alguma devolve undefined", () => {
		const c = card("c", "user", [img("a")]) as Extract<ChatItem, { kind: "images" }>;
		expect(imageCaption(img("a"), c)).toBeUndefined();
	});
});

describe("collectViewerImages", () => {
	it("junta anexos e imagens do bot na ordem do fio", () => {
		const items = [user("u1", "veja"), card("c1", "user", [img("a"), img("b")]), bot("b1", "ok"), card("c2", "assistant", [img("c")], "Resultado"), card("c3", "user", [img("d")])];
		const out = collectViewerImages(items);
		expect(out.map((image) => image.artifactId)).toEqual(["a", "b", "c", "d"]);
		expect(out[0]?.caption).toBe("veja");
		expect(out[2]?.caption).toBe("Resultado");
		expect(out[3]?.caption).toBeUndefined();
	});
	it("o mesmo arquivo em dois cartões aparece uma vez, na primeira posição", () => {
		const items = [card("live", "assistant", [img("a"), img("b")]), card("saved", "assistant", [img("b"), img("c")])];
		expect(collectViewerImages(items).map((image) => image.artifactId)).toEqual(["a", "b", "c"]);
	});
	it("fica a legenda que existe quando a repetição é a que tem", () => {
		const items = [card("live", "assistant", [img("a")]), card("saved", "assistant", [img("a")], "Com legenda")];
		expect(collectViewerImages(items)[0]?.caption).toBe("Com legenda");
	});
	it("sem imagens devolve lista vazia", () => {
		expect(collectViewerImages([user("u", "oi"), bot("b", "olá")])).toEqual([]);
		expect(collectViewerImages([])).toEqual([]);
	});
});

describe("viewerStartIndex / clampIndex / indexFromOffset", () => {
	const list = collectViewerImages([card("c", "assistant", [img("a"), img("b"), img("c")])]);
	it("abre na imagem tocada", () => {
		expect(viewerStartIndex(list, "b")).toBe(1);
		expect(viewerStartIndex(list, "c")).toBe(2);
	});
	it("id desconhecido ou vazio abre na primeira", () => {
		expect(viewerStartIndex(list, "zzz")).toBe(0);
		expect(viewerStartIndex(list, null)).toBe(0);
		expect(viewerStartIndex([], "a")).toBe(0);
	});
	it("limita o índice", () => {
		expect(clampIndex(5, 3)).toBe(2);
		expect(clampIndex(-1, 3)).toBe(0);
		expect(clampIndex(Number.NaN, 3)).toBe(0);
		expect(clampIndex(1, 0)).toBe(0);
	});
	it("a página vem da posição da rolagem", () => {
		expect(indexFromOffset(0, 400, 3)).toBe(0);
		expect(indexFromOffset(210, 400, 3)).toBe(1);
		expect(indexFromOffset(5000, 400, 3)).toBe(2);
		expect(indexFromOffset(100, 0, 3)).toBe(0);
	});
});

describe("URLs de imagem", () => {
	it("aceita data de imagem, file e http(s)", () => {
		expect(isSafeImageUri("data:image/png;base64,iVBORw0KGgo=")).toBe(true);
		expect(isSafeImageUri("file:///data/user/0/cache/a.png")).toBe(true);
		expect(isSafeImageUri("https://exemplo.com/a.png")).toBe(true);
		expect(isSafeImageUri("http://192.168.0.2:3001/a.png")).toBe(true);
	});
	it("recusa esquema estranho, data que não é imagem e vazio", () => {
		for (const bad of ["javascript:alert(1)", "content://media/1", "intent://x#Intent;end", "data:text/html;base64,PGgxPg==", "data:image/svg+xml;base64,PHN2Zz4=", "ftp://x/a.png", "//x/a.png", "", "  "]) expect(isSafeImageUri(bad)).toBe(false);
		expect(isSafeImageUri(undefined)).toBe(false);
	});
	it("localImageUri só devolve a uri segura", () => {
		expect(localImageUri({ uri: "https://x/a.png" })).toBe("https://x/a.png");
		expect(localImageUri({ uri: "javascript:1" })).toBeNull();
		expect(localImageUri({})).toBeNull();
	});
	it("o caminho do servidor escapa o id", () => {
		expect(imageApiPath("a/b c")).toBe("/v1/files/a%2Fb%20c");
	});
});

describe("imageFileName", () => {
	it("usa o nome do anexo sem caminho, com a extensão do tipo", () => {
		expect(imageFileName({ artifactId: "x", mime: "image/jpeg", name: "fotos/minha foto.png" })).toBe("minha-foto.jpg");
	});
	it("sem nome usa o id", () => {
		expect(imageFileName({ artifactId: "abc123", mime: "image/webp" })).toBe("imagem-abc123.webp");
	});
	it("tipo desconhecido vira png e nome só de símbolos cai no id", () => {
		expect(imageFileName({ artifactId: "q", mime: "image/x", name: "../.." })).toBe("imagem-q.png");
	});
});

describe("fitImage", () => {
	it("contém sem cortar", () => {
		expect(fitImage(2000, 1000, 400, 800)).toEqual({ width: 400, height: 200 });
		expect(fitImage(1000, 2000, 400, 800)).toEqual({ width: 400, height: 800 });
	});
	it("amplia imagens pequenas até a caixa (contain)", () => {
		expect(fitImage(100, 100, 400, 800)).toEqual({ width: 400, height: 400 });
	});
	it("dimensão inválida ocupa a caixa; caixa inválida é zero", () => {
		expect(fitImage(0, 0, 300, 500)).toEqual({ width: 300, height: 500 });
		expect(fitImage(100, 100, 0, 500)).toEqual({ width: 0, height: 0 });
	});
});

describe("leque do chat", () => {
	it("a primeira fica na frente e até 2 vão atrás, na ordem", () => {
		expect(fanImages(["a"])).toEqual({ front: "a", behind: [] });
		expect(fanImages(["a", "b"])).toEqual({ front: "a", behind: ["b"] });
		expect(fanImages(["a", "b", "c", "d", "e", "f"])).toEqual({ front: "a", behind: ["b", "c"] });
		expect(FAN_MAX).toBe(3);
		expect(FAN_ROTATIONS).toEqual([4, 8]);
	});
	it("lista vazia não vira leque", () => {
		expect(fanImages([])).toBeNull();
	});
	it("texto da contagem no singular e no plural", () => {
		expect(imagesCountLabel(1)).toBe("1 imagem");
		expect(imagesCountLabel(2)).toBe("2 imagens");
		expect(imagesCountLabel(6)).toBe("6 imagens");
		expect(imagesCountLabel(0)).toBe("0 imagens");
		expect(imagesCountLabel(Number.NaN)).toBe("0 imagens");
	});
	it("proporção da imagem única é limitada", () => {
		expect(singleImageAspect(3000, 100)).toBe(1.6);
		expect(singleImageAspect(100, 3000)).toBe(0.6);
		expect(singleImageAspect(400, 300)).toBeCloseTo(1.333, 2);
		expect(singleImageAspect(0, 0)).toBe(1);
	});
});

describe("revalidateIndex", () => {
	const list = (...keys: string[]) => keys.map((key) => ({ key }));
	it("segue a imagem atual quando a lista muda de posição", () => {
		expect(revalidateIndex(list("x", "a", "b"), "b", 1)).toBe(2);
	});
	it("imagem que sumiu cai no mais próximo da posição antiga", () => {
		expect(revalidateIndex(list("a", "b"), "gone", 5)).toBe(1);
		expect(revalidateIndex(list("a", "b", "c"), "gone", 1)).toBe(1);
	});
	it("sem chave ou sem imagens", () => {
		expect(revalidateIndex(list("a", "b"), undefined, 1)).toBe(1);
		expect(revalidateIndex([], "a", 3)).toBe(0);
	});
});
