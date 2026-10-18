import assert from "node:assert/strict";
import { test } from "node:test";

test("A3: GET, validação e peek compartilham uma única consulta pública", async (t) => {
    const previous = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
        calls++;
        await Promise.resolve();
        return Response.json({ data: [{ id: "provider/m", name: "M", context_length: 128000 }] });
    };
    t.after(() => { globalThis.fetch = previous; });
    const { createModelRoutes, isKnownModelId, peekModelContextLength, refreshModelsCache } = await import("./models.js");
    const routes = createModelRoutes();
    refreshModelsCache();
    assert.equal(peekModelContextLength("provider/m"), null);
    const [a, b, known] = await Promise.all([routes.request("/v1/models"), routes.request("/v1/models"), isKnownModelId("provider/m")]);
    assert.equal(a.status, 200); assert.equal(b.status, 200); assert.equal(known, true);
    const payload = await a.json() as {models:Array<{provider:string;vendor:string;capabilities:unknown}>};
    assert.equal(payload.models[0]?.provider, "openrouter");
    assert.equal(payload.models[0]?.vendor, "provider");
    assert.equal(payload.models[0]?.capabilities, "unknown");
    assert.equal(peekModelContextLength("provider/m"), 128000);
    assert.equal(calls, 1);
});

test("A3: sem catálogo válido, GET conserva 502", async () => {
    const { createModelRoutes } = await import("./models.js");
    assert.equal((await createModelRoutes(async () => null).request("/v1/models")).status, 502);
});

test("Imagem: GET /v1/models/image consulta o catálogo filtrado por saída de imagem", async (t) => {
    const previous = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = async (input) => {
        urls.push(String(input));
        return Response.json({ data: [{ id: "bytedance-seed/seedream-4.5", name: "Seedream", architecture: { output_modalities: ["image"] } }] });
    };
    t.after(() => { globalThis.fetch = previous; });
    const { createModelRoutes } = await import("./models.js");
    const response = await createModelRoutes(async () => null).request("/v1/models/image");
    assert.equal(response.status, 200);
    assert.deepEqual(urls, ["https://openrouter.ai/api/v1/models?output_modalities=image"]);
    const payload = await response.json() as { models: Array<{ id: string; outputModalities?: string[] }> };
    assert.equal(payload.models[0]?.id, "bytedance-seed/seedream-4.5");
    assert.deepEqual(payload.models[0]?.outputModalities, ["image"]);
    assert.equal((await createModelRoutes(undefined, async () => null).request("/v1/models/image")).status, 502);
});
