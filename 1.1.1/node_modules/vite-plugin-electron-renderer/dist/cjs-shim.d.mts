import { Plugin } from "vite";

//#region src/cjs-shim.d.ts
declare function cjsShim(): Plugin;
//#endregion
export { cjsShim as default };