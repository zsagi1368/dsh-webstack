/**
 * P1 内核增强模块的用户可见文案（W-B-79 双语全覆盖）：会话联网模式标记等。
 * 键集以 `webstack.mode.*` / `webstack.kernel-p1.*` 为前缀；zh/en 键集奇偶
 * 一致性由 tests/kernel-fusion.test.ts 断言锁死。文案只进 i18n 键，不拼
 * 自由文本（W-B-53 防注入）。
 *
 * 本分册独立成册、自带查找入口（与 fetch-safety 册同约定），不并入
 * i18n/index 统一表，避免扩大内核冻结面。
 *
 * @module webstack/i18n/kernel-p1
 */

/** 本册全部文案键的闭集 union。 */
export type KernelP1I18nKey = 'webstack.mode.online-marker';

/** 语言闭包（与 src/i18n/index.ts 的 Locale 同形；就地声明避免反向依赖）。 */
type Locale = 'zh' | 'en';

/** 中文文案。 */
export const kernelP1MessagesZh: Readonly<Record<KernelP1I18nKey, string>> = Object.freeze({
  'webstack.mode.online-marker': '[WebStack] 会话联网模式已开启：以下为本次在线检索结果。',
});

/** English copy. */
export const kernelP1MessagesEn: Readonly<Record<KernelP1I18nKey, string>> = Object.freeze({
  'webstack.mode.online-marker':
    '[WebStack] Session online mode is ON: results below were fetched live.',
});

/** 取本册文案；未知 locale 安全回落中文（与各分册同约定）。 */
export function kernelP1Text(key: KernelP1I18nKey, locale: Locale = 'zh'): string {
  return locale === 'en' ? kernelP1MessagesEn[key] : kernelP1MessagesZh[key];
}
