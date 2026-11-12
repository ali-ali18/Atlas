# Vídeo no v4 (transcrição)

- **Status:** entregue (F9)
- **Data:** 2026-11-09
- **Issues/PRs:** #

## O que é
O bot lê o que é falado num vídeo (YouTube e outros sites que o yt-dlp entende) a partir da legenda, para resumir, citar ou responder perguntas sobre ele.

## Problema
O texto de um vídeo não está na página: ler a página não resume nada. O motor antigo tinha `video_transcript`; o v4 não tinha equivalente.

## Por que existe
Paridade do v4 com o legado, mantendo o contrato (mesma tool, mesmas regras) e a execução dentro da VM do dono (yt-dlp já vem na imagem `docker/agent-sandbox`).

## Alternativas descartadas
- Rodar o yt-dlp no worker: o link do modelo seria aberto fora da VM isolada.
- Importar `@workspace/agent-runtime` no adaptador: proibido pela fronteira do v4. As peças puras (idiomas, escolha do arquivo, comandos de shell, paginação) foram para `packages/shared/src/video-transcript.ts`; o legado passou a importar de lá.

## Como funciona
- Capacidade lazy `video` (`packages/agent/src/capabilities/video/`), uma tool: `video_transcript` com `url`, `lang?`, `offset?`, `limit?` (padrão 12.000, máximo 30.000 caracteres).
- Efeito `read`, `egress` (a VM abre o link escolhido pelo modelo), conteúdo `trust: untrusted`, `source: web`. Sem aprovação própria; a política de egress do run vale como em `browser_open`.
- URL validada na tool e de novo no tratador (`checkPublicHttpUrl`): só http(s), sem credencial, sem localhost, IP privado, link-local ou metadata.
- Paginação: cada parte diz `characters a-b of total` e o `Next offset` com quantos caracteres faltam, ou `End of transcript`. Legenda grande demais para ler inteira é dita ("o fim do vídeo não está no texto"). Nada é cortado em silêncio.
- Porta `Sandbox`: `kind` `video.transcript` (contrato em `capabilities/video/kinds.ts`). O tratador `apps/worker/src/v4-adapters/sandbox-video.ts` roda yt-dlp na VM da conversa (legendas manuais e automáticas), no YouTube cai para `captionTracks` da página, limpa o VTT (`parseVtt`) e guarda o texto 10 min (8 entradas, chave por sessão da VM + link + idiomas), então a parte seguinte não baixa de novo. Texto redigido por `redactSecrets`.
- Registro: `CapabilityId` `video`, `PresetDeps.video: boolean`, ligado em `buildV4Registry` junto com a VM (`input.browser`). Sem VM (`SANDBOX_ENABLED` desligado) a capacidade fica em `unavailable`, dita no log; se a VM falhar ao subir, a tool devolve o erro honesto da porta.
- Sem dono presente (rotina, agenda, subagente): continua disponível, como no legado, porque só lê; o conteúdo volta como dado não confiável.

## Riscos
- O yt-dlp segue redirecionamentos dentro da VM: um site público pode redirecionar a um endereço interno da rede da VM. Mesmo risco do legado; a VM não tem acesso à rede do servidor.
- Vídeos sem legenda falham com erro e dica (oferecer descrição ou comentários).
- Cache em memória do worker: com várias instâncias, a parte seguinte pode cair em outra e baixar de novo (só custo, não erro; a legenda também fica em disco na VM).

## Custo
Sem modelo extra: só o tempo do yt-dlp na VM (até 120 s por download). "Bom dia" não muda (teste de economia: a capacidade só ocupa uma linha do índice).

## Como testar
- `pnpm --filter @workspace/shared test` (peças puras), `pnpm --filter @workspace/agent test` (tool, preset, economia, invariantes).
- Worker: `src/v4-adapters/sandbox-video.test.ts` (manager falso: yt-dlp, fallback, cache, link privado, erro sem VM, segredo redigido).
