import { describe, expect, it } from "vitest";
import { DEV_APPROVAL_MODE_HELP, DEV_APPROVAL_MODE_LABEL, decideCommand, isFastPathCommand, isSensitiveWrite, riskyReason } from "./dev-command-approval.js";

const auto = (cmd: string, cwd?: string) => decideCommand({ cmd, mode: "auto", allowlist: [], cwd });

const SAFE = [
	"pnpm install",
	"pnpm test && pnpm build",
	"npm ci",
	"git add -A && git commit -m 'feat: x'",
	"git switch -c feat/x",
	"git stash",
	"git reset --hard HEAD~1",
	"git branch -D old",
	"git push origin feat/x",
	"git push -u origin feat/x",
	"git push origin HEAD:feat/x",
	"git -C /workspace/repo push origin feat/x",
	"gh pr create --title t --body b",
	"gh pr view 3",
	"gh api repos/o/r/pulls",
	"gh api -X GET repos/o/r",
	"curl https://example.com/file.json",
	"curl -sSL -o out.tgz https://example.com/a.tgz",
	"curl -X GET https://example.com",
	"wget https://example.com/a.zip",
	"rm -rf node_modules",
	"rm -rf ./dist .next",
	"rm -rf /workspace/repo/build",
	"rm -rf /tmp/work",
	"rm file.txt",
	"docker ps",
	"kubectl get pods",
	"terraform plan",
	"netlify status",
	"npx prisma generate",
	"npx prisma migrate dev",
	"psql -c 'select 1'",
	"cat <<EOF\nhello\nEOF",
	"$CMD --flag",
	"echo $(whoami) | tee >(cat)",
	"npm view left-pad version",
];

const RISKY: Array<[string, string]> = [
	["git push", "sem branch"],
	["git push origin", "sem branch"],
	["git push origin HEAD", "destino"],
	["git push --all origin", "várias"],
	["git push --tags", "várias"],
	["gh pr merge 4 --squash", "pull request"],
	["gh pr close 4", "pull request"],
	["gh release create v1.0.0", "release"],
	["gh repo edit --visibility public", "repositório"],
	["gh repo delete o/r --yes", "repositório"],
	["gh api -X POST repos/o/r/issues", "GitHub"],
	["gh api --method=DELETE repos/o/r/git/refs/heads/x", "GitHub"],
	["gh api repos/o/r/issues -f title=x", "GitHub"],
	["npm publish", "publica"],
	["pnpm publish --no-git-checks", "publica"],
	["yarn publish", "publica"],
	["yarn npm publish", "publica"],
	["docker push img:1", "contêiner"],
	["docker run --rm alpine", "contêiner"],
	["kubectl apply -f x.yaml", "cluster"],
	["terraform apply -auto-approve", "terraform"],
	["terraform destroy", "terraform"],
	["vercel --prod", "vercel"],
	["npx vercel deploy", "vercel"],
	["netlify deploy --prod", "netlify"],
	["fly deploy", "fly"],
	["railway up", "railway"],
	["wrangler deploy", "wrangler"],
	["pnpm exec wrangler publish", "wrangler"],
	["curl -X POST https://x.test/hook", "curl"],
	["curl -XPUT https://x.test/a", "curl"],
	["curl --request DELETE https://x.test/a", "curl"],
	["curl -d 'a=1' https://x.test", "curl"],
	["curl --data-binary @f https://x.test", "curl"],
	["curl -F file=@a https://x.test", "curl"],
	["curl -T a.txt https://x.test/a", "curl"],
	["wget --post-data=a=1 https://x.test", "wget"],
	["rm -rf /var/lib/foo", "fora do projeto"],
	["rm -rf ~/projetos", "fora do projeto"],
	["rm -rf ../outro", "fora do projeto"],
	["rm -rf $HOME/x", "fora do projeto"],
	["rm -R /opt/app", "fora do projeto"],
	["find /var -name '*.log' -delete", "fora do projeto"],
	["chmod -R 777 /etc/foo", "permissões"],
	["chown -R me /srv", "permissões"],
	["psql -c 'DROP TABLE users'", "banco"],
	["mysql -e 'drop database app'", "banco"],
	["psql -c 'TRUNCATE users'", "banco"],
	["prisma migrate reset --force", "prisma"],
	["npx prisma migrate reset", "prisma"],
	["pnpm exec prisma db push --force-reset", "prisma"],
	["bash -c 'git push'", "sem branch"],
	["echo ok && curl -X POST https://x.test", "curl"],
];

describe("modo Automático: o que roda", () => {
	for (const cmd of SAFE) {
		it(`roda: ${cmd.split("\n")[0]}`, () => {
			expect(auto(cmd)).toEqual({ action: "run" });
		});
	}
});

describe("modo Automático: o que pergunta", () => {
	for (const [cmd, hint] of RISKY) {
		it(`pergunta: ${cmd}`, () => {
			const d = auto(cmd);
			expect(d.action).toBe("ask");
			if (d.action === "ask") {
				expect(d.prefixes).toEqual([]);
				expect(["risky", "hard-deny"]).toContain(d.reason);
				expect(d.detail ?? "").not.toBe("");
				if (d.reason === "risky") expect(d.detail).toContain(hint);
			}
		});
	}

	it("push para a branch principal e force push continuam bloqueio fixo", () => {
		for (const cmd of ["git push origin main", "git push origin HEAD:master", "git push --force origin feat", "git push origin --delete feat", "sudo ls", "rm -rf /"]) {
			expect(auto(cmd), cmd).toMatchObject({ action: "ask", reason: "hard-deny" });
		}
	});

	it("push de branch de trabalho roda, sem branch explícita pergunta", () => {
		expect(auto("git push origin feat/login")).toEqual({ action: "run" });
		expect(auto("git push")).toMatchObject({ action: "ask", reason: "risky" });
	});

	it("caminho relativo vale pelo diretório de trabalho da chamada", () => {
		expect(auto("rm -rf build", "/workspace/app")).toEqual({ action: "run" });
		expect(auto("rm -rf build", "/etc")).toMatchObject({ action: "ask", reason: "risky" });
	});

	it("outros modos não mudam: lista liberada ainda pergunta o que não conhece", () => {
		expect(decideCommand({ cmd: "make x", mode: "allowlist", allowlist: [] })).toMatchObject({ action: "ask", reason: "not-allowed" });
		expect(decideCommand({ cmd: "$CMD", mode: "allowlist", allowlist: [] })).toMatchObject({ action: "ask", reason: "unparseable" });
	});
});

describe("riskyReason", () => {
	const NL = String.fromCharCode(10);
	it("comando que não dá para analisar e não esconde nada arriscado roda", () => {
		expect(riskyReason(["cat <<EOF", "x", "EOF"].join(NL))).toBeNull();
		expect(riskyReason("echo $(whoami) | tee >(cat)")).toBeNull();
		expect(decideCommand({ cmd: "$CMD --flag", mode: "auto", allowlist: [] })).toEqual({ action: "run" });
	});
	it("ação arriscada escondida em heredoc, bash -c ou substituição pergunta com a explicação de escondido", () => {
		const heredoc = ["cat <<EOF > deploy.sh", "npm publish", "EOF"].join(NL);
		const substituted = 'bash -c "$(echo npm publish)"';
		const pushHeredoc = ["bash <<EOF", "git push", "EOF"].join(NL);
		for (const cmd of [heredoc, substituted, pushHeredoc, "echo $(git push) | tee >(cat)", "curl -X POST https://x.test <(echo a)"]) {
			expect(riskyReason(cmd), cmd).toContain("escondido");
		}
		expect(riskyReason(heredoc)).toContain("publica um pacote");
		expect(riskyReason(pushHeredoc)).toContain("sem branch");
		// bash -c com texto simples o analisador entende: o motivo vem direto, sem o aviso de escondido.
		expect(riskyReason('bash -c "cd app && npm publish"')).toBe("publica um pacote");
		const decided = decideCommand({ cmd: heredoc, mode: "auto", allowlist: [] });
		expect(decided).toMatchObject({ action: "ask", reason: "risky" });
	});
	it("devolve o motivo em português", () => {
		expect(riskyReason("npm publish")).toBe("publica um pacote");
		expect(riskyReason("ls")).toBeNull();
	});
	it("docker build, buildx e compose não são arriscados por regra (vão ao Verificador)", () => {
		for (const cmd of ["docker build .", "docker buildx build .", "docker compose up"]) expect(riskyReason(cmd), cmd).toBeNull();
		expect(riskyReason("docker run --rm alpine")).toContain("contêiner");
		expect(riskyReason("docker push img:1")).toContain("contêiner");
	});
});

describe("textos do modo Automático", () => {
	it("mantém o rótulo e explica o que ainda pergunta", () => {
		expect(DEV_APPROVAL_MODE_LABEL.auto).toBe("Automático");
		expect(DEV_APPROVAL_MODE_HELP.auto).toContain("Roda tudo sem perguntar");
		expect(DEV_APPROVAL_MODE_HELP.auto).toContain("não têm volta");
	});
});

describe("caminho rápido do Verificador", () => {
	it("só leitura e comandos comuns de desenvolvimento pulam o modelo", () => {
		for (const cmd of ["ls -la", "git status", "git diff HEAD~1", "pnpm install", "pnpm test && pnpm build", "npm ci", "git add -A && git commit -m 'feat: x'", "git switch -c feat/x", "git branch feat/y", "pnpm run lint | tail -5"]) {
			expect(isFastPathCommand(cmd), cmd).toBe(true);
		}
	});
	it("o resto vai ao Verificador", () => {
		for (const cmd of ["git push origin feat/x", "rm -rf node_modules", "git branch -D old", "docker build .", "curl https://example.com", "pnpm test > out.txt", "pnpm publish", "bash -c 'x'", "$CMD", "pnpm test && git push origin feat/x"]) {
			expect(isFastPathCommand(cmd), cmd).toBe(false);
		}
	});
});

describe("caminho rápido: inspeção inofensiva", () => {
	const bs = String.fromCharCode(92);
	it("os dois comandos reais de produção", () => {
		const first = "cd /workspace/agent-bot && echo \"=== mount callback route ===\" && grep -rn \"createDevJobCallbackRoutes" + bs + "|CALLBACK_PATH\" apps/api/src --include=*.ts | grep -v test && echo \"=== x ===\" && sed -n '1,70p' apps/api/src/middleware/auth.ts";
		const second = "cd /workspace/agent-bot/packages/db && cat package.json | sed -n '1,40p'";
		for (const cmd of [first, second]) {
			expect(auto(cmd).action, cmd).toBe("run");
			expect(riskyReason(cmd), cmd).toBeNull();
			expect(isFastPathCommand(cmd), cmd).toBe(true);
		}
	});
	it("builtins e leitura comuns", () => {
		for (const cmd of ["cd /tmp", "pushd /tmp && popd", "echo oi", "printf '%s' oi", "pwd", "true", ":", "test -f a", "[ -f a ]", "which node", "command -v node", "env", "export FOO=bar", "set -e", "set -o pipefail", "set -eu", "sed -n '1,5p' a.ts", "sed -n '$p' a.ts", "sed -n '/x/,/y/p' a.ts", "head -5 a | tail -2 | wc -l", "find . -name '*.ts'", "jq .a x.json", "tree -L 2", "git show HEAD", "git rev-parse HEAD", "rg foo src"]) {
			expect(isFastPathCommand(cmd), cmd).toBe(true);
		}
	});
	it("o que escreve ou executa continua fora", () => {
		for (const cmd of ["sed -i 's/a/b/' x", "sed -n 'w out.txt' x", "sed -n '1,5p;w o' x", "sed 's/a/b/' x", "sed -n -f s.sed x", "echo oi > a.txt", "printf x >> a", "env FOO=1 node x", "env rm -rf x", "export FOO=$(rm x)", "set -x; rm a", "find . -delete", "find . -exec rm {} ;", "command rm x", "cd /tmp && rm -rf x"]) {
			expect(isFastPathCommand(cmd), cmd).toBe(false);
		}
	});
});

describe("escrita sensível (Verificador)", () => {
	it("CI, autenticação, segredos, deploy e fora do projeto vão ao modelo; código comum não", () => {
		for (const path of [".github/workflows/ci.yml", ".env", ".env.production", "src/lib/auth.ts", "package.json", "deploy/Dockerfile", "../outro/a.ts", "/etc/hosts", "~/.ssh/config", "config/permissions.ts", ".husky/pre-commit"]) {
			expect(isSensitiveWrite(path, "x"), path).toBe(true);
		}
		for (const path of ["src/app.ts", "apps/web/components/button.tsx", "README.md", "/workspace/repo/src/a.ts", "/tmp/out.txt"]) {
			expect(isSensitiveWrite(path, "const a = 1;"), path).toBe(false);
		}
	});
	it("texto que afrouxa checagens ou parece levar segredo também vai ao modelo", () => {
		expect(isSensitiveWrite("src/a.test.ts", "it.skip('x', () => {})")).toBe(true);
		expect(isSensitiveWrite("scripts/run.sh", "git commit --no-verify")).toBe(true);
		expect(isSensitiveWrite("src/a.ts", "const t = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'", "const t = '[redigido]'")).toBe(true);
		expect(isSensitiveWrite("src/a.ts", "ok", "ok")).toBe(false);
	});
});
