import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { identityFor } from "../../lib/avatar/identity";
import { toSvg } from "../../lib/avatar/render/still";
import { Avatar } from "./avatar";

const html = (node: React.ReactElement) => renderToStaticMarkup(node);

describe("Avatar (SSR / export estático)", () => {
	it("renderiza no servidor sem window e sem gradientes; olhos recortados por máscara", () => {
		expect(typeof window).toBe("undefined");
		const out = html(
			<>
				<Avatar color="#4caf50" shape="cloud" />
				<Avatar color="#4caf50" shape="cloud" />
			</>,
		);
		expect(out).not.toMatch(/gradient|filter/i);
		expect(out.match(/<mask /g)).toHaveLength(2);
		expect(out.match(/<path /g)).toHaveLength(4);
		expect(out).toContain('fill="#4caf50"');
		expect(out).toContain('viewBox="0 0 250 250"');
	});

	it("máscaras: ids únicos entre instâncias e estáveis entre renderizações (SSR/hidratação)", () => {
		const tree = (
			<>
				<Avatar color="#4caf50" shape="cloud" />
				<Avatar color="#4caf50" shape="cloud" />
				<Avatar color="#4caf50" shape="hex" />
			</>
		);
		const ids = (markup: string) => [...markup.matchAll(/<mask id="([^"]+)"/g)].map((m) => m[1]);
		const first = ids(renderToString(tree));
		expect(first).toHaveLength(3);
		expect(new Set(first).size).toBe(3);
		for (const id of first) expect(id).toMatch(/^av-[a-zA-Z0-9_-]+-holes$/);
		// mesma árvore, mesma ordem: mesmos ids (o cliente hidrata com os do servidor)
		expect(ids(renderToString(tree))).toEqual(first);
		expect(ids(html(tree))).toEqual(first);
		// cada <g mask> aponta para a máscara da própria instância
		const refs = [...renderToString(tree).matchAll(/mask="url\(#([^)]+)\)"/g)].map((m) => m[1]);
		expect(refs).toEqual(first);
	});

	it("eyeColor pinta o olho dentro do corpo; sem ele, recorta", () => {
		const painted = html(<Avatar color="#4caf50" eyeColor="#123456" />);
		expect(painted).toContain("-inside");
		expect(painted).toContain('fill="#123456"');
		expect(html(<Avatar color="#4caf50" />)).toContain("-holes");
		expect(html(<Avatar color="#000000" />)).toContain("-inside");
	});

	it("é determinístico (mesma marcação no servidor e na hidratação)", () => {
		const a = html(<Avatar id="bot-9" size={48} />);
		const b = html(<Avatar id="bot-9" size={48} />);
		expect(a).toBe(b);
	});

	it("sem forma/cor usa a identidade do id; com forma antiga, mapeia", () => {
		const idn = identityFor("bot-9");
		expect(html(<Avatar id="bot-9" />)).toBe(
			html(<Avatar color={idn.color} id="bot-9" shape={idn.shape} />),
		);
		expect(html(<Avatar color="#f44336" shape="goutte" />)).toBe(
			html(<Avatar color="#f44336" shape="teardrop" />),
		);
	});

	it("o corpo e os olhos são os mesmos do export estático (mesmo código)", () => {
		const out = html(<Avatar color="#FF6700" reducedMotion shape="wedge" />);
		const still = toSvg({ shape: "wedge", color: "#FF6700" });
		const dOf = (s: string) => [...s.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);
		expect(dOf(out)).toEqual(dOf(still));
		expect(dOf(out)).toHaveLength(2);
	});

	it("a11y: sem rótulo é decorativo; com rótulo vira role=img; SVG sempre aria-hidden", () => {
		const decorative = html(<Avatar />);
		expect(decorative).not.toContain("role=");
		expect(decorative).toContain('aria-hidden="true"');
		const labeled = html(<Avatar ariaLabel="Atlas" />);
		expect(labeled).toContain('role="img"');
		expect(labeled).toContain('aria-label="Atlas"');
		expect(labeled).toContain('<svg aria-hidden="true"');
	});

	it("interactive: botão com aria-label e SVG decorativo", () => {
		const out = html(<Avatar ariaLabel="Cutucar Atlas" interactive />);
		expect(out).toMatch(/^<button[^>]*type="button"/);
		expect(out).toContain('aria-label="Cutucar Atlas"');
		expect(out).toContain('<svg aria-hidden="true"');
	});

	it("movimento reduzido: quadro estático; follow/estado não mexem nele", () => {
		const base = html(<Avatar reducedMotion shape="blob" />);
		expect(html(<Avatar follow="always" reducedMotion shape="blob" state="thinking" />)).toBe(base);
		expect(html(<Avatar expression="happy" reducedMotion shape="blob" />)).not.toBe(base);
	});

	it("respeita o tamanho pedido e escolhe expressão por apelido", () => {
		const out = html(<Avatar size={96} />);
		expect(out).toContain("height:96px");
		expect(out).toContain("width:96px");
		expect(html(<Avatar expression="smile" reducedMotion />)).toBe(
			html(<Avatar expression="happy" reducedMotion />),
		);
	});

	it("não escapa cor maliciosa", () => {
		const out = html(<Avatar color={'"><script>x</script>'} eyeColor={'" onload="y'} id="z" />);
		expect(out).not.toContain("<script");
		expect(out).not.toContain("onload");
	});
});
