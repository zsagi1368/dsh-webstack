/** 凭据三级解析链：优先级矩阵 / 占位符拦截 / 掩码与指纹（W-B-54/55/74）。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CREDS_SOURCE_ORDER,
  credFingerprint,
  envVarName,
  isCredentialRefShape,
  isPlaceholderSecret,
  maskSecret,
  opaqueIdOf,
  PLACEHOLDER_PATTERNS,
  resolveCreds,
  resolveCredsDetailed,
  unwrapResolvedCredential,
} from '../src/creds/resolve.ts';
import type { CredsSnapshot, SeamCredentialsRuntime } from '../src/kernel/types.ts';

afterEach(() => {
  vi.unstubAllEnvs();
});

/** credentials seam 桩：ref → 固定密钥，并记录调用次数。 */
function makeSeam(secret = 'seam-resolved-secret'): SeamCredentialsRuntime & { calls: number } {
  return {
    calls: 0,
    async resolve(ref) {
      this.calls++;
      return ref === 'KNOWN_REF' ? secret : undefined;
    },
  };
}

describe('解析链词汇', () => {
  it('优先级冻结：遗留字面 → credentialRef → env', () => {
    expect([...CREDS_SOURCE_ORDER]).toEqual(['legacy-literal', 'credential-ref', 'env']);
    expect(PLACEHOLDER_PATTERNS.length).toBeGreaterThan(0);
  });

  it('env 变量名映射：bing-lite → WEBSTACK_BING_LITE_API_KEY', () => {
    expect(envVarName('bing-lite')).toBe('WEBSTACK_BING_LITE_API_KEY');
    expect(envVarName('SearXNG')).toBe('WEBSTACK_SEARXNG_API_KEY');
  });
});

describe('resolveCreds · 三级优先级矩阵', () => {
  const matrix: readonly {
    readonly name: string;
    readonly config?: string;
    readonly ref?: string;
    readonly withSeam?: boolean;
    readonly env?: string;
    readonly expectedSource: 'legacy-literal' | 'credential-ref' | 'env' | undefined;
  }[] = [
    {
      name: '三级齐备 → legacy-literal 胜出',
      config: 'cfg-key-01',
      ref: 'KNOWN_REF',
      withSeam: true,
      env: 'env-key-01',
      expectedSource: 'legacy-literal',
    },
    {
      name: '字面缺席 → credential-ref 次之',
      ref: 'KNOWN_REF',
      withSeam: true,
      env: 'env-key-02',
      expectedSource: 'credential-ref',
    },
    { name: '仅 env → 兜底生效', env: 'env-key-03', expectedSource: 'env' },
    { name: '全缺席 → absent 无 source', expectedSource: undefined },
  ];

  for (const c of matrix) {
    it(c.name, async () => {
      if (c.env !== undefined) vi.stubEnv('WEBSTACK_TESTER_API_KEY', c.env);
      const snapshot = await resolveCreds(['tester'], {
        configValues: c.config === undefined ? {} : { tester: c.config },
        credentialsRef: c.ref === undefined ? {} : { tester: c.ref },
        seams: c.withSeam === true ? { credentials: makeSeam() } : {},
      });
      const entry = snapshot.entries.tester!;
      if (c.expectedSource === undefined) {
        expect(entry.state).toBe('absent');
        expect(entry.source).toBeUndefined();
      } else {
        expect(entry.state).toBe('configured');
        expect(entry.source).toBe(c.expectedSource);
      }
    });
  }

  it('credentials 服务缺席时跳级到 env（降级梯）', async () => {
    vi.stubEnv('WEBSTACK_TESTER_API_KEY', 'env-fallback-key');
    const snapshot = await resolveCreds(['tester'], {
      configValues: {},
      credentialsRef: { tester: 'KNOWN_REF' },
    });
    expect(snapshot.entries.tester).toMatchObject({
      state: 'configured',
      source: 'env',
    });
  });

  it('seam 在但 resolve 返回空 → 继续下探到 env', async () => {
    vi.stubEnv('WEBSTACK_TESTER_API_KEY', 'env-after-empty-seam');
    const snapshot = await resolveCreds(['tester'], {
      credentialsRef: { tester: 'UNKNOWN_REF' },
      seams: { credentials: makeSeam() },
    });
    expect(snapshot.entries.tester).toMatchObject({
      state: 'configured',
      source: 'env',
    });
  });
});

describe('resolveCreds · 占位符拦截', () => {
  it('配置占位符视为 absent 并发出 webstack.creds.placeholder-detected 告警键', async () => {
    const warnings: [string, string][] = [];
    const snapshot = await resolveCreds(['tester'], {
      configValues: { tester: '<your-api-key>' },
      onWarning: (engineId, key) => warnings.push([engineId, key]),
    });
    expect(snapshot.entries.tester!.state).toBe('absent');
    expect(warnings).toEqual([['tester', 'webstack.creds.placeholder-detected']]);
  });

  it('占位符不阻断下探：字面为占位符而 env 有真值 → env 生效', async () => {
    vi.stubEnv('WEBSTACK_TESTER_API_KEY', 'real-env-key-99');
    const snapshot = await resolveCreds(['tester'], {
      configValues: { tester: 'YOUR_API_KEY' },
    });
    expect(snapshot.entries.tester).toMatchObject({
      state: 'configured',
      source: 'env',
    });
  });

  it('isPlaceholderSecret 覆盖黑名单正则与尖括号包裹；真密钥不误伤', () => {
    for (const bad of [
      '<your-key>',
      '<anything-here>',
      'your-api-key-here',
      'sk-xxxxxxxxxxxxxxxx',
      'placeholder-value',
      'changeme',
    ]) {
      expect(isPlaceholderSecret(bad), bad).toBe(true);
    }
    for (const good of ['sk-real-9f8e7d6c5b4a3210', 'AIzaSyD-1234567890abcdef', 'k']) {
      expect(isPlaceholderSecret(good), good).toBe(false);
    }
  });
});

describe('掩码与 opaque id（明文不出快照）', () => {
  it('长度 > 8：前 3 + … + 尾 4；长度 ≤ 8：等长星号', () => {
    expect(maskSecret('abcdefghijkl')).toBe('abc…ijkl');
    expect(maskSecret('12345678')).toBe('********');
    expect(maskSecret('k')).toBe('*');
  });

  it('opaqueId 稳定可对比、不同密钥不同 id', () => {
    expect(opaqueIdOf('same-secret')).toBe(opaqueIdOf('same-secret'));
    expect(opaqueIdOf('secret-A')).not.toBe(opaqueIdOf('secret-B'));
    expect(opaqueIdOf('x')).toMatch(/^[0-9a-f]{8}$/);
  });

  it('快照序列化后不含明文片段', async () => {
    const secret = 'super-plain-secret-42';
    vi.stubEnv('WEBSTACK_TESTER_API_KEY', secret);
    const snapshot = await resolveCreds(['tester']);
    expect(JSON.stringify(snapshot)).not.toContain(secret);
    expect(snapshot.entries.tester!.maskedHint).toBe(maskSecret(secret));
  });
});

describe('credFingerprint', () => {
  const build = async (
    secrets: Readonly<Record<string, string | undefined>>,
  ): Promise<CredsSnapshot> => resolveCreds(Object.keys(secrets), { configValues: secrets });

  it('无任何凭据 → none', async () => {
    const fp = credFingerprint(await build({ a: undefined }));
    expect(fp).toBe('none');
    const empty: CredsSnapshot = { resolvedAt: 0, entries: {} };
    expect(credFingerprint(empty)).toBe('none');
  });

  it('凭据轮换即变指纹；引擎枚举顺序不影响取值', async () => {
    const before = credFingerprint(await build({ ddg: 'key-ddg-1', bing: 'key-bing-1' }));
    const afterRotation = credFingerprint(await build({ ddg: 'key-ddg-2', bing: 'key-bing-1' }));
    expect(afterRotation).not.toBe(before);

    const reversed = await resolveCreds(['bing', 'ddg'], {
      configValues: { ddg: 'key-ddg-1', bing: 'key-bing-1' },
    });
    expect(credFingerprint(reversed)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// TC-B4-W1④：R-4 双向形状判别对 + ref 语法预校验锁。
// 三级优先级/跳级/占位符/掩码/指纹行为锁 = 上方既有谱（不重复）；本节锁
// 主线 ResolvedCredential {value,source} 对象形状（credentials/src/index.ts
// :118-123 镜像）的解包正确性（正向）与未命中 → undefined 静默跳级（负向）。
// ---------------------------------------------------------------------------

/** 主线对象形状 seam 桩：KNOWN_REF → {value,source}；其余 → undefined（未命中）。 */
function makeObjectSeam(
  secret = 'object-resolved-secret',
): SeamCredentialsRuntime & { calls: number } {
  return {
    calls: 0,
    async resolve(ref) {
      this.calls++;
      return ref === 'KNOWN_REF' ? { value: secret, source: 'user-env' } : undefined;
    },
  };
}

describe('R-4 形状判别对（TC-B4-W1④）', () => {
  it('正向：主线对象 {value,source} 解包正确 → configured/credential-ref，掩码与 opaqueId 由 value 派生', async () => {
    const secret = 'obj-secret-abcdefgh';
    const seam = makeObjectSeam(secret);
    const snapshot = await resolveCreds(['tester'], {
      credentialsRef: { tester: 'KNOWN_REF' },
      seams: { credentials: seam },
    });
    expect(seam.calls).toBe(1);
    expect(snapshot.entries.tester).toEqual({
      state: 'configured',
      source: 'credential-ref',
      maskedHint: maskSecret(secret),
      opaqueId: opaqueIdOf(secret),
    });
  });

  it('正向伴随：resolveCredsDetailed 明文表含解包后 value；快照本体仍零明文', async () => {
    const secret = 'detailed-secret-99';
    const { snapshot, secrets } = await resolveCredsDetailed(['tester'], {
      credentialsRef: { tester: 'KNOWN_REF' },
      seams: { credentials: makeObjectSeam(secret) },
    });
    expect(secrets.tester).toBe(secret);
    expect(snapshot.entries.tester!.source).toBe('credential-ref');
    expect(JSON.stringify(snapshot)).not.toContain(secret);
  });

  it('负向：resolve 未命中 → undefined 静默跳级到 env（不抛错）', async () => {
    vi.stubEnv('WEBSTACK_TESTER_API_KEY', 'env-after-object-miss');
    const seam = makeObjectSeam();
    const snapshot = await resolveCreds(['tester'], {
      credentialsRef: { tester: 'ABSENT_REF' },
      seams: { credentials: seam },
    });
    expect(seam.calls).toBe(1); // ref 语法合法 → 触达 seam；未命中不抛
    expect(snapshot.entries.tester).toMatchObject({ state: 'configured', source: 'env' });
  });

  it('异形状对象（value 空串/空白/非 string/缺位）一律读作未命中 → 下探', async () => {
    vi.stubEnv('WEBSTACK_TESTER_API_KEY', 'env-real-value');
    const badShapes: unknown[] = [
      { value: '', source: 'env' },
      { value: '   ', source: 'env' },
      { value: 42, source: 'env' },
      { source: 'env' },
      null,
      42,
    ];
    for (const bad of badShapes) {
      const seam: SeamCredentialsRuntime = { resolve: async () => bad as never };
      const snapshot = await resolveCreds(['tester'], {
        credentialsRef: { tester: 'KNOWN_REF' },
        seams: { credentials: seam },
      });
      expect(snapshot.entries.tester, JSON.stringify(bad)).toMatchObject({
        state: 'configured',
        source: 'env',
      });
    }
  });

  it('解包值命中占位符 → 该层 absent（拦截语义与字面层等价；告警键归 legacy-literal 层，此层不发）', async () => {
    const warnings: [string, string][] = [];
    const seam: SeamCredentialsRuntime = {
      resolve: async () => ({ value: '<your-api-key>', source: 'file' }),
    };
    const snapshot = await resolveCreds(['tester'], {
      credentialsRef: { tester: 'KNOWN_REF' },
      seams: { credentials: seam },
      onWarning: (engineId, key) => warnings.push([engineId, key]),
    });
    expect(snapshot.entries.tester!.state).toBe('absent');
    expect(warnings).toEqual([]);
  });

  it('裸 string 形状（插件历史契约）→ 兼容解包成功', async () => {
    const seam: SeamCredentialsRuntime = { resolve: async () => 'plain-string-secret' };
    const snapshot = await resolveCreds(['tester'], {
      credentialsRef: { tester: 'KNOWN_REF' },
      seams: { credentials: seam },
    });
    expect(snapshot.entries.tester).toMatchObject({
      state: 'configured',
      source: 'credential-ref',
      maskedHint: maskSecret('plain-string-secret'),
    });
  });

  it('unwrapResolvedCredential 单元：对象取 value / string 原样 / 其余未命中', () => {
    expect(unwrapResolvedCredential({ value: 'v', source: 's' })).toBe('v');
    expect(unwrapResolvedCredential('raw')).toBe('raw');
    expect(unwrapResolvedCredential(undefined)).toBeUndefined();
    expect(unwrapResolvedCredential(null)).toBeUndefined();
    expect(unwrapResolvedCredential(42)).toBeUndefined();
    expect(unwrapResolvedCredential({ value: 42, source: 's' })).toBeUndefined();
    expect(unwrapResolvedCredential({ source: 's' })).toBeUndefined();
  });

  it('ref 预校验：非 POSIX 标识符语法 → seam 零触达、静默跳级（主线 isCredentialRefName 消费纪律）', async () => {
    vi.stubEnv('WEBSTACK_TESTER_API_KEY', 'env-after-bad-ref');
    for (const bad of ['scope/id', 'has-hyphen', '123lead', 'with space', '']) {
      const seam = makeObjectSeam();
      const snapshot = await resolveCreds(['tester'], {
        credentialsRef: { tester: bad },
        seams: { credentials: seam },
      });
      expect(seam.calls, bad).toBe(0);
      expect(snapshot.entries.tester, bad).toMatchObject({
        state: 'configured',
        source: 'env',
      });
    }
  });

  it('isCredentialRefShape 语法单元锁：与主线 REF_PATTERN（index.ts:19 @9da7f7371d）语义一致', () => {
    for (const good of ['DEEPSEEK_API_KEY', '_private', 'A1', 'k']) {
      expect(isCredentialRefShape(good), good).toBe(true);
    }
    // `<scope>/<id>` 是主线 CredentialKey 语法（types.ts:17-29），ref 面必拒——
    // contract-webstack.md:57 该半句系误读（回执 §0.1 偏差登记）。
    for (const bad of ['scope/id', 'has-hyphen', '123lead', '', 'with space', 'dot.name']) {
      expect(isCredentialRefShape(bad), bad).toBe(false);
    }
  });
});
