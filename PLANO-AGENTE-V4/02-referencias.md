# Referências: o que copiar dos harnesses abertos

Pesquisa de 05/11/2026. Marcas de confiança:
- **[V]**: lido em doc ou README oficial;
- **[S]**: fonte secundária;
- **[?]**: não confirmado.

| Harness | Ideia que entra no v4 | Onde no v4 |
|---|---|---|
| **OpenCode** (sst/opencode) [V] | Permissão como **dado**: `padrão → allow/ask/deny`, a última regra vence, sobreposição por agente. Plan/Build são **presets de permissão**, não instrução no prompt. Tool ou subagente negado some do menu em vez de falhar. | Política (`03` §4), Código (F8) |
| **DeepSeek Harness** (`dsh`, deepseek-ai/deepseek-harness, MIT) [V/S] | "Tudo é plugin" (modelo, tool pack, sessão, sandbox). **Presets nomeados**, incluindo um *Minimal* (bash + editor) como linha de base. Config de snapshot de transcrição. Code Mode (o modelo escreve um programa que chama tools). Não achamos um harness DeepSeek "só de agente": o que existe é este, usado para código. | Capacidades (`03` §2), preset `minimal` no eval (`04`), Code Mode como experimento em F8 |
| **OpenClaw** (ex-Clawdbot) [V, "2.0" só em fonte S] | Heartbeat virou **job comum** com `activeHours` e contrato `NO_REPLY`/`no_change`. Tool `intent` para **intenção condicionada a evento**. Memória em Markdown: `MEMORY.md` curado sempre carregado + notas diárias pesquisáveis + *flush* antes de compactar + **dreaming** (promove só o que passa frequência, diversidade e fonte confiável). Modos de mensagem no meio do run: steer, followup, collect e interrupt. | Agenda (F4), Memória e sono (F5), steering (F1) |
| **Hermes Agent** (Nous Research, MIT) [V] | Memória **procedural** (skills `SKILL.md`) separada da declarativa. Skills criadas depois de tarefa complexa e refinadas no uso. Busca FTS nas sessões antigas. O ganho de "auto-melhora" **não tem prova pública**: medir antes de confiar. | Skills aprendidas (F5) |
| **Claude Code / Agent SDK** [conhecimento prévio] | **Ganchos** determinísticos (PreToolUse, PostToolUse, Stop, SessionStart, SubagentStop) como lugar único de política. Skills com divulgação progressiva (nome + linha). Subagente com contexto descartável que devolve só o resumo. Todo list como ferramenta de plano. | Ganchos (`03` §2), Pesquisa (F3) |
| **Manus** (blog de context engineering) [V] | Prefixo estável e contexto só de acréscimo. **Mascarar tools em vez de tirar no meio do run**. Sistema de arquivos como memória ilimitada (compressão restaurável). Recitar o objetivo no fim do contexto. **Manter erros no contexto**. | Núcleo (`03` §1), Caderno (F3/F5) |
| **Letta** (MemGPT) [V] | Memória como repositório versionado (diff, rollback). **Sleep-time agents** consolidam fora do caminho quente, disparados por passos ou compactação. "Doctor" de memória (duplicata e custo em tokens). | Sono (F5) |
| **Codex CLI** [conhecimento prévio] | Separar **sandbox** (o que o run pode tocar) de **aprovação** (quando pergunta). | Política (`03` §4) |
| **Vercel Eve** (o "EVA" do dono; ai-sdk.dev/docs/agents/eve) [V] | Checkpoint a cada passo; o run sobrevive a queda e a esperas de dias. **Agêntico ou determinístico por tarefa**, misturável no mesmo run. Canais como primitivo (Slack, WhatsApp, web). Tools por **convenção de arquivo** (`defineTool` com `description`, `inputSchema`, `execute`; nome = arquivo) e instruções em `instructions.md`. Pausa para aprovação e retoma de forma durável. Credenciais ficam no runtime, fora do código do agente. **Troca de provedor em uma linha, fallback e modelo por tarefa.** Testar o comportamento antes e depois de cada mudança. | Capacidades por convenção de pasta (`03` §5), kernel durável (`03` §2), passos determinísticos nas capacidades (ex.: checkout), porta `Llm` com papéis e reserva (`03` §8), matriz de eval por PR (`04`) |

## Síntese em 8 ideias
1. Proatividade é job agendado com contrato silencioso (OpenClaw).
2. Intenção por evento ao lado da intenção por tempo (OpenClaw `intent`).
3. Política é dado mais gancho determinístico, nunca parse de texto (OpenCode, Claude Code, Codex).
4. Prefixo de cache estável: mascarar, não remover (Manus).
5. Memória em camadas: curada sempre carregada, notas pesquisáveis, sessões por FTS e procedural em skills (OpenClaw, Hermes).
6. Consolidar no "sono", atrás de critério estrutural, com proveniência e rollback (Letta, OpenClaw).
7. Subagente com contexto próprio que devolve só o resultado (Claude Code, OpenCode).
8. Preset mínimo e componentes trocáveis para medir o ganho do harness separado do ganho do modelo (dsh).

## Fontes
- https://opencode.ai/docs/agents/
- https://github.com/deepseek-ai/deepseek-harness
- https://docs.openclaw.ai/concepts/agent-loop
- https://docs.openclaw.ai/gateway/heartbeat
- https://docs.openclaw.ai/concepts/memory
- https://github.com/NousResearch/hermes-agent
- https://hermes-agent.nousresearch.com/docs/
- https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
- https://docs.letta.com/guides/agents/architectures/sleeptime
- https://ai-sdk.dev/docs/agents/eve
