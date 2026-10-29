import assert from "node:assert/strict"
import test from "node:test"
import {
	AUTONOMY_DURATION_LABELS,
	AUTONOMY_LEVEL_LABELS,
	AUTONOMY_LEVEL_DESCRIPTIONS,
	API_AUTH_LABEL,
	DEV_APPROVAL_MODE_HELP,
	DEV_APPROVAL_MODE_LABEL,
	DEV_ENV_NETWORK_LABEL,
	DEV_ENV_TIER_LABEL,
	DEV_PR_STATE_LABEL,
	DEV_VERIFIER_HINT,
	DEV_VERIFIER_LABEL,
	DECIDE_FOR_OTHER_BOTS_HINT,
	DECIDE_FOR_OTHER_BOTS_LABEL,
	MAINTENANCE_JOB_LABEL,
	MODEL_TIER_LABELS,
	REFLECTION_FAILURE_LABELS,
	alwaysAllowDetail as sharedAlwaysAllowDetail,
	alwaysAllowLabel as sharedAlwaysAllowLabel,
	ciSummaryText,
	formatIntervalSummary,
	formatOnceSummary,
} from "@workspace/shared"
import { devApprovalOptions } from "../dev-approval-options"
import * as labels from "../shared-labels"
import { loadMessages } from "./messages"
import { UI_LOCALES } from "./locales"
import { createTranslator, defaultTranslator } from "./translator"

const en = createTranslator("en-US", await loadMessages("en-US"))
const es = createTranslator("es-ES", await loadMessages("es-ES"))
const entries = <K extends string>(record: Record<K, string>) => Object.entries(record) as [K, string][]

test("rótulos do shared: no pt-BR o texto é idêntico ao do shared (não há duas verdades)", () => {
	for (const [key, text] of entries(AUTONOMY_LEVEL_LABELS)) assert.equal(labels.autonomyLevelLabel(key, defaultTranslator), text)
	for (const [key, text] of entries(AUTONOMY_LEVEL_DESCRIPTIONS)) assert.equal(labels.autonomyLevelDescription(key, defaultTranslator), text)
	for (const [key, text] of entries(AUTONOMY_DURATION_LABELS)) assert.equal(labels.autonomyDurationLabel(key, defaultTranslator), text)
	for (const [key, text] of entries(DEV_APPROVAL_MODE_LABEL)) assert.equal(labels.devApprovalModeLabel(key, defaultTranslator), text)
	for (const [key, text] of entries(DEV_APPROVAL_MODE_HELP)) assert.equal(labels.devApprovalModeHelp(key, defaultTranslator), text)
	for (const [key, text] of entries(DEV_ENV_TIER_LABEL)) assert.equal(labels.devEnvTierLabel(key, defaultTranslator), text)
	for (const [key, text] of entries(DEV_ENV_NETWORK_LABEL)) assert.equal(labels.devEnvNetworkLabel(key, defaultTranslator), text)
	for (const [key, text] of entries(MODEL_TIER_LABELS)) assert.equal(labels.modelTierLabel(key, defaultTranslator), text)
	for (const [key, text] of entries(DEV_PR_STATE_LABEL)) assert.equal(labels.devPrStateLabel(key, defaultTranslator), text)
	for (const [key, text] of entries(API_AUTH_LABEL)) assert.equal(labels.apiAuthLabel(key, defaultTranslator), text)
	for (const [key, text] of entries(MAINTENANCE_JOB_LABEL)) assert.equal(labels.maintenanceJobLabel(key, defaultTranslator), text)
	for (const [key, text] of entries(REFLECTION_FAILURE_LABELS)) assert.equal(labels.reflectionFailureLabel(key, defaultTranslator), text)
	assert.equal(labels.devVerifierLabel(defaultTranslator), DEV_VERIFIER_LABEL)
	assert.equal(labels.devVerifierHint(defaultTranslator), DEV_VERIFIER_HINT)
	assert.equal(labels.decideForOtherBotsLabel(defaultTranslator), DECIDE_FOR_OTHER_BOTS_LABEL)
	assert.equal(labels.decideForOtherBotsHint(defaultTranslator), DECIDE_FOR_OTHER_BOTS_HINT)
	for (const prefixes of [[], ["pnpm test"], ["pnpm test", "git status"]]) {
		assert.equal(labels.alwaysAllowLabel(prefixes, defaultTranslator), sharedAlwaysAllowLabel(prefixes))
		assert.equal(labels.alwaysAllowDetail(prefixes, defaultTranslator), sharedAlwaysAllowDetail(prefixes))
	}
})

test("resumos de agenda e de verificações batem com o shared no pt-BR", () => {
	const runAt = "2026-10-03T13:00:00.000Z"
	assert.equal(labels.onceSummaryLabel(runAt, "America/Sao_Paulo", defaultTranslator), formatOnceSummary(runAt, "America/Sao_Paulo"))
	assert.equal(labels.onceSummaryLabel("lixo", "America/Sao_Paulo", defaultTranslator), formatOnceSummary("lixo"))
	for (const minutes of [50, 60, 120, 0, -5, Number.NaN]) assert.equal(labels.intervalSummaryLabel(minutes, defaultTranslator), formatIntervalSummary(minutes))
	const checks = [
		{ status: "completed", conclusion: "success" },
		{ status: "completed", conclusion: "failure" },
		{ status: "in_progress", conclusion: null },
	] as const
	for (const list of [[], checks.slice(0, 1), checks.slice(0, 2), checks, [checks[0], checks[0]]]) {
		assert.equal(labels.ciSummaryLabel(list, defaultTranslator), ciSummaryText(list))
	}
})

test("rótulos do shared em outros idiomas", () => {
	assert.equal(labels.autonomyLevelLabel("always_ask", en), "Always ask")
	assert.equal(labels.autonomyLevelLabel("autonomous", es), "Autónomo")
	assert.equal(labels.devEnvTierLabel("medium", en), "Medium · 2.5 GB")
	assert.equal(labels.intervalSummaryLabel(120, en), "Every 2 h")
	assert.equal(labels.onceSummaryLabel("2026-10-03T13:00:00.000Z", "America/Sao_Paulo", en), "Once · 10/03 at 10:00 AM")
	assert.equal(labels.ciSummaryLabel([{ status: "completed", conclusion: "success" }], en), "1 of 1 passed")
})


test("opções do menu de aprovação de comando em en-US", () => {
	assert.deepEqual(devApprovalOptions({ canAlways: true, prefixes: ["pnpm test"] }, en).map((option) => option.label), ["Allow once", "Always in this repository", "Not now"])
	assert.deepEqual(devApprovalOptions({ canAlways: true, prefixes: ["pnpm test"] }).map((option) => option.label), ["Permitir uma vez", "Sempre neste repositório", "Agora não"])
})

test("sharedLabels: nenhum idioma deixa texto vazio", async () => {
	for (const locale of UI_LOCALES) {
		const messages = (await loadMessages(locale)) as Record<string, string>
		for (const [key, value] of Object.entries(messages)) if (key.startsWith("sharedLabels.")) assert.notEqual(value.trim(), "", `${locale}.${key}`)
	}
})
