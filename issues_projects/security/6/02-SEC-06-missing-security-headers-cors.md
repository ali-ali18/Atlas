# SEC-06: Ausência de Cabeçalhos HTTP de Segurança e CORS Frouxo

- **ID:** `SEC-06`
- **Agravante:** 6 (Médio)
- **Categoria:** Segurança / HTTP Headers / CORS
- **Status:** Aberta para Correção

---

## 1. Arquivos Afetados

- `apps/api/src/index.ts` (linhas 55 a 75)

---

## 2. Descrição Técnica da Falha

1. **Ausência de Cabeçalhos de Segurança (Secure Headers):**
   - A API não retorna os cabeçalhos padrão de endurecimento HTTP recomendados pela OWASP e CIS Benchmarks:
     - `X-Content-Type-Options: nosniff` (impede MIME-sniffing no browser).
     - `X-Frame-Options: DENY` (previne ataques de Clickjacking).
     - `Strict-Transport-Security: max-age=31536000; includeSubDomains` (força HTTPS).
     - `Referrer-Policy: strict-origin-when-cross-origin`.
     - `Content-Security-Policy` (CSP).

2. **CORS com Fallback Frouxo:**
   - Em `apps/api/src/index.ts`:
     ```ts
     const rawCors = process.env.CORS_ORIGIN?.trim();
     const allowedOrigins = rawCors
       ? rawCors.split(",").map((s) => s.trim()).filter(Boolean)
       : ["http://localhost:3000", "http://127.0.0.1:3000"];
     ```
   - Se mal configurado em produção ou se `CORS_ORIGIN` for preenchido com `*`, browsers podem efetuar requisições autenticadas por terceiros sem validação rígida de origem.

---

## 3. Impacto de Negócio e Segurança

- Vulnerabilidade a Clickjacking em interfaces integradas.
- Risco de ataques Cross-Origin caso o CORS seja mal configurado em ambiente de produção.

---

## 4. Bibliotecas Externas Recomendadas

- Middleware nativo **`hono/secure-headers`** (o equivalente ao Helmet do Express para o Hono).

---

## 5. Passos para Validação pelo QA

1. Subir a API.
2. Inspecionar os cabeçalhos de resposta:
   ```bash
   curl -I http://localhost:3001/health
   ```
3. **Comportamento Inseguro Atual:** Apenas headers básicos (`content-type`, `date`) são retornados.
4. **Comportamento Esperado:** Devem estar presentes `x-content-type-options: nosniff`, `x-frame-options: DENY`, `referrer-policy`, etc.

---

## 6. Plano de Ação e Remediação

1. **Registrar `secureHeaders` no Hono:**
   ```ts
   // apps/api/src/index.ts
   import { secureHeaders } from "hono/secure-headers";

   app.use("*", secureHeaders({
     xContentTypeOptions: "nosniff",
     xFrameOptions: "DENY",
     xXssProtection: "1; mode=block",
     strictTransportSecurity: "max-age=31536000; includeSubDomains",
   }));
   ```
2. **Validação Estrita de CORS:**
   - Garantir que origens com `*` sejam proibidas caso cookies ou headers de autorização sejam suportados.
