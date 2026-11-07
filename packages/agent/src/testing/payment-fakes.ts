// Fakes de pagamento para teste: VM, cofre de cartões e backend do canal do CVV. SÓ números de teste públicos e CVV fictício.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { SavedCardSecrets } from "@workspace/shared";
import { createCardFill, createCardVaultAdapter, createCvvEscrow, type EscrowBackend, type EscrowSealer } from "../adapters/payment.js";
import type { CardInfo } from "../ports/payment.js";
import type { Sandbox, SandboxAction, SandboxResult } from "../ports/sandbox.js";

/** Número de teste público da Visa e CVV fictício. */
export const TEST_CARD_NUMBER = "4111111111111111";
export const TEST_CVV = "737";
export const TEST_HOLDER = "TESTE DA SILVA";

export const testCardSecrets: SavedCardSecrets = {
	number: TEST_CARD_NUMBER,
	holder: TEST_HOLDER,
	expMonth: 12,
	expYear: 2030,
	billing: { line1: "Rua Teste 1", city: "Sao Paulo", state: "SP", postalCode: "01000-000", country: "BR" },
};

/** VM falsa: guarda as ações recebidas e responde com o que o teste mandar. */
export class FakeCardSandbox implements Sandbox {
	readonly actions: Array<{ userId: string; action: SandboxAction }> = [];
	respond: (action: SandboxAction) => SandboxResult | Promise<SandboxResult> = () => ({ ok: true, data: { state: "paid", orderRef: "PED-1001" } });
	async run(userId: string, action: SandboxAction): Promise<SandboxResult> {
		this.actions.push({ userId, action });
		return this.respond(action);
	}
	async release(): Promise<void> {}
}

export class MemoryEscrowBackend implements EscrowBackend {
	readonly entries = new Map<string, { value: string; expiresAt: number }>();
	now = 1_000_000;
	async set(key: string, value: string, ttlMs: number) {
		this.entries.set(key, { value, expiresAt: this.now + ttlMs });
	}
	async getdel(key: string) {
		const entry = this.entries.get(key);
		this.entries.delete(key);
		return entry && entry.expiresAt > this.now ? entry.value : null;
	}
	async del(key: string) {
		this.entries.delete(key);
	}
}

/** AES-256-GCM com chave de teste, como a caixa de segredos real. */
export function testSealer(): EscrowSealer {
	const key = randomBytes(32);
	return {
		seal(plain) {
			const iv = randomBytes(12);
			const cipher = createCipheriv("aes-256-gcm", key, iv);
			const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
			return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(":");
		},
		open(sealed) {
			try {
				const [, iv, tag, data] = sealed.split(":");
				const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv!, "base64"));
				decipher.setAuthTag(Buffer.from(tag!, "base64"));
				return Buffer.concat([decipher.update(Buffer.from(data!, "base64")), decipher.final()]).toString("utf8");
			} catch {
				return null;
			}
		},
	};
}

/** Cofre de cartões em memória, escopado por dono como o real. */
export function memoryCardVault(cards: Array<{ userId: string; info: CardInfo; secrets: SavedCardSecrets }>) {
	return createCardVaultAdapter({
		meta: async (userId, cardId) => cards.find((c) => c.userId === userId && c.info.id === cardId)?.info ?? null,
		sealed: async (userId, cardId) => {
			const found = cards.find((c) => c.userId === userId && c.info.id === cardId);
			return found ? JSON.stringify(found.secrets) : null;
		},
		open: (sealed) => sealed,
	});
}

export function paymentRig(owner = "owner-1") {
	const info: CardInfo = { id: "card-1", brand: "visa", last4: "1111", label: "Visa final 1111" };
	const sandbox = new FakeCardSandbox();
	const backend = new MemoryEscrowBackend();
	const escrow = createCvvEscrow(backend, testSealer());
	const vault = memoryCardVault([{ userId: owner, info, secrets: testCardSecrets }]);
	const fill = createCardFill({ vault, escrow, sandbox });
	return { info, sandbox, backend, escrow, vault, fill };
}
