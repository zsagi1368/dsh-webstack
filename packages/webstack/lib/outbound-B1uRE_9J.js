import { a as engineError, i as scrubText, n as checkTarget, r as redactUrl, t as assertSafeRedirect } from "./ssrf-D1j5k1Xp.js";
//#region src/safety/outbound.ts
/**
* 统一出站客户端工厂：所有引擎适配器必须经此发请求，直连 fetch 在 lint 层
* 禁用——保证 SSRF 四道闸不可绕过（分册 05 §1.3）。
*
* 单次 outboundFetch 的执行序列：
* 1. G1+G2 目标核验（checkTarget；DNS 失败归一为 ssrf-blocked/dns-resolution-failed）；
* 2. `redirect:'manual'` 发起请求，3xx 逐跳复验（assertSafeRedirect，≤5 跳；
*    跨源跳转剥 Cookie/Authorization，带 Authorization 的跨源跳转直接硬拒）；
* 3. 双态取消信号：caller signal ∪ timeoutMs 超时 ∪ 内部限流 controller；
*    已中止 → `aborted`，超时与其它网络异常 → `transport`；
* 4. G4 有界响应体：reader 循环读，超 maxBytes 即停并 abort 连接，
*    `bytes` 为实收字节数，`text()` 解码已收内容。
*
* 非 2xx 是「数据」不是异常：status 如实上呈，不抛 EngineError。
* @module webstack/safety/outbound
*/
/** 协议白名单：出站仅允许 http/https（Mimosa 硬性约束）。 */
const OUTBOUND_PROTOCOLS = ["http:", "https:"];
/** 版本化客户端标识前缀；版本号与包版本同步由测试锁定（W-B-116）。 */
const USER_AGENT_PRODUCT = "webstack";
/** 重定向跳数上限（≤5 跳；第 6 个 3xx 响应即拒绝）。 */
const MAX_REDIRECT_HOPS = 5;
/** 单跳默认超时预算（毫秒）；每跳独立计时。 */
const DEFAULT_TIMEOUT_MS = 8e3;
/** 安全取 origin；不可解析时返回空串。 */
function safeOrigin(url) {
	try {
		return new URL(url).origin;
	} catch {
		return "";
	}
}
/** 判定请求头是否携带 Authorization（大小写不敏感）。 */
function hasAuthorization(headers) {
	return Object.keys(headers).some((key) => key.toLowerCase() === "authorization");
}
/** 返回剔除 Cookie/Authorization 后的头副本（跨源跳转防凭据泄漏）。 */
function stripSensitiveHeaders(headers) {
	const out = {};
	for (const [key, value] of Object.entries(headers)) {
		const lower = key.toLowerCase();
		if (lower === "authorization" || lower === "cookie") continue;
		out[key] = value;
	}
	return out;
}
/**
* G4 有界读体：reader 循环累计至 maxBytes 即停；截断时 abort 掉底层连接
* 防止继续下载。返回实收字节、解码缓存与是否被截断。
*/
async function readBounded(res, maxBytes, stop) {
	const chunks = [];
	let received = 0;
	let overBound = false;
	const reader = res.body?.getReader();
	if (reader === void 0) {
		const buf = new Uint8Array(await res.arrayBuffer());
		if (buf.byteLength > maxBytes) {
			chunks.push(buf.subarray(0, maxBytes));
			received = maxBytes;
			overBound = true;
		} else {
			chunks.push(buf);
			received = buf.byteLength;
		}
	} else {
		for (;;) {
			const { done, value } = await reader.read();
			if (done || value === void 0) break;
			const remaining = maxBytes - received;
			if (remaining <= 0) {
				overBound = true;
				break;
			}
			if (value.byteLength > remaining) {
				chunks.push(value.subarray(0, remaining));
				received += remaining;
				overBound = true;
				break;
			}
			chunks.push(value);
			received += value.byteLength;
		}
		reader.releaseLock();
	}
	if (overBound) stop.abort();
	const merged = new Uint8Array(received);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk.subarray(0, Math.min(chunk.byteLength, received - offset)), offset);
		offset += chunk.byteLength;
		if (offset >= received) break;
	}
	const decoder = new TextDecoder("utf-8", { fatal: false });
	return {
		bytes: received,
		text: decoder.decode(merged)
	};
}
/**
* 统一出站客户端：全插件唯一下网络通道（引擎适配器一律经此发请求）。
*
* 错误语义（冻结）：非 2xx 正常返回（status 如实），仅网络层异常抛
* EngineError——`ssrf-blocked`（G1/G2/G3 任一拒绝或 DNS 失败）、`aborted`
* （caller 中止）、`transport`（超时/DNS 外网络故障/重定向超限/Location 非法）。
* @param req  出站请求（url/maxBytes 必填）
* @param opts 可选豁免表：透传给 G2（host:port 与 CIDR），永不影响 G1/G3/G4
*/
async function outboundFetch(req, opts) {
	if (req.signal?.aborted) throw engineError("aborted", "outbound request aborted before start", {});
	const exemptions = opts?.exemptions;
	let currentUrl = req.url;
	let headers = req.headers === void 0 ? {} : { ...req.headers };
	const hadAuthHeader = hasAuthorization(headers);
	let hop = 0;
	for (;;) {
		let verdict;
		try {
			verdict = await checkTarget(currentUrl, exemptions);
		} catch (cause) {
			throw engineError("ssrf-blocked", `target dns resolution failed: ${redactUrl(currentUrl)}`, {
				detail: "dns-resolution-failed",
				cause
			});
		}
		if (!verdict.allowed) {
			const detail = verdict.reasonCode ?? "unknown-reason";
			throw engineError("ssrf-blocked", `blocked by ${verdict.gate ?? "G1-static"}: ${detail}`, { detail });
		}
		const stop = new AbortController();
		const signals = [AbortSignal.timeout(req.timeoutMs ?? 8e3), stop.signal];
		if (req.signal !== void 0) signals.unshift(req.signal);
		const composed = AbortSignal.any(signals);
		let res;
		try {
			res = await globalThis.fetch(currentUrl, {
				method: req.method ?? "GET",
				headers,
				redirect: "manual",
				signal: composed
			});
		} catch (thrown) {
			if (req.signal?.aborted) throw engineError("aborted", "outbound request aborted by caller", {});
			if (composed.aborted && !stop.signal.aborted) throw engineError("transport", `outbound request timed out after ${req.timeoutMs ?? 8e3}ms`, {
				detail: "timeout",
				cause: thrown
			});
			throw engineError("transport", `network failure fetching ${safeOrigin(currentUrl)}`, { cause: thrown });
		}
		const location = res.headers.get("location");
		if (!(res.status >= 300 && res.status < 400 && location !== null)) {
			const bounded = await readBounded(res, req.maxBytes, stop);
			return {
				status: res.status,
				finalUrl: currentUrl,
				headers: Object.fromEntries(res.headers.entries()),
				bytes: bounded.bytes,
				text: async () => bounded.text
			};
		}
		if (hop >= 5) throw engineError("transport", `redirect limit exceeded (5 hops) at ${safeOrigin(currentUrl)}`, { detail: "redirect-limit-exceeded" });
		res.body?.cancel().catch(() => void 0);
		let nextUrl;
		try {
			nextUrl = new URL(location, currentUrl).toString();
		} catch (cause) {
			throw engineError("transport", `invalid Location header: ${scrubText(location.slice(0, 256))}`, { cause });
		}
		await assertSafeRedirect(currentUrl, nextUrl, hadAuthHeader, exemptions);
		if (safeOrigin(nextUrl) !== safeOrigin(currentUrl)) headers = stripSensitiveHeaders(headers);
		currentUrl = nextUrl;
		hop++;
	}
}
//#endregion
export { DEFAULT_TIMEOUT_MS, MAX_REDIRECT_HOPS, OUTBOUND_PROTOCOLS, USER_AGENT_PRODUCT, outboundFetch };
