import assert from "node:assert/strict";
import { test } from "node:test";
import { toNetscape } from "./export-cookies.mjs";

test("toNetscape: formato do curl (HttpOnly, subdomínios, sessão)", () => {
	const out = toNetscape([
		{ domain: ".ava.edu", path: "/", secure: true, httpOnly: true, expires: -1, name: "MoodleSession", value: "abc" },
		{ domain: "ava.edu", path: "/x", secure: false, httpOnly: false, expires: 1900000000.5, name: "k", value: "v" },
	]);
	const lines = out.trimEnd().split("\n");
	assert.equal(lines[0], "# Netscape HTTP Cookie File");
	assert.equal(lines[1], "#HttpOnly_.ava.edu\tTRUE\t/\tTRUE\t0\tMoodleSession\tabc");
	assert.equal(lines[2], "ava.edu\tFALSE\t/x\tFALSE\t1900000000\tk\tv");
});
