import { createSign } from "node:crypto";

function b64url(input: string | Buffer): string {
	return Buffer.from(input).toString("base64url");
}

/**
 * JWT do GitHub App (RS256) com `node:crypto` — sem dependência extra.
 * `iat` 60 s no passado (tolera relógio atrasado) e `exp` em 9 min (o GitHub aceita no máximo 10).
 */
export function createGithubAppJwt(input: { appId: string; privateKey: string; now?: () => number }): string {
	const nowSec = Math.floor((input.now ?? Date.now)() / 1000);
	const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
	const payload = b64url(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 9 * 60, iss: input.appId }));
	const signingInput = `${header}.${payload}`;
	const signer = createSign("RSA-SHA256");
	signer.update(signingInput);
	signer.end();
	const signature = signer.sign(input.privateKey);
	return `${signingInput}.${b64url(signature)}`;
}
