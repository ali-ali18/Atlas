import { describe, expect, it } from "vitest";
import { defineCapability } from "./define-capability.js";
import { fakeTool } from "./fixtures.js";
import { capabilityIndex, createCapabilityRegistry } from "./registry.js";

const cap = (id: string, tools: string[], extra: { core?: boolean; summary?: string } = {}) =>
	defineCapability({ id, title: id.toUpperCase(), summary: extra.summary ?? `Does ${id} things.`, core: extra.core, tools: tools.map((t) => fakeTool(t)) });

describe("createCapabilityRegistry", () => {
	it("recusa id repetido", () => {
		expect(() => createCapabilityRegistry([cap("a", ["x"]), cap("a", ["y"])])).toThrow(/duplicate id "a"/);
	});
	it("recusa nome de tool repetido entre capacidades, dizendo as duas", () => {
		expect(() => createCapabilityRegistry([cap("a", ["x"]), cap("b", ["x"])])).toThrow(/"x" is in both "a" and "b"/);
	});
	it("reserva use_capability", () => {
		expect(() => createCapabilityRegistry([cap("a", ["use_capability"])])).toThrow(/reserved/);
	});
	it("ordena por id, qualquer que seja a ordem de entrada", () => {
		const r1 = createCapabilityRegistry([cap("web", ["w"]), cap("agenda", ["g"])]);
		const r2 = createCapabilityRegistry([cap("agenda", ["g"]), cap("web", ["w"])]);
		expect(r1.ids()).toEqual(["agenda", "web"]);
		expect(r2.ids()).toEqual(r1.ids());
		expect(r1.ownerOf("w")?.id).toBe("web");
		expect(r1.toolByName("g")?.name).toBe("g");
	});
});

describe("capabilityIndex", () => {
	const caps = [cap("shopping", ["s"]), cap("email", ["e"]), cap("web", ["w"], { core: true })];
	it("uma linha por capacidade carregável, em ordem de id, sem o núcleo", () => {
		const index = capabilityIndex(createCapabilityRegistry(caps));
		expect(index).toBe("- email: Does email things.\n- shopping: Does shopping things.");
		expect(index.split("\n")).toHaveLength(2);
	});
	it("é determinístico", () => {
		const a = capabilityIndex(createCapabilityRegistry(caps));
		const b = capabilityIndex(createCapabilityRegistry([...caps].reverse()));
		expect(b).toBe(a);
	});
	it("sem capacidade carregável devolve vazio", () => {
		expect(capabilityIndex(createCapabilityRegistry([cap("web", ["w"], { core: true })]))).toBe("");
	});
});
