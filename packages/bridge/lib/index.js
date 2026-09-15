import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
//#region src/render.ts
var BridgeRenderer = class {
	deps;
	queueTail = Promise.resolve();
	constructor(deps) {
		this.deps = deps;
	}
	/** 装配层后置注入 SSRF 校验器（如 peer 动态加载成功后的回填）。 */
	setTargetChecker(checkTarget) {
		this.deps = {
			...this.deps,
			checkTarget
		};
	}
	get online() {
		return this.deps.server.isConnected();
	}
	/** 断连回调直通底层通道（内核降级 site: 搜索的触发点）。 */
	onDisconnect(listener) {
		return this.deps.server.onDisconnect(listener);
	}
	/**
	* 串行渲染：并发调用按到达顺序排队；单个任务的超时/失败不传染后续。
	* 返回 undefined = 本次桥接不可用（含 SSRF 拒绝），调用方走降级链。
	*/
	render(url, timeoutMs) {
		const job = this.queueTail.then(() => this.runOnce(url, timeoutMs));
		this.queueTail = job.then(() => void 0, () => void 0);
		return job;
	}
	async runOnce(url, timeoutMs) {
		const checkTarget = this.deps.checkTarget;
		if (checkTarget === void 0) return void 0;
		let verdict;
		try {
			verdict = await checkTarget(url);
		} catch {
			return;
		}
		if (!verdict.allowed) return void 0;
		return this.deps.server.requestRender(url, timeoutMs);
	}
};
//#endregion
//#region src/protocol.ts
/** 一次性配对 ticket 有效期（毫秒）。 */
const DEFAULT_TICKET_TTL_MS = 6e4;
/** 心跳 ping 间隔（毫秒）。 */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 2e4;
/** 连续无 pong 判死窗口（毫秒）；实际断开最迟滞后一个心跳周期。 */
const DEFAULT_PONG_TIMEOUT_MS = 6e4;
/**
* 关闭码闭集（扩展侧据此决定是否重连提示）：
* - 4001 配对被拒（ticket 缺失/过期/重复消费/格式非法）——不可重连；
* - 4002 协议违规（非 JSON / id 缺失 / 握手前杂讯 / 未知类型）——不可重连；
* - 4003 认证失败（key 与已配对哈希不符，或尚无已配对键）——不可重连。
* 三者均为「配置或凭据问题」，自动重连只会反复撞墙，故统一要求人工介入。
*/
const CLOSE_PAIR_REJECTED = 4001;
const CLOSE_PROTOCOL_VIOLATION = 4002;
const CLOSE_AUTH_FAILED = 4003;
//#endregion
//#region src/server.ts
/**
* BridgeServer（W-B-58 宿主侧）：MV3 扩展借真实浏览器会话做渲染兜底的
* 回环 WS 服务。安全模型四支柱：
*
* 1. 只绑 127.0.0.1 随机端口——外网不可达，内网其他用户会话仍是边界；
* 2. 升级闸：Origin 必须是 `chrome-extension://*` 或**缺失**。取舍说明：
*    MV3 service worker 发起的 WebSocket 历史上可以不带 Origin 头，强求
*    Origin 会把合法 SW 客户端一并拒掉；而恶意网页受浏览器同源策略约束
*    必然带自身 Origin 落入拒绝分支。Sec-Fetch-* 不作硬性要求（非所有
*    客户端栈都会附带）。真正的访问控制在配对协议层，不在升级头。
* 3. 配对协议：一次性短时效 ticket（60s、单次消费）换长期 key；明文 key
*    **只此一次**下发，服务端从此只存 sha256(key)——宿主进程内存/日志/
*    快照中不存在可复用凭据（W-B-55 同源原则）。ticket 本身同样只存哈希。
* 4. 心跳看门狗：20s ping / 60s 无 pong 判死（判死粒度滞后至多一个心跳
*    周期），半开连接不悬挂渲染请求。
*
* ACK 纪律：每个请求帧必须携带整数 id，响应原样回显；render-req 的 id 在
* 服务端全局单调自增，客户端回包 id 不匹配的一律静默忽略（迟到包）。
*
* cookie 零落盘宿主：渲染发生在扩展所在的真实浏览器会话里，cookie/
* localStorage 永不离开浏览器进程；宿主只接收提取后的正文文本。
*
* @module webstack-bridge/server
*/
/**
* 回环桥接服务器。生命周期：`start()` → 扩展 pair/auth → `requestRender()`
* 往返 → `stop()`。断连语义：已认证连接关闭时，在途渲染全部以 undefined
* 结算并触发 onDisconnect（内核据此降级 site: 搜索）。
*/
var BridgeServer = class {
	opts;
	/** 仅在 start() 后赋值；TS-private 保持运行时可枚举以便测试深扫描存储面。 */
	httpServer;
	wss;
	/** ticket 只存 sha256(ticket) → 记录；消费即删除。 */
	tickets = /* @__PURE__ */ new Map();
	/** 已配对长期键的唯一哈希；重新配对即轮换（旧 key 立即失效）。 */
	pairedKeyHash = null;
	socketStates = /* @__PURE__ */ new Map();
	readySockets = /* @__PURE__ */ new Set();
	pendingRenders = /* @__PURE__ */ new Map();
	outboundId = 0;
	readyListeners = /* @__PURE__ */ new Set();
	disconnectListeners = /* @__PURE__ */ new Set();
	started = false;
	stopped = false;
	constructor(options) {
		this.opts = {
			issueTicket: options.issueTicket,
			host: options.host ?? "127.0.0.1",
			ticketTtlMs: options.ticketTtlMs ?? 6e4,
			heartbeatIntervalMs: options.heartbeatIntervalMs ?? 2e4,
			pongTimeoutMs: options.pongTimeoutMs ?? 6e4
		};
		this.httpServer = createServer((_req, res) => {
			res.writeHead(404, { connection: "close" });
			res.end();
		});
		this.wss = new WebSocketServer({ noServer: true });
		this.httpServer.on("upgrade", (req, socket, head) => {
			this.handleUpgrade(req, socket, head);
		});
	}
	/** 监听 127.0.0.1 随机端口（listen(0)，由内核分配避免冲突）。 */
	async start() {
		if (this.started || this.stopped) return;
		this.started = true;
		await new Promise((resolve, reject) => {
			const onError = (err) => reject(err);
			this.httpServer.once("error", onError);
			this.httpServer.listen(0, this.opts.host, () => {
				this.httpServer.removeListener("error", onError);
				resolve();
			});
		});
	}
	/** 幂等停止：断连接、结算在途渲染、清票据与定时器、释放端口。 */
	async stop() {
		if (this.stopped) return;
		this.stopped = true;
		for (const [socket, state] of [...this.socketStates]) {
			this.clearHeartbeat(state);
			try {
				socket.terminate();
			} catch {}
		}
		for (const [id, pending] of [...this.pendingRenders]) {
			this.clearPendingTimer(pending);
			this.pendingRenders.delete(id);
			pending.resolve(void 0);
		}
		this.tickets.clear();
		this.readySockets.clear();
		await new Promise((resolve) => {
			let settled = false;
			const done = () => {
				if (!settled) {
					settled = true;
					resolve();
				}
			};
			this.httpServer.close(done);
			this.wss.close(done);
		});
	}
	/** 随机端口；未启动或已停止后为 undefined。 */
	getPort() {
		const address = this.httpServer.address();
		return typeof address === "object" && address !== null ? address.port : void 0;
	}
	/** 当前是否存在已配对（ready）连接。 */
	isConnected() {
		return this.readySockets.size > 0;
	}
	/**
	* 签发一次性 ticket：明文经返回值交给装配层（apply 里打进日志），服务端
	* 只落 sha256 哈希与过期时间。
	*/
	issueTicket() {
		const ticket = this.opts.issueTicket();
		const digest = sha256(ticket);
		this.tickets.set(digest, {
			expiresAt: Date.now() + this.opts.ticketTtlMs,
			consumed: false
		});
		return ticket;
	}
	/** 连接就绪（pair 或 auth 成功）回调；返回注销函数。 */
	onReady(listener) {
		this.readyListeners.add(listener);
		return () => {
			this.readyListeners.delete(listener);
		};
	}
	/** 已认证连接断开回调（内核降级信号）；返回注销函数。 */
	onDisconnect(listener) {
		this.disconnectListeners.add(listener);
		return () => {
			this.disconnectListeners.delete(listener);
		};
	}
	/**
	* 向当前 ready 连接发 render-req 并等待 render-res；无连接、发送失败、
	* 超时、对端 ok=false、连接中断一律 resolve undefined（调用方降级），
	* 绝不抛错——桥的不可用是「数据」不是异常。
	*/
	requestRender(url, timeoutMs) {
		const socket = this.pickReadySocket();
		if (socket === void 0) return Promise.resolve(void 0);
		const id = ++this.outboundId;
		const frame = JSON.stringify({
			type: "render-req",
			id,
			url,
			timeoutMs
		});
		try {
			socket.send(frame);
		} catch {
			return Promise.resolve(void 0);
		}
		return new Promise((resolve) => {
			const pending = {
				socket,
				resolve
			};
			pending.timer = setTimeout(() => {
				this.pendingRenders.delete(id);
				resolve(void 0);
			}, Math.max(1, timeoutMs));
			this.pendingRenders.set(id, pending);
		});
	}
	handleUpgrade(req, socket, head) {
		const origin = req.headers.origin;
		if (origin !== void 0 && !origin.startsWith("chrome-extension://")) {
			socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
			socket.destroy();
			return;
		}
		this.wss.handleUpgrade(req, socket, head, (ws) => {
			this.handleConnection(ws);
		});
	}
	handleConnection(ws) {
		const state = {
			ready: false,
			lastPongAt: Date.now()
		};
		this.socketStates.set(ws, state);
		state.heartbeatTimer = setInterval(() => {
			this.heartbeatTick(ws, state);
		}, this.opts.heartbeatIntervalMs);
		ws.on("pong", () => {
			state.lastPongAt = Date.now();
		});
		ws.on("message", (data) => {
			this.handleMessage(ws, state, data);
		});
		ws.on("close", () => {
			this.handleClose(ws, state);
		});
		ws.on("error", () => {});
	}
	heartbeatTick(ws, state) {
		if (Date.now() - state.lastPongAt > this.opts.pongTimeoutMs) {
			ws.terminate();
			return;
		}
		try {
			ws.ping();
		} catch {}
	}
	handleClose(ws, state) {
		this.clearHeartbeat(state);
		this.socketStates.delete(ws);
		const wasReady = this.readySockets.delete(ws);
		for (const [id, pending] of [...this.pendingRenders]) if (pending.socket === ws) {
			this.clearPendingTimer(pending);
			this.pendingRenders.delete(id);
			pending.resolve(void 0);
		}
		if (wasReady) for (const listener of [...this.disconnectListeners]) listener();
	}
	handleMessage(ws, state, data) {
		let frame;
		try {
			frame = JSON.parse(String(data));
		} catch {
			this.closeWith(ws, CLOSE_PROTOCOL_VIOLATION, "non-json-frame");
			return;
		}
		if (!isRecord(frame)) {
			this.closeWith(ws, CLOSE_PROTOCOL_VIOLATION, "non-object-frame");
			return;
		}
		const id = frame.id;
		if (!Number.isInteger(id)) {
			this.closeWith(ws, CLOSE_PROTOCOL_VIOLATION, "missing-ack-id");
			return;
		}
		if (!state.ready) {
			this.handleHandshake(ws, state, frame, id);
			return;
		}
		this.handleReadyFrame(ws, frame, id);
	}
	/** 握手态：只认 pair / auth，其余立即断（不重连提示见 protocol.ts 关闭码注释）。 */
	handleHandshake(ws, state, frame, id) {
		const type = frame.type;
		if (type === "pair") {
			const ticket = frame.ticket;
			if (typeof ticket !== "string" || !this.consumeTicket(ticket)) {
				this.closeWith(ws, CLOSE_PAIR_REJECTED, "pair-rejected");
				return;
			}
			const key = randomBytes(32).toString("base64url");
			this.pairedKeyHash = sha256(key);
			this.sendJson(ws, {
				type: "paired",
				id,
				key
			});
			this.markReady(ws, state);
			return;
		}
		if (type === "auth") {
			const key = frame.key;
			if (!(typeof key === "string" && this.pairedKeyHash !== null && timingSafeEq(sha256(key), this.pairedKeyHash))) {
				this.closeWith(ws, CLOSE_AUTH_FAILED, "auth-failed");
				return;
			}
			this.sendJson(ws, {
				type: "auth-ok",
				id
			});
			this.markReady(ws, state);
			return;
		}
		this.closeWith(ws, CLOSE_PROTOCOL_VIOLATION, "handshake-required");
	}
	/** 就绪态：只认 render-res；id 不匹配视为迟到包静默忽略。 */
	handleReadyFrame(ws, frame, id) {
		if (frame.type !== "render-res") {
			this.closeWith(ws, CLOSE_PROTOCOL_VIOLATION, "unknown-type");
			return;
		}
		const pending = this.pendingRenders.get(id);
		if (pending === void 0 || pending.socket !== ws) return;
		this.pendingRenders.delete(id);
		this.clearPendingTimer(pending);
		if (frame.ok === true && typeof frame.content === "string") {
			const statusCodeRaw = frame.statusCode;
			const statusCode = typeof statusCodeRaw === "number" && Number.isInteger(statusCodeRaw) ? statusCodeRaw : 0;
			pending.resolve({
				content: frame.content,
				statusCode
			});
		} else pending.resolve(void 0);
	}
	/** 单次消费校验：存在、未过期、未消费 → 标记消费并从存储删除（哈希不留痕）。 */
	consumeTicket(ticket) {
		const digest = sha256(ticket);
		const record = this.tickets.get(digest);
		if (record === void 0) return false;
		this.tickets.delete(digest);
		return !record.consumed && Date.now() <= record.expiresAt;
	}
	markReady(ws, state) {
		state.ready = true;
		this.readySockets.add(ws);
		for (const listener of [...this.readyListeners]) listener();
	}
	pickReadySocket() {
		for (const socket of this.readySockets) if (socket.readyState === WebSocket.OPEN) return socket;
	}
	sendJson(ws, payload) {
		ws.send(JSON.stringify(payload));
	}
	closeWith(ws, code, reason) {
		try {
			ws.close(code, reason);
		} catch {
			ws.terminate();
		}
	}
	clearHeartbeat(state) {
		if (state.heartbeatTimer !== void 0) {
			clearInterval(state.heartbeatTimer);
			delete state.heartbeatTimer;
		}
	}
	clearPendingTimer(pending) {
		if (pending.timer !== void 0) clearTimeout(pending.timer);
	}
};
function sha256(input) {
	return createHash("sha256").update(input, "utf8").digest("hex");
}
/** 常数时间十六进制摘要比较（比较的是哈希，长度恒定 64）。 */
function timingSafeEq(a, b) {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}
function isRecord(value) {
	return typeof value === "object" && value !== null;
}
//#endregion
//#region src/index.ts
/**
* WebStack Bridge (网栈·桥) — browser-bridge satellite, host side.
*
* Cordis entry: starts the loopback BridgeServer and exposes a named `bridge`
* service implementing the webstack SeamBridgeRuntime shape. The extension
* pairs once per host lifetime: take the one-time ticket from the log line
* below, paste it in the extension popup, and keep the returned long-term key
* in extension storage — the host process only ever stores sha256(key)
* (W-B-55 key hygiene; cookies never leave the browser at all).
*
* SSRF 闸复用：checkTarget（G1+G2）来自 peer dsh-webstack，经动态导入
* best-effort 装配；peer 缺席或加载失败时保持 fail-closed（渲染恒 undefined，
* 内核走 site: 搜索降级），绝不裸放行。
*
* @module dsh-webstack-bridge
*/
/** Cordis plugin name used by loader diagnostics (service name = `bridge`). */
const name = "bridge";
/** 无强依赖接缝：web seam / logger 均为可选探测（能力缺失即静默降级）。 */
const inject = [];
/**
* 配置 schema（Standard Schema V1 最小实现）。刻意不依赖 schemastery：
* 本包唯一的运行时依赖预算给了 ws（Node 无内置 WS 服务端），而配置面只有
* 一个布尔开关——字面校验器足够，且让本包保持「monorepo 外可编译、零
* 深路径耦合」的 W-B-05 姿态。
*/
const Config = Object.freeze({ "~standard": {
	version: 1,
	validate(value) {
		const input = typeof value === "object" && value !== null ? value : {};
		if (input.enabled !== void 0 && typeof input.enabled !== "boolean") return { issues: [{ message: "enabled must be a boolean" }] };
		return { value: { enabled: input.enabled ?? true } };
	}
} });
/**
* 日志解析三级回落（与 webstack apply 同款姿态）：
* 1. 宿主注入的 `{info}` 服务对象；
* 2. cordis 内置可调用 LoggerService（`ctx.logger(name).info(...)`）——注意
*    它是 function 形态的对象，「对象探测」会漏掉，必须单独分支；
* 3. console.info 兜底（裸环境/测试）。
*/
function resolveInfo(ctx) {
	let logger;
	try {
		logger = ctx.logger;
	} catch {
		logger = void 0;
	}
	const asObject = typeof logger === "object" && logger !== null ? logger : void 0;
	const method = asObject?.info;
	if (typeof method === "function") return (message) => method.call(asObject, message);
	if (typeof logger === "function") try {
		const named = logger(name);
		if (named && typeof named.info === "function") {
			const info = named.info;
			return (message) => info.call(named, message);
		}
	} catch {}
	return (message) => console.info(message);
}
/**
* Assemble the bridge satellite: start the loopback server, provide the named
* `bridge` service, and emit the one-time pairing ticket through the logger.
* Everything is registered on the calling fiber — disposal stops the server.
*/
function apply(ctx, config = {}) {
	if ((config.enabled ?? true) === false) return;
	const info = resolveInfo(ctx);
	const server = new BridgeServer({ issueTicket: () => randomBytes(24).toString("base64url") });
	const renderer = new BridgeRenderer({ server });
	ctx.provide(name, renderer);
	renderer.onDisconnect(() => {
		info("[webstack-bridge] 扩展连接断开——内核将降级 site: 搜索");
	});
	import("dsh-webstack").then((mod) => {
		const candidate = mod.checkTarget;
		if (typeof candidate === "function") renderer.setTargetChecker(candidate);
	}).catch(() => {});
	ctx.effect(() => {
		server.start().then(() => {
			const port = server.getPort();
			info(`[webstack-bridge] ws://127.0.0.1:${port} pairing ticket(60s, single-use): ${server.issueTicket()}`);
		}).catch((err) => {
			info(`[webstack-bridge] start failed: ${String(err)}`);
		});
		return () => {
			server.stop();
		};
	});
}
//#endregion
export { BridgeRenderer, BridgeServer, CLOSE_AUTH_FAILED, CLOSE_PAIR_REJECTED, CLOSE_PROTOCOL_VIOLATION, Config, DEFAULT_HEARTBEAT_INTERVAL_MS, DEFAULT_PONG_TIMEOUT_MS, DEFAULT_TICKET_TTL_MS, apply, inject, name };
