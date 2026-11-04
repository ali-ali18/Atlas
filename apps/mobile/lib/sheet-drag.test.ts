import { describe, expect, it } from "vitest";
import { dragHeight, FLING_VELOCITY, isSingleHeight, normalizeRest, restHeight, settleSheet, tapRest } from "./sheet-drag";

const h = { collapsed: 400, expanded: 760 };

describe("altura durante o arraste", () => {
	it("sem deslocamento fica na altura de repouso", () => {
		expect(dragHeight("collapsed", 0, h)).toBe(400);
		expect(dragHeight("expanded", 0, h)).toBe(760);
	});
	it("puxar para cima aumenta e para baixo diminui", () => {
		expect(dragHeight("collapsed", -100, h)).toBe(500);
		expect(dragHeight("expanded", 100, h)).toBe(660);
	});
	it("nunca fica negativa", () => {
		expect(dragHeight("collapsed", 900, h)).toBe(0);
		expect(dragHeight("collapsed", 400, h)).toBe(0);
	});
	it("além da expandida só segue uma fração do dedo", () => {
		expect(dragHeight("expanded", -100, h)).toBeCloseTo(775);
		expect(dragHeight("collapsed", -1000, h)).toBeLessThan(760 + 1000 * 0.2);
		expect(dragHeight("collapsed", -1000, h)).toBeGreaterThan(760);
	});
	it("conteúdo maior que a expandida usa a colapsada como teto", () => {
		expect(restHeight("expanded", { collapsed: 800, expanded: 700 })).toBe(800);
	});
});

describe("onde a gaveta assenta ao soltar", () => {
	it("parada sem mover (dy 0) fica onde estava", () => {
		expect(settleSheet("collapsed", 0, 0, h)).toEqual({ next: "collapsed", height: 400 });
		expect(settleSheet("expanded", 0, 0, h)).toEqual({ next: "expanded", height: 760 });
	});
	it("arremesso para cima expande, de qualquer estado", () => {
		expect(settleSheet("collapsed", -10, -FLING_VELOCITY, h).next).toBe("expanded");
		expect(settleSheet("expanded", 0, -2, h).next).toBe("expanded");
	});
	it("arremesso para baixo fecha se estava colapsada e colapsa se estava expandida", () => {
		expect(settleSheet("collapsed", 10, FLING_VELOCITY, h)).toEqual({ next: "closed", height: 0 });
		expect(settleSheet("expanded", 10, 1.2, h)).toEqual({ next: "collapsed", height: 400 });
	});
	it("logo abaixo do limiar de velocidade decide pela distância", () => {
		expect(settleSheet("collapsed", 10, FLING_VELOCITY - 0.01, h).next).toBe("collapsed");
		expect(settleSheet("collapsed", -300, -(FLING_VELOCITY - 0.01), h).next).toBe("expanded");
	});
	it("sem arremesso, exatamente a metade do caminho fica onde estava", () => {
		// 400 -> 760: metade em 580
		expect(settleSheet("collapsed", -180, 0, h).next).toBe("collapsed");
		expect(settleSheet("expanded", 180, 0, h).next).toBe("expanded");
		expect(settleSheet("collapsed", -181, 0, h).next).toBe("expanded");
		expect(settleSheet("expanded", 181, 0, h).next).toBe("collapsed");
	});
	it("puxar a colapsada para baixo mais da metade fecha; menos, volta", () => {
		expect(settleSheet("collapsed", 201, 0, h).next).toBe("closed");
		expect(settleSheet("collapsed", 200, 0, h).next).toBe("collapsed");
	});
	it("da expandida, arrastar até abaixo da metade da inicial fecha", () => {
		expect(settleSheet("expanded", 600, 0, h).next).toBe("closed");
	});
	it("colapsada igual à expandida: expandir mantém a mesma altura e fechar continua possível", () => {
		const same = { collapsed: 500, expanded: 500 };
		expect(settleSheet("collapsed", -50, -1, same)).toEqual({ next: "expanded", height: 500 });
		expect(settleSheet("collapsed", 10, 0, same).height).toBe(500);
		expect(settleSheet("collapsed", 300, 0, same).next).toBe("closed");
	});
	it("conteúdo menor que a folga ainda sobe até o topo (expandida é a altura da tela)", () => {
		expect(settleSheet("collapsed", -400, 0, { collapsed: 200, expanded: 760 })).toEqual({ next: "expanded", height: 760 });
	});
});

describe("folha de conteúdo (altura inicial = altura máxima)", () => {
	const full = { collapsed: 760, expanded: 760 };
	it("parada ou puxada para cima fica aberta", () => {
		expect(settleSheet("collapsed", 0, 0, full)).toEqual({ next: "collapsed", height: 760 });
		expect(settleSheet("collapsed", -80, 0, full).height).toBe(760);
		expect(settleSheet("collapsed", -10, -FLING_VELOCITY, full)).toEqual({ next: "expanded", height: 760 });
	});
	it("arrastar para baixo além da metade ou arremessar fecha direto", () => {
		expect(settleSheet("collapsed", 400, 0, full)).toEqual({ next: "closed", height: 0 });
		expect(settleSheet("collapsed", 20, FLING_VELOCITY, full)).toEqual({ next: "closed", height: 0 });
	});
	it("arrasto curto para baixo volta para aberta", () => {
		expect(settleSheet("collapsed", 120, 0, full)).toEqual({ next: "collapsed", height: 760 });
	});
});

describe("folha de altura única: toque na alça e repouso", () => {
	const full = { collapsed: 760, expanded: 760 };
	it("toque na alça não muda o repouso (o arremesso seguinte ainda fecha)", () => {
		expect(isSingleHeight(full)).toBe(true);
		expect(tapRest("collapsed", full)).toBe("collapsed");
		expect(settleSheet(tapRest("collapsed", full), 20, FLING_VELOCITY, full).next).toBe("closed");
	});
	it("arremesso para cima não deixa o repouso em 'expanded'", () => {
		const next = settleSheet("collapsed", -10, -FLING_VELOCITY, full).next;
		expect(normalizeRest(next === "closed" ? "collapsed" : next, full)).toBe("collapsed");
	});
	it("com duas alturas o toque alterna e o repouso é o pedido", () => {
		expect(isSingleHeight(h)).toBe(false);
		expect(tapRest("collapsed", h)).toBe("expanded");
		expect(tapRest("expanded", h)).toBe("collapsed");
		expect(normalizeRest("expanded", h)).toBe("expanded");
	});
});
