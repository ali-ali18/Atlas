import assert from "node:assert/strict";
import { test } from "node:test";
import { toEnvelopeGithub, toEnvelopeGeneric } from "./normalize.js";

test("toEnvelopeGeneric: idempotencyKey usa header quando presente", () => {
	const envelope = toEnvelopeGeneric({
		hookKey: "abc",
		payload: { a: 1 },
		headers: { "x-atlas-idempotency-key": "idem-1" },
		rawBody: "{}",
	});
	assert.equal(envelope.idempotencyKey, "idem-1");
	assert.equal(envelope.provider, "generic");
});

test("toEnvelopeGithub: pull_request opened vira envelope com dados compactos, nunca o payload cru", () => {
	const payload = {
		action: "opened",
		repository: { full_name: "acme/site" },
		sender: { login: "alisson" },
		pull_request: { number: 3, title: "Fix bug", html_url: "https://github.com/acme/site/pull/3" },
	};
	const envelope = toEnvelopeGithub({
		githubEvent: "pull_request",
		deliveryId: "delivery-123",
		payload,
		rawBody: JSON.stringify(payload),
	});
	assert.ok(envelope);
	assert.equal(envelope?.provider, "github");
	assert.equal(envelope?.type, "pr_opened");
	assert.equal(envelope?.idempotencyKey, "delivery-123");
	assert.equal(envelope?.refs.repo, "acme/site");
	const data = envelope?.payload as { type: string; pr: { number: number } };
	assert.equal(data.type, "pr_opened");
	assert.equal(data.pr.number, 3);
});

test("toEnvelopeGithub: sem X-GitHub-Delivery cai pro hash do body", () => {
	const payload = { repository: { full_name: "acme/site" }, action: "opened", pull_request: {} };
	const envelope = toEnvelopeGithub({
		githubEvent: "pull_request",
		deliveryId: undefined,
		payload,
		rawBody: JSON.stringify(payload),
	});
	assert.ok(envelope?.idempotencyKey);
	assert.notEqual(envelope?.idempotencyKey, "");
});

test("toEnvelopeGithub: evento não suportado retorna null", () => {
	const envelope = toEnvelopeGithub({
		githubEvent: "star",
		deliveryId: "d1",
		payload: {},
		rawBody: "{}",
	});
	assert.equal(envelope, null);
});

test("toEnvelopeGithub: push (voltou ao vocabulário v4) vira envelope com branch/commits/actor=pusher", () => {
	const payload = {
		ref: "refs/heads/main",
		repository: { full_name: "acme/site" },
		sender: { login: "alisson" },
		pusher: { name: "alisson" },
		after: "abcdef1234",
		commits: [{ id: "abcdef1234", message: "fix bug", author: { name: "A" } }],
	};
	const envelope = toEnvelopeGithub({
		githubEvent: "push",
		deliveryId: "delivery-push",
		payload,
		rawBody: JSON.stringify(payload),
	});
	assert.ok(envelope);
	assert.equal(envelope?.type, "push");
	assert.equal(envelope?.refs.repo, "acme/site");
	const data = envelope?.payload as { type: string; actor?: string; push?: { branch: string; commits: number } };
	assert.equal(data.type, "push");
	assert.equal(data.actor, "alisson");
	assert.equal(data.push?.branch, "main");
	assert.equal(data.push?.commits, 1);
});

test("toEnvelopeGithub: push com deleted:true retorna null (deleção de branch nunca vira evento)", () => {
	const payload = {
		ref: "refs/heads/feature-x",
		deleted: true,
		repository: { full_name: "acme/site" },
	};
	const envelope = toEnvelopeGithub({
		githubEvent: "push",
		deliveryId: "delivery-push-2",
		payload,
		rawBody: JSON.stringify(payload),
	});
	assert.equal(envelope, null);
});

test("toEnvelopeGithub: issue_comment (sem PR) saiu do vocabulário v3, retorna null", () => {
	const payload = {
		action: "created",
		repository: { full_name: "acme/site" },
		issue: { number: 1, title: "Bug" },
		comment: { body: "ainda ocorre" },
	};
	const envelope = toEnvelopeGithub({
		githubEvent: "issue_comment",
		deliveryId: "d2",
		payload,
		rawBody: JSON.stringify(payload),
	});
	assert.equal(envelope, null);
});

test("toEnvelopeGithub: issue_comment num PR mapeia pro tipo pr_commented", () => {
	const payload = {
		action: "created",
		repository: { full_name: "acme/site" },
		issue: { number: 7, title: "Fix", pull_request: {} },
		comment: { body: "manda ver" },
	};
	const envelope = toEnvelopeGithub({
		githubEvent: "issue_comment",
		deliveryId: "d3",
		payload,
		rawBody: JSON.stringify(payload),
	});
	assert.equal(envelope?.type, "pr_commented");
});
