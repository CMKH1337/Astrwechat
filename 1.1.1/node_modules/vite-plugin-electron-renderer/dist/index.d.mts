import { Plugin } from "vite";

//#region src/snippets.d.ts
/** Electron Renderer process code snippets */
declare const electronSnippet: string;
//#endregion
//#region src/index.d.ts
interface RendererOptions {
  /**
  * Electron 35+ is required for runtime `require(esm)`.
  * Use this compatibility option for Electron < 35 to pre-build
  * `resolve.*.type = 'esm'` deps to CJS during dev.
  */
  prebuildEsm?: boolean;
  /**
  * Explicitly tell Vite how to load modules, which is very useful for C/C++ and `esm` modules
  *
  * - `type.cjs` loads through `require()` and exposes statically known names when possible
  * - `type.esm` loads through `createRequire()` and exposes statically known names when possible (falls back to dynamic `export *` when introspection fails)
  *
  * Experimental.
  */
  resolve?: {
    [module: string]: {
      type: "cjs" | "esm";
      /**
      * Whether this dependency should be bundled in production builds.
      *
      * Defaults to `true` for `type: 'esm'`, and `false` for `type: 'cjs'`.
      */
      bundle?: boolean; /** Full custom how to generate the shim module */
      build?: (args: {
        cjs: (module: string) => Promise<string>;
        esm: (module: string) => Promise<string>;
      }) => Promise<string>;
    };
  };
}
declare function renderer(options?: RendererOptions): Plugin;
//#endregion
export { RendererOptions, renderer as default, electronSnippet as electron };