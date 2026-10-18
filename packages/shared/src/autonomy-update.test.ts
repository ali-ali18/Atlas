import { describe, expect, it } from "vitest";
import { applyAutonomyUpdate, autonomyFallbackBase, confirmWritesExceptions, parseAutonomyUpdate } from "./autonomy-update.js";

const NOW = new Date("2026-09-29T12:00:00.000Z");

describe("parseAutonomyUpdate", () => {
	it("aceita nível, validade e exceções; null herda", () => {
		expect(
			parseAutonomyUpdate({
				level: "autonomous",
				duration: "7d",
				exceptions: [{ connector: "gmail", mode: "never_ask" }],
			}),
		).toEqual({
			level: "autonomous",
			duration: "7d",
			exceptions: [{ connector: "gmail", mode: "never_ask" }],
		});
		expect(parseAutonomyUpdate({ level: null })).toEqual({ level: null });
	});
	it("rejeita nível, validade ou exceção inválidos", () => {
		expect(parseAutonomyUpdate({ level: "x" })).toBeNull();
		expect(parseAutonomyUpdate({ duration: "2y" })).toBeNull();
		expect(parseAutonomyUpdate({ exceptions: [{ connector: "a", mode: "x" }] })).toBeNull();
		expect(parseAutonomyUpdate({ exceptions: "a" })).toBeNull();
		expect(parseAutonomyUpdate("x")).toBeNull();
		expect(parseAutonomyUpdate([])).toBeNull();
	});
});

describe("applyAutonomyUpdate", () => {
	const base = { scope: "bot" as const, levelBeforeChange: "balanced" as const, now: NOW };

	it("nível novo com validade grava until e o nível de antes como fallback", () => {
		expect(applyAutonomyUpdate({ ...base, current: null, update: { level: "autonomous", duration: "7d" } })).toEqual({
			level: "autonomous",
			until: "2026-10-06T12:00:00.000Z",
			fallbackLevel: "balanced",
			exceptions: [],
		});
	});
	it("nível novo sem validade = para sempre", () => {
		expect(applyAutonomyUpdate({ ...base, current: null, update: { level: "always_ask" } })).toEqual({
			level: "always_ask",
			exceptions: [],
		});
	});
	it("só exceções: mantém nível e validade", () => {
		const current = {
			level: "autonomous" as const,
			until: "2026-10-06T12:00:00.000Z",
			fallbackLevel: "balanced" as const,
			exceptions: [],
		};
		expect(
			applyAutonomyUpdate({ ...base, current, update: { exceptions: [{ tool: "t", mode: "blocked" }] } }),
		).toEqual({ ...current, exceptions: [{ tool: "t", mode: "blocked" }] });
	});
	it("trocar de temporário para temporário não encadeia o fallback", () => {
		const current = {
			level: "autonomous" as const,
			until: "2026-10-06T12:00:00.000Z",
			fallbackLevel: "balanced" as const,
			exceptions: [],
		};
		const next = applyAutonomyUpdate({
			...base,
			levelBeforeChange: "autonomous",
			current,
			update: { level: "always_ask", duration: "1d" },
		});
		expect(next?.fallbackLevel).toBe("balanced");
		expect(autonomyFallbackBase(current, "autonomous")).toBe("balanced");
	});
	it("bot: level null sem exceções limpa tudo (herda)", () => {
		const current = { level: "autonomous" as const, exceptions: [] };
		expect(applyAutonomyUpdate({ ...base, current, update: { level: null } })).toBeNull();
	});
	it("bot: level null mantém as exceções", () => {
		const current = { level: "autonomous" as const, exceptions: [{ tool: "t", mode: "never_ask" as const }] };
		expect(applyAutonomyUpdate({ ...base, current, update: { level: null } })).toEqual({
			exceptions: [{ tool: "t", mode: "never_ask" }],
		});
	});
	it("conta nunca vira null", () => {
		expect(
			applyAutonomyUpdate({ ...base, scope: "account", current: null, update: { level: null } }),
		).toEqual({ exceptions: [] });
	});
});

describe("confirmWritesExceptions (espelho da migração)", () => {
	it("confirmWrites=false vira never_ask do conector", () => {
		expect(
			confirmWritesExceptions([
				{ catalogId: "github", slug: "github", confirmWrites: false },
				{ catalogId: null, slug: "meu_mcp", confirmWrites: false },
				{ catalogId: "notion", slug: "notion", confirmWrites: true },
			]),
		).toEqual([
			{ connector: "github", mode: "never_ask" },
			{ connector: "meu_mcp", mode: "never_ask" },
		]);
	});
});
