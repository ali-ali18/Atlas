# Painéis no motor v4

## O que é
Completa a entrega de **painéis** na capacidade lazy `deliverables` do v4 (antes só havia `create_page`). O dono pode pedir, conversando, para listar, ler, alterar, compartilhar por link e desligar o link de um painel. Sem `CapabilityId` novo: as tools entram no `use_capability("deliverables")`; o prompt estável continua só com o índice curto ("Bom dia" intacto).

## Tools (em `packages/agent/src/capabilities-builtin/deliverables/panel-tools.ts`)
| Tool | Efeito | Regra |
|---|---|---|
| `panel_list` | read, dado privado | painéis do bot do run, do dono |
| `panel_read` | read, dado privado | ids dos nós + conteúdo + se o link público está ligado |
| `panel_update` | write_internal | `ops` (patch por id) **ou** `spec` (reescrita); `title`/`summary` soltos. Revisão + 1, mesmo `pageId`; conflito relê e tenta uma vez |
| `panel_share` | public_link, `confirm: "always"` | cria/gira o link público; o dono aprova toda chamada; sem dono presente (agenda, rotina…) a tool fica oculta pelo `decide` |
| `panel_unshare` | write_internal | desliga o link |

Validação com `parsePageSpec`/`parsePagePatchOps`/`applyPagePatch` (shared): campo desconhecido ou spec inválido falha com a lista do aceito. Texto do modelo em inglês; ao dono diz-se "painel".

## Porta e adaptador
- `PageStore` (`packages/agent/src/ports/deliverables.ts`) ganhou `list`, `read`, `update`, `share`, `unshare`; tudo recebe o `userId` do run.
- Adaptador: `apps/worker/src/v4-adapters/deliverables.ts`, sobre `packages/db` (`getPageForUser`, `listBotPagesForUser`, `updatePage`, `page-shares`). Painel de outro dono, de outro bot ou inexistente = `null`/`not_found` (a tool responde "not found").
- Atualizar emite o cartão `page` com `action: "updated"` e o MESMO `pageId` (persistido na conversa e ao vivo): o merge do chat (`collapsePageCards`) troca a revisão no lugar, sem cartão novo.
- `outlinePageSpec` (ids dos nós) saiu do `agent-runtime` para `packages/shared` (com teste); o legado reexporta como `outlinePage`.

## Riscos e decisões
- O endereço do link público é a credencial de leitura: vai só no resumo mostrado ao dono, não no recibo/journal. Exige `ATLAS_URL` no worker; sem ela, falha com o motivo.
- Grupos de painéis (`group` do legado) e o refresh de rotina (`routinePageId`) ficam de fora desta entrega.
- Sem migration.
