Object.defineProperties(exports, {
	__esModule: { value: true },
	[Symbol.toStringTag]: { value: "Module" }
});
//#region \0rolldown/runtime.js
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));
//#endregion
let node_fs = require("node:fs");
node_fs = __toESM(node_fs, 1);
let node_module = require("node:module");
let node_path = require("node:path");
node_path = __toESM(node_path, 1);
let vite = require("vite");
//#region src/snippets.ts
const PLUGIN_NAME = "vite-plugin-electron-renderer";
const req = (0, node_module.createRequire)(require("url").pathToFileURL(__filename).href);
const IDENTIFIER_RE = /^[$A-Z_][0-9A-Z_$]*$/i;
function staticNamedExports(exportKeys) {
	const bindings = [...new Set(exportKeys)].filter((key) => key !== "default" && key !== "__esModule" && IDENTIFIER_RE.test(key)).map((key, index) => ({
		key,
		binding: `__export_${index}__`
	}));
	if (bindings.length === 0) return "";
	return `${bindings.map(({ binding, key }) => `const ${binding} = _m_[${JSON.stringify(key)}];`).join("\n")}\nexport {\n${bindings.map(({ binding, key }) => `  ${binding} as ${key},`).join("\n")}\n};`;
}
function cjsSnippet(moduleId) {
	try {
		const required = req(moduleId);
		return cjsShimStatic(moduleId, Object.getOwnPropertyNames(required ?? {}));
	} catch {
		return cjsShimFallback(moduleId);
	}
}
/**
* CJS shim with statically known export names.
* Preferred because Rolldown can tree-shake static exports.
*/
function cjsShimStatic(pkg, exportKeys) {
	const named = staticNamedExports(exportKeys);
	return `// [${PLUGIN_NAME}] CJS shim - ${JSON.stringify(pkg)}
// Loaded via require() inside Electron's Node.js runtime.
const _r_ = require;
const _m_ = _r_(${JSON.stringify(pkg)});
export default (_m_?.default ?? _m_);
${named}
`;
}
/**
* CJS shim fallback when we can't introspect the module at build time.
*/
function cjsShimFallback(pkg) {
	return `// [${PLUGIN_NAME}] CJS shim (dynamic) - ${JSON.stringify(pkg)}
const _r_ = require;
const _m_ = _r_(${JSON.stringify(pkg)});
export default (_m_?.default ?? _m_);
export * from ${JSON.stringify(pkg)};
`;
}
/**
* ESM shim for pure-ESM packages.
*
* Emits a `require()`-based wrapper (via `createRequire`) rather than a
* top-level `await import()`. Electron's embedded Node (22+) supports
* `require(esm)`, so this works for ESM packages too and keeps the loader
* synchronous. If we can't introspect the package at build time we fall back
* to a dynamic `export *`.
*/
function esmSnippet(moduleId, root) {
	let named = "";
	try {
		const required = req(moduleId);
		named = staticNamedExports(Object.getOwnPropertyNames(required ?? {}));
	} catch {
		return `// [${PLUGIN_NAME}] ESM shim (dynamic) - ${JSON.stringify(moduleId)}
import { createRequire } from 'node:module';
const req = createRequire(${JSON.stringify(root)});
const _m_ = req(${JSON.stringify(moduleId)});
export default (_m_?.default ?? _m_);
export * from ${JSON.stringify(moduleId)};
`;
	}
	return `// [${PLUGIN_NAME}] ESM shim - ${JSON.stringify(moduleId)}
import { createRequire } from 'node:module';
const req = createRequire(${JSON.stringify(root)});
const _m_ = req(${JSON.stringify(moduleId)});
export default (_m_?.default ?? _m_);
${named}
`;
}
/** Electron Renderer process code snippets */
const electronSnippet = `
const electron = typeof require !== 'undefined'
  // All exports module see https://www.electronjs.org -> API -> Renderer process Modules
  ? (function requireElectron() {
      const avoid_parse_require = require;
      return avoid_parse_require("electron");
    }())
  : (function nodeIntegrationWarn() {
      console.error(\`If you need to use "electron" in the Renderer process, make sure that "nodeIntegration" is enabled in the Main process.\`);
      return {
        // TODO: polyfill
      };
    }());

// Proxy in Worker
let _ipcRenderer;
if (typeof document === 'undefined') {
  // Throws on any access so feature-detection (typeof / 'in' / instanceof)
  // can't be fooled into thinking ipcRenderer is usable inside a Worker.
  _ipcRenderer = new Proxy({}, {
    get() {
      throw new Error(
        'ipcRenderer doesn\\'t work in a Web Worker.\\n' +
        'You can see https://github.com/electron-vite/vite-plugin-electron/issues/69'
      );
    },
  });
} else {
  _ipcRenderer = electron.ipcRenderer;
}

export { electron as default };
export const clipboard = electron.clipboard;
export const contextBridge = electron.contextBridge;
export const crashReporter = electron.crashReporter;
export const ipcRenderer = _ipcRenderer;
export const nativeImage = electron.nativeImage;
export const shell = electron.shell;
export const webFrame = electron.webFrame;
export const deprecate = electron.deprecate;
export const webUtils = electron.webUtils;

// Electron Main process apis
// Using them in the Renderer process will got undefined, which is required by some third-party npm pkgs
${[
	{
		name: "app",
		envs: ["Main"]
	},
	{
		name: "autoUpdater",
		envs: ["Main"]
	},
	{
		name: "BaseWindow",
		envs: ["Main"]
	},
	{
		name: "BrowserView",
		envs: ["Main"],
		deprecated: true
	},
	{
		name: "BrowserWindow",
		envs: ["Main"]
	},
	{
		name: "clipboard",
		envs: ["Main", "Renderer"]
	},
	{
		name: "contentTracing",
		envs: ["Main"]
	},
	{
		name: "crashReporter",
		envs: ["Main", "Renderer"]
	},
	{
		name: "desktopCapturer",
		envs: ["Main"]
	},
	{
		name: "dialog",
		envs: ["Main"]
	},
	{
		name: "globalShortcut",
		envs: ["Main"]
	},
	{
		name: "inAppPurchase",
		envs: ["Main"]
	},
	{
		name: "ipcMain",
		envs: ["Main"]
	},
	{
		name: "Menu",
		envs: ["Main"]
	},
	{
		name: "MessageChannelMain",
		envs: ["Main"]
	},
	{
		name: "MessagePortMain",
		envs: ["Main"]
	},
	{
		name: "nativeImage",
		envs: ["Main", "Renderer"]
	},
	{
		name: "nativeTheme",
		envs: ["Main"]
	},
	{
		name: "net",
		envs: ["Main", "Utility"]
	},
	{
		name: "netLog",
		envs: ["Main"]
	},
	{
		name: "Notification",
		envs: ["Main"]
	},
	{
		name: "parentPort",
		envs: ["Utility"]
	},
	{
		name: "powerMonitor",
		envs: ["Main"]
	},
	{
		name: "powerSaveBlocker",
		envs: ["Main"]
	},
	{
		name: "process",
		envs: ["Main", "Renderer"]
	},
	{
		name: "protocol",
		envs: ["Main"]
	},
	{
		name: "pushNotifications",
		envs: ["Main"]
	},
	{
		name: "safeStorage",
		envs: ["Main"]
	},
	{
		name: "screen",
		envs: ["Main"]
	},
	{
		name: "session",
		envs: ["Main"]
	},
	{
		name: "ShareMenu",
		envs: ["Main"]
	},
	{
		name: "shell",
		envs: ["Main", "Renderer"]
	},
	{
		name: "systemPreferences",
		envs: ["Main", "Utility"]
	},
	{
		name: "TouchBar",
		envs: ["Main"]
	},
	{
		name: "Tray",
		envs: ["Main"]
	},
	{
		name: "utilityProcess",
		envs: ["Main"]
	},
	{
		name: "webContents",
		envs: ["Main"]
	},
	{
		name: "WebContentsView",
		envs: ["Main"]
	},
	{
		name: "webFrameMain",
		envs: ["Main"]
	},
	{
		name: "View",
		envs: ["Main"]
	}
].filter(({ envs }) => envs.length === 1 && envs[0] === "Main").map(({ name }) => `export const ${name} = electron.${name};`).join("\n")}
`.trim();
//#endregion
//#region src/index.ts
const ELECTRON_PATHS = [
	"electron",
	"electron/main",
	"electron/renderer",
	"electron/common",
	"electron/utility"
];
const NODE_BUILTINS = node_module.builtinModules.filter((m) => !m.startsWith("_"));
const ALL_BUILTINS = [
	...ELECTRON_PATHS,
	...NODE_BUILTINS,
	...NODE_BUILTINS.filter((m) => !m.startsWith("node:")).map((m) => `node:${m}`)
];
const CACHE_DIR = "/.vite-electron-renderer";
const BUNDLE_ENTRY_DIR = `${CACHE_DIR}/entries`;
const BUNDLE_OUT_DIR = `${CACHE_DIR}/bundled`;
const BUNDLE_CJS_OUT_DIR = `${CACHE_DIR}/bundled-cjs`;
const TAG = "[electron-renderer]";
const RE_ESCAPE = /[\\^$.*+?()[\]{}|]/g;
const SCRIPT_EXT_RE = /\.[cm]?[jt]sx?(?:[?#].*)?$/;
function renderer(options = {}) {
	return createRenderer(options, false);
}
function createRenderer(options, isWorker) {
	let cacheDir;
	let root;
	let logger;
	let resolvedConfig;
	let isBuild = false;
	const moduleCache = /* @__PURE__ */ new Map();
	const bundledModuleCache = /* @__PURE__ */ new Map();
	const bundledBuildPromises = /* @__PURE__ */ new Map();
	let bundledEntryDir;
	let bundledOutDir;
	let bundledCjsOutDir;
	const resolveOptions = options.resolve ?? {};
	const resolveEntries = Object.entries(resolveOptions);
	const normalizedResolveOptions = new Map(resolveEntries.flatMap(([module, option]) => {
		const normalizedModule = module.startsWith("node:") ? module.slice(5) : module;
		return normalizedModule === module ? [[module, option]] : [[module, option], [normalizedModule, option]];
	}));
	const bundledModuleSet = new Set(resolveEntries.filter(([, option]) => shouldBundleDependency(option)).map(([module]) => module));
	const shimmedModules = [...new Set([...resolveEntries.filter(([, option]) => !shouldBundleDependency(option)).map(([module]) => module), ...ALL_BUILTINS])];
	const resolvedModules = [...new Set([...Object.keys(resolveOptions), ...ALL_BUILTINS])];
	function bundleDependency(source, format = "es") {
		const cacheKey = `${format}:${source}`;
		const outDir = format === "cjs" ? bundledCjsOutDir : bundledOutDir;
		const extension = format === "cjs" ? ".cjs" : ".mjs";
		const cached = bundledModuleCache.get(cacheKey);
		if (cached) return Promise.resolve(cached);
		const pending = bundledBuildPromises.get(cacheKey);
		if (pending) return pending;
		const entryFile = writeGeneratedModule(bundledEntryDir, source, `import * as _m_ from ${JSON.stringify(source)};
export default (_m_?.default ?? _m_);
export * from ${JSON.stringify(source)};
`);
		logger.info(`Bundle resolve dep: ${source} -> ${format}`, { timestamp: true });
		const promise = (0, vite.build)({
			configFile: false,
			root,
			publicDir: false,
			logLevel: "error",
			cacheDir: node_path.default.join(outDir, ".vite"),
			resolve: {
				alias: resolvedConfig.resolve.alias,
				conditions: ["node", ...resolvedConfig.resolve.conditions ?? []]
			},
			build: {
				copyPublicDir: false,
				emptyOutDir: false,
				lib: {
					entry: { [node_path.default.basename(entryFile, ".mjs")]: entryFile },
					formats: [format]
				},
				minify: isBuild,
				modulePreload: false,
				outDir,
				target: "esnext",
				rolldownOptions: {
					external: shimmedModules,
					output: {
						entryFileNames: `[name]${extension}`,
						chunkFileNames: `chunks/[name]-[hash]${extension}`,
						exports: "named"
					}
				}
			}
		}).then(() => {
			const bundledFile = getCacheFile(outDir, source, extension).filename;
			if (!node_fs.default.existsSync(bundledFile)) throw new TypeError(`Missing bundled output for ${JSON.stringify(source)}`);
			bundledModuleCache.set(cacheKey, bundledFile);
			return bundledFile;
		}).catch((error) => {
			const message = error instanceof Error ? error.message : String(error);
			logger.error(`Failed to bundle ${source}: ${message}`, { timestamp: true });
			throw error;
		}).finally(() => {
			bundledBuildPromises.delete(cacheKey);
		});
		bundledBuildPromises.set(cacheKey, promise);
		return promise;
	}
	async function buildSnippet(source) {
		const resolved = normalizedResolveOptions.get(source);
		if (source === "electron") return electronSnippet;
		if (typeof (resolved === null || resolved === void 0 ? void 0 : resolved.build) === "function") {
			logger.info(`Custom build for ${source}`, { timestamp: true });
			return await resolved.build({
				cjs: async (module) => cjsSnippet(module),
				esm: async (module) => esmSnippet(module, root)
			}) ?? `/* ${TAG}: empty */`;
		}
		if (!isBuild && options.prebuildEsm && (resolved === null || resolved === void 0 ? void 0 : resolved.type) === "esm") return cjsSnippet(await bundleDependency(source, "cjs"));
		if ((resolved === null || resolved === void 0 ? void 0 : resolved.type) === "esm") {
			logger.info(`Wrap for ESM dep: ${source}`, { timestamp: true });
			return esmSnippet(source, root);
		}
		if (resolved) logger.info(`Wrap for CJS dep: ${source}`, { timestamp: true });
		return cjsSnippet(source);
	}
	const resolvedModulesRegex = new RegExp(`^(?:${resolvedModules.map((s) => s.replace(RE_ESCAPE, "\\$&")).join("|")})$`);
	const shimmedModulesRegex = new RegExp(`^(?:${shimmedModules.map((s) => s.replace(RE_ESCAPE, "\\$&")).join("|")})$`);
	return {
		name: PLUGIN_NAME,
		enforce: "pre",
		async config(config, env) {
			moduleCache.clear();
			bundledModuleCache.clear();
			bundledBuildPromises.clear();
			isBuild = env.command === "build";
			const partial = {
				base: config.base ?? "./",
				optimizeDeps: { exclude: resolvedModules },
				build: { rolldownOptions: { external: shimmedModules } }
			};
			if (!isWorker) partial.worker = {
				rolldownOptions: { external: shimmedModules },
				plugins: () => [createRenderer(options, true)]
			};
			return partial;
		},
		configResolved(config) {
			cacheDir = node_path.default.dirname(config.cacheDir) + CACHE_DIR;
			bundledEntryDir = node_path.default.dirname(config.cacheDir) + BUNDLE_ENTRY_DIR;
			bundledOutDir = node_path.default.dirname(config.cacheDir) + BUNDLE_OUT_DIR;
			bundledCjsOutDir = node_path.default.dirname(config.cacheDir) + BUNDLE_CJS_OUT_DIR;
			root = config.root;
			resolvedConfig = config;
			logger = (0, vite.createLogger)(config.logLevel ?? "info", { prefix: TAG });
			isBuild = config.command === "build";
		},
		resolveId: {
			order: "pre",
			filter: { id: resolvedModulesRegex },
			async handler(source) {
				if (isBuild && bundledModuleSet.has(source)) return bundleDependency(source);
				const cacheKey = source.startsWith("node:") ? source.slice(5) : source;
				const cached = moduleCache.get(cacheKey);
				if (cached) return cached;
				const resolved = writeGeneratedModule(cacheDir, cacheKey, await buildSnippet(cacheKey));
				moduleCache.set(cacheKey, resolved);
				return resolved;
			}
		},
		transform: {
			order: "post",
			filter: {
				code: [/import/, shimmedModulesRegex],
				id: SCRIPT_EXT_RE
			},
			async handler(code) {
				if (!isBuild) return null;
				const transformed = rewriteStaticImports(code, this.parse(code), new Set(shimmedModules));
				return transformed ? {
					code: transformed,
					map: null
				} : null;
			}
		}
	};
}
function rewriteStaticImports(code, program, externalModules) {
	const rewrites = [];
	for (const node of program.body) {
		if (node.type === "ExpressionStatement" && node.directive && rewrites.length === 0) continue;
		if (node.type !== "ImportDeclaration") break;
		if (externalModules.has(node.source.value)) rewrites.push({
			start: node.start,
			end: node.end,
			replacement: buildRequireImport(node, rewrites.length)
		});
	}
	const dynamicImports = collectDynamicImportExpressions(program);
	for (const dynamicImport of dynamicImports) {
		if (!isStringLiteral(dynamicImport.source)) continue;
		if (!externalModules.has(dynamicImport.source.value)) continue;
		rewrites.push({
			start: dynamicImport.start,
			end: dynamicImport.end,
			replacement: `Promise.resolve().then(() => require(${JSON.stringify(dynamicImport.source.value)}))`
		});
	}
	if (rewrites.length === 0) return null;
	rewrites.sort((a, b) => a.start - b.start);
	let lastIndex = 0;
	let output = "";
	for (const { start, end, replacement } of rewrites) {
		output += code.slice(lastIndex, start);
		output += replacement;
		lastIndex = end;
	}
	output += code.slice(lastIndex);
	return output;
}
function shouldBundleDependency(option) {
	return option.bundle ?? (option.type === "esm" && typeof option.build !== "function");
}
function collectDynamicImportExpressions(program) {
	const dynamicImports = [];
	const stack = [program];
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current || typeof current !== "object") continue;
		if (current.type === "ImportExpression") dynamicImports.push(current);
		for (const value of Object.values(current)) {
			if (!value) continue;
			if (Array.isArray(value)) {
				for (let i = value.length - 1; i >= 0; i -= 1) stack.push(value[i]);
				continue;
			}
			if (typeof value === "object") stack.push(value);
		}
	}
	return dynamicImports;
}
function isStringLiteral(node) {
	return !!node && typeof node === "object" && node.type === "Literal" && typeof node.value === "string";
}
function buildRequireImport(node, index) {
	const source = JSON.stringify(node.source.value);
	if (node.specifiers.length === 0) return `require(${source});`;
	const binding = `__electron_import_${index}__`;
	const lines = [`const ${binding} = require(${source});`];
	for (const specifier of node.specifiers) switch (specifier.type) {
		case "ImportDefaultSpecifier":
			lines.push(`const ${specifier.local.name} = ${binding}?.default ?? ${binding};`);
			break;
		case "ImportNamespaceSpecifier":
			lines.push(`const ${specifier.local.name} = ${binding};`);
			break;
		case "ImportSpecifier":
			lines.push(`const ${specifier.local.name} = ${binding}[${JSON.stringify(specifier.imported.name ?? String(specifier.imported.value))}];`);
			break;
	}
	return lines.join("\n");
}
function writeGeneratedModule(outDir, moduleId, content) {
	const filename = getCacheFile(outDir, moduleId, ".mjs").filename;
	node_fs.default.mkdirSync(node_path.default.dirname(filename), { recursive: true });
	node_fs.default.writeFileSync(filename, content);
	return filename;
}
function getCacheFile(outDir, moduleId, extension) {
	const root = node_path.default.resolve(outDir);
	const safe = moduleId.replaceAll("/", "+").replaceAll(":", "+");
	const filename = node_path.default.resolve(root, `${safe}${extension}`);
	const relativePath = (0, vite.normalizePath)(node_path.default.relative(root, filename));
	if (relativePath === "" || relativePath.startsWith("..") || node_path.default.isAbsolute(relativePath)) throw new TypeError(`Invalid cache file path for ${JSON.stringify(moduleId)}`);
	return {
		filename: (0, vite.normalizePath)(filename),
		relativePath
	};
}
//#endregion
exports.default = renderer;
exports.electron = electronSnippet;
