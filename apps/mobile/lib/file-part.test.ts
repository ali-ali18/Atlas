import { describe, expect, it, vi } from "vitest";

const ctor = vi.fn();
vi.mock("expo-file-system", () => ({
	File: class {
		constructor(uri: string) {
			ctor(uri);
		}
		bytes = async () => new Uint8Array([1, 2, 3]);
	},
}));

import { filePart } from "./file-part";

describe("filePart", () => {
	it("leva nome e tipo do anexo e lê os bytes do uri (file:// ou content://)", async () => {
		const part = filePart({ uri: "content://media/1", name: "foto.jpg", mime: "image/jpeg" });
		expect(ctor).toHaveBeenCalledWith("content://media/1");
		expect(part).toMatchObject({ name: "foto.jpg", type: "image/jpeg" });
		expect([...(await part.bytes())]).toEqual([1, 2, 3]);
	});
});
