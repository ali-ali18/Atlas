import { describe, expect, it, vi } from "vitest";
import { deleteSectionRemote, patchSection } from "./section-api";

describe("section-api", () => {
	it("PATCH envia o corpo", async () => {
		const apiFetch = vi.fn(async () => new Response(JSON.stringify({ id: "s1", name: "Novo", order: 0 }), { status: 200 }));
		const section = await patchSection(apiFetch, "s1", { name: "Novo" });
		expect(section.name).toBe("Novo");
		expect(apiFetch).toHaveBeenCalledWith("/v1/sections/s1", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ name: "Novo" }) }));
	});

	it("DELETE falha quando o servidor recusa", async () => {
		const apiFetch = vi.fn(async () => new Response("", { status: 404 }));
		await expect(deleteSectionRemote(apiFetch, "s1")).rejects.toThrow(/404/);
	});
});
