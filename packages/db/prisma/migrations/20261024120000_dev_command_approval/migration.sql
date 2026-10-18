-- Aprovação de comandos das sessões de código: modo por ambiente (null = padrão da conta), lista liberada
-- de prefixos e padrão da conta. Aditiva: só colunas novas (com padrão ou opcionais).
ALTER TABLE "dev_environments" ADD COLUMN "approvalMode" TEXT;
ALTER TABLE "dev_environments" ADD COLUMN "commandAllowlist" TEXT[] NOT NULL DEFAULT ARRAY['pnpm test', 'pnpm typecheck', 'pnpm lint', 'pnpm build', 'pnpm install', 'pnpm run test', 'pnpm run build', 'pnpm run lint', 'pnpm run typecheck', 'npm test', 'npm run test', 'npm run build', 'npm run lint', 'npm run typecheck', 'npm install', 'npm ci', 'yarn test', 'yarn build', 'yarn lint', 'yarn install', 'git add', 'git commit', 'git switch', 'git fetch']::TEXT[];
ALTER TABLE "user_settings" ADD COLUMN "devApprovalMode" TEXT;
