/**
 * Windows 系统代理探测（全离线）：vi.mock('node:child_process') 替换 execFile，
 * 覆盖 enable/disable/缺值/缓存命中与重置/env 注入边界。
 *
 * WS1-F4（SECURITY-B4-D1a）：reg 命令位绝对化判别锁——合成 SystemRoot 树
 * （tmpdir 自建自收）+ 绝对路径断言 + 裸名形必红负对照 + 解析不到即跳过
 * （SystemRoot 缺失/reg.exe 缺席两腿，execFile 零调用）+ windir 兜底腿。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile: execFileMock }));

import {
  applyProxyToEnv,
  getWindowsSystemProxy,
  resetWindowsProxyCacheForTest,
  WINDOWS_PROXY_CACHE_TTL_MS,
} from '../src/safety/winproxy.ts';

/** 构造 reg query 成功输出：键头行 + 值行。 */
function regStdout(name: string, value: string): string {
  return [
    '',
    `HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings`,
    `    ${name}    REG_DWORD    ${value}`,
    '',
    '',
  ].join('\r\n');
}

/** 让 execFileMock 按 /v 参数名返回预设应答。 */
function mockRegistry(values: Record<string, string | undefined>): void {
  execFileMock.mockImplementation(
    (
      _cmd: string,
      args: readonly string[],
      callback: (err: Error | null, stdout: string) => void,
    ) => {
      const name = args.at(-1) ?? '';
      const value = values[name];
      if (value === undefined || args.includes('/v') === false) {
        callback(new Error('The system was unable to find the specified registry key'), '');
        return undefined;
      }
      callback(null, regStdout(name, value));
      return undefined;
    },
  );
}

const ORIGINAL_ENV = { ...process.env };
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

/** WS1-F4：合成 SystemRoot 树（System32\reg.exe 空文件在位），tmpdir 自建自收。 */
let fakeSystemRoot = '';
/** WS1-F4：reg.exe 缺席的合成树（「解析不到即跳过」腿用）。 */
let bareSystemRoot = '';
/** SystemRoot 的全部环境键形（生产代码多态回退序）。 */
const SYSTEM_ROOT_KEYS = ['SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR'] as const;

/** 合成树内 reg.exe 的绝对路径（F4 正形期望值）。 */
function fakeRegExe(): string {
  return join(fakeSystemRoot, 'System32', 'reg.exe');
}

beforeEach(() => {
  resetWindowsProxyCacheForTest();
  execFileMock.mockReset();
  fakeSystemRoot = mkdtempSync(join(tmpdir(), 'ws1-f4-root-'));
  mkdirSync(join(fakeSystemRoot, 'System32'), { recursive: true });
  writeFileSync(fakeRegExe(), '');
  bareSystemRoot = mkdtempSync(join(tmpdir(), 'ws1-f4-empty-'));
  // 四键形全清后只留受控 SystemRoot（Git Bash 宿主真实 env 为 SYSTEMROOT 大写形）。
  for (const key of SYSTEM_ROOT_KEYS) delete process.env[key];
  process.env.SystemRoot = fakeSystemRoot;
});

describe('getWindowsSystemProxy', () => {
  it('常量：缓存 TTL 为 5 分钟', () => {
    expect(WINDOWS_PROXY_CACHE_TTL_MS).toBe(5 * 60_000);
  });

  it('ProxyEnable=0x1 且 ProxyServer 存在 → 返回服务器串，reg 绝对路径参数正确（WS1-F4）', async () => {
    mockRegistry({ ProxyEnable: '0x1', ProxyServer: '127.0.0.1:8888' });
    await expect(getWindowsSystemProxy()).resolves.toBe('127.0.0.1:8888');
    expect(execFileMock).toHaveBeenCalledWith(
      fakeRegExe(), // WS1-F4：绝对路径（SystemRoot\System32\reg.exe），裸名 'reg' 形必红
      [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
        '/v',
        'ProxyEnable',
      ],
      expect.any(Function),
    );
  });

  it('ProxyEnable=0x0 → 未启用返回 undefined 且不再查询 ProxyServer', async () => {
    mockRegistry({ ProxyEnable: '0x0', ProxyServer: '10.0.0.1:3128' });
    await expect(getWindowsSystemProxy()).resolves.toBeUndefined();
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it('启用但 ProxyServer 键缺失 → undefined', async () => {
    mockRegistry({ ProxyEnable: '0x1' });
    await expect(getWindowsSystemProxy()).resolves.toBeUndefined();
  });

  it('reg 缺失/查询报错 → 探测静默返回 undefined（永不抛）', async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: readonly string[], cb: (err: Error | null) => void) => {
        cb(new Error('reg not found'));
        return undefined;
      },
    );
    await expect(getWindowsSystemProxy()).resolves.toBeUndefined();
  });

  it('结果缓存：TTL 内第二次调用不再拉起子进程；重置后重新探测', async () => {
    let enable = '0x1';
    execFileMock.mockImplementation(
      (_cmd: string, args: readonly string[], cb: (err: Error | null, stdout: string) => void) => {
        const name = args.at(-1) ?? '';
        if (name === 'ProxyEnable') {
          cb(null, regStdout('ProxyEnable', enable));
          return undefined;
        }
        cb(null, regStdout('ProxyServer', 'proxy.local:8080'));
        return undefined;
      },
    );
    await getWindowsSystemProxy();
    await getWindowsSystemProxy();
    expect(execFileMock).toHaveBeenCalledTimes(2); // enable + server 各一次

    // 关掉系统代理后 TTL 内仍命中旧缓存。
    enable = '0x0';
    await expect(getWindowsSystemProxy()).resolves.toBe('proxy.local:8080');
    expect(execFileMock).toHaveBeenCalledTimes(2);

    resetWindowsProxyCacheForTest();
    await expect(getWindowsSystemProxy()).resolves.toBeUndefined(); // 重新探测到 0x0（短路，不再查 Server）
    expect(execFileMock).toHaveBeenCalledTimes(3);
  });

  it('非 win32 平台直接返回 undefined 且不执行 reg', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      await expect(getWindowsSystemProxy()).resolves.toBeUndefined();
      expect(execFileMock).not.toHaveBeenCalled();
    } finally {
      if (originalPlatformDescriptor !== undefined) {
        Object.defineProperty(process, 'platform', originalPlatformDescriptor);
      }
    }
  });
});

describe('WS1-F4 · reg.exe 绝对化（防御深度加固，patterns ⑦）', () => {
  it('判别对：execFile 首参 = SystemRoot\\System32\\reg.exe 绝对路径；裸名形必红（负对照）', async () => {
    mockRegistry({ ProxyEnable: '0x1', ProxyServer: 'proxy.local:3128' });
    await getWindowsSystemProxy();
    const cmd: string = execFileMock.mock.calls[0]?.[0] as string;
    expect(cmd).toBe(fakeRegExe());
    expect(isAbsolute(cmd)).toBe(true);
    expect(cmd.endsWith(join('System32', 'reg.exe'))).toBe(true);
    // 负对照：任何人回改裸名 'reg' / 相对形，上面三条必红。
    expect(cmd).not.toBe('reg');
    expect(cmd).not.toBe('reg.exe');
  });

  it('SystemRoot 全键形缺失 → 跳过探测：resolve(undefined) 且 execFile 零调用（绝不裸名回退）', async () => {
    for (const key of SYSTEM_ROOT_KEYS) delete process.env[key];
    mockRegistry({ ProxyEnable: '0x1', ProxyServer: 'proxy.local:3128' });
    await expect(getWindowsSystemProxy()).resolves.toBeUndefined();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('SystemRoot 指向无 reg.exe 的目录（存在性校验失败）→ 跳过探测，execFile 零调用', async () => {
    process.env.SystemRoot = bareSystemRoot;
    mockRegistry({ ProxyEnable: '0x1', ProxyServer: 'proxy.local:3128' });
    await expect(getWindowsSystemProxy()).resolves.toBeUndefined();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('SystemRoot 缺失但 windir 在位 → windir 兜底解析同款绝对路径', async () => {
    delete process.env.SystemRoot;
    delete process.env.SYSTEMROOT;
    process.env.windir = fakeSystemRoot;
    mockRegistry({ ProxyEnable: '0x1', ProxyServer: 'proxy.local:3128' });
    await expect(getWindowsSystemProxy()).resolves.toBe('proxy.local:3128');
    expect(execFileMock.mock.calls[0]?.[0]).toBe(fakeRegExe());
  });

  it('跳过腿与「探测永不抛错」相容：两腿均不抛、负缓存同样入槽（TTL 内二次调用仍零子进程）', async () => {
    for (const key of SYSTEM_ROOT_KEYS) delete process.env[key];
    await expect(getWindowsSystemProxy()).resolves.toBeUndefined();
    await expect(getWindowsSystemProxy()).resolves.toBeUndefined();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('真实宿主环境健全性：win32 上 SystemRoot 键形（任一）指向的 System32\\reg.exe 实存', () => {
    if (process.platform !== 'win32') return; // 非 win32 CI 无此语义，跳过
    let realRoot: string | undefined;
    for (const key of SYSTEM_ROOT_KEYS) {
      const value = ORIGINAL_ENV[key];
      if (typeof value === 'string' && value !== '') {
        realRoot = value;
        break;
      }
    }
    expect(typeof realRoot).toBe('string');
    expect(existsSync(join(realRoot as string, 'System32', 'reg.exe'))).toBe(true);
  });
});

describe('applyProxyToEnv', () => {
  it('注入 HTTPS_PROXY 与 HTTP_PROXY（trim 后）', () => {
    applyProxyToEnv('  127.0.0.1:8888  ');
    expect(process.env.HTTPS_PROXY).toBe('127.0.0.1:8888');
    expect(process.env.HTTP_PROXY).toBe('127.0.0.1:8888');
  });

  it('undefined / 空白串不动环境', () => {
    delete process.env.HTTPS_PROXY;
    delete process.env.HTTP_PROXY;
    applyProxyToEnv(undefined);
    applyProxyToEnv('   ');
    expect(process.env.HTTPS_PROXY).toBeUndefined();
    expect(process.env.HTTP_PROXY).toBeUndefined();
  });
});

afterEach(() => {
  for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', ...SYSTEM_ROOT_KEYS]) {
    const value = ORIGINAL_ENV[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (originalPlatformDescriptor !== undefined) {
    Object.defineProperty(process, 'platform', originalPlatformDescriptor);
  }
  // WS1-F4 合成树自建自收：前缀守卫（只删本 spec 在系统 tmpdir 自产的目录）。
  const guard = join(tmpdir(), 'ws1-f4-');
  for (const dir of [fakeSystemRoot, bareSystemRoot]) {
    if (dir !== '' && dir.startsWith(guard)) rmSync(dir, { recursive: true, force: true });
  }
  fakeSystemRoot = '';
  bareSystemRoot = '';
});
