import { lookup } from "node:dns/promises";
//#region src/kernel/types.ts
/** 全部路由层的封闭枚举（顺序即 UI 呈现顺序）。 */
const SEARCH_LAYERS = [
	"native",
	"free",
	"api",
	"selfhosted",
	"mcp"
];
/** WebStack 注册进宿主 seam 的 provider id（补丁选择器的唯一指向目标）。 */
const WEBSTACK_PROVIDER_ID = "webstack";
/**
* 分类学映射表：每个错误码恰好一个分类。完整性由
* tests/kernel-errors.test.ts 表驱动锁死——新增码而漏映射会直接红。
*/
const ERROR_CLASSIFICATION = Object.freeze({
	transport: "retryable",
	"http-upstream": "retryable",
	unrepresentable: "non-retryable",
	aborted: "terminal",
	auth: "non-retryable",
	quota: "non-retryable",
	cooldown: "non-retryable",
	"ssrf-blocked": "terminal",
	"narrow-failed": "retryable",
	"rate-limited": "retryable"
});
Object.freeze([
	"G1-static",
	"G2-dns",
	"G3-redirect",
	"G4-body-bound"
]);
//#endregion
//#region src/kernel/errors.ts
/**
* 统一错误机制：EngineError 类、守卫与翻译入口（W-B-40/44/45）。
* 错误码闭集 union 与三分类映射表（契约数据）冻结于 kernel/types.ts；
* 本文件只提供运行时机制。TODO(W2-DIAG): 双语翻译层接入 i18n 包。
* @module webstack/kernel/errors
*/
/** 统一错误对象：引擎适配器、安全闸、窄化层抛错的唯一合法形状。 */
var EngineError = class extends Error {
	name = "EngineError";
	code;
	engineId;
	httpStatus;
	retryAfterMs;
	detail;
	cause;
	constructor(code, message, extras = {}) {
		super(message);
		this.code = code;
		if (extras.engineId !== void 0) this.engineId = extras.engineId;
		if (extras.httpStatus !== void 0) this.httpStatus = extras.httpStatus;
		if (extras.retryAfterMs !== void 0) this.retryAfterMs = extras.retryAfterMs;
		if (extras.detail !== void 0) this.detail = extras.detail;
		if (extras.cause !== void 0) this.cause = extras.cause;
	}
};
/** 构造统一错误的工厂函数。 */
function engineError(code, message, extras = {}) {
	return new EngineError(code, message, extras);
}
/** 运行时守卫：判定任意抛出值是否为统一错误对象。 */
function isEngineError(value) {
	return value instanceof Error && value.name === "EngineError" && typeof value.code === "string";
}
/**
* 归一化任意未知抛出值：EngineError 原样返回；其余包一层 transport。
* TODO(W2-KERNEL): fallback 链据此三分类决策——retryable 退避重试，
* non-retryable 换候选，terminal 立即结算整场操作。
*/
function normalizeThrown(value, engineId) {
	if (isEngineError(value)) return value;
	return engineError("transport", value instanceof Error ? value.message : String(value), engineId === void 0 ? {} : { engineId });
}
/** 查询某错误码的三分类。映射表完整性由 tests/kernel-errors.test.ts 锁死。 */
function errorClass(code) {
	return ERROR_CLASSIFICATION[code];
}
//#endregion
//#region src/safety/scrub.ts
/**
* 输出边界统一脱敏 scrubber（W-B-56 / W-A-03 反制）：URL userinfo 与敏感
* query 参数在一切日志、错误文本、诊断输出之前过滤。
*
* 两套占位符语义：`redactUrl`（遗留，`[REDACTED]`）用于结构化 URL 字段的
* 强替换；`scrubUrl`/`scrubText`（`***`）用于自由文本的轻量遮蔽——二者共用
* 同一套敏感键黑名单与 userinfo 剥除规则。scrubber 自身绝不允许成为新的
* 故障点：解析失败一律安全占位而非抛错。
* @module webstack/safety/scrub
*/
/** 敏感 query 键黑名单（小写比较；命中即整值替换为占位符）。 */
const SENSITIVE_QUERY_KEYS = [
	"api_key",
	"apikey",
	"access_token",
	"token",
	"key",
	"secret",
	"password",
	"sig",
	"signature"
];
const REDACTED = "[REDACTED]";
const SCRUB_PLACEHOLDER = "***";
/** 自由文本中的 http(s) URL 字形；排除常见包裹符避免吞掉句子标点。 */
const URL_IN_TEXT = /(https?:\/\/[^\s<>"')\]]+)/gi;
/** 敏感 query 键 → 文本级遮蔽模式（动态派生自黑名单，单一事实源）。 */
const QUERY_PAIR = new RegExp(`([?&](?:${SENSITIVE_QUERY_KEYS.join("|")})=)[^\\s&"'<>]+`, "gi");
/** 共享脱敏核心：剥 userinfo + 遮蔽敏感 query 值；失败返回安全占位。 */
function maskUrl(rawUrl, placeholder) {
	try {
		const parsed = new URL(rawUrl);
		if (parsed.username !== "" || parsed.password !== "") {
			parsed.username = placeholder;
			parsed.password = "";
		}
		for (const key of [...parsed.searchParams.keys()]) if (SENSITIVE_QUERY_KEYS.includes(key.toLowerCase())) parsed.searchParams.set(key, placeholder);
		return String(parsed);
	} catch {
		return REDACTED;
	}
}
/**
* 脱敏 URL：遮蔽黑名单 query 值、剥除 userinfo 段。解析失败时返回占位符
* 而非抛错——scrubber 自身绝不允许成为新的故障点。
*/
function redactUrl(rawUrl) {
	return maskUrl(rawUrl, REDACTED);
}
/**
* 脱敏自由文本：先对文本中出现的每个 http(s) URL 应用 scrubUrl 规则
* （userinfo 与敏感 query 值替换为 `***`），再兜底扫描裸 `?key=value`
* 形态的敏感参数对——覆盖错误消息里被截断的非完整 URL。
*/
function scrubText(text) {
	return text.replace(URL_IN_TEXT, (match) => maskUrl(match, SCRUB_PLACEHOLDER)).replace(QUERY_PAIR, "$1***");
}
//#endregion
//#region src/safety/ssrf.ts
/**
* SSRF 纵深四道闸（W-B-50 / F-007）：G1 静态校验 → G2 DNS 解析核验 →
* G3 重定向逐跳复验 → G4 有界响应体。豁免只跳过 G2 网段判定，永不跳过
* G1/G3/G4。判定基于解析后 IP 而非 hostname 字符串黑名单——`localhost`
* 字符串绕过、自建 DNS 重绑定（TOCTOU 由 outbound 每跳复验兜底）均失效。
*
* 端口治理采用**黑名单制**而非白名单制：SearXNG / Crawl4AI 等自托管引擎
* 常部署在 8080、11235 等高位端口，白名单会把合法自托管实例一刀切死；
* 黑名单只封已知高危服务端口（SSH/Telnet/SMTP/DNS/RPC/SMB/数据库等），
* 对高位业务端口保持放行，由 G2 网段判定承担真正的内网防护。
* @module webstack/safety/ssrf
*/
/** 放行裁决便捷构造。 */
function allow() {
	return { allowed: true };
}
/** 拒绝裁决便捷构造：必须携带闸位与原因码（i18n/处方按 reasonCode 派生）。 */
function reject(gate, reasonCode, detail) {
	return detail === void 0 ? {
		allowed: false,
		gate,
		reasonCode
	} : {
		allowed: false,
		gate,
		reasonCode,
		detail
	};
}
/**
* 高危服务端口黑名单（G1）：SSH(22)/Telnet(23)/SMTP(25)/DNS(53)/RPC(135)/
* NetBIOS(139/445)/MySQL(3306)/RDP(3389)/PostgreSQL(5432)/Redis(6379)/
* MongoDB(27017)。黑名单制理由见模块头注释——自托管引擎常用 8080/11235
* 高位端口，白名单制会误杀合法实例。
*/
const BLOCKED_PORTS = Object.freeze([
	22,
	23,
	25,
	53,
	135,
	139,
	445,
	3306,
	3389,
	5432,
	6379,
	27017
]);
/** `::ffff:` 前缀的 IPv4 映射地址（如 ::ffff:127.0.0.1）——按 v4 规则判定。 */
const IPV4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;
/** 点分十进制 IPv4 → 32 位无符号整数；非法输入返回 null。 */
function ipv4ToUint32(dotted) {
	const parts = dotted.split(".");
	if (parts.length !== 4) return null;
	let out = 0;
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return null;
		const n = Number(part);
		if (n > 255) return null;
		out = out * 256 + n;
	}
	return out >>> 0;
}
/** IPv4 数值分类（RFC 1918/3927/6598 及保留段清单见分册 05 §4）。 */
function classifyV4(n) {
	const o1 = n >>> 24;
	const o2 = n >>> 16 & 255;
	const o3 = n >>> 8 & 255;
	if (o1 === 127) return "loopback";
	if (o1 === 10) return "private";
	if (o1 === 172 && o2 >= 16 && o2 <= 31) return "private";
	if (o1 === 192 && o2 === 168) return "private";
	if (o1 === 169 && o2 === 254) return "link-local";
	if (o1 === 0) return "reserved";
	if (o1 === 100 && o2 >= 64 && o2 <= 127) return "reserved";
	if (o1 === 192 && o2 === 0 && o3 === 0) return "reserved";
	if (o1 === 198 && (o2 === 18 || o2 === 19)) return "reserved";
	if (o1 >= 224) return "reserved";
	return "public";
}
/**
* 展开 IPv6 为 8 个 hextet 数组；支持 `::` 压缩与尾段内嵌 IPv4。
* 非法输入返回 null。zone id（%eth0）剥离后忽略。
*/
function ipv6Hextets(ip) {
	let s = ip.trim().toLowerCase();
	const zone = s.indexOf("%");
	if (zone >= 0) s = s.slice(0, zone);
	if (!s.includes(":")) return null;
	const halves = s.split("::");
	if (halves.length > 2) return null;
	/** 解析冒号分段为 hextet 数组；含 '.' 的段只允许出现在末尾并按 v4 展开。 */
	const parseGroups = (raw) => {
		if (raw === "") return [];
		const segs = raw.split(":");
		const groups = [];
		for (let i = 0; i < segs.length; i++) {
			const seg = segs[i];
			if (seg === void 0 || seg === "") return null;
			if (seg.includes(".")) {
				if (i !== segs.length - 1) return null;
				const v4 = ipv4ToUint32(seg);
				if (v4 === null) return null;
				groups.push(v4 >>> 16, v4 & 65535);
				continue;
			}
			if (!/^[0-9a-f]{1,4}$/.test(seg)) return null;
			groups.push(Number.parseInt(seg, 16));
		}
		return groups;
	};
	const head = parseGroups(halves[0] ?? "");
	if (head === null) return null;
	if (halves.length === 1) return head.length === 8 ? head : null;
	const tail = parseGroups(halves[1] ?? "");
	if (tail === null) return null;
	const fill = 8 - head.length - tail.length;
	if (fill < 1) return null;
	return [
		...head,
		...Array.from({ length: fill }, () => 0),
		...tail
	];
}
/**
* 纯 IPv6 分类：仅清单化 ::1/fc00::/7/fe80::/10 与未指定地址 ::。
* W10 审计加固：`::ffff:<v4>` 的**十六进制缩写形态**（如 `::ffff:7f00:1`，
* 即 inet_ntop 对映射地址的规范输出）与点分形态同权——剥 `::ffff:0:0/96`
* 前缀后完全按 v4 规则判定；NAT64 已知前缀 `64:ff9b::/96` 按 fail-closed
* 归入 reserved（其尾嵌 v4 经网关可折返内网）。
*/
function classifyV6(groups) {
	const last = groups[7] ?? 0;
	if (groups.every((g, i) => i === 7 || g === 0)) return last === 1 ? "loopback" : "reserved";
	const first = groups[0] ?? 0;
	if (first === 100 && (groups[1] ?? 0) === 65435) return "reserved";
	if ((groups[5] ?? 0) === 65535 && groups.every((g, i) => i >= 5 || g === 0)) return classifyV4(((groups[6] ?? 0) << 16 | last) >>> 0);
	if (first >= 64512 && first <= 65023) return "private";
	if (first >= 65152 && first <= 65215) return "link-local";
	return "public";
}
/**
* IP 风险分类纯函数：IPv4、纯 IPv6 与 `::ffff:` 映射地址统一判定；
* 映射地址剥前缀后完全按 v4 规则走（防 `::ffff:127.0.0.1` 绕过）。
*/
function classifyIp(ip) {
	const trimmed = ip.trim();
	const v4 = ipv4ToUint32(IPV4_MAPPED.exec(trimmed)?.[1] ?? trimmed);
	if (v4 !== null) return classifyV4(v4);
	const groups = ipv6Hextets(trimmed);
	return groups === null ? "unknown" : classifyV6(groups);
}
/**
* 解析豁免条目；无法识别的条目安全忽略（豁免宁缺勿滥）。host 侧容忍
* `[::1]:8080` 方括号形态（与 URL hostname 的无括号规范形对齐）。
*/
function parseExemptions(entries) {
	const list = [];
	for (const raw of entries) {
		const entry = raw.trim().toLowerCase();
		if (entry === "") continue;
		if (entry.includes("/")) {
			const [base, bitsRaw] = entry.split("/");
			const bits = Number(bitsRaw);
			const baseV4 = base === void 0 ? null : ipv4ToUint32(base);
			if (baseV4 === null || !Number.isInteger(bits) || bits < 0 || bits > 32) continue;
			list.push({ cidr: {
				base: baseV4,
				bits
			} });
			continue;
		}
		const colon = entry.lastIndexOf(":");
		if (colon > 0) {
			let host = entry.slice(0, colon);
			const port = entry.slice(colon + 1);
			if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
			if (/^\d{1,5}$/.test(port)) {
				list.push({
					host,
					port
				});
				continue;
			}
		}
		list.push({ host: entry });
	}
	return list;
}
/** scheme 缺省端口（豁免 `host:port` 对缺省端口 URL 的等价匹配用）。 */
function defaultPortOf(protocol) {
	if (protocol === "https:") return "443";
	if (protocol === "http:") return "80";
	return "";
}
/** host:port 形态豁免是否命中当前 URL（命中则整段跳过 G2，不做 DNS）。 */
function hostExempt(parsed, list) {
	let hostname = parsed.hostname.toLowerCase();
	if (hostname.startsWith("[") && hostname.endsWith("]")) hostname = hostname.slice(1, -1);
	const effectivePort = parsed.port === "" ? defaultPortOf(parsed.protocol) : parsed.port;
	return list.some((e) => e.host !== void 0 && e.host === hostname && (e.port === void 0 || e.port === parsed.port || e.port === effectivePort));
}
/** CIDR 豁免是否覆盖该已解析地址（仅 IPv4；v6 无 CIDR 豁免）。 */
function cidrExempt(ip, list) {
	const v4 = ipv4ToUint32(IPV4_MAPPED.exec(ip.trim())?.[1] ?? ip.trim());
	if (v4 === null) return false;
	return list.some((e) => {
		if (e.cidr === void 0) return false;
		const shift = 32 - e.cidr.bits;
		return v4 >>> shift === e.cidr.base >>> shift >>> 0;
	});
}
/**
* 目标核验主入口：先 G1 静态校验（scheme/userinfo/端口黑名单），再经 DNS
* 把 hostname 解析为**全部**地址逐个做网段判定（任一地址落入受限段即拒，
* 防「公网域名解析到内网 IP」的 DNS 重绑定面）。DNS 层失败不在此吞掉——
* 上抛由 outbound 归一为 ssrf-blocked/dns-resolution-failed。
* @param url        待检目标 URL
* @param exemptions 豁免表：`host:port`（跳过 G2 且不发起 DNS）与 IPv4 CIDR
*                   （对已解析地址放行）；永不影响 G1/G3/G4
*/
async function checkTarget(url, exemptions) {
	const list = exemptions === void 0 ? [] : parseExemptions(exemptions);
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		return reject("G1-static", "scheme-disallowed", "url-parse-failed");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return reject("G1-static", "scheme-disallowed", parsed.protocol);
	if (parsed.username !== "" || parsed.password !== "") return reject("G1-static", "userinfo-present", redactUrl(url));
	const portNum = parsed.port === "" ? void 0 : Number(parsed.port);
	if (portNum !== void 0 && BLOCKED_PORTS.includes(portNum)) return reject("G1-static", "nonstandard-port", String(portNum));
	if (hostExempt(parsed, list)) return allow();
	const addresses = await lookup(parsed.hostname, { all: true });
	for (const addr of addresses) {
		const cls = classifyIp(addr.address);
		const reason = cls === "loopback" ? "loopback" : cls === "private" ? "private-range" : cls === "link-local" ? "link-local" : cls === "reserved" || cls === "unknown" ? "reserved-range" : void 0;
		if (reason !== void 0 && !cidrExempt(addr.address, list)) return reject("G2-dns", reason, `${addr.address} classified ${cls}`);
	}
	return allow();
}
/** 安全取 origin；不可解析时返回空串（调用侧必然先过 G1，此为防御兜底）。 */
function safeOrigin(url) {
	try {
		return new URL(url).origin;
	} catch {
		return "";
	}
}
/**
* G3 重定向逐跳复验：目标 URL 先完整过 G1+G2，任一拒绝即抛
* `ssrf-blocked`（detail=redirect-to-blocked）；随后若原请求带 Authorization
* 头且重定向跨源，抛 `ssrf-blocked`（detail=redirect-cross-origin-auth）——
* 凭据头跟随跨源跳转是最高危泄漏面，直接硬拒而非降级剥头。
* @param fromUrl       跳转来源 URL（用于诊断消息，经 redactUrl 脱敏）
* @param toUrl         Location 解析出的绝对目标 URL
* @param hadAuthHeader 原请求是否携带 Authorization 头
* @param exemptions    透传给 G2 的豁免表（语义同 checkTarget）
* @throws EngineError(code='ssrf-blocked') 目标被拒或凭据跨源
*/
async function assertSafeRedirect(fromUrl, toUrl, hadAuthHeader, exemptions) {
	let verdict;
	try {
		verdict = await checkTarget(toUrl, exemptions);
	} catch (cause) {
		throw engineError("ssrf-blocked", `redirect target dns resolution failed: ${redactUrl(fromUrl)} -> ${redactUrl(toUrl)}`, {
			detail: "dns-resolution-failed",
			cause
		});
	}
	if (!verdict.allowed) throw engineError("ssrf-blocked", `redirect to blocked target (${verdict.gate}/${verdict.reasonCode}): ${redactUrl(fromUrl)} -> ${redactUrl(toUrl)}`, { detail: "redirect-to-blocked" });
	if (hadAuthHeader && safeOrigin(toUrl) !== safeOrigin(fromUrl)) throw engineError("ssrf-blocked", `cross-origin redirect with Authorization header: ${redactUrl(fromUrl)} -> ${redactUrl(toUrl)}`, { detail: "redirect-cross-origin-auth" });
}
//#endregion
export { engineError as a, normalizeThrown as c, scrubText as i, SEARCH_LAYERS as l, checkTarget as n, errorClass as o, redactUrl as r, isEngineError as s, assertSafeRedirect as t, WEBSTACK_PROVIDER_ID as u };
