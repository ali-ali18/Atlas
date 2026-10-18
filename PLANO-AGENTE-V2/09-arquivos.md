# F9 — O bot gera e devolve arquivos (PDF, Word, Excel, TXT, código…) com prévia e download

**Dono:** Bot C · **Depende de:**
- nada no backend (começa depois da F3);
- a parte web depende de o usuário commitar `template-4/*` (o `assistant-message.tsx` e o `chat-thread.tsx` estão lá);
- o texto do prompt entra na F6.

**Status:** pronta para revisão (9A–9C)

## Pedido do usuário
"Como no Grok": pedir um PDF, Word, Excel, TXT, `.py`… de qualquer tipo, e o bot cria e devolve o arquivo no chat. Usar o componente de anexo:
- `packages/ui/src/components/attachment.tsx` (Attachment, AttachmentMedia, AttachmentTitle, AttachmentDescription, AttachmentActions, AttachmentGroup);
- `apps/web/components/ai-elements/attachments.tsx` (`AttachmentPreview`, `AttachmentInfo`, `AttachmentHoverCard`, `getMediaCategory`).

Referência visual (prints do Grok):
- cartão com ícone por tipo (PDF vermelho, DOCX azul), nome truncado, tamanho e botão de download;
- ao clicar, abre um modal de prévia:
  - DOCX renderizado como documento;
  - PDF com paginação "1 / 5", zoom +/−, download e fechar.

## Diagnóstico
- Já existe a tabela `Artifact` (`schema.prisma`: `runId`, `kind`, `uri`, `metaJson`). Hoje só é usada para screenshots: `packages/db/src/artifacts.ts` grava em `ATLAS_ARTIFACT_DIR` (padrão `tmpdir()/atlas-artifacts/<runId>/<id>.png`), e `loadScreenshotArtifact` checa o dono.
- **Não existe:**
  - tool de gerar arquivo nem de rodar código;
  - bibliotecas `docx`, `exceljs`, pdf, `mammoth` ou `react-pdf` em nenhum `package.json`;
  - Python na imagem do sandbox (`docker/agent-sandbox/Dockerfile`: Chrome, VS Code, Node e Playwright no servidor de controle);
  - rota de download ou prévia de arquivo (só `GET /v1/sandbox/sessions/:id/screenshot`).
- api e worker rodam fora do compose (mesma máquina), então o diretório de artefatos é compartilhado. Na VPS, vão precisar de um volume em comum. Documentar.

## Abordagem
**Renderizador no servidor + uma tool.** O modelo escreve o **conteúdo** (texto, Markdown/HTML ou tabela) e o worker converte para o formato. É mais confiável que o modelo gerar binário e não exige sandbox. A execução de código livre (Python) fica para depois, em 9D.

| Formato pedido | O modelo manda | Conversão |
|---|---|---|
| txt, md, csv, json, py, js, ts, html, yml, sql… (qualquer texto) | `content` (texto) | grava como está; MIME pela extensão |
| docx (Word) | `content` em Markdown (títulos, listas, tabelas, negrito/itálico) | lib `docx` (npm), com um conversor Markdown → docx simples (via `marked` tokens) |
| pdf | `content` em Markdown **ou** HTML + CSS opcional | Markdown → HTML (tema de documento: fonte, margens, tabelas); HTML → PDF pelo **Chromium via Playwright**, no servidor de controle do sandbox (`page.pdf()`) ou num Playwright do worker; A4, com cabeçalho e rodapé opcionais |
| xlsx (Excel) | `sheets: [{ name, columns?, rows: (string\|number\|null)[][] }]` | `exceljs`: cabeçalho em negrito, auto-largura, congelar a 1ª linha; valores que começam com `=` viram fórmula |
| pptx (opcional) | `slides: [{ title, bullets[] }]` | `pptxgenjs` |

## Tarefas

### 9A — Geração e armazenamento (worker, db, agent-runtime)
- [ ] **`packages/db/src/artifacts.ts`:**
  - `persistFileArtifact({ runId, userId, filename, mime, bytes })` → `kind:"file"`, `metaJson { filename, mime, size, format, version }`, arquivo em `<root>/<runId>/<id>.<ext>`;
  - `loadFileArtifact(id, userId)` com a mesma checagem de dono do screenshot;
  - limite de 20 MB;
  - nome sanitizado (sem path, até 120 chars, extensão coerente com o formato).
- [ ] **Novo pacote ou módulo** `packages/agent-runtime/src/files/` (arquivos novos do Bot C):
  - `render.ts`: `renderFile({format, content|sheets|slides, title?, css?}) → {bytes, mime, ext}`, puro exceto o PDF;
  - `markdown-to-docx.ts`, `xlsx.ts`, `pdf.ts` (recebe um `printPdf(html)` injetado).
- [ ] **PDF:** endpoint `POST /pdf` no `docker/agent-sandbox/control/server.mjs` (`page.setContent(html)` + `page.pdf({format:"A4", printBackground:true})`). Esse arquivo é do Bot B: registrar em `REVIEW.md` e fazer a mudança mínima. Alternativa, se o sandbox estiver desligado: `playwright-core` + Chromium no worker. Escolher uma e documentar.
- [ ] **Tool `create_file`:**
  - args `{ filename: string, format?: string (inferido da extensão), content?: string, sheets?: [...], slides?: [...], title?: string, css?: string }`;
  - valida por formato;
  - gera, persiste e emite o evento `file {artifactId, filename, mime, size}`;
  - devolve ao modelo "Arquivo criado: <nome> (<tamanho>)", sem repetir o conteúdo.
- [ ] **Versão:** `create_file` com o mesmo `filename` na mesma conversa cria `version+1` (o cartão mostra "v2"). Pedidos de ajuste ("muda o título do PDF") geram um arquivo novo.
- [ ] **Persistir na conversa:** o evento `file` vira parte da mensagem do assistente, reusando `persistConversationCardFromEvent` (o mesmo caminho dos cards de rotina e questionário), para que o arquivo reapareça ao recarregar a conversa.
- [ ] **Limites:** até 5 arquivos por run. Tamanho do `content` limitado (ex.: 400k chars).

### 9B — API (download e prévia)
- [ ] `GET /v1/files/:id`:
  - devolve o arquivo com `Content-Type` e `Content-Disposition: attachment; filename*=UTF-8''…`;
  - escopado por usuário (dono do run);
  - `?inline=1` usa `inline` (para o PDF no visualizador).
- [ ] `GET /v1/files/:id/preview` → JSON por tipo:
  - docx: `{ kind:"html", html }` via `mammoth` (sanitizado);
  - xlsx: `{ kind:"sheets", sheets:[{name, rows (até 500 linhas)}] }` via `exceljs`;
  - texto e código: `{ kind:"text", text (até 200k), language }`;
  - pdf e imagem: `{ kind:"url", url:"/v1/files/:id?inline=1" }`.
- [ ] Testes de rota: dono consegue baixar; outro usuário recebe 404; headers corretos; prévia de cada tipo.

### 9C — Web (cartão + modal de prévia)
- [ ] **`FileAttachment`**, usando `@workspace/ui/components/attachment`:
  - ícone e cor por categoria: PDF vermelho, DOCX azul, XLSX/CSV verde, PPTX laranja, código `</>`, texto;
  - `AttachmentTitle` com o nome, `AttachmentDescription` com o tamanho (e "v2" quando houver);
  - `AttachmentAction` de download;
  - `AttachmentTrigger` abre a prévia;
  - vários arquivos da mesma mensagem ficam em um `AttachmentGroup`.
- [ ] **Modal de prévia** (Dialog existente em `packages/ui`), com cabeçalho mostrando o nome, a meta ("5 páginas") e os botões de download e fechar:
  - **PDF:** `react-pdf` (pdf.js) com paginação "1 / N" e zoom +/−, como no print;
  - **DOCX:** o HTML do `/preview` em um "papel" centralizado, no tema escuro como no print;
  - **XLSX/CSV:** tabela com abas;
  - **código e texto:** bloco com destaque de sintaxe (reusar o renderer de código que o chat já usa em Markdown) e botão de copiar;
  - **imagem:** `<img>`.
- [ ] Encaixar o componente em `assistant-message.tsx` (template-4) e na hidratação do histórico (`use-atlas-chat.ts`, `lib/atlas-api.ts`, tipo do evento `file`). Reaproveitar `getMediaCategory` e `getAttachmentLabel` de `ai-elements/attachments.tsx`.

### 9D — (depois) Arquivos por código no sandbox
- [ ] Python 3 e as libs (`python-docx`, `openpyxl`, `reportlab`, `matplotlib`, `pandas`) na imagem do sandbox; tool `run_code` + `export_file(path)` para devolver arquivos gerados por script (gráficos, planilhas calculadas).
- [ ] Só depois que 9A–9C estiverem estáveis. É do Bot B (sandbox e loop).

### Prompt (texto para a F6)
"When the user asks for a file (PDF, Word, Excel, CSV, code, text…), call `create_file` — never paste the whole document in chat. Write rich Markdown for docx/pdf (headings, tables), structured `sheets` for xlsx. After creating, reply with one short line; the file card shows the rest. To change a file, create it again with the same filename."

## Testes obrigatórios
- [ ] `renderFile`:
  - txt e `.py` iguais ao conteúdo;
  - docx abre com `mammoth` e contém os títulos e a tabela;
  - xlsx lido de volta pelo `exceljs` com as linhas e a fórmula;
  - pdf com `printPdf` mockado recebe HTML com o conteúdo.
- [ ] Nome sanitizado (sem `../`), limite de tamanho, formato inferido pela extensão.
- [ ] `create_file` emite o evento `file` e persiste o `Artifact` `kind:"file"`. A versão sobe com o mesmo nome.
- [ ] Rotas 9B (dono e outro usuário, headers, prévia por tipo).
- [ ] Replay: "me faz um PDF e um Word do meu PVU com este texto…" → 2 `create_file` (pdf e docx), sem colar o texto na resposta.

## Commits
1. `feat(files): renderizador de arquivos (txt/código, docx, xlsx, pdf)`
2. `feat(agent): tool create_file e artefato de arquivo na conversa`
3. `feat(api): download e prévia de arquivos gerados`
4. `feat(web): cartão de arquivo e modal de prévia (pdf, docx, xlsx, código)`
5. _(9D, depois)_ `feat(sandbox): run_code com Python e export_file`

## Critérios de aceite (`/run`)
- "Gera um PDF e um Word com um resumo do projeto Atlas" → 2 cartões (PDF vermelho, DOCX azul) com tamanho. Clicar no PDF abre a prévia com páginas e zoom; no DOCX, o documento renderizado. O download baixa o arquivo certo, e ele abre no Word e no leitor de PDF.
- "Me dá uma planilha com os preços do MacBook que você achou" → cartão XLSX, e a prévia mostra a tabela.
- "Escreve um script python que renomeia arquivos" → cartão `.py` com prévia colorida.
- Recarregar a conversa: os cartões continuam lá. Outro usuário não baixa o arquivo pelo id.

## Commits feitos
_(preencher)_
