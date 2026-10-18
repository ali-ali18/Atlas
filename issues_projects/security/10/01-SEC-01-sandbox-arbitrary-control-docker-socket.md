# SEC-01: Controle Arbitrário do Sandbox e Exposição do Docker Socket do Host

- **ID:** `SEC-01`
- **Agravante:** 10 (Crítico Máximo)
- **Categoria:** Segurança (RCE / SSRF / Container Breakout)
- **Status:** Aberta para Correção

---

## 1. Arquivos Afetados

- `apps/api/src/routes/sandbox.ts`
- `packages/sandbox/src/docker-manager.ts`
- `packages/sandbox/src/control-client.ts`
- `packages/sandbox/src/config.ts`

---

## 2. Descrição Técnica da Falha

Existem três vetores de ataque graves combinados na arquitetura do Sandbox:

1. **SSRF e Acesso Irrestrito à Rede (Server-Side Request Forgery):**
   - O endpoint `POST /v1/sandbox/sessions/:id/navigate` aceita qualquer URL sem sanitização ou validação de destino.
   - O contêiner de sandbox é criado em modo `networkMode: "bridge"`, permitindo comunicação direta com a rede local da empresa/residência, outros contêineres Docker (`redis`, `postgres`, `api`) e serviços de metadados em nuvem (`http://169.254.169.254`).
   - Não há bloqueio contra esquemas perigosos como `file:///`, `gopher://` ou portas administrativas locais.

2. **Injeção de Teclas e Execução Arbitrária de Comandos no Container:**
   - O endpoint `POST /v1/sandbox/sessions/:id/key` aceita qualquer sequência para a ferramenta `xdotool` (ex: `ctrl+alt+t` para abrir emuladores de terminal).
   - O endpoint `POST /v1/sandbox/sessions/:id/type` digita sequências de texto sem restrição no elemento em foco.
   - Comandos de mouse e teclado são passados sem exigir chave ou token de sessão assinado.

3. **Exposição do Socket Docker do Host (RCE / Host Breakout):**
   - A API e o Worker montam diretamente o Docker socket do host (`/var/run/docker.sock` ou `//./pipe/docker_engine`).
   - Se houver qualquer falha ou injeção na aplicação Node.js, qualquer invasor obtém privilégios de `root` no host Docker da máquina física, permitindo subir novos contêineres privilegiados que montam a raiz do sistema operacional hospedeiro (`/` ou `C:\`).

---

## 3. Impacto de Negócio e Segurança

- Tomada de controle do servidor host (Container Escape via Docker Daemon).
- Vazamento de credenciais internas de rede e bancos de dados através de SSRF no browser do Sandbox.
- Execução não autorizada de código remoto (RCE).

---

## 4. Bibliotecas Externas Recomendadas

- **`ssrf-req-filter`** ou **`zod`** com validação estrita de URL e resolução de DNS.
- **`ip-address`** para checagem de faixas privadas (RFC 1918, CGNAT, Loopback).

---

## 5. Passos para Validação pelo QA

1. Subir a API localmente (`pnpm dev`).
2. Criar uma sessão de sandbox via `POST /v1/sandbox/sessions`.
3. Enviar uma requisição de navegação para a porta do Postgres ou Redis interno:
   ```bash
   curl -X POST http://localhost:3001/v1/sandbox/sessions/<session-id>/navigate \
     -H "Content-Type: application/json" \
     -d '{"url": "http://127.0.0.1:5432"}'
   ```
4. **Comportamento Inseguro Atual:** O sandbox tenta resolver e conectar na porta interna do banco.
5. **Comportamento Esperado:** A API deve rejeitar a requisição com `400 Bad Request` indicando que IPs locais/privados são proibidos.

---

## 6. Plano de Ação e Remediação

1. **Validação Estrita de URL:**
   - Permitir estritamente os protocolos `http:` e `https:`.
   - Resolver o DNS da URL antes do envio e verificar se o IP resultante cai em faixas restritas (`127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`).
2. **Isolamento de Rede Docker:**
   - Criar os contêineres sandbox em uma rede Docker isolada (`internal: true`) ou com regras de firewall (`iptables`) impedindo acesso à rede privada e ao host.
3. **Mínimo Privilégio no Docker:**
   - Em produção, nunca montar o Docker socket na API pública; utilizar uma API de orquestração interna dedicada ou instâncias em nuvem descartáveis (ex: Firecracker MicroVMs).
