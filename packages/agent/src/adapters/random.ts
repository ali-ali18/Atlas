import { randomBytes } from "node:crypto";
import type { Random } from "../ports/random.js";

/** `Random` real: CSPRNG do sistema (o nonce de canal depende de ser imprevisível). */
export function createSystemRandom(): Random {
	return {
		bytes(length) {
			if (!Number.isInteger(length) || length < 0) throw new RangeError("length deve ser um inteiro >= 0");
			return new Uint8Array(randomBytes(length));
		},
	};
}
