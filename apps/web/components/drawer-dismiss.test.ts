import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

test("nenhum Sheet/Dialog do app desliga o toque fora ou o modo modal", () => {
	const files = execFileSync("git", ["ls-files", "--", "components", "app", "hooks"], { cwd: root, encoding: "utf8" })
		.split("\n")
		.filter((f) => /\.tsx$/.test(f) && !/\.test\./.test(f));
	const offenders = files.filter((f) => /disablePointerDismissal|modal=\{false\}/.test(read(f)));
	assert.deepEqual(offenders, []);
});

test("add menu, painel do fluxo e gavetas da lista usam o Sheet (fundo + toque fora fecham)", () => {
	for (const f of [
		"components/ui/templates/template-4/chat-thread/chat-add-menu.tsx",
		"components/ai-elements/login/flow-panel.tsx",
		"components/ui/templates/template-4/mobile-chat-list.tsx",
	]) {
		const src = read(f);
		assert.match(src, /@workspace\/ui\/components\/sheet/, f);
		assert.match(src, /onOpenChange=/, f);
	}
});
