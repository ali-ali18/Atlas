import { describe, expect, it } from "vitest";
import { shouldRecreateForImage } from "./image-staleness.js";

describe("shouldRecreateForImage", () => {
	it("recria quando os IDs diferem", () => {
		expect(shouldRecreateForImage("sha256:old", "sha256:new")).toBe(true);
	});
	it("reusa quando os IDs são iguais", () => {
		expect(shouldRecreateForImage("sha256:a", "sha256:a")).toBe(false);
	});
	it("reusa quando algum ID é desconhecido ou vazio", () => {
		expect(shouldRecreateForImage(undefined, "sha256:a")).toBe(false);
		expect(shouldRecreateForImage("sha256:a", null)).toBe(false);
		expect(shouldRecreateForImage("", "sha256:a")).toBe(false);
		expect(shouldRecreateForImage("  ", "  ")).toBe(false);
	});
});
