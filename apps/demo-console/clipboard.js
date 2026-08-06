(function initAuriClipboard(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AuriClipboard = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createClipboardModule() {
  "use strict";

  async function copyText(content, environment = {}) {
    const root = environment.window || (typeof window !== "undefined" ? window : null);
    const documentRef = environment.document || root?.document;
    const clipboard = environment.clipboard !== undefined
      ? environment.clipboard
      : root?.navigator?.clipboard;
    const secureContext = environment.isSecureContext !== undefined
      ? environment.isSecureContext
      : Boolean(root?.isSecureContext);

    if (secureContext && clipboard?.writeText) {
      try {
        await clipboard.writeText(content);
        return "clipboard";
      } catch (_error) {
        // Browser policy can deny clipboard access even on HTTPS. Fall back
        // to the user-gesture-compatible legacy copy path.
      }
    }

    if (!documentRef?.body || typeof documentRef.execCommand !== "function") {
      throw new Error("浏览器未提供可用的复制能力，请手动选择日志内容");
    }

    const textarea = documentRef.createElement("textarea");
    textarea.value = content;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    textarea.style.pointerEvents = "none";
    documentRef.body.appendChild(textarea);
    textarea.select();
    let copied = false;
    try {
      copied = documentRef.execCommand("copy");
    } catch (_error) {
      throw new Error("浏览器未允许复制，请手动选择日志内容");
    } finally {
      textarea.remove();
    }
    if (!copied) throw new Error("浏览器未允许复制，请手动选择日志内容");
    return "legacy";
  }

  return { copyText };
});
