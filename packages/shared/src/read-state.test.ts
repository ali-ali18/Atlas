import { assert } from "vitest";
import { test } from "vitest";
import {
	advanceLastReadAt,
	buildMessageSource,
	computeUnread,
	eventSourceLabel,
	formatSourceMarker,
	hasUnread,
	initialLastReadAt,
	sourcePreviewPrefix,
} from "./read-state.js";

const at = (iso: string) => new Date(`2026-10-30T${iso}:00.000Z`);
const msg = (id: string, role: string, time: string) => ({ id, role, createdAt: at(time) });

test("conta só falas do assistente depois da última leitura", () => {
	const state = computeUnread(
		[msg("a", "assistant", "10:00"), msg("b", "user", "10:05"), msg("c", "assistant", "10:10"), msg("d", "assistant", "10:20"), msg("e", "confirm", "10:30")],
		{ lastReadAt: at("10:05"), manualUnread: false },
	);
	assert.deepEqual(state, { unreadCount: 2, firstUnreadMessageId: "c", manualUnread: false });
});

test("sem linha de leitura nada é não lido; marca manual vale sem mensagens novas", () => {
	assert.equal(computeUnread([msg("a", "assistant", "10:00")], null).unreadCount, 0);
	const manual = computeUnread([], { lastReadAt: at("10:00"), manualUnread: true });
	assert.equal(manual.unreadCount, 0);
	assert.equal(hasUnread(manual), true);
	assert.equal(hasUnread({ unreadCount: 0, manualUnread: false }), false);
});

test("ler é monotônico", () => {
	assert.equal(advanceLastReadAt(at("10:10"), at("10:00")).getTime(), at("10:10").getTime());
	assert.equal(advanceLastReadAt(at("10:00"), at("10:10")).getTime(), at("10:10").getTime());
});

test("backfill: conversa antiga nasce lida, conversa nova nasce com tudo não lido", () => {
	const now = new Date("2026-11-02T12:00:00.000Z");
	const migratedAt = new Date("2026-10-20T00:00:00.000Z");
	assert.equal(initialLastReadAt(new Date("2026-09-01T00:00:00.000Z"), now, migratedAt).getTime(), now.getTime());
	const fresh = new Date("2026-10-30T00:00:00.000Z");
	assert.equal(initialLastReadAt(fresh, now, migratedAt).getTime(), fresh.getTime());
});

test("origem: rotina, lembrete (rotina única e follow-up) e GitHub", () => {
	const created = at("20:00");
	const routine = buildMessageSource({
		runOrigin: "routine",
		runCreatedAt: created,
		routine: { name: "Resumo da agenda e e-mail", triggerType: "cron" },
		routineRun: { triggeredBy: "schedule", scheduledFor: at("20:00") },
	});
	assert.equal(routine?.kind, "routine");
	assert.equal(formatSourceMarker({ ...routine!, at: routine!.at.toISOString() }, "UTC"), "Rotina · Resumo da agenda e e-mail · 20:00");
	const once = buildMessageSource({ runOrigin: "routine", runCreatedAt: created, routine: { name: "Ligar para o João", triggerType: "once" }, routineRun: { triggeredBy: "schedule" } });
	assert.equal(once?.kind, "reminder");
	const followup = buildMessageSource({ runOrigin: "proactive", runCreatedAt: at("09:00"), followup: { note: "Pagar o boleto\n da luz" } });
	assert.deepEqual([followup?.kind, followup?.label], ["reminder", "Pagar o boleto da luz"]);
	const github = buildMessageSource({
		runOrigin: "routine",
		runCreatedAt: created,
		routine: { name: "Revisar PR", triggerType: "event" },
		routineRun: {
			triggeredBy: "event",
			eventJson: { provider: "github", type: "pr_opened", refs: { repo: "org/app" }, payload: { type: "pr_opened", repo: "org/app", pr: { number: 12 } } },
		},
	});
	assert.deepEqual([github?.kind, github?.label], ["github", "PR #12 em org/app"]);
	assert.equal(buildMessageSource({ runOrigin: "chat", runCreatedAt: created }), null);
	assert.equal(eventSourceLabel({ provider: "github", type: "push", payload: { type: "push", repo: "org/app" } })?.label, "push em org/app");
	assert.equal(sourcePreviewPrefix({ kind: "routine", label: "Resumo da agenda" }), "Rotina: Resumo da agenda");
});
