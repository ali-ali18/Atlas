import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "@/components/ui/templates/template-4/data";
import { applyServerTail } from "./thread-sync";
const user = (id: string, text: string): Message => ({ id, kind: "user", text });
const bot = (id: string, text: string): Message => ({ id, kind: "assistant", text });
const T = "Entendi, obrigado.\nO que você quer testar agora?";
const P = "Não. Eu nunca vi.\n\nTambém não guardei.\n\nTente o quê?";
for (const [name, full] of [["linha", T], ["paragrafo", P]] as const) {
	const segs = full.split(/\n{2,}/).map((s, i) => bot(`db-${i + 2}`, s));
	const lines = full.split("\n").filter(Boolean).map((s, i) => bot(`db-${i + 2}`, s));
	for (const [pn, persisted] of [["seg", segs], ["linhas", lines]] as const) {
		for (const result of [full, null]) {
			for (const runLive of [true, false]) {
				test(`${name}/${pn}/result=${result === null ? "null" : "full"}/live=${runLive}`, () => {
					const live = [user("db-0", "x"), user("msg-1", "Tava testando"), bot("cu-t1", full)];
					const tail = [user("db-0", "x"), user("db-1", "Tava testando"), ...persisted];
					const out = applyServerTail(live, tail, { runLive, resultText: result });
					assert.deepEqual(out.map((m) => m.id), tail.map((m) => m.id));
				});
			}
		}
	}
}
