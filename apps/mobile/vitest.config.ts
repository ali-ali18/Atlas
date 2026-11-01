import { defineConfig } from "vitest/config";

// Lê `@workspace/shared` do código-fonte (condição "react-native" do package.json), como o Metro faz:
// o teste não depende do `dist` estar compilado.
export default defineConfig({ resolve: { conditions: ["react-native"] }, ssr: { resolve: { conditions: ["react-native"] } } });
