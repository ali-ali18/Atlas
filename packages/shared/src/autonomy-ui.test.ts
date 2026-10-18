import { describe, expect, it } from "vitest";
import {
	autonomyConnectorKey,
	autonomyConnectorLabeler,
	autonomyToolOptions,
	neverAskIsRisky,
} from "./autonomy-ui.js";

const github = {
	catalogId: "github",
	slug: "github",
	name: "GitHub",
	tools: [
		{ name: "list_issues", inputSchema: {}, annotations: { readOnlyHint: true } },
		{ name: "create_issue", inputSchema: {} },
		{ name: "merge_pull_request", inputSchema: {} },
	],
};

describe("autonomy-ui", () => {
	it("usa o catálogo como chave do conector e o nome como rótulo", () => {
		expect(autonomyConnectorKey(github)).toBe("github");
		expect(autonomyConnectorKey({ catalogId: null, slug: "meu_mcp" })).toBe("meu_mcp");
		expect(autonomyConnectorLabeler([github])("github")).toBe("GitHub");
		expect(autonomyConnectorLabeler([github])("outro")).toBeUndefined();
	});

	it("lista só tools que escrevem, mais as do próprio agente", () => {
		const values = autonomyToolOptions([github]).map((option) => option.value);
		expect(values).toContain("mcp__github__create_issue");
		expect(values).toContain("mcp__github__merge_pull_request");
		expect(values).not.toContain("mcp__github__list_issues");
		expect(values).toContain("propose_profile_update");
	});

	it("avisa quando never_ask atinge ação irreversível", () => {
		expect(neverAskIsRisky({ tool: "mcp__github__merge_pull_request", mode: "never_ask" }, [github])).toBe(true);
		expect(neverAskIsRisky({ tool: "mcp__github__create_issue", mode: "never_ask" }, [github])).toBe(false);
		expect(neverAskIsRisky({ connector: "github", mode: "never_ask" }, [github])).toBe(true);
		expect(neverAskIsRisky({ tool: "propose_skill_delete", mode: "never_ask" }, [])).toBe(true);
		expect(neverAskIsRisky({ connector: "github", mode: "always_ask" }, [github])).toBe(false);
	});
});
