Object.defineProperties(exports, {
	__esModule: { value: true },
	[Symbol.toStringTag]: { value: "Module" }
});
//#region src/cjs-shim.ts
const CJS_FORMATS = new Set(["cjs", "commonjs"]);
function cjsShim() {
	let config;
	let isCjs;
	return {
		name: "vite-plugin-electron-renderer:cjs-shim",
		apply: "build",
		config: { handler(config) {
			var _config$build, _config$build2;
			config.build ?? (config.build = {});
			(_config$build = config.build).cssCodeSplit ?? (_config$build.cssCodeSplit = false);
			(_config$build2 = config.build).assetsDir ?? (_config$build2.assetsDir = "");
		} },
		configResolved(_config) {
			var _config$build$rolldow;
			config = _config;
			const output = ((_config$build$rolldow = config.build.rolldownOptions) === null || _config$build$rolldow === void 0 ? void 0 : _config$build$rolldow.output) ?? config.build.rollupOptions.output;
			if (output) {
				if (Array.isArray(output) ? output.find((o) => CJS_FORMATS.has(o.format)) : CJS_FORMATS.has(output.format)) isCjs = true;
			}
		},
		transformIndexHtml: {
			order: "pre",
			handler(html) {
				if (!isCjs) return;
				const headRE = /(<\s*?head\s*?>)/;
				const assetsDir = config.build.assetsDir;
				if (assetsDir) {
					const requireIdShim = `<script id="shim-require-id">
; (function () {
  if (typeof require !== 'function') return;
  var Module = require('module');
  var _resolveFilename = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, isMain, options) {
    // "assetsDir" is always at the same level as "index.html"
    var prefix = './';
    if (request.startsWith(prefix)) {
      try {
        // TODO: The way is more elegant.
        var newRequest = request.replace(prefix, ${JSON.stringify(`./${assetsDir}/`)});
        return _resolveFilename.call(this, newRequest, parent, isMain, options);
      } catch (error) { }
    }
    return _resolveFilename.call(this, request, parent, isMain, options);
  };
})();
<\/script>`;
					html = html.replace(headRE, `$1\n${requireIdShim}`);
				}
				html = html.replace(headRE, `$1\n<script id="shim-exports">var exports = typeof module !== 'undefined' ? module.exports : {};<\/script>`);
				return html;
			}
		}
	};
}
//#endregion
exports.default = cjsShim;
