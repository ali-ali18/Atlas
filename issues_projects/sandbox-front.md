# Issues — Front (viewer + criação de sessão)

- [ ] [P1] **ABERTO** — `code` do 503 não é consumido: `apps/web/lib/atlas-api.ts:35-53` (sem campo `code`), `createSandboxSession` (`atlas-api.ts:256-265`) descarta o corpo, catch em `template-4-client.tsx:648-649` só loga. Ligar o `code`: mensagem ao usuário + retry **só** em timeout/503.
- [ ] [P1] **ABERTO** — Retry incondicional do `startSandbox` (`template-4-client.tsx:637-641`): dispara até para erro determinístico (400, Docker desligado), pagando 3s + boot completo à toa. Condicionar ao `code`/503 após o item acima.
- [ ] [P1] **ABERTO** — Front sem timeout: `atlasFetch` (`apps/web/lib/atlas-api.ts:55-74`) não usa `AbortSignal`; POST pendente para sempre com botão em busy. Sugestão: `AbortSignal.timeout` no fetch do sandbox.
- [ ] [P2] **ABERTO** — Sem trava de double-click: 2 cliques antes do re-render = 2 POSTs = 2 containers; o órfão nunca é removido (`hardTtlMs: Infinity` em `apps/api/src/index.ts:117`). Sugestão: `if (sandboxBusy) return`.
- [ ] [P2] **ABERTO** — Stale closure no boot: `active?.conversationId` da closure; trocar de bot durante o boot lembra a sessão na conversa errada (`template-4-client.tsx:642`). Sugestão: capturar `conversationId` no início + guard de unmount.
- [ ] [P2] **ABERTO** — Pior caso ~6min sem feedback (60 tent × ~3s, dobrado pelo retry). Considerar reduzir defaults, expor progresso/cancelamento.
- [ ] [P2] **ABERTO** — Health-poll do viewer mira o alvo errado (`template-4-client.tsx:174-207`): `fetch` no `viewerUrl` (websockify, `no-cors` opaco) em vez do `/health` do control; 30s p/ detectar queda. Divergência possível (control morto × VNC vivo).
- [ ] [P3] **ABERTO** — `getSessionForConversation` no reload não reabre o modal (`template-4-client.tsx:291-310`), divergindo do comentário "Reabre o viewer". Comportamento atual é razoável; corrigir o comentário.

## Já corrigido (referência)

- [x] **FECHADO** — Queda da VM (TTL) volta à tela padrão via health-poll; reconexão reaproveita a sessão.
- [x] **FECHADO** — Roubo de foco do noVNC contido (ref no composer + guarda anti-theft + autofoco).
