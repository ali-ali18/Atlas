import { describe, expect, it, vi } from "vitest";
import { ExtractError, assertPublicExtractUrl, isPrivateExtractAddress } from "./extract.js";

/** SSRF: todas as formas de escrever um endereço interno (IPv4, IPv6, IPv4 embutido em IPv6) são bloqueadas. */
const BLOCKED = [
	"127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.0.9", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
	"::", "::1", "fe80::1", "fe80::abcd%eth0", "febf::1", "fec0::1", "fc00::1", "fd12:3456::1", "ff02::1",
	// IPv4 mapeado: pontuado e hexadecimal (é assim que `new URL` normaliza)
	"::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "::ffff:10.0.0.1", "::ffff:a00:1", "::FFFF:C0A8:1",
	// IPv4 compatível e SIIT
	"::127.0.0.1", "::7f00:1", "::a9fe:a9fe", "::ffff:0:127.0.0.1", "::ffff:0:7f00:1", "0:0:0:0:0:ffff:7f00:1", "0000:0000:0000:0000:0000:ffff:7f00:0001",
	// NAT64 e 6to4 com IPv4 interno embutido; NAT64 local sempre
	"64:ff9b::127.0.0.1", "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "64:ff9b:1::1", "2002:7f00:1::", "2002:a9fe:a9fe::1", "2002:c0a8:101::5",
	// Teredo e documentação
	"2001:0:4136:e378:8000:63bf:3fff:fdd2", "2001:db8::1",
	// lixo que não é IP
	"", "not-an-ip", "1.2.3", "999.1.1.1",
];
const PUBLIC = ["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:808:808", "64:ff9b::808:808", "2002:808:808::1"];

describe("isPrivateExtractAddress", () => {
	it.each(BLOCKED)("bloqueia %j", (address) => expect(isPrivateExtractAddress(address)).toBe(true));
	it.each(PUBLIC)("libera %s", (address) => expect(isPrivateExtractAddress(address)).toBe(false));
	it("aceita colchetes", () => expect(isPrivateExtractAddress("[::ffff:7f00:1]")).toBe(true));
});

describe("assertPublicExtractUrl com IP literal (checado antes de conectar)", () => {
	const lookup = vi.fn(async () => ["93.184.216.34"]);
	it.each([
		"http://[::ffff:127.0.0.1]/",
		"http://[::ffff:169.254.169.254]/latest/meta-data/",
		"http://[::ffff:a9fe:a9fe]/",
		"http://[::127.0.0.1]/",
		"http://[64:ff9b::7f00:1]/",
		"http://[2002:7f00:1::]/",
		"http://[fd00::1]/",
		"http://[::1]:8080/",
		"http://2130706433/",
		"http://0x7f.1/",
		"http://127.1/",
		"http://[0:0:0:0:0:ffff:7f00:1]/",
	])("recusa %s sem consultar o DNS", async (url) => {
		await expect(assertPublicExtractUrl(url, lookup)).rejects.toBeInstanceOf(ExtractError);
		expect(lookup).not.toHaveBeenCalled();
	});

	it("recusa nome que resolve (AAAA em hexadecimal) para IPv4 interno mapeado", async () => {
		await expect(assertPublicExtractUrl("https://evil.example.com/", async () => ["::ffff:a9fe:a9fe"])).rejects.toBeInstanceOf(ExtractError);
		await expect(assertPublicExtractUrl("https://evil.example.com/", async () => ["93.184.216.34", "::ffff:7f00:1"])).rejects.toBeInstanceOf(ExtractError);
	});

	it("aceita IP público literal", async () => {
		await expect(assertPublicExtractUrl("http://[2606:4700:4700::1111]/", lookup)).resolves.toBeInstanceOf(URL);
		await expect(assertPublicExtractUrl("http://93.184.216.34/", lookup)).resolves.toBeInstanceOf(URL);
	});
});
