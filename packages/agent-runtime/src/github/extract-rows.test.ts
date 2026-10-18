import { describe, expect, it } from "vitest";
import { describeRowsShape, extractHookRows } from "./hook-ops.js";

const repos = [{ full_name: "ali-ali18/agent-bot" }];

describe("extractHookRows: lista em qualquer embrulho do Composio", () => {
	it("chaves conhecidas, chaves do próprio app e string JSON", () => {
		expect(extractHookRows(repos)).toEqual(repos);
		expect(extractHookRows({ details: repos })).toEqual(repos);
		expect(extractHookRows({ repositories: repos })).toEqual(repos);
		expect(extractHookRows({ data: { repositories: repos } })).toEqual(repos);
		expect(extractHookRows({ response_data: { pull_requests: [] } })).toEqual([]);
		expect(extractHookRows(JSON.stringify({ data: { branches: repos } }))).toEqual(repos);
		expect(extractHookRows({ data: JSON.stringify({ items: repos }) })).toEqual(repos);
	});

	it("prefere as chaves conhecidas a outras listas do objeto", () => {
		expect(extractHookRows({ links: [{ x: 1 }], details: repos })).toEqual(repos);
	});

	it("sem lista nenhuma: null", () => {
		expect(extractHookRows({ message: "ok", count: 3 })).toBeNull();
		expect(extractHookRows("não é json")).toBeNull();
	});

	it("describeRowsShape mostra só chaves e tipos, nunca valores", () => {
		const shape = describeRowsShape({ data: { token: "SEGREDO", total: 2 } });
		expect(shape).toBe("{data:{token:string(7),total:number}}");
		expect(shape).not.toContain("SEGREDO");
	});
});
