import { describe, expect, it } from "vitest";
import { describeRoutineFailure, extractUrls, redactSecrets } from "./index.js";

// Regressão dos alertas CodeQL "Polynomial regular expression".
const N = 50_000;
const LIMIT_MS = 200;

function timed<T>(fn: () => T): { value: T; ms: number } {
	const start = performance.now();
	const value = fn();
	return { value, ms: performance.now() - start };
}

describe("regex lineares (ReDoS)", () => {
	it("extractUrls: milhares de '!' no fim da URL", () => {
		const { value, ms } = timed(() => extractUrls(`https://a.com/${"!".repeat(N)}b`));
		expect(ms).toBeLessThan(LIMIT_MS);
		expect(value).toHaveLength(1);
		expect(extractUrls("veja https://a.com/x?y=1, e https://b.com/z.")).toEqual(["https://a.com/x?y=1", "https://b.com/z"]);
		expect(extractUrls("https://a.com/x!?!")).toEqual(["https://a.com/x"]);
	});

	it("redactSecrets: BEGIN repetido sem END responde rápido", () => {
		const { ms } = timed(() => redactSecrets("-----BEGIN PRIVATE KEY-----".repeat(5000)));
		expect(ms).toBeLessThan(LIMIT_MS);
	});

	it("redactSecrets: continua redigindo chaves PEM (inclusive com cabeçalho Proc-Type)", () => {
		const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabc+/=\n-----END RSA PRIVATE KEY-----";
		expect(redactSecrets(`antes\n${pem}\ndepois`)).toBe("antes\n[redacted]\ndepois");
		const enc = "-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,ABCD\n\nMIIE\n-----END RSA PRIVATE KEY-----";
		expect(redactSecrets(enc)).toBe("[redacted]");
		const two = `${"-----BEGIN PRIVATE KEY-----"}\nlixo sem fim\n${"-----BEGIN PRIVATE KEY-----\nAAA\n-----END PRIVATE KEY-----"}`;
		expect(redactSecrets(two)).toContain("[redacted]");
		expect(redactSecrets(two)).not.toContain("AAA");
	});

	it("describeRoutineFailure: milhares de tabs no erro", () => {
		const { ms } = timed(() => describeRoutineFailure(`${"\t".repeat(N)}x`));
		expect(ms).toBeLessThan(LIMIT_MS);
		const { ms: ms2 } = timed(() => describeRoutineFailure(`erro${"\t".repeat(N)}x`));
		expect(ms2).toBeLessThan(LIMIT_MS);
	});
});
