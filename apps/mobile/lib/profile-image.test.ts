import { describe, expect, it } from "vitest";
import { PROFILE_IMAGE_MAX_BYTES, base64Bytes, centerSquare, fitJpeg, jpegDataUrl } from "./profile-image";

describe("centerSquare", () => {
	it("paisagem, retrato, quadrada e vazia", () => {
		expect(centerSquare(400, 200)).toEqual({ sx: 100, sy: 0, side: 200 });
		expect(centerSquare(200, 400)).toEqual({ sx: 0, sy: 100, side: 200 });
		expect(centerSquare(300, 300)).toEqual({ sx: 0, sy: 0, side: 300 });
		expect(centerSquare(0, 0).side).toBe(1);
	});
});

describe("base64Bytes", () => {
	it("desconta o preenchimento", () => {
		expect(base64Bytes("")).toBe(0);
		expect(base64Bytes("QUJD")).toBe(3);
		expect(base64Bytes("QUI=")).toBe(2);
		expect(base64Bytes("QQ==")).toBe(1);
	});
});

describe("fitJpeg", () => {
	const sized = (bytes: number) => "A".repeat(Math.ceil((bytes * 4) / 3));
	it("usa a primeira qualidade que cabe", () => {
		const tried: number[] = [];
		const url = fitJpeg((quality) => {
			tried.push(quality);
			return quality > 55 ? sized(PROFILE_IMAGE_MAX_BYTES + 1000) : sized(1000);
		});
		expect(tried).toEqual([85, 70, 55]);
		expect(url).toBe(jpegDataUrl(sized(1000)));
		expect(url?.startsWith("data:image/jpeg;base64,")).toBe(true);
	});
	it("nem a menor cabe: null, para avisar em vez de enviar", () => {
		expect(fitJpeg(() => sized(PROFILE_IMAGE_MAX_BYTES * 2))).toBeNull();
	});
	it("codificação vazia não passa", () => {
		expect(fitJpeg(() => "")).toBeNull();
	});
});
