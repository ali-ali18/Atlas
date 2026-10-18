import { createHmac } from "node:crypto";

/** TOTP (RFC 6238 / HOTP RFC 4226). Aceita chave base32 ou URL `otpauth://`. */

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Decode(input: string): Buffer {
	const clean = input.toUpperCase().replace(/[\s=-]+/g, "");
	let bits = 0;
	let value = 0;
	const out: number[] = [];
	for (const ch of clean) {
		const idx = B32.indexOf(ch);
		if (idx < 0) throw new Error("chave 2FA inválida (base32)");
		value = (value << 5) | idx;
		bits += 5;
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 0xff);
			bits -= 8;
		}
	}
	return Buffer.from(out);
}

export type TotpConfig = { secret: string; digits: number; period: number; algorithm: "sha1" | "sha256" | "sha512" };

/** `otpauth://totp/Site:user?secret=ABC&digits=6&period=30` ou só a chave base32. */
export function parseTotpInput(raw: string): TotpConfig | null {
	const text = raw.trim();
	if (!text) return null;
	if (/^otpauth:\/\//i.test(text)) {
		try {
			const url = new URL(text);
			if (url.hostname.toLowerCase() !== "totp") return null;
			const secret = url.searchParams.get("secret");
			if (!secret) return null;
			base32Decode(secret);
			const algo = (url.searchParams.get("algorithm") ?? "SHA1").toLowerCase();
			return {
				secret: secret.toUpperCase().replace(/[\s=-]+/g, ""),
				digits: url.searchParams.get("digits") === "8" ? 8 : 6,
				period: Math.max(5, Math.min(120, Number(url.searchParams.get("period")) || 30)),
				algorithm: algo === "sha256" || algo === "sha512" ? algo : "sha1",
			};
		} catch {
			return null;
		}
	}
	try {
		base32Decode(text);
	} catch {
		return null;
	}
	return { secret: text.toUpperCase().replace(/[\s=-]+/g, ""), digits: 6, period: 30, algorithm: "sha1" };
}

export function hotp(key: Buffer, counter: number, digits = 6, algorithm: TotpConfig["algorithm"] = "sha1"): string {
	const buf = Buffer.alloc(8);
	buf.writeBigUInt64BE(BigInt(counter));
	const hmac = createHmac(algorithm, key).update(buf).digest();
	const offset = hmac[hmac.length - 1]! & 0xf;
	const bin = ((hmac[offset]! & 0x7f) << 24) | (hmac[offset + 1]! << 16) | (hmac[offset + 2]! << 8) | hmac[offset + 3]!;
	return String(bin % 10 ** digits).padStart(digits, "0");
}

export function totpAt(config: TotpConfig | string, timeMs: number = Date.now()): { code: string; expiresInSec: number } {
	const parsed = typeof config === "string" ? parseTotpInput(config) : config;
	if (!parsed) throw new Error("chave 2FA inválida");
	const key = base32Decode(parsed.secret);
	const step = Math.floor(timeMs / 1000 / parsed.period);
	return {
		code: hotp(key, step, parsed.digits, parsed.algorithm),
		expiresInSec: parsed.period - (Math.floor(timeMs / 1000) % parsed.period),
	};
}
