/**
 * Rotas do web que abrem sem sessão. Casamento exato: só `/login` e `/p/<token>` (43 caracteres base64url, o
 * mesmo formato que a API emite). Qualquer outro caminho, inclusive `/p/` sozinho ou `/p/x/y`, continua exigindo login.
 */
const SHARED_PAGE_PATH = /^\/p\/[A-Za-z0-9_-]{43}\/?$/

export function isSharedPagePath(pathname: string): boolean {
  return SHARED_PAGE_PATH.test(pathname)
}

export function isPublicWebPath(pathname: string): boolean {
  return pathname === "/login" || isSharedPagePath(pathname)
}
