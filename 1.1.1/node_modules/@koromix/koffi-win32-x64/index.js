let native = null;
let err = null;
if (native == null) {
  try {
    native = require("./win32_x64/koffi.node");
  } catch (e) {
    err = e;
  }
}
if (native == null)
  throw err;
module.exports = native;
