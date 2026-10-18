import { describe, expect, it } from "vitest";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { isMcpAuthFailure, mcpAuthRequired } from "./auth-marker.js";

describe("isMcpAuthFailure", () => {
	it("401 é falha de login", () => {
		expect(isMcpAuthFailure(new Error("HTTP 401: invalid credentials"))).toBe(true);
		expect(isMcpAuthFailure(new UnauthorizedError("x"))).toBe(true);
		expect(isMcpAuthFailure(mcpAuthRequired("sem login"))).toBe(true);
	});

	it("invalid_token e invalid_grant são falha de login", () => {
		expect(isMcpAuthFailure(new Error("invalid_token"))).toBe(true);
		expect(isMcpAuthFailure(new Error("invalid_grant: Token has been expired or revoked"))).toBe(true);
	});

	it("escopo insuficiente é falha de login (precisa reconectar)", () => {
		expect(isMcpAuthFailure(new Error("HTTP 403: Request had insufficient authentication scopes."))).toBe(true);
	});

	it("403 de permissão de arquivo NÃO é falha de login", () => {
		expect(isMcpAuthFailure(new Error("HTTP 403: The caller does not have permission"))).toBe(false);
		expect(isMcpAuthFailure(new Error("HTTP 403: Sheets API has not been used in project 1 or it is disabled"))).toBe(false);
	});

	it("outros erros e valores não-Error não são", () => {
		expect(isMcpAuthFailure(new Error("HTTP 500: internal"))).toBe(false);
		expect(isMcpAuthFailure("401")).toBe(false);
	});
});
