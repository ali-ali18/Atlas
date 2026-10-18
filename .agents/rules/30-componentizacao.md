---
description: Componentização e organização de código (camadas, reuso, funções puras, UI)
globs: apps/**/*.ts,apps/**/*.tsx,packages/**/*.ts,packages/**/*.tsx
alwaysApply: false
---

# Componentização e organização

## Camadas (quem pode importar quem)
```
apps/web ─┐
apps/api ─┼─► packages/agent-runtime ─► packages/{llm,sandbox,search,queue,mail}
apps/worker┘          │
                      └─► packages/db ─► packages/shared
packages/ui ─► (só React/estilo; nada de db/api)
```
- `packages/shared`: **tipos, validação e funções puras** (sem I/O, sem Prisma, sem `process.env` em lógica). Regra de negócio testável mora aqui: parse de gatilho, formatadores (`formatOnceSummary`), seleção de instrução etc.
- `packages/db`: acesso a dados. Toda função que lê ou escreve dado de usuário recebe o `userId` (ver `40-seguranca.md`).
- `packages/agent-runtime`: loop do agente, tools, MCP. Recebe as dependências por injeção (`streamChat`, `mcp`, `onEvent`), o que torna tudo testável com mock.
- Apps são finos: rota/processador = parse → chama o pacote → responde.

## Reuso antes de criar
- Procure antes de escrever: `rg "<conceito>" packages/`. Se já existe algo 80% igual, **estenda** (parâmetro, variante) em vez de copiar.
- Padrão novo parecido com um existente → siga o existente. Ex.: gatilho `interval` copia o caminho do `once` em shared, db, queue, api e web.
- Lógica repetida em 2 lugares → extraia para `shared` na hora, com teste.

## Funções e arquivos
- Decisão pura separada do efeito: `planOnceRoutine(runAt, now)` decide, o worker executa. Teste a pura.
- Arquivo novo quando o assunto é novo. **Não** engorde ainda mais o `computer-use.ts` (>4k linhas): tool nova ganha módulo próprio (`src/tools/<nome>.ts`, `src/files/…`) e só é registrada lá.
- Funções pequenas, nomes que dizem a intenção, early return. Sem `any` novo, sem `as unknown as` para calar o tipo.
- Comentários explicam o **porquê** e a restrição não óbvia, no mesmo tom e densidade do arquivo vizinho.

## UI (apps/web + packages/ui)
- Primitivos em `packages/ui/src/components/*` (button, dialog, attachment, sheet, select, tooltip, …). **Use-os.** Não recrie botão, modal ou anexo com `div`.
- Componentes de IA reaproveitáveis em `apps/web/components/ai-elements/*` (attachments, confirm, routines, skills, model-selector).
- Telas em `apps/web/components/ui/templates/template-4/*`. Componente de tela >~250 linhas → extrair subcomponentes na mesma pasta.
- Estado de servidor via `lib/atlas-api.ts` e `use-atlas-chat.ts` (tipos de evento compartilhados com `packages/shared`). Não faça `fetch` solto em componente.
- Estilo: Tailwind + `cn`, variantes com `cva` como em `packages/ui`. Ícones de marca: SVG com `fill="currentColor"`.
- Acessibilidade: botão de ícone tem `aria-label`; modal fecha com Esc e prende o foco (o Dialog do `packages/ui` já faz isso).
