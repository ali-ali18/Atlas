# Anexos no motor v4

- **Status:** em andamento (frente F9, branch `feat/f9-anexos`)
- **Data:** 2026-11-09
- **Issues/PRs:** #

## O que é
O modelo do motor v4 passa a ler os arquivos que o dono enviou na conversa (PDF, Word, planilha, CSV, texto, zip), em partes, e a copiar um deles para o computador do dono para processar com comandos.

## Problema
No motor atual (v2) o modelo já lê anexos com `attachment_read`, `attachment_list` e `attachment_to_computer`. No v4 esses anexos não chegavam ao registro de tools: um pedido "resume o contrato que mandei" não tinha onde pegar o texto.

## Por que existe
A capacidade é lazy (só o índice curto vai ao prompt) e reaproveita o que já existe:
- a leitura pesada (PDF, Office, planilha) e o cache de extração continuam no pool de worker threads do `agent-runtime`, que o processador já monta por run;
- `inspect_file` (arquivos que o próprio bot gera) continua separado: é outro conjunto de arquivos (artefatos do dono, não anexos da conversa).

## Alternativas descartadas
- **Reusar `inspect_file` para anexos:** ele lê arquivo por id do dono, mas não conhece a conversa nem o cache de extração do run, e não lista anexos. Ampliá-lo misturaria dois conjuntos de arquivos com regras de escopo diferentes.
- **Mover a extração para `packages/agent`:** a extração usa o pool de worker threads e as bibliotecas de PDF/Office, que moram no `agent-runtime`. A regra do v4 é que `packages/agent` não importa o `agent-runtime`; a fonte entra por injeção.
- **Mover o leitor de zip para `packages/shared`:** o leitor usa `node:zlib`, e `shared` também é usado pelo front. O leitor foi para `@workspace/files/zip` (só servidor).

## Como funciona
- **Porta** `packages/agent/src/ports/attachments.ts`: `list(ownerId)` e `open(ownerId, id)`. O arquivo aberto traz o conteúdo extraído (texto, tabelas, avisos), os bytes sob demanda e a leitura de zip (listagem e uma entrada).
- **Capacidade** `packages/agent/src/capabilities/attachments/` (lazy, opt-in: só entra com a porta no run):
  - `attachment_list`: anexos da conversa, ou as entradas de um zip/docx/xlsx pelo id. Não extrai nada.
  - `attachment_read`: texto por caractere (`offset`, `length`) ou busca (`find`); planilha e CSV por aba e linha (`sheet`, `start_row`, `rows`); uma entrada de zip (`entry`). Cada parte diz o intervalo, o total e o próximo passo.
  - `attachment_to_computer`: copia o anexo (ou uma entrada) para `anexos/<nome>` no computador do dono, pela porta `Sandbox` com o kind `attachments.copy`. Só entra com computador (VM) no run (`browser`).
- **Adaptador** `apps/worker/src/v4-adapters/attachments.ts`: a porta sobre a fonte do run (`runtime` do processador: lista da conversa e cache de extração) e o leitor de zip de `@workspace/files/zip`. Escopo: o dono e a conversa vêm da montagem do run.
- **Tratador do kind** `apps/worker/src/v4-adapters/sandbox-attachments.ts`: confere o nome (sem `/`, `\`, `..`, controle) e grava com `execWriteFile` da VM. Registrado em `defaultSandboxHandlers` (uma linha).
- **Montagem:** `buildV4Registry` recebe `attachments` (só com dono presente: não entra em rotina nem em run de agenda). `engine-v4` repassa; o processador passa a fonte só quando a conversa tem arquivo (`present`), para que conversa sem anexo não ganhe a linha do índice no prompt.

### Regras de aprovação e riscos
- Tudo é leitura, exceto a cópia para a VM, que é `write_internal` (escrita dentro do computador do dono, sem saída para fora).
- Conteúdo de anexo é `trust: untrusted` com `source: file`: o run fica marcado como lido de fonte não confiável, e o modelo recebe a instrução de tratar o conteúdo como dado.
- `attachment_read` e `attachment_list` são `privateData` (`ownerData: file`). `attachment_to_computer` não é: o resultado é só o caminho.
- Anexo de outro dono ou de outra conversa responde "not found" (o adaptador confere o dono de novo, além da fonte).
- Sem VM, a cópia falha com a frase honesta da porta, e a capacidade nem oferece a tool quando o run não tem computador.
- Zip: listagem e leitura passam pelos limites do leitor (entradas, tamanho descomprimido, razão de compressão). Entrada maior que o teto é recusada, nunca cortada.
- Não cobre (fica para depois): copiar para a sessão de código (`/workspace/anexos`) e anexos de imagem (vão pelo caminho de visão, não por aqui).

## Custo
- Prompt: uma linha do índice (`attachments`) só em conversa com arquivo. Sem arquivo, nada muda; o teste "Bom dia" (`guards/economy.test.ts`) segue verde.
- Tokens: as partes de leitura têm teto (8.000 caracteres de texto, 200 linhas de planilha, 5 MB por entrada de zip).

## Como testar
- `packages/agent/src/capabilities/attachments/attachments-capability.test.ts`: contrato e flags, opt-in no preset, listagem, leitura em partes, busca, planilha, entrada de zip, escopo (usuário B não lê o anexo de A), cópia com nome saneado, falha honesta sem VM.
- `packages/shared/src/attachment-text.test.ts`: busca de posições (função pura).
- `apps/worker/src/v4-adapters/attachments.test.ts`: porta escopada, zip real (montado no teste), limite de entrada, tratador do kind, e o caminho completo pelo `Sandbox` do run.
- `apps/worker/src/v4-adapters/index.test.ts`: a capacidade entra só com dono presente e fonte; sai em rotina e em agenda.
- Guardas: `contract-invariants` (a tool de cópia não declara `privateData`, porque o resultado é só o caminho), `no-behavior-regex` (a busca de texto ficou em `@workspace/shared`, função pura fora da varredura da guarda; ver o relatório).
