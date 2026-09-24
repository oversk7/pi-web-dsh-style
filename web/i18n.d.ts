export function getLanguage(): "zh-CN" | "en";
export function setLanguage(value: string): void;
export function t<T extends string>(value: T): string;
export function translateUi(root?: Node): void;
export function observeUi(): MutationObserver;
