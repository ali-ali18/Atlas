// Importado primeiro pelo cli: ES modules avaliam os imports na ordem, e o `@workspace/db` exige
// `ATLAS_HOOK_PEPPER` (e lê `DATABASE_URL`) assim que é carregado.
const flag = process.argv.indexOf("--env-file");
const envFile = flag >= 0 ? process.argv[flag + 1] : undefined;
if (envFile) process.loadEnvFile(envFile);
process.env.ATLAS_HOOK_PEPPER ??= "eval-harness-pepper";
process.env.SANDBOX_PROFILE_VOLUMES ??= "0"; // perfil efêmero: cada run começa sem cookies nem consentimento do anterior
