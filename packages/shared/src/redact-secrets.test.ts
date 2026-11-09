import { describe, expect, it } from "vitest";
import { redactSecrets } from "./redact-secrets.js";

const SECRET = 'pa"ss\\word/+=sk-9876';
const b64 = Buffer.from(SECRET).toString("base64");

describe("redactSecrets: ecos transformados do valor", () => {
	it("literal", () => {
		expect(redactSecrets(`x ${SECRET} y`, [SECRET])).toBe("x [redacted] y");
	});
	it("base64 (com e sem =), base64url, URL-encoded e escapado em JSON", () => {
		const forms = [b64, b64.replace(/=+$/, ""), Buffer.from(SECRET).toString("base64url"), encodeURIComponent(SECRET), JSON.stringify(SECRET).slice(1, -1)];
		for (const form of forms) {
			const out = redactSecrets(`echo: ${form} fim`, [SECRET]);
			expect(out, form).not.toContain(form);
			expect(out).toContain("[redacted]");
		}
	});
	it("valor curto só no literal (forma codificada de valor curto casaria com texto comum)", () => {
		expect(redactSecrets("abc YWJj", ["abc"])).toBe("[redacted] YWJj");
	});
	it("sem segredos não muda o texto", () => {
		expect(redactSecrets("nada aqui", [])).toBe("nada aqui");
	});
});
