// CRUD de seções na home: os mesmos endpoints do web (`PATCH`/`DELETE /v1/sections/:id`).
import type { Section, UpdateSectionInput } from "@workspace/shared";

export async function patchSection(apiFetch: (path: string, init?: RequestInit) => Promise<Response>, id: string, patch: UpdateSectionInput): Promise<Section> {
	const response = await apiFetch(`/v1/sections/${encodeURIComponent(id)}`, {
		method: "PATCH",
		body: JSON.stringify(patch),
	});
	if (!response.ok) throw new Error(`patch section ${response.status}`);
	return (await response.json()) as Section;
}

export async function deleteSectionRemote(apiFetch: (path: string, init?: RequestInit) => Promise<Response>, id: string): Promise<void> {
	const response = await apiFetch(`/v1/sections/${encodeURIComponent(id)}`, { method: "DELETE" });
	if (!response.ok) throw new Error(`delete section ${response.status}`);
}
