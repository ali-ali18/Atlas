import { describe, expect, it } from "vitest";
import { openSecrets, sealSecrets } from "./secret-box.js";
import {
	openSecrets as openMcp,
	sealSecrets as sealMcp,
} from "../mcp/secret-box.js";
describe("cofre genérico preserva MCP", () => {
	it("abre envelopes antigos e separa segredo do texto cifrado", () => {
		const key = Buffer.alloc(32, 7);
		const secrets = {
			accessToken: "fixture-access",
			refreshToken: "fixture-refresh",
		};
		const sealed = sealSecrets(secrets, key);
		expect(sealed).not.toContain(secrets.accessToken);
		expect(openSecrets(sealed, key)).toEqual(secrets);
		expect(openMcp(sealMcp({ apiKey: "fixture-api-key" }, key), key)).toEqual({
			apiKey: "fixture-api-key",
		});
		expect(() => openSecrets(sealed, Buffer.alloc(32, 8))).toThrow(
			"não foi possível abrir",
		);
	});
});
