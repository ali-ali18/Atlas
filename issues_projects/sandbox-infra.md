# Issues — Infra / housekeeping

- [ ] [P2] **ABERTO** — Reaper nunca remove do disco (`hardTtlMs: POSITIVE_INFINITY`, `apps/api/src/index.ts:117`): órfãos acumulam. Definir hard TTL finito ou GC manual.
- [ ] [P3] **ABERTO** — Rodar `bash -n docker/agent-sandbox/entrypoint.sh` num Linux/CI (auditoria foi só revisão manual; sem bash disponível no ambiente).
- [ ] [P3] **ABERTO** — `README.md:40` diverge do default real de memória (diz 1024, código usa 2048). Alinhar doc ou default.
