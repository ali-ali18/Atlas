# Imagens no Motor v4 (F9)

Gerar imagens novas (logo, arte, ilustração) pelo chat, no motor v4 (`packages/agent`, ainda atrás da flag). Paridade com o `generate_image` do legado (`packages/agent-runtime`).

## O que é
- Capacidade lazy `images`: só o índice curto entra no prompt; o schema da tool e as instruções entram ao carregar. "Bom dia" não cresce.
- Tool `generate_image` com `prompt` (obrigatório, até 4000 caracteres), `count` (1 ou 2, padrão 1) e `aspectRatio` (`largura:altura`, ex.: `16:9`). Qualquer outro campo, inclusive `ownerId`, falha com a lista do que é aceito.
- Porta `Images` (`packages/agent/src/ports/images.ts`) e adaptador `createV4Images` (`apps/worker/src/v4-adapters/images.ts`) sobre `packages/llm` (`generateImages`), `packages/files` (`processImageForStorage`) e `packages/db` (`persistUserArtifact`, `persistConversationCardFromEvent`).

## Resultado para o dono
- Cada imagem vira artefato do dono do run, com o mesmo `meta` do legado (origem gerada).
- O chat recebe o evento `images` do legado (`type: "images"`, `origin: "assistant"`, `items` com `artifactId`, `mime`, `width`, `height`), gravado do mesmo jeito. Não existe tipo de card novo para imagem.
- Gerações seguidas saem como eventos `images` seguidos, e o chat as agrupa num baralho só. Por isso a descrição da tool manda fazer todas as chamadas em sequência, sem texto entre elas (com teste de string).
- A resposta da tool diz quantas imagens saíram, os ids e o custo do provedor (ou que ele não informou). Nunca inventa link.

## Aprovação (política v4)
- Efeito `write_external`. A autonomia decide, igual ao legado:
  - Equilibrado (padrão) e Sempre perguntar: cartão de aprovação antes de gerar.
  - Autônomo: gera direto.
- `egress: true`: o prompt sai para o provedor. Com conteúdo não confiável e dado privado lidos no mesmo run, a política pede aprovação.
- Conteúdo não confiável lido no run (página, e-mail) faz a tool pedir aprovação mesmo em Autônomo.
- Sem dono presente (rotina, agenda, subagente, bot a bot), a porta nem é montada no registro: a capacidade fica fora e não aparece no prompt.
- `money` foi descartada de propósito: essa classe pede cartão em qualquer autonomia, o que tiraria do Autônomo o comportamento do legado. Se o dono preferir o cartão sempre, a mudança é o efeito da tool, numa linha.

## Sem modelo de imagem
- O modelo vem do dono (`imageModel` da configuração), ou de `ATLAS_IMAGE_MODEL`, como no legado. Sem chave OpenRouter no run, a capacidade também não recebe o modelo.
- Sem modelo, a tool falha com o erro real e a dica: o modelo deve dizer ao dono, em português, onde configurar (Configurações › Modelos › Modelo para gerar imagens). Nada é gerado.

## Riscos e limites
- **Custo fora do teto do dono.** O custo do provedor é informado na resposta da tool, mas ainda não entra no livro de gasto do motor v4 (o kernel só soma o custo dos modelos de texto). Um teto em US$ não enxerga as imagens. O legado somava o custo nos totais do run. Pendente: a porta de custo do kernel (fora da frente F9).
- **Limite por run.** O legado tinha um teto de imagens por run (`ATLAS_IMAGE_MAX_PER_RUN`, padrão 3). O v4 não tem teto de economia (`00-README`, "sem corte por economia"); o único teto de gasto é o que o dono configurar. A conferência fica no custo, não em contagem.
- **Edição por referência.** Não existe no v4 (nem no legado): o campo não é aceito.
- **Falha do cartão no chat.** A imagem já existe; a falha de gravação do cartão vai ao log e o evento ao vivo sai mesmo assim.

## Testes
- `packages/agent/src/capabilities/images/images-capability.test.ts`: forma da capacidade, política por autonomia e por dono, validação dos args, resultado honesto, escopo do run, e a regra de várias imagens na descrição (string).
- `apps/worker/src/v4-adapters/images.test.ts`: formato exato do evento `images`, gerações seguidas, meta e dono do artefato, outro dono, sem modelo, chave fora do erro, falha do cartão, custo, montagem do registro com e sem dono.
- `presets.test.ts` e `contract-invariants.test.ts`: a porta entra no preset full e a tool está no registro de contrato.
