import assert from "node:assert/strict";
import test from "node:test";
import { getLanguage, setLanguage, t, translateUi } from "../web/i18n.js";

function element(className = "", attrs: Record<string, string> = {}, children: any[] = []) {
  const node = {
    nodeType: 1, className, attrs, childNodes: children,
    matches(selectors: string) { return selectors.split(",").some((selector) => selector.trim() === `.${className}`); },
    closest(selectors: string) {
      return this.matches(selectors) ? this : this.parentElement?.closest(selectors) || null;
    },
    hasAttribute(name: string) { return Object.hasOwn(this.attrs, name); },
    getAttribute(name: string) { return this.attrs[name]; },
    setAttribute(name: string, value: string) { this.attrs[name] = value; },
    parentElement: null as any,
  };
  for (const child of children) child.parentElement = node;
  return node;
}

function text(value: string) { return { nodeType: 3, nodeValue: value, parentElement: null as any }; }

test("language choice persists and translates UI labels in both directions without changing user text", () => {
  const savedStorage = globalThis.localStorage;
  const savedDocument = globalThis.document;
  const values = new Map<string, string>();
  (globalThis as any).localStorage = { getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value) };
  (globalThis as any).document = { documentElement: { lang: "zh-CN" } };
  try {
    const label = text("设置");
    const message = text("设置");
    const button = element("", { "aria-label": "关闭设置", title: "关闭设置" }, [label]);
    const userMessage = element("_text_1pfhk_1", {}, [message]);
    const root = element("", {}, [button, userMessage]);

    setLanguage("en");
    translateUi(root as unknown as Node);
    assert.equal(getLanguage(), "en");
    assert.equal(values.get("pi-web-language"), "en");
    assert.equal(document.documentElement.lang, "en");
    assert.equal(label.nodeValue, "Settings");
    assert.equal(button.getAttribute("aria-label"), "Close settings");
    assert.equal(message.nodeValue, "设置");
    assert.equal(t("3 条用户消息 · 2 个历史分支节点"), "3 user messages · 2 branch nodes");
    assert.equal(t("typescript · 24 行 · 3 KB · 纯文本模式"), "typescript · 24 lines · 3 KB · Plain text mode");
    assert.equal(t("用户自己输入的内容"), "用户自己输入的内容");

    setLanguage("zh-CN");
    translateUi(root as unknown as Node);
    assert.equal(label.nodeValue, "设置");
    assert.equal(button.getAttribute("aria-label"), "关闭设置");
    assert.equal(message.nodeValue, "设置");
  } finally {
    setLanguage("zh-CN");
    (globalThis as any).localStorage = savedStorage;
    (globalThis as any).document = savedDocument;
  }
});
