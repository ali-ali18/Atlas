import { describe, expect, it } from "vitest";

import { DRAWABLE_SHAPES, SHAPE_IDS } from "../geometry/shapes.js";
import {
	AVATAR_COLORS,
	eyeColorFor,
	identityFor,
	normalizeShape,
	resolveColor,
	resolveShape,
} from "../identity.js";
import { projectFrame } from "./project.js";
import { stillFrame, toDataUrl, toSvg, toSvgFile } from "./still.js";
import {
	bodyPath,
	eyePath,
	eyePoints,
	groupTransform,
	maskId,
	renderFrame,
	resolveEyes,
	safeColor,
} from "./svg.js";

describe("renderer", () => {
	it("corpo vira M…L…Z com 2 casas e olhos são paths fechados", () => {
		const frame = stillFrame("hex");
		const d = bodyPath(frame.body);
		expect(d.startsWith("M")).toBe(true);
		expect(d.endsWith("Z")).toBe(true);
		expect(d.match(/L/g)).toHaveLength(95);
		expect(d).not.toMatch(/\.\d{3}/);
		expect(eyePath(frame.eyes[0])).toMatch(/^M[-\d. L]+Z$/);
	});

	it("visual chapado: sem gradiente, sombra, brilho nem filtro", () => {
		for (const shape of SHAPE_IDS) {
			const svg = toSvg({ shape, color: "#FF6700", size: 64 });
			expect(svg).not.toMatch(/gradient|filter|clipPath|opacity|<ellipse|<circle/i);
			expect(svg).toContain('fill="#FF6700"');
			expect(svg).toContain('aria-hidden="true"');
		}
	});

	it("olhos recortados (cutout) por padrão: máscara com buracos, olho não é pintado", () => {
		const svg = toSvg({ shape: "hex", color: "#FF6700", size: 64, id: "t1" });
		const frame = stillFrame("hex");
		expect(svg).toContain('<mask id="av-t1-holes"');
		expect(svg).toContain('mask="url(#av-t1-holes)"');
		expect(svg).toContain(`<path d="${projectFrame(frame).eyes}" fill="#000"/>`);
		expect(svg.match(/<path /g)).toHaveLength(2);
		expect(svg).not.toContain("#0a0a0c");
	});

	it("cor de olho explícita pinta o olho recortado para dentro do corpo (máscara inside)", () => {
		const svg = toSvg({ shape: "hex", color: "#FF6700", eyeColor: "#112233", id: "t2" });
		expect(svg).toContain('<mask id="av-t2-inside"');
		expect(svg).toContain('<use href="#av-t2-body" fill="#FF6700"/>');
		expect(svg).toContain('<g mask="url(#av-t2-inside)">');
		expect(svg).toContain('fill="#112233"');
	});

	it("corpo preto/branco pinta o olho com contraste: o recorte sumiria no fundo", () => {
		expect(resolveEyes("#000000")).toEqual({ mode: "paint", color: "#f9f9f9" });
		expect(resolveEyes("#fafafa")).toEqual({ mode: "paint", color: "#0a0a0c" });
		expect(resolveEyes("#FF6700").mode).toBe("cutout");
		expect(resolveEyes("#FF6700", "#fff").mode).toBe("paint");
	});

	it("id da máscara é sanitizado e nunca vazio", () => {
		expect(maskId("«r1»")).toBe("av-r1");
		expect(maskId(":R12a:")).toBe("av-R12a");
		expect(maskId('a b"><x')).toBe("av-abx");
		expect(maskId("«»")).toBe("av-x");
	});

	it("sem id explícito, o id deriva do conteúdo: estável e distinto entre formas", () => {
		const a = toSvg({ shape: "hex", color: "#FF6700" });
		expect(a).toBe(toSvg({ shape: "hex", color: "#FF6700" }));
		const id = (svg: string) => /mask id="([^"]+)"/.exec(svg)?.[1];
		expect(id(a)).not.toBe(id(toSvg({ shape: "cloud", color: "#FF6700" })));
	});

	it("é determinístico: mesma entrada, mesma string", () => {
		expect(toSvg({ shape: "cloud", color: "#00BCA6" })).toBe(toSvg({ shape: "cloud", color: "#00BCA6" }));
		expect(toSvg({ shape: "cloud", color: "#00BCA6" })).not.toBe(toSvg({ shape: "hex", color: "#00BCA6" }));
	});

	it("expressão muda só os olhos, não o corpo", () => {
		const neutral = stillFrame("blob", "neutral");
		const happy = stillFrame("blob", "happy");
		expect(bodyPath(happy.body)).toBe(bodyPath(neutral.body));
		expect(eyePath(happy.eyes[0])).not.toBe(eyePath(neutral.eyes[0]));
	});

	it("olho feliz é um arco \"^\": o ponto mais alto fica no meio, não nas pontas", () => {
		const eye = stillFrame("blob", "happy").eyes[0];
		const pts = eyePoints(eye);
		let topX = 0;
		let topY = Number.POSITIVE_INFINITY;
		for (let i = 0; i < pts.length; i += 2) {
			if ((pts[i + 1] as number) < topY) {
				topY = pts[i + 1] as number;
				topX = pts[i] as number;
			}
		}
		expect(Math.abs(topX - eye.cx)).toBeLessThan(eye.length * 0.1);
		// O meio sobe bem acima das pontas (a dobra aparece no traço inteiro).
		expect(eye.cy - topY).toBeGreaterThan(eye.bend * 0.8);
	});

	it("o olho direito é o espelho do esquerdo nas expressões simétricas", () => {
		const f = stillFrame("hex", "sad");
		const [l, r] = f.eyes;
		expect(l.cx + r.cx).toBeCloseTo(250, 5);
		expect(l.mirror).toBe(false);
		expect(r.mirror).toBe(true);
	});

	it("transform do grupo em repouso é a identidade em torno do centro", () => {
		expect(groupTransform(stillFrame("blob"))).toBe(
			"translate(125 125) scale(1 1) translate(-125 -125)",
		);
	});

	it("export estático: arquivo autônomo, cor dos olhos por variável CSS (tema)", () => {
		const file = toSvgFile({ shape: "wedge", color: "#FF6700", eyeColor: "#0a0a0c", size: 96 });
		expect(toSvgFile({ shape: "wedge", color: "#FF6700" })).toContain('<mask id="av-a-holes"');
		expect(file.startsWith("<?xml")).toBe(true);
		expect(file).toContain('width="96" height="96"');
		expect(file).toContain("--avatar-eye");
		expect(file).toContain('viewBox="0 0 250 250"');
		const url = toDataUrl({ shape: "wedge", color: "#FF6700" });
		expect(url.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
		expect(decodeURIComponent(url.split(",")[1] as string)).toContain("<svg");
	});

	it("cor maliciosa não escapa do atributo", () => {
		const svg = toSvg({ color: '"/><script>alert(1)</script>', eyeColor: '" onload="x', id: '"/><script>' });
		expect(svg).not.toContain("<script");
		expect(svg).not.toContain("onload");
		expect(safeColor("#abc", "x")).toBe("#abc");
		expect(safeColor("red", "x")).toBe("red");
		expect(safeColor("var(--atlas-avatar-eye, #111)", "x")).toBe("var(--atlas-avatar-eye, #111)");
		expect(safeColor('" onload="x', "x")).toBe("x");
	});

	it("renderFrame sem size escala com o contêiner", () => {
		const svg = renderFrame(stillFrame("blob"), { color: "#777777" });
		expect(svg.slice(0, svg.indexOf(">"))).not.toContain("width=");
	});
});

describe("identidade", () => {
	it("o mesmo id sempre dá o mesmo visual; ids diferentes variam", () => {
		expect(identityFor("agente-123")).toEqual(identityFor("agente-123"));
		const shapes = new Set<string>();
		const colors = new Set<string>();
		for (let i = 0; i < 80; i++) {
			const idn = identityFor(`bot-${i}`);
			shapes.add(idn.shape);
			colors.add(idn.color);
			expect(DRAWABLE_SHAPES).toContain(idn.shape);
			expect(AVATAR_COLORS.map((c) => c.value)).toContain(idn.color);
			expect(idn.color).not.toBe("#000000");
		}
		expect(shapes.size).toBeGreaterThanOrEqual(5);
		expect(colors.size).toBeGreaterThanOrEqual(6);
	});

	it("paleta tem 11 cores e todas dão contraste com olho escuro (exceto preto, que vira olho claro)", () => {
		expect(AVATAR_COLORS).toHaveLength(11);
		expect(eyeColorFor("#000000")).toBe("#f9f9f9");
		expect(eyeColorFor("#FF6700")).toBe("#0a0a0c");
	});

	it("mapeia as formas antigas (bloub) para as novas e mantém as novas", () => {
		expect(normalizeShape("rond")).toBe("blob");
		expect(normalizeShape("goutte")).toBe("teardrop");
		expect(normalizeShape("nuage")).toBe("cloud");
		expect(normalizeShape("hexagone")).toBe("hex");
		expect(normalizeShape("triangle")).toBe("wedge");
		expect(normalizeShape("galet")).toBe("pebble");
		expect(normalizeShape("capsule")).toBe("capsule");
		expect(normalizeShape("squircle")).toBe("squircle");
		expect(normalizeShape("wedge")).toBe("wedge");
		expect(normalizeShape("inexistente")).toBeUndefined();
		expect(normalizeShape(undefined)).toBeUndefined();
	});

	it("sem forma ou cor, usa as do id; com valor antigo (hex), respeita", () => {
		expect(resolveShape(undefined, "abc")).toBe(identityFor("abc").shape);
		expect(resolveShape("rond", "abc")).toBe("blob");
		expect(resolveColor(undefined, "abc")).toBe(identityFor("abc").color);
		expect(resolveColor("#f44336", "abc")).toBe("#f44336");
		expect(resolveColor("  ", "abc")).toBe(identityFor("abc").color);
	});
});
