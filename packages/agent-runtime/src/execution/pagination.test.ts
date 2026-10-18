import { describe, expect, it } from "vitest";
import { clipWithNotice } from "../mcp/clip-notice.js";
import { buildClipHint } from "./pagination.js";

const make = (properties: Record<string, unknown>) => ({ type: "object", properties });
const hint = (schema: unknown, args: Record<string, unknown> = {}, shownItems: number | null = null, text = "") =>
	buildClipHint({ schema, args, shownItems, text });

describe("buildClipHint", () => {
	it("page: nomeia o parâmetro e o próximo valor (padrão = página 1)", () => {
		const schema = make({ page: { type: "integer" }, limit: { type: "integer" } });
		expect(hint(schema)).toContain("page=2");
		expect(hint(schema, { page: 4 })).toContain("page=5");
		expect(hint(schema)).toContain("lower `limit`");
	});
	it("pagina (pt) e offset com limit", () => {
		expect(hint(make({ pagina: { type: "number" } }), { pagina: "2" })).toContain("pagina=3");
		const schema = make({ offset: { type: "integer" }, limit: { type: "integer" } });
		expect(hint(schema, { offset: 100, limit: 50 })).toContain("offset=150");
		expect(hint(schema, { limit: 50 })).toContain("offset=50");
	});
	it("offset usa os itens realmente mostrados quando conhecidos (sem pular itens)", () => {
		const schema = make({ offset: { type: "integer" }, limit: { type: "integer" } });
		expect(hint(schema, { offset: 100, limit: 50 }, 12)).toContain("offset=112");
	});
	it("start/skip e default do schema", () => {
		expect(hint(make({ skip: { type: "integer" }, limit: { type: "integer", default: 25 } }))).toContain("skip=25");
		expect(hint(make({ start: { type: "integer" } }), { start: 3 }, 4)).toContain("start=7");
	});
	it("cursor: usa o cursor do resultado, ou diz de onde tirar", () => {
		const schema = make({ cursor: { type: "string" } });
		expect(hint(schema, {}, null, '{"items":[],"next_cursor":"abc123"}')).toContain("cursor=abc123");
		expect(hint(schema, {}, null, "{}")).toContain("cursor=<next cursor from the result>");
	});
	it("sem paginação: sugere até 3 filtros do schema, ignorando texto livre e limit", () => {
		const schema = make({
			explanation: { type: "string" },
			name: { type: "string" },
			status: { type: "string" },
			created_after: { type: "string" },
			owner: { type: "string" },
			limit: { type: "integer" },
		});
		const out = hint(schema, { status: "open" })!;
		expect(out).toContain("no pagination parameter");
		const names = out.split("filters: ")[1]!.replace(/\.$/, "").split(", ");
		expect(names).toHaveLength(3);
		expect(names).not.toContain("explanation");
		expect(names).not.toContain("limit");
		expect(names).not.toContain("status"); // já usado: os não usados vêm primeiro
	});
	it("schema sem nada útil devolve null", () => {
		expect(hint(undefined)).toBeNull();
		expect(hint(make({ explanation: { type: "string" } }))).toBeNull();
	});
});

describe("aviso de corte com dica do schema", () => {
	const text = JSON.stringify({ data: Array.from({ length: 200 }, (_, i) => ({ id: i, name: `item-${i}` })) });
	it("inclui page=2 no aviso de corte", () => {
		const schema = make({ page: { type: "integer" }, limit: { type: "integer" } });
		const clipped = clipWithNotice(text, 500, ({ shownItems }) => buildClipHint({ schema, args: {}, shownItems, text }));
		expect(clipped.truncated).toBe(true);
		expect(clipped.text).toMatch(/of 200 items\)\. Do not conclude[^\]]*page=2/);
		expect(clipped.text.endsWith("]")).toBe(true);
	});
	it("sem dica o aviso fica como antes", () => {
		expect(clipWithNotice(text, 500).text).toBe(clipWithNotice(text, 500, () => null).text);
	});
});
