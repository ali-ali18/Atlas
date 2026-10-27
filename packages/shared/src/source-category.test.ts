import { describe, expect, it } from "vitest";
import { categorizeSource, composioToolkitOfTool, isBriefCategory } from "./index.js";

describe("categorizeSource", () => {
	it("cobre os ids do catálogo nativo", () => {
		expect(categorizeSource({ catalogId: "gmail" })).toBe("email");
		expect(categorizeSource({ catalogId: "google_calendar" })).toBe("calendar");
		expect(categorizeSource({ catalogId: "slack" })).toBe("messages");
		expect(categorizeSource({ catalogId: "notion" })).toBe("tasks");
		expect(categorizeSource({ catalogId: "github" })).toBe("tasks");
	});

	it("o que não é caixa de entrada nem trabalho do dia vira 'other'", () => {
		for (const catalogId of ["google_drive", "google_sheets", "firecrawl", "brave_search", "higgsfield"]) {
			expect(categorizeSource({ catalogId })).toBe("other");
		}
		expect(isBriefCategory("other")).toBe(false);
		expect(isBriefCategory("email")).toBe(true);
	});

	it("cobre toolkits do Composio", () => {
		const cases: Array<[string, string]> = [
			["gmail", "email"],
			["outlook", "email"],
			["googlecalendar", "calendar"],
			["outlookcalendar", "calendar"],
			["slack", "messages"],
			["notion", "tasks"],
			["linear", "tasks"],
			["trello", "tasks"],
			["github", "tasks"],
			["shopify", "business"],
			["hubspot", "business"],
		];
		for (const [toolkit, expected] of cases) {
			expect(categorizeSource({ kind: "composio", toolkit })).toBe(expected);
		}
	});

	it("conector de API é 'business' por padrão, mas respeita o que o nome diz", () => {
		expect(categorizeSource({ kind: "api", name: "Bling" })).toBe("business");
		expect(categorizeSource({ kind: "api", name: "API da minha loja" })).toBe("business");
		expect(categorizeSource({ kind: "api", name: "Meu ERP interno" })).toBe("business");
		expect(categorizeSource({ kind: "api", name: "Calendário da empresa (agenda)" })).toBe("calendar");
	});

	it("MCP próprio: o nome decide, sem acento nem caixa", () => {
		expect(categorizeSource({ kind: "mcp", name: "Meu Outlook (trabalho)" })).toBe("email");
		expect(categorizeSource({ kind: "mcp", name: "Google Agenda" })).toBe("calendar");
		expect(categorizeSource({ kind: "mcp", name: "Fastmail" })).toBe("email");
		expect(categorizeSource({ kind: "mcp", name: "Servidor qualquer" })).toBe("other");
	});

	it("catálogo vence o nome livre", () => {
		expect(categorizeSource({ catalogId: "slack", name: "Agenda do time" })).toBe("messages");
	});
});

describe("composioToolkitOfTool", () => {
	it("tira o toolkit do prefixo do nome da tool", () => {
		expect(composioToolkitOfTool("GMAIL_FETCH_EMAILS")).toBe("gmail");
		expect(composioToolkitOfTool("GOOGLECALENDAR_EVENTS_LIST")).toBe("googlecalendar");
		expect(composioToolkitOfTool("GOOGLE_CALENDAR_LIST_EVENTS")).toBe("googlecalendar");
		expect(composioToolkitOfTool("LINEAR_LIST_ISSUES")).toBe("linear");
		expect(composioToolkitOfTool("")).toBe("");
	});
});
