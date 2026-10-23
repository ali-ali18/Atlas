# Fluxo de trabalho (humanos e agentes)

Como uma mudança anda da ideia à `main`. Vale para toda feature e correção. Ordem: análise → plano → implementação → verificação → documentação → auditoria → entrega.

## 1. Análise antes de implementar
- Pese **estabilidade**, escala vertical e horizontal (várias instâncias de api/worker), **desempenho** e **custo** (infra e tokens de LLM).
- **O que pode quebrar:**
  - quem consome o código ou contrato alterado: callers, eventos SSE, tipos em `shared`, API pública, app desktop Tauri, celular;
  - dados que já existem no banco;
  - migrations com api e worker em versões diferentes durante o deploy (compatível para frente e para trás);
  - jobs em andamento;
  - cache;
  - comportamento do bot coberto por replays/evals.
- Liste os riscos no plano ou no PR e cubra os principais com teste de regressão.

## 2. Plano antes de código grande
- Mudança em mais de 3 arquivos, ou de risco (banco, contrato, agente, segurança) → plano curto, aprovado pelo dono, antes do código.
- Plano de fase (`PLANO-*/`): siga o arquivo da fase (ver `00-core.md`).

## 3. Implementação
- **Pequeno e frequente:** um PR por assunto, escopo claro. Nada de acumular dezenas de commits de assuntos diferentes.
- **Reutilizável e pronto para escalar:** pastas fáceis de achar, componentes reaproveitáveis. Regras em `30-componentizacao.md` e `35-componentes.md`.
- **Fora do escopo vira issue no GitHub** (ver `docs/agents/issue-tracker.md`), não conserto no meio do caminho nem TODO solto.

## 4. Verificação (prova de antes e depois)
- Bug → teste que falhava antes e passa agora.
- Desempenho → número medido antes e depois, no PR.
- Comportamento do bot → replay/eval (`packages/evals`).
- Definição de pronto e comandos: `00-core.md` e `50-testes.md`.

## 5. Documentação
- Toda entrega atualiza o `CHANGELOG.md` (formato Keep a Changelog, pt-BR) e a documentação afetada. As seções saem dos tipos do Conventional Commits; `scripts/changelog.mjs` agrupa os commits desde a tag anterior e ajuda a montar a entrada (`node scripts/changelog.mjs --to <tag>`).
- **Implementação grande é documentada:** o que é, o problema, por que existe (justificativa), alternativas descartadas, riscos e custo.
  - Decisão de arquitetura → ADR em `docs/adr/NNNN-<assunto>.md` (próximo número livre; Status, Data, Contexto, Decisão, alternativas, consequências).
  - Feature → `docs/features/<nome>.md` (modelo em `docs/features/README.md`).

## 6. Auditoria independente
Ao finalizar, antes das prévias e do merge:
- Um agente **novo**, modelo Sonnet, **somente leitura**, sem viés.
- Recebe só o pedido original e o diff/branch. **Nunca** a conclusão nem o raciocínio de quem implementou.
- Devolve achados verificados: `arquivo:linha` e o cenário de falha.
- O implementador corrige ou justifica cada achado antes de seguir.

## 7. Entrega
- **Relato honesto:** nunca diga "passou" sem ter rodado. Mostre a saída real e diga o que ficou de fora e por quê.
- **Comunicação com o dono:** resumo em pt-BR simples, sem despejo técnico.
- Mudança visível só é dada como pronta com **prévias**: desktop e celular, tema escuro, no máximo 3 blocos por imagem (MockAtlas + Chromium).
- Cada assunto vai para a `main` no seu próprio PR. **Merge só com o ok do dono**, depois de ele aprovar as prévias.
- **Limpeza:** remova o worktree do agente após o merge e apague os branches de agente antigos.

## Agentes: custo e recursos
- Subagentes no **Sonnet** ou **Haiku** (Haiku para buscas simples), até **3 em paralelo**. **Opus** só com pedido explícito do dono.
- Uma tarefa específica por agente. Nada de auditoria ampla que ninguém pediu.
- Pesquisa e implementação por subagentes em worktree isolado; o orquestrador integra (cherry-pick) no branch do PR e roda a verificação completa.
- **Um processo pesado por vez** (suíte grande, build, install, dev server). Rode pela fila compartilhada, com `flock` num lock comum, por exemplo `flock <caminho-do-lock> pnpm exec turbo typecheck`. Mais de um ao mesmo tempo já derrubou o container.
