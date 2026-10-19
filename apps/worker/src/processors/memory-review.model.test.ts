import assert from "node:assert/strict";
import { test } from "node:test";
import { processMemoryReview } from "./memory-review.js";
import { ATLAS_JOB_NAMES } from "@workspace/shared";
import type { WorkerConfig } from "../config.js";
import { loadWorkerConfig } from "../config.js";

test("L11: revisão usa modelo independente do bot e contabiliza manutenção", async () => {
    const config: WorkerConfig = { redisUrl: "unused", openRouterApiKey: "test", openRouterModel: "expensive", summarizerModel: "cheap", agentRunConcurrency: 1 };
    for (const override of [undefined, "maintenance"]) {
        const requested: string[] = [];
        const result = await processMemoryReview({ name: ATLAS_JOB_NAMES.memoryReview, id: "job", data: { botId: "bot-a", messages: [{ role: "user", content: "oi" }] } },
            { ...config, maintenanceModel: override }, {
                profile: async () => null, bots: async () => [], snapshot: async () => ({ user: { entries: [] }, memory: { entries: [] } }),
                complete: async (input) => { requested.push(input.model); return { model: input.model, message: { role: "assistant", content: "" }, usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, costUsd: 0.001 } }; },
            });
        assert.deepEqual(requested, [override ?? "cheap"]);
        assert.deepEqual(result, { saved: 0, maintenance: { model: override ?? "cheap", calls: 1, promptTokens: 10, completionTokens: 2, totalTokens: 12, costUsd: 0.001 } });
    }
});

test("L11: ATLAS_MAINTENANCE_MODEL é aparado e vazio conserva fallback", () => {
    const previous = process.env.ATLAS_MAINTENANCE_MODEL;
    try {
        process.env.ATLAS_MAINTENANCE_MODEL = " maintenance ";
        assert.equal(loadWorkerConfig().maintenanceModel, "maintenance");
        process.env.ATLAS_MAINTENANCE_MODEL = " ";
        assert.equal(loadWorkerConfig().maintenanceModel, undefined);
    } finally {
        if (previous === undefined) delete process.env.ATLAS_MAINTENANCE_MODEL;
        else process.env.ATLAS_MAINTENANCE_MODEL = previous;
    }
});

test("revisão de memória usa a chave Anthropic da conta e registra no diagnóstico", async () => {
    const { createMaintenanceLlm } = await import("../maintenance-llm.js");
    const config: WorkerConfig = { redisUrl: "unused", openRouterApiKey: undefined, openRouterModel: "expensive", summarizerModel: "cheap", agentRunConcurrency: 1 };
    const seen: Array<[string, number]> = [];
    const reports: Array<[string, boolean]> = [];
    const result = await processMemoryReview({ name: ATLAS_JOB_NAMES.memoryReview, id: "job", data: { userId: "u1", botId: "bot-a", messages: [{ role: "user", content: "oi" }] } } as never, config, {
        profile: async () => null, bots: async () => [], snapshot: async () => ({ user: { entries: [] }, memory: { entries: [] } }),
        llm: await createMaintenanceLlm({ kind: "memory-review", config, userId: "u1" }, {
            loadConfig: async () => ({ v: 1, models: { maintenance: "anthropic-direct/claude-x" } }) as never,
            hasKey: async (_user, provider) => provider === "anthropic",
            streams: () => ({
                anthropic: (async (params: { model: string; tools: unknown[] }) => { seen.push([params.model, params.tools.length]); return { model: params.model, message: { role: "assistant", content: "" } }; }) as never,
                opencodeGo: (async () => ({})) as never,
            }),
            record: async (_user, kind, outcome) => void reports.push([kind, outcome.ok]),
        }),
    });
    assert.deepEqual(seen, [["anthropic-direct/claude-x", 1]]);
    assert.deepEqual(reports, [["memory-review", true]]);
    assert.equal(result.saved, 0);
});
