import { describe, expect, it } from "vitest";
import { fetchHome, parseSnapshot } from "./home-sync";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const goodBot = { id: "b1", name: "Cookie", memberIds: [], lastMessage: null };
const goodSection = { id: "s1", name: "Codding", order: 0 };

describe("fetchHome", () => {
	it("busca bots e seções e devolve o retrato", async () => {
		const paths: string[] = [];
		const result = await fetchHome(async (path) => {
			paths.push(path);
			return path === "/v1/bots" ? json(200, { bots: [goodBot] }) : json(200, { sections: [goodSection] });
		});
		expect(paths.sort()).toEqual(["/v1/bots", "/v1/sections"]);
		expect(result).toMatchObject({ ok: true, snapshot: { bots: [{ id: "b1", name: "Cookie", preview: "" }], sections: [goodSection] } });
	});
	it("401 em qualquer chamada = sessão recusada", async () => {
		const result = await fetchHome(async (path) => (path === "/v1/bots" ? json(200, { bots: [] }) : json(401, {})));
		expect(result).toEqual({ ok: false, reason: "unauthorized" });
	});
	it("sem rede", async () => {
		const result = await fetchHome(async () => {
			throw new TypeError("Network request failed");
		});
		expect(result).toEqual({ ok: false, reason: "network" });
	});
	it("erro do servidor e corpo inesperado", async () => {
		expect(await fetchHome(async () => json(500, {}))).toEqual({ ok: false, reason: "server" });
		expect(await fetchHome(async () => json(200, { oops: true }))).toEqual({ ok: false, reason: "server" });
	});
});

describe("parseSnapshot", () => {
	it("descarta item malformado sem derrubar a lista", () => {
		const snapshot = parseSnapshot({ bots: [goodBot, { id: 3 }, null] }, { sections: [goodSection, { id: "x" }] });
		expect(snapshot?.bots).toHaveLength(1);
		expect(snapshot?.sections).toHaveLength(1);
	});
	it("lastMessage ausente vira prévia vazia", () => {
		const { lastMessage: _omit, ...semUltima } = goodBot;
		expect(parseSnapshot({ bots: [semUltima] }, { sections: [] })?.bots[0]).toMatchObject({ preview: "", lastAt: null });
	});
	it("o que sai não carrega campos além dos da home", () => {
		const snapshot = parseSnapshot({ bots: [{ ...goodBot, policyJson: { a: 1 }, description: "d" }] }, { sections: [{ ...goodSection, createdAt: "x" }] });
		expect(JSON.stringify(snapshot)).not.toMatch(/policyJson|description|createdAt/);
	});
});
