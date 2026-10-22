-- Modo de aviso da rotina: "always" (padrão, push a cada execução) ou "important" (o bot decide).
ALTER TABLE "routines" ADD COLUMN "notify" TEXT NOT NULL DEFAULT 'always';
