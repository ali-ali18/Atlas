import { describe, expect, it } from "vitest";
import { alreadyLoadedSummary, findAlreadyLoadedTools, ownToolName } from "./tool-search-guard.js";

const loaded = ["mcp__shop__list_items", "mcp__shop__get_item"];
const available = [...loaded, "mcp__shop__create_item", "mcp__shop__list_orders"];
const find = (query: string, current: string[] = loaded) =>
	findAlreadyLoadedTools({ query, loaded: current, available });

describe("findAlreadyLoadedTools", () => {
	it("nome exposto ou próprio na consulta", () => {
		expect(find("mcp__shop__list_items")).toEqual(["mcp__shop__list_items"]);
		expect(find("list_items")).toEqual(["mcp__shop__list_items"]);
		expect(find("get item by id")).toEqual(["mcp__shop__get_item"]);
	});
	it("alta sobreposição de tokens (plural, ordem, palavras de enchimento)", () => {
		expect(find("find all items to list")).toEqual(["mcp__shop__list_items"]);
		expect(find("list item and get item")).toEqual(expect.arrayContaining(loaded));
	});
	it("tool ainda não carregada que casa também: segue a busca normal", () => {
		expect(find("create item")).toEqual([]);
		expect(find("list orders")).toEqual([]);
		expect(find("list items", ["mcp__shop__get_item"])).toEqual([]);
	});
	it("consulta que não mira o carregado ou vazia", () => {
		expect(find("weather forecast")).toEqual([]);
		expect(find("   ")).toEqual([]);
		expect(find("items")).toEqual([]);
	});
	it("texto devolvido", () => {
		expect(alreadyLoadedSummary(loaded)).toBe("Already loaded: mcp__shop__list_items, mcp__shop__get_item. Call them directly.");
		expect(ownToolName("mcp__a__b__c")).toBe("b__c");
		expect(ownToolName("web_search")).toBe("web_search");
	});
});
