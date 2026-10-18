import assert from "node:assert/strict";
import test from "node:test";
import { isBotWorking, setBotWorking, setServerWorking } from "./bot-activity";

test("marca e desmarca o bot como trabalhando, por bot", () => {
	setBotWorking("a", true);
	assert.equal(isBotWorking("a"), true);
	assert.equal(isBotWorking("b"), false);
	setBotWorking("a", false);
	assert.equal(isBotWorking("a"), false);
});

test("ignora id vazio e repetição sem mudança", () => {
	setBotWorking("", true);
	assert.equal(isBotWorking(""), false);
	setBotWorking("c", false);
	assert.equal(isBotWorking("c"), false);
});

test("fonte do servidor e sinal local se somam; um não apaga o outro", () => {
	setServerWorking(["s1", "s2"]);
	setBotWorking("l1", true);
	assert.equal(isBotWorking("s1"), true);
	assert.equal(isBotWorking("l1"), true);
	setServerWorking(["s2"]);
	assert.equal(isBotWorking("s1"), false);
	assert.equal(isBotWorking("l1"), true, "o sinal local continua");
	setBotWorking("l1", false);
	setBotWorking("s2", true);
	setServerWorking([]);
	assert.equal(isBotWorking("s2"), true, "local segue valendo sem o servidor");
	setBotWorking("s2", false);
	assert.equal(isBotWorking("s2"), false);
});
