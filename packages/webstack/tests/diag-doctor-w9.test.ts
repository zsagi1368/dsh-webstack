/**
 * W9 诊断面回归：doctor 报告加法式增补（桥接在线/离线、垂类三态）与
 * statusSection extras 短句（词数预算内）。
 */
import { describe, expect, it } from 'vitest';
import { SearchCache } from '../src/cache/store.ts';
import { type DoctorDeps, renderDoctor, runDoctor } from '../src/diag/doctor.ts';
import { EngineRegistry } from '../src/kernel/registry.ts';
import { countWords, statusSection } from '../src/prompt/sections.ts';

function deps(overrides?: Partial<DoctorDeps>): DoctorDeps {
  return {
    bitmap: {
      webSeam: true,
      selectorPatchable: false,
      settingsSection: true,
      inputSlot: false,
      credentialsDomain: false,
      storageService: false,
      bridgeOnline: false,
    },
    tier: 'coexist',
    registry: new EngineRegistry(),
    cache: new SearchCache(),
    ...overrides,
  };
}

describe('runDoctor W9 增补', () => {
  it('bridgeOnline=true → report.bridge=online；false → offline', () => {
    expect(runDoctor(deps({ bridgeOnline: true })).bridge).toBe('online');
    expect(runDoctor(deps({ bridgeOnline: false })).bridge).toBe('offline');
  });

  it('vertical 三态透传；缺席字段保持缺席（报告向后兼容）', () => {
    const base = runDoctor(deps());
    expect(base.bridge).toBeUndefined();
    expect(base.vertical).toBeUndefined();
    expect(runDoctor(deps({ vertical: 'on' })).vertical).toBe('on');
    expect(runDoctor(deps({ vertical: 'off' })).vertical).toBe('off');
    expect(runDoctor(deps({ vertical: 'pack-missing' })).vertical).toBe('pack-missing');
  });

  it('render：桥接与垂类状态行按 locale 渲染；缺席不输出', () => {
    const withBoth = renderDoctor(runDoctor(deps({ bridgeOnline: true, vertical: 'on' })), 'zh');
    expect(withBoth).toContain('桥接卫星：在线');
    expect(withBoth).toContain('垂直频道（X）：已开启');

    const missing = renderDoctor(runDoctor(deps({ vertical: 'pack-missing' })), 'en');
    expect(missing).toContain('dsh-webstack-verticals is missing');
    expect(missing).not.toContain('bridge satellite'); // 未上报桥 → 不渲染该行

    const plain = renderDoctor(runDoctor(deps()), 'zh');
    expect(plain).not.toContain('桥接卫星');
    expect(plain).not.toContain('垂直频道');
  });
});

describe('statusSection W9 extras', () => {
  it('extras 追加桥/垂类短句且仍守 ≤80 词预算', () => {
    const section = statusSection({ ddg: { state: 'ok' } }, 'zh', {
      bridgeOnline: true,
      verticalEnabled: true,
    });
    expect(section.text).toContain('桥接在线');
    expect(section.text).toContain('X垂类开');
    expect(countWords(section.text)).toBeLessThanOrEqual(80);
  });

  it('extras 缺席时行为与旧版一致（无短句、无词数膨胀）', () => {
    const legacy = statusSection({ ddg: { state: 'ok' } }, 'zh');
    const modern = statusSection({ ddg: { state: 'ok' } }, 'zh', {});
    expect(modern.text).toBe(legacy.text);
  });
});
