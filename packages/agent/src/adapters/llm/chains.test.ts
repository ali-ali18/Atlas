import { MODEL_ROLES } from "@workspace/shared";
import { describe, expect, it } from "vitest";
import { chainsForAllRoles } from "./chains.js";

describe("chainsForAllRoles (auditoria F1, A3)", () => {
	it("todos os papéis levam a entrada do run, em listas independentes", () => {
		const entry = { provider: "openrouter", model: "vendor/modelo" } as const;
		const chains = chainsForAllRoles(entry);
		expect(Object.keys(chains).sort()).toEqual([...MODEL_ROLES].sort());
		for (const role of MODEL_ROLES) expect(chains[role]).toEqual([entry]);
		chains.main.push({ provider: "openrouter", model: "outro" });
		expect(chains.helper).toHaveLength(1);
		expect(entry).toEqual({ provider: "openrouter", model: "vendor/modelo" });
	});
});
