import { describe, expect, it } from "vitest";
import { attachHistoryImages, groupUserImageRows, serializeConversationCard, type PersistedImagesCard } from "./index.js";

const card = (origin: "user" | "assistant", ids: string[]): string =>
	serializeConversationCard({ v: 1, kind: "images", origin, items: ids.map((artifactId) => ({ artifactId, mime: "image/png", width: 10, height: 10, name: `${artifactId}.png` })) } as PersistedImagesCard);

describe("imagens de turnos anteriores", () => {
	const rows = [
		{ role: "user", content: "olha essas telas" },
		{ role: "images", content: card("user", ["a", "b"]) },
		{ role: "assistant", content: "vi" },
		{ role: "images", content: card("assistant", ["gen"]) },
		{ role: "user", content: "igual ao da imagem?" },
	];

	it("liga o cartão do usuário à mensagem anterior e ignora imagens do assistente", () => {
		const groups = groupUserImageRows(rows);
		expect(groups).toHaveLength(1);
		expect(groups[0]).toMatchObject({ userText: "olha essas telas", items: [{ artifactId: "a" }, { artifactId: "b" }] });
	});

	it("anexa image_ref à mensagem de origem no turno seguinte sem anexo novo", () => {
		const out = attachHistoryImages(
			[{ role: "user", content: "olha essas telas" }, { role: "assistant", content: "vi" }, { role: "user", content: "igual ao da imagem?" }],
			groupUserImageRows(rows),
		);
		expect(out[0]!.content).toEqual([
			{ type: "text", text: "olha essas telas" },
			{ type: "image_ref", artifactId: "a", name: "a.png" },
			{ type: "image_ref", artifactId: "b", name: "b.png" },
		]);
		expect(out[2]!.content).toBe("igual ao da imagem?");
	});

	it("não duplica as imagens do pedido atual", () => {
		const out = attachHistoryImages([{ role: "user", content: "olha essas telas" }], groupUserImageRows(rows), ["a", "b"]);
		expect(out[0]!.content).toBe("olha essas telas");
	});

	it("avisa de forma neutra quando a imagem não pode ser anexada", () => {
		const groups = [{ userText: "olha", items: [], missing: ["x.png"] }];
		const out = attachHistoryImages([{ role: "user", content: "olha" }], groups);
		expect(out[0]!.content).toBe("olha\n[An earlier message included 1 user image(s) (x.png); they are not attached now.]");
	});

	it("limita por mensagem e avisa do excedente", () => {
		const items = ["1", "2", "3"].map((artifactId) => ({ artifactId, name: `${artifactId}.png` }));
		const out = attachHistoryImages([{ role: "user", content: "t" }], [{ userText: "t", items, missing: [] }], [], 2);
		expect((out[0]!.content as unknown[]).length).toBe(3);
		expect((out[0]!.content as Array<{ text?: string }>)[0]!.text).toContain("1 user image(s) (3.png)");
	});
});
