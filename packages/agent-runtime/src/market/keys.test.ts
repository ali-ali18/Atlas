import { describe, expect, it, vi } from "vitest";
import { ownerMarketAccess, reportRejectedMarketKey, resolveMarketKeys } from "./keys.js";
import { proposeConnector, type ProposeConnectorDeps } from "../tools/propose-connector.js";

/** Chave da brapi revogada: sem beco sem saída (a conexão vira erro e o cartão de reconexão aparece). */

type Row = { id: string; userId: string; status: string; secretsEnc: string; catalogId: string; name: string; tools: never[]; disabledTools: string[] };
const rows: Row[] = [];
const seal = (key: string) => `sealed:${key}`;
const open = (sealed: string | null | undefined) => ({ apiKey: String(sealed).replace("sealed:", "") });
const getConnection = async (catalogId: string, userId: string) => rows.find((row) => row.catalogId === catalogId && row.userId === userId) ?? null;
const update = vi.fn(async (id: string, patch: { status: "error"; lastError: string }, userId: string) => {
	const row = rows.find((item) => item.id === id && item.userId === userId);
	if (row) row.status = patch.status;
	return row;
});
const deps = { getConnection, update, open };

function seed() {
	rows.length = 0;
	update.mockClear();
	rows.push({ id: "ca", userId: "A", status: "connected", secretsEnc: seal("key-A-000001"), catalogId: "brapi", name: "brapi", tools: [], disabledTools: [] });
	rows.push({ id: "cb", userId: "B", status: "connected", secretsEnc: seal("key-B-000002"), catalogId: "brapi", name: "brapi", tools: [], disabledTools: [] });
}

describe("chave da brapi recusada", () => {
	it("marca só a conexão do dono como erro; o outro usuário não é afetado", async () => {
		seed();
		expect(await reportRejectedMarketKey("A", "key-A-000001", deps)).toBe(true);
		expect(rows.find((row) => row.userId === "A")!.status).toBe("error");
		expect(rows.find((row) => row.userId === "B")!.status).toBe("connected");
		expect(update).toHaveBeenCalledWith("ca", expect.objectContaining({ status: "error" }), "A");
		// resolveMarketKeys passa a devolver "sem chave" (needs_key) para A, e continua entregando a de B
		const boxReady = () => true;
		expect(await resolveMarketKeys("A", { getConnection, boxReady, open })).toEqual({});
		expect(await resolveMarketKeys("B", { getConnection, boxReady, open })).toEqual({ brapi: "key-B-000002" });
	});

	it("o dono A recusado não mexe na conexão do B, mesmo apontando a chave do B", async () => {
		seed();
		expect(await reportRejectedMarketKey("A", "key-B-000002", deps)).toBe(false);
		expect(rows.every((row) => row.status === "connected")).toBe(true);
		expect(await reportRejectedMarketKey("default", "key-A-000001", deps)).toBe(false);
		expect(await reportRejectedMarketKey(undefined, "key-A-000001", deps)).toBe(false);
	});

	it("se o usuário já reconectou com outra chave, a recusa da antiga não derruba a nova", async () => {
		seed();
		rows[0]!.secretsEnc = seal("key-A-novinha");
		expect(await reportRejectedMarketKey("A", "key-A-000001", deps)).toBe(false);
		expect(rows[0]!.status).toBe("connected");
	});

	it("o acesso do dono só reporta quando a leitura volta 'auth' com a chave usada", async () => {
		seed();
		const onRejected = vi.fn(async () => true);
		const access = ownerMarketAccess("A", { resolveKeys: async () => ({ brapi: "key-A-000001" }), onRejected });
		await access.getKeys();
		await access.afterRead({ ok: false, code: "rate_limit" });
		await access.afterRead({ ok: true });
		expect(onRejected).not.toHaveBeenCalled();
		await access.afterRead({ ok: false, code: "auth" });
		expect(onRejected).toHaveBeenCalledWith("A", "key-A-000001");
	});

	it("depois de marcada, propose_connector oferece RECONECTAR a brapi (e para o B, já conectado, não mostra cartão)", async () => {
		seed();
		await reportRejectedMarketKey("A", "key-A-000001", deps);
		const proposeDeps = { listConnections: async (userId: string) => rows.filter((row) => row.userId === userId) } as unknown as ProposeConnectorDeps;
		const ctx = (userId: string) => ({ userId, origin: "chat", runId: "r1", loginAsked: new Set<string>() });
		const a = await proposeConnector({ app: "brapi" }, ctx("A"), proposeDeps);
		expect(a.loginEvent).toMatchObject({ connector: { kind: "native", id: "brapi" } });
		expect(a.summary).toContain("reconnect card");
		const b = await proposeConnector({ app: "brapi" }, ctx("B"), proposeDeps);
		expect(b.loginEvent).toBeUndefined();
		expect(b.summary).toContain("already connected");
	});
});
