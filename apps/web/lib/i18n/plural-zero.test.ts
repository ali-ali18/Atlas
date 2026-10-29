import assert from "node:assert/strict";
import test from "node:test";

import { githubRepoCountLabel } from "@/components/settings/github-app-state";
import { runsLabel } from "@/components/settings/usage-state";
import { loadMessages } from "./messages";
import { createTranslator } from "./translator";

test("pt-BR: zero usa o plural ('0 repositórios', '0 execuções'); 1 segue no singular", () => {
	assert.equal(githubRepoCountLabel({ repositorySelection: "selected", repoCount: 0 }), "0 repositórios");
	assert.equal(githubRepoCountLabel({ repositorySelection: "selected", repoCount: 1 }), "1 repositório");
	assert.equal(runsLabel(0), "0 execuções");
	assert.equal(runsLabel(1), "1 execução");
});

test("en-US e es-ES: zero também usa o plural", async () => {
	for (const locale of ["en-US", "es-ES"] as const) {
		const translator = createTranslator(locale, await loadMessages(locale));
		assert.match(runsLabel(0, translator), /^0 \w+s$/, locale);
		assert.match(githubRepoCountLabel({ repositorySelection: "selected", repoCount: 0 }, translator), /^0 \S+s$/, locale);
	}
});
