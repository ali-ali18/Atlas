import assert from "node:assert/strict"
import { test } from "node:test"

import {
	BOOT_DANCE_AFTER_MS,
	BOOT_MAX_MS,
	BOOT_MIN_DANCE_MS,
	bootAction,
	bootPose,
	isAppReady,
	markAppReady,
	resetAppReadyForTests,
	subscribeAppReady,
} from "./boot-screen"

test("carregou rápido: some sem dançar", () => {
	assert.equal(bootAction(100, true, null), "hide")
	assert.equal(bootAction(BOOT_DANCE_AFTER_MS - 1, true, null), "hide")
})

test("ainda carregando: quadro parado e depois a dança", () => {
	assert.equal(bootAction(100, false, null), "still")
	assert.equal(bootAction(BOOT_DANCE_AFTER_MS, false, null), "dance")
})

test("dançando: só sai após o tempo mínimo", () => {
	const start = 300
	assert.equal(bootAction(start + 100, true, start), "dance")
	assert.equal(bootAction(start + BOOT_MIN_DANCE_MS, true, start), "hide")
	assert.equal(bootAction(start + 5000, false, start), "dance")
})

test("trava de segurança", () => {
	assert.equal(bootAction(BOOT_MAX_MS, false, 300), "hide")
	assert.equal(bootAction(BOOT_MAX_MS, false, null), "hide")
})

test("coreografia: começa feliz no playful, troca de olhos, gira e repete", () => {
	assert.deepEqual(bootPose(0), { state: "playful", expression: "happy", spins: 0 })
	assert.equal(bootPose(900).expression, "surprised")
	assert.equal(bootPose(1600).expression, "squinted")
	assert.equal(bootPose(3100).spins, 1)
	assert.equal(bootPose(5100).state, "excited")
	assert.equal(bootPose(7100).state, "laughing")
	const loop = bootPose(8700 + 10)
	assert.equal(loop.state, "playful")
	assert.equal(loop.spins, 1)
	assert.equal(bootPose(8700 + 3100).spins, 2)
})

test("sinal de pronto avisa os ouvintes uma vez", () => {
	resetAppReadyForTests()
	let calls = 0
	subscribeAppReady(() => calls++)
	assert.equal(isAppReady(), false)
	markAppReady()
	markAppReady()
	assert.equal(isAppReady(), true)
	assert.equal(calls, 1)
})
