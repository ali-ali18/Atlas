import { describe, expect, it } from "vitest";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { base64UrlDecode, base64UrlEncode, GoogleApiError, googleFetch, mapGoogleApiError } from "./google-api.js";

function fakeResponse(status: number, body: unknown, asJson = true) {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => (asJson ? body : (() => { throw new Error("não é JSON"); })()),
		text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
	};
}

describe("googleFetch", () => {
	it("manda o token como Authorization: Bearer", async () => {
		let seenAuth: string | undefined;
		const fetchFn = async (_url: string, init?: RequestInit) => {
			seenAuth = (init?.headers as Record<string, string> | undefined)?.Authorization;
			return fakeResponse(200, { ok: true });
		};
		await googleFetch({ getAccessToken: async () => "tok-segredo-123", fetchFn }, "https://example.com");
		expect(seenAuth).toBe("Bearer tok-segredo-123");
	});

	it("401 vira UnauthorizedError sem ecoar o token na mensagem", async () => {
		const fetchFn = async () => fakeResponse(401, { error: { message: "invalid_token" } });
		const promise = googleFetch({ getAccessToken: async () => "tok-secreto-xyz", fetchFn }, "https://example.com");
		await expect(promise).rejects.toBeInstanceOf(UnauthorizedError);
		await expect(promise).rejects.not.toThrow(/tok-secreto-xyz/);
	});

	it("getAccessToken que falha também vira UnauthorizedError (sem chamar a API)", async () => {
		const fetchFn = async () => {
			throw new Error("não deveria ser chamado");
		};
		await expect(
			googleFetch({ getAccessToken: async () => { throw new Error("sem refresh_token"); }, fetchFn }, "https://example.com"),
		).rejects.toBeInstanceOf(UnauthorizedError);
	});

	it("outros erros HTTP viram GoogleApiError com status e a mensagem do Google", async () => {
		const fetchFn = async () => fakeResponse(403, { error: { message: "forbidden por escopo" } });
		const promise = googleFetch({ getAccessToken: async () => "tok", fetchFn }, "https://example.com");
		await expect(promise).rejects.toBeInstanceOf(GoogleApiError);
		await expect(promise).rejects.toMatchObject({ status: 403, message: expect.stringContaining("forbidden por escopo") });
	});
});

describe("mapGoogleApiError", () => {
	it("403 sem permissão no arquivo", () => {
		const text = mapGoogleApiError(403, "HTTP 403: The caller does not have permission", "sheets");
		expect(text).toContain("não tem acesso a esse arquivo");
		expect(text).toContain("create_spreadsheet");
	});

	it.each([
		"HTTP 403: Google Sheets API has not been used in project 123 before or it is disabled.",
		"HTTP 403: Calendar API is disabled",
	])("403 de API desativada: %s", (message) => {
		expect(mapGoogleApiError(403, message)).toBe(
			"A API do Google está desativada no projeto do Google Cloud. O usuário precisa ativá-la.",
		);
	});

	it("403 de escopo insuficiente pede reconexão", () => {
		expect(mapGoogleApiError(403, "HTTP 403: Request had insufficient authentication scopes.")).toBe(
			"Falta permissão no conector: reconecte no Marketplace.",
		);
	});

	it("404 na Agenda e 404 genérico", () => {
		expect(mapGoogleApiError(404, "HTTP 404: Not Found", "calendar")).toBe("calendarId inválido: use list_calendars ou 'primary'.");
		expect(mapGoogleApiError(404, "HTTP 404: Not Found", "sheets")).toBe("não encontrado (id errado ou sem acesso).");
		expect(mapGoogleApiError(404, "HTTP 404: Not Found")).toBe("não encontrado (id errado ou sem acesso).");
	});

	it("sem regra aplicável devolve a mensagem crua", () => {
		expect(mapGoogleApiError(500, "HTTP 500: internal")).toBe("HTTP 500: internal");
		expect(mapGoogleApiError(403, "HTTP 403: rate limit")).toBe("HTTP 403: rate limit");
	});
});

describe("base64url", () => {
	it("roundtrip preserva acentos", () => {
		const text = "Olá, tudo bem? — café ☕";
		expect(base64UrlDecode(base64UrlEncode(text))).toBe(text);
	});
});
