import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { connectorEscrowSealer, openCardSecretsJson, sealCardSecrets } from "./card-seal.js";

const key = randomBytes(32);
const card = { number: "4111111111111111", holder: "TESTE DA SILVA", expMonth: 12, expYear: 2030, billing: { line1: "Rua Teste 1", city: "Sao Paulo", state: "SP", postalCode: "01000-000", country: "BR" } };

describe("selo de cartão", () => {
	it("o texto selado não contém número, nome nem endereço; abre de volta", () => {
		const sealed = sealCardSecrets(card, key);
		for (const secret of ["4111", "TESTE DA SILVA", "Rua Teste"]) assert.ok(!sealed.includes(secret));
		assert.deepEqual(JSON.parse(openCardSecretsJson(sealed, key)), card);
	});
	it("sem chave nada é selado (nunca em claro)", () => {
		const saved = process.env.CONNECTOR_ENCRYPTION_KEY;
		delete process.env.CONNECTOR_ENCRYPTION_KEY;
		try {
			assert.throws(() => sealCardSecrets(card));
		} finally {
			if (saved !== undefined) process.env.CONNECTOR_ENCRYPTION_KEY = saved;
		}
	});
	it("chave errada ou texto adulterado não abre", () => {
		const sealed = sealCardSecrets(card, key);
		assert.throws(() => openCardSecretsJson(sealed, randomBytes(32)));
		const sealer = connectorEscrowSealer(key);
		assert.equal(sealer.open(sealer.seal("x")), "x");
		assert.equal(sealer.open("v1:aaaa:bbbb:cccc"), null);
		assert.equal(connectorEscrowSealer(randomBytes(32)).open(sealer.seal("x")), null);
	});
});
