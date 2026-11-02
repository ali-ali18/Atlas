const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");

// Expo detecta o monorepo sozinho (watchFolders e nodeModulesPaths): não configure à mão.
const config = getDefaultConfig(__dirname);

// No web o Expo só liga a condição `browser`; o `@workspace/shared` expõe `src` pela condição
// `react-native` (o `dist` pode nem existir). Ligamos também no web, só no Metro do app mobile.
config.resolver.unstable_conditionsByPlatform = {
	...config.resolver.unstable_conditionsByPlatform,
	web: ["browser", "react-native"],
};

// O packages/shared é escrito em ESM de Node: dentro de `src`, os imports relativos levam o
// sufixo `.js` mesmo apontando para arquivos `.ts`. O Metro não faz esse mapeamento, então,
// se o `.js` não existe, tentamos `.ts`/`.tsx`.
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
	const resolve = defaultResolveRequest ?? context.resolveRequest;
	try {
		return resolve(context, moduleName, platform);
	} catch (error) {
		if (!moduleName.startsWith(".") || !moduleName.endsWith(".js")) throw error;
		const base = moduleName.slice(0, -3);
		for (const ext of [".ts", ".tsx"]) {
			try {
				return resolve(context, base + ext, platform);
			} catch {
				// tenta a próxima extensão
			}
		}
		throw error;
	}
};

module.exports = withNativeWind(config, { input: "./global.css" });
