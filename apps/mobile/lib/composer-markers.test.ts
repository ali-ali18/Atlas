import { describe, expect, it } from "vitest";
import { addMarker, adoptLeadingMarkers, composeMessage, fieldMaxLength, fieldOffset, fieldValue, MESSAGE_MAX, readFieldChange, SENTINEL, skillsFull, hasContent, markerToken, removeMarker, splitLeadingMarkers, type Marker } from "./composer-markers";

const cookie: Marker = { kind: "bot", id: "b1", name: "Cookie" };
const ana: Marker = { kind: "bot", id: "b2", name: "Ana Maria" };
const resumo: Marker = { kind: "skill", id: "s1", name: "resumo-do-dia" };

describe("markerToken", () => {
	it("bot vira @Nome e habilidade vira /slug", () => {
		expect(markerToken(cookie)).toBe("@Cookie");
		expect(markerToken(resumo)).toBe("/resumo-do-dia");
	});
	it("nome com espaço e acento fica inteiro", () => {
		expect(markerToken({ kind: "bot", id: "b3", name: " João da Conceição " })).toBe("@João da Conceição");
	});
});

describe("addMarker e removeMarker", () => {
	it("não repete o mesmo marcador, mas aceita bot e habilidade com o mesmo id", () => {
		expect(addMarker([cookie], cookie)).toEqual([cookie]);
		expect(addMarker([cookie], { kind: "skill", id: "b1", name: "x" })).toHaveLength(2);
	});
	it("ignora nome vazio", () => {
		expect(addMarker([], { kind: "bot", id: "b", name: "  " })).toEqual([]);
	});
	it("habilidade além do limite do servidor não entra, bot ainda entra", () => {
		let list: Marker[] = [];
		for (const n of ["a", "b", "c", "d"]) list = addMarker(list, { kind: "skill", id: n, name: n });
		expect(list.map((m) => m.name)).toEqual(["a", "b", "c"]);
		expect(addMarker(list, cookie)).toHaveLength(4);
	});
	it("remove só o marcador pedido", () => {
		expect(removeMarker([cookie, ana, resumo], ana)).toEqual([cookie, resumo]);
		expect(removeMarker([], ana)).toEqual([]);
	});
});

describe("sentinela do campo", () => {
	it("só há sentinela com marcadores", () => {
		expect(fieldValue(0, "oi")).toBe("oi");
		expect(fieldValue(2, "oi")).toBe(`${SENTINEL}oi`);
		expect(fieldValue(1, "")).toBe(SENTINEL);
		expect(fieldOffset(0)).toBe(0);
		expect(fieldOffset(3)).toBe(1);
	});
	it("o sentinela sumiu (backspace no começo): apaga o último marcador e o texto fica", () => {
		expect(readFieldChange("oi", 2)).toEqual({ text: "oi", removeLast: true });
		expect(readFieldChange("", 1)).toEqual({ text: "", removeLast: true });
	});
	it("digitar com o sentinela no lugar não apaga marcador", () => {
		expect(readFieldChange(`${SENTINEL}oi!`, 2)).toEqual({ text: "oi!", removeLast: false });
		// texto digitado antes do sentinela: o sentinela só mudou de lugar.
		expect(readFieldChange(`a${SENTINEL}oi`, 1)).toEqual({ text: "aoi", removeLast: false });
	});
	it("sem marcador nunca apaga nada e tira sentinela colado", () => {
		expect(readFieldChange("oi", 0)).toEqual({ text: "oi", removeLast: false });
		expect(readFieldChange(`o${SENTINEL}i`, 0).text).toBe("oi");
	});
});

describe("fieldMaxLength", () => {
	it("sem marcador vale o limite todo", () => {
		expect(fieldMaxLength([])).toBe(MESSAGE_MAX);
	});
	it("desconta os tokens e o espaço depois deles", () => {
		// "@Cookie " = 8
		expect(fieldMaxLength([cookie])).toBe(MESSAGE_MAX - 8);
		expect(composeMessage([cookie, resumo], "x".repeat(fieldMaxLength([cookie, resumo]))).length).toBe(MESSAGE_MAX);
	});
	it("nunca negativo", () => {
		expect(fieldMaxLength([cookie], 3)).toBe(0);
	});
});

describe("skillsFull", () => {
	const s = (n: string): Marker => ({ kind: "skill", id: n, name: n });
	it("conta chips e /slug escritos no texto", () => {
		expect(skillsFull([s("a"), s("b")], "")).toBe(false);
		expect(skillsFull([s("a"), s("b"), s("c")], "")).toBe(true);
		expect(skillsFull([s("a")], "use /b e /c agora")).toBe(true);
	});
	it("bot não conta", () => {
		expect(skillsFull([cookie, cookie, cookie], "")).toBe(false);
	});
});

describe("adoptLeadingMarkers", () => {
	const skills = [{ id: "s1", name: "resumo-do-dia" }];
	it("rascunho com /slug vira chip e o que veio depois fica", () => {
		const out = adoptLeadingMarkers([], "/resumo-do-dia e mais isto", [], skills);
		expect(out.markers).toEqual([resumo]);
		expect(out.text).toBe("e mais isto");
		expect(out.consumed).toBe("/resumo-do-dia ".length);
	});
	it("soma aos marcadores que já existem e não repete", () => {
		expect(adoptLeadingMarkers([cookie], "/resumo-do-dia", [], skills).markers).toEqual([cookie, resumo]);
		expect(adoptLeadingMarkers([resumo], "/resumo-do-dia x", [], skills).markers).toEqual([resumo]);
	});
	it("sem habilidade conhecida nada muda", () => {
		expect(adoptLeadingMarkers([], "/outra x", [], skills)).toEqual({ markers: [], text: "/outra x", consumed: 0 });
	});
});

describe("composeMessage", () => {
	it("vazio sem marcador nem texto", () => {
		expect(composeMessage([], "")).toBe("");
		expect(composeMessage([], "   \n ")).toBe("");
	});
	it("só o marcador envia o token", () => {
		expect(composeMessage([cookie], "")).toBe("@Cookie");
		expect(composeMessage([resumo], "  ")).toBe("/resumo-do-dia");
	});
	it("várias menções e habilidade antes do texto, um espaço entre cada", () => {
		expect(composeMessage([cookie, ana, resumo], "  me conta o dia \n")).toBe("@Cookie @Ana Maria /resumo-do-dia me conta o dia");
	});
	it("sem marcador é o texto aparado", () => {
		expect(composeMessage([], " oi ")).toBe("oi");
	});
});

describe("hasContent", () => {
	it("marcador sozinho conta; espaço sozinho não", () => {
		expect(hasContent([cookie], "")).toBe(true);
		expect(hasContent([], "  ")).toBe(false);
		expect(hasContent([], "a")).toBe(true);
	});
});

describe("splitLeadingMarkers", () => {
	const bots = [
		{ id: "b1", name: "Cookie" },
		{ id: "b2", name: "Ana" },
		{ id: "b3", name: "Ana Maria" },
		{ id: "b4", name: "João da Conceição" },
	];
	const skills = [{ id: "s1", name: "resumo-do-dia" }];
	it("lê menções e habilidade em fila e devolve o resto", () => {
		const out = splitLeadingMarkers("@Cookie /resumo-do-dia faz isso", bots, skills);
		expect(out.markers.map(markerToken)).toEqual(["@Cookie", "/resumo-do-dia"]);
		expect(out.rest).toBe("faz isso");
	});
	it("o nome mais longo vence e não importa caixa nem acento", () => {
		expect(splitLeadingMarkers("@ana maria oi", bots, skills).markers[0]).toMatchObject({ id: "b3", name: "Ana Maria" });
		expect(splitLeadingMarkers("@joao da conceicao oi", bots, skills).markers[0]).toMatchObject({ id: "b4", name: "João da Conceição" });
	});
	it("Ana sozinha não vira Ana Maria", () => {
		const out = splitLeadingMarkers("@Ana e depois", bots, skills);
		expect(out.markers[0]).toMatchObject({ id: "b2" });
		expect(out.rest).toBe("e depois");
	});
	it("nome que continua em outra palavra não casa (@Cookies)", () => {
		expect(splitLeadingMarkers("@Cookies oi", bots, skills)).toEqual({ markers: [], rest: "@Cookies oi" });
	});
	it("desconhecido fica no texto, e menção no meio não vira marcador", () => {
		expect(splitLeadingMarkers("/outra coisa", bots, skills)).toEqual({ markers: [], rest: "/outra coisa" });
		expect(splitLeadingMarkers("oi @Cookie", bots, skills)).toEqual({ markers: [], rest: "oi @Cookie" });
	});
	it("só o marcador, sem resto, e texto vazio", () => {
		expect(splitLeadingMarkers("@Cookie", bots, skills)).toEqual({ markers: [{ kind: "bot", id: "b1", name: "Cookie" }], rest: "" });
		expect(splitLeadingMarkers("", bots, skills)).toEqual({ markers: [], rest: "" });
	});
	it("ida e volta: o que composeMessage monta, o parse devolve", () => {
		const text = composeMessage([ana, cookie, resumo], "tudo bem?");
		const out = splitLeadingMarkers(text, [{ id: "b2", name: "Ana Maria" }, { id: "b1", name: "Cookie" }], skills);
		expect(out.markers).toEqual([ana, cookie, resumo]);
		expect(out.rest).toBe("tudo bem?");
	});
	it("repetido para de ler (sem laço)", () => {
		expect(splitLeadingMarkers("@Cookie @Cookie oi", bots, skills).markers).toHaveLength(1);
	});
});
