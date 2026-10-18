import assert from "node:assert/strict";
import { test } from "node:test";
import { createOpenRouterCatalog } from "./openrouter-models.js";

test("A3: validação, contexto e visão compartilham inflight e stale/cooldown", async () => {
    let calls = 0, clock = 0, fail = false;
    const catalog = createOpenRouterCatalog(async () => {
        calls++;
        await Promise.resolve();
        if (fail) throw new Error("offline");
        return Response.json({ data: [{ id: "m", context_length: 128000, architecture: { input_modalities: ["image"] } }] });
    }, () => clock);
    assert.deepEqual(await Promise.all([catalog.isKnownOpenRouterModel("m"), catalog.getOpenRouterContextLength("m"), catalog.supportsImageInput("m")]), [true, 128000, true]);
    assert.equal(calls, 1);
    clock = 3600001; fail = true;
    assert.equal(await catalog.getOpenRouterContextLength("m"), 128000);
    await Promise.all([catalog.isKnownOpenRouterModel("m"), catalog.supportsImageInput("m")]);
    assert.equal(calls, 2);
    clock += 30001; fail = false;
    assert.equal(await catalog.supportsImageInput("m"), true);
    assert.equal(calls, 3);
});

test("capacidades vêm do catálogo; id ausente ou catálogo fora do ar não presume visão", async () => {
    const catalog = createOpenRouterCatalog(async () => Response.json({ data: [
        { id: "a/text", context_length: 8000, architecture: { input_modalities: ["text"] }, supported_parameters: ["temperature"] },
        { id: "a/vis", context_length: 64000, architecture: { input_modalities: ["text", "image", "file"] }, supported_parameters: ["tools"] },
    ] }));
    assert.equal(await catalog.supportsImageInput("a/text"), false);
    assert.equal(await catalog.supportsImageInput("a/vis"), true);
    assert.equal(await catalog.supportsImageInput("a/absent"), false);
    assert.deepEqual((await catalog.catalogInfo("a/vis"))?.supportedParameters, ["tools"]);
    const down = createOpenRouterCatalog(async () => { throw new Error("offline"); });
    assert.equal(await down.supportsImageInput("a/vis"), false);
});
