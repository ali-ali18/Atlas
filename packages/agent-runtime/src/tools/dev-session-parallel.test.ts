import { describe, expect, it } from "vitest";
import { scheduleIndependentReads } from "../read-execution.js";
import { isParallelDevRead, parallelDevReadKey } from "./dev-session.js";

describe("leituras de código em paralelo", () => {
  it("só ferramentas sem efeito colateral entram", () => {
    for (const name of ["read_file", "grep", "list_files", "dev_environment_get"]) expect(isParallelDevRead(name)).toBe(true);
    for (const name of ["shell", "shell_output", "write_file", "edit_file", "todo_write", "dev_pr_create", "dev_session_start"]) expect(isParallelDevRead(name)).toBe(false);
  });

  it("chave estável e nula para argumentos inválidos", () => {
    expect(parallelDevReadKey("read_file", '{"path":"a","startLine":1}')).toBe(parallelDevReadKey("read_file", '{"startLine":1,"path":"a"}'));
    expect(parallelDevReadKey("read_file", "{nope")).toBeNull();
    expect(parallelDevReadKey("shell", '{"cmd":"pnpm test"}')).toBeNull();
  });

  it("leituras do mesmo passo rodam juntas; escrita é barreira", async () => {
    const calls = [
      { name: "read_file", args: '{"path":"a"}' },
      { name: "grep", args: '{"pattern":"x"}' },
      { name: "list_files", args: "{}" },
      { name: "edit_file", args: '{"path":"a"}' },
      { name: "read_file", args: '{"path":"b"}' },
    ];
    let running = 0;
    let maximum = 0;
    const order: string[] = [];
    await scheduleIndependentReads(calls, (c) => parallelDevReadKey(c.name, c.args), async (c, index) => {
      running += 1;
      maximum = Math.max(maximum, running);
      await new Promise((resolve) => setTimeout(resolve, c.name === "edit_file" ? 1 : 30));
      order.push(`${index}:${c.name}`);
      running -= 1;
    });
    expect(maximum).toBe(3);
    expect(order.indexOf("3:edit_file")).toBe(3);
    expect(order[4]).toBe("4:read_file");
  });
});

describe("paralelismo até 10", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("shell só de leitura (caminho rápido) é concorrente; install/build/test, escrita e background não", () => {
    for (const cmd of ["git status", "git diff --stat", "git log --oneline -5", "ls -la src", "cat package.json", "rg foo src", "grep -rn bar . | head -20", "cd packages/a && ls"]) {
      expect(parallelDevReadKey("shell", JSON.stringify({ cmd }))).not.toBeNull();
    }
    for (const cmd of ["pnpm install", "pnpm test", "pnpm --filter a build", "tsc -p .", "git commit -m x", "echo oi > a.txt", "rm -rf dist", "sed -i s/a/b/ f", "git status && pnpm test", "curl https://x.y", "{bad"]) {
      expect(parallelDevReadKey("shell", JSON.stringify({ cmd }))).toBeNull();
    }
    expect(parallelDevReadKey("shell", JSON.stringify({ cmd: "ls", background: true }))).toBeNull();
    expect(parallelDevReadKey("shell", "{nope")).toBeNull();
    expect(parallelDevReadKey("shell", JSON.stringify({ cmd: 5 }))).toBeNull();
    expect(isParallelDevRead("shell")).toBe(false);
  });

  it("10 leituras do mesmo passo rodam todas juntas", async () => {
    const calls = Array.from({ length: 10 }, (_, i) => ({ name: "read_file", args: JSON.stringify({ path: `f${i}` }) }));
    let running = 0;
    let maximum = 0;
    await scheduleIndependentReads(calls, (c) => parallelDevReadKey(c.name, c.args), async () => {
      running += 1;
      maximum = Math.max(maximum, running);
      await sleep(20);
      running -= 1;
    });
    expect(maximum).toBe(10);
  });

  it("12 leituras: no máximo 10 por vez, escrita é barreira e a ordem é respeitada", async () => {
    const calls = [
      ...Array.from({ length: 12 }, (_, i) => ({ name: i % 3 === 0 ? "grep" : "read_file", args: JSON.stringify({ path: `f${i}`, pattern: `p${i}` }) })),
      { name: "write_file", args: JSON.stringify({ path: "x", content: "y" }) },
      { name: "shell", args: JSON.stringify({ cmd: "git status" }) },
      { name: "shell", args: JSON.stringify({ cmd: "pnpm test" }) },
      { name: "list_files", args: "{}" },
    ];
    let running = 0;
    let maximum = 0;
    const started: number[] = [];
    const finished: number[] = [];
    await scheduleIndependentReads(calls, (c) => parallelDevReadKey(c.name, c.args), async (c, index) => {
      running += 1;
      maximum = Math.max(maximum, running);
      started.push(index);
      await sleep(c.name === "write_file" || c.name === "shell" ? 1 : 15 + (index % 4) * 5);
      finished.push(index);
      running -= 1;
    });
    expect(maximum).toBe(10);
    const write = calls.findIndex((c) => c.name === "write_file");
    // Nada depois da escrita começa antes de ela e todas as leituras anteriores terminarem.
    for (let i = 0; i < write; i++) expect(finished.indexOf(i)).toBeLessThan(finished.indexOf(write));
    for (let i = write + 1; i < calls.length; i++) expect(started.indexOf(i)).toBeGreaterThan(finished.indexOf(write));
    // O "pnpm test" é barreira: o list_files seguinte só começa depois dele; o git status antes dele pode correr junto com leituras só se vier antes.
    const tests = calls.findIndex((c) => c.name === "shell" && c.args.includes("pnpm test"));
    expect(started.indexOf(tests + 1)).toBeGreaterThan(finished.indexOf(tests));
    expect(started.indexOf(tests)).toBeGreaterThan(finished.indexOf(tests - 1));
  });

  it("chamadas idênticas no mesmo passo não correm juntas (a segunda espera a primeira)", async () => {
    const calls = [
      { name: "shell", args: JSON.stringify({ cmd: "git status" }) },
      { name: "shell", args: JSON.stringify({ cmd: "git status" }) },
    ];
    let running = 0;
    let maximum = 0;
    await scheduleIndependentReads(calls, (c) => parallelDevReadKey(c.name, c.args), async () => {
      running += 1;
      maximum = Math.max(maximum, running);
      await sleep(10);
      running -= 1;
    });
    expect(maximum).toBe(1);
  });
});
