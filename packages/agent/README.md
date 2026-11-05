# `@workspace/agent` — motor v4 do Atlas

O motor do agente do Atlas, feito para o Atlas e open-source junto com ele (MIT). Não é uma biblioteca genérica para outros produtos. É uma base nova: não importa nada de `@workspace/agent-runtime` (v1/v2/v3), para que o legado possa ser apagado no fim. O plano está em `PLANO-AGENTE-V4/`.

## Estado atual (honesto)

Prontos: as **portas** e as guardas (F1.1) e, na F1.2, as **classes de efeito** e o `defineTool`. O resto abaixo é o desenho, ainda sem código.

| Camada | O que é | Existe? |
|---|---|---|
| `ports/` | interfaces `Llm`, `Store`, `Queue`, `Sandbox`, `Vault`, `Clock`, `Events` | sim |
| `adapters/` | implementações das portas (Prisma, BullMQ, VM, cofre, `packages/llm`) | pasta, sem código |
| `kernel/` | laço, estado do run, checkpoint, compactação | não |
| `contract/` | classes de efeito (`effects.ts`, pronto), política, mandatos, handoff, taint, recibos | parcial (só efeitos) |
| `tools/` | `defineTool`: efeito obrigatório, args validados pelo zod, resultado `ok`/`erro` tipado, `LlmToolSpec` | sim |
| `channels/` | envelopes: fala do usuário, sistema (nonce), dado não confiável | não |
| `capabilities/` | uma pasta por feature (tools + skill + cards + evals) | não |
| `agenda/` | lembrete, vigia, intenção por evento | não |
| `memory/` | perfil, caderno, sessões | não |
| `presets/` | `full` e `minimal` | não |

Tudo de fora entra por porta injetada: o worker monta as implementações reais, o teste monta mocks. Lógica pura compartilhada com o legado vai para `packages/shared`.

## Regras

- **Sem regex em decisão de comportamento.** Parar, promover, entregar ou barrar usa sinal estrutural (estado do run, tools chamadas, campo declarado numa tool), nunca regex sobre texto do usuário ou do modelo.
- **A resposta do modelo nunca é reescrita, descartada nem substituída.**
- **Sem corte de contexto por economia.** Compactação só com a janela quase cheia e de forma restaurável; leitura em partes no lugar de truncar. O único teto de gasto é o que o dono configurar.
- **Toda tool declara uma classe de efeito** (`read`, `draft`, `write_internal`, `write_external`, `send`, `money`, `public_link`, `credential`, `destructive`); a política é a mesma em todas as superfícies.
- **Segredo nunca no contexto do modelo**: só a porta `Vault`, na camada de execução.
- **Nada do dono no código**: sem chave, e-mail, conta ou dado pessoal; exemplos genéricos e trocáveis. A guarda de higiene confere.
- **`process.env` só em `src/adapters/`.**

## Testes

```bash
pnpm --filter @workspace/agent test
pnpm --filter @workspace/agent typecheck
```

- `src/boundary.test.ts`: falha se algo importar `@workspace/agent-runtime` (ou caminho relativo para ele) ou usar `process.env` fora de `adapters/`.
- `src/hygiene.test.ts`: falha se o pacote tiver cara de chave de API, e-mail real ou nome da denylist.
