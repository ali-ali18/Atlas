import { describe, expect, it } from "vitest";
import { applySettingsChange, revertSettings } from "./settings-change";
import type { AccountSettings } from "./settings-parse";

const before: AccountSettings = { timezone: null, botLanguage: "auto", sandboxAutoStart: true };

describe("escrita otimista", () => {
	it("aplica só o campo pedido", () => {
		expect(applySettingsChange(before, { sandboxAutoStart: false })).toEqual({ ...before, sandboxAutoStart: false });
		expect(applySettingsChange(before, { timezone: "America/Manaus" }).timezone).toBe("America/Manaus");
	});
	it("desfaz só o campo que falhou, sem atropelar outro em voo", () => {
		const current = { timezone: "America/Manaus", botLanguage: "en-US", sandboxAutoStart: false } as const;
		expect(revertSettings(current, before, { botLanguage: "en-US" })).toEqual({ ...current, botLanguage: "auto" });
		expect(revertSettings(current, before, { timezone: "America/Manaus" })).toEqual({ ...current, timezone: null });
		expect(revertSettings(current, before, { sandboxAutoStart: false })).toEqual({ ...current, sandboxAutoStart: true });
	});
});
