//#region src/framework.ts
/** 深冻结工具（webstack freezeDescriptor 同款语义，本地实现防跨包依赖）。 */
function freezeDeep(value) {
	if (typeof value === "object" && value !== null) {
		for (const key of Object.keys(value)) freezeDeep(value[key]);
		Object.freeze(value);
	}
	return value;
}
/**
* 频道注册表：register/list/canRun 三面。同名重复注册按「替换」处理并返回
* 新 disposer（旧 disposer 幂等失效）；list 返回注册顺序快照。
*/
var VerticalRegistry = class {
	channels = /* @__PURE__ */ new Map();
	/**
	* 注册或替换频道；返回 disposer（再次调用幂等无害）。
	* @throws 同一实例重复注册不同对象但同 id 时按替换语义，不抛错。
	*/
	register(channel) {
		this.channels.set(channel.id, channel);
		let active = true;
		return () => {
			if (!active) return;
			active = false;
			if (this.channels.get(channel.id) === channel) this.channels.delete(channel.id);
		};
	}
	/** 注册顺序快照（只读数组副本，外部增删不影响注册表）。 */
	list() {
		return [...this.channels.values()];
	}
	/** 频道存在且 canHandle(hints)=true 才可运行；未知 id 恒 false。 */
	canRun(id, hints) {
		const channel = this.channels.get(id);
		if (channel === void 0) return false;
		try {
			return channel.canHandle(hints);
		} catch {
			return false;
		}
	}
};
//#endregion
//#region src/x-search.ts
/**
* 合规版免凭据 X（Twitter）检索降级链（实验性频道，默认关闭）。
*
* 两腿结构：
* - 腿 1（发现）：经 `deps.search` 免费池回调跑
*   `site:x.com OR site:twitter.com <topic>`，取得结果列表。本腿只消费
*   公开搜索引擎的公开输出，不登录、不绕墙。
* - 腿 2（富化）：对其中 `/status/<id>` 形态的推文 URL 逐个调用**官方公开**
*   oEmbed 端点 `https://publish.twitter.com/oembed`（GET，
*   `omit_script=true&dnt=true`；出站经注入的 outboundFetch——与内核
*   outboundFetch 动态探测同款手法：缺席/非函数视为未接线，静默跳过），
*   用返回 html 的纯文本形态富化 snippet 并记 `provenance.via = 'oembed'`。
*
* 治理纪律：
* - 单飞防重：同主题并发 run 共享同一次执行（in-flight Map）；
* - 每 URL 一次会话内缓存：oEmbed 成败结果均缓存，会话内不重复出站；
* - 两腿全失败返回空数组不抛错；成功路径每条结果如实带 via 标注（W-B-17）
*   与 i18n note 键（W-B-53 键即白名单）。
*
* @module dsh-webstack-verticals/x-search
*/
const X_VERTICAL_ID = "x-vertical";
/** 频道名片：免费档、零凭据、caps.vertical（深冻结防运行期篡改）。 */
const X_VERTICAL_DESCRIPTOR = freezeDeep({
	id: X_VERTICAL_ID,
	kind: "search",
	tier: "free",
	caps: { vertical: true },
	cost: {
		keysRequired: 0,
		quotaHint: "unknown"
	},
	latencyBudgetMs: 6e3
});
/**
* 推文 URL 形态：scheme 可选 http(s)；host 容忍 www./mobile. 前缀；
* 路径必须为 `<handle>/status|statuses/<纯数字 id>`。其余一律非推文。
*/
const TWEET_URL_RE = /^https?:\/\/(?:(?:www|mobile)\.)?(?:x\.com|twitter\.com)\/[A-Za-z0-9_]{1,20}\/status(?:es)?\/\d+(?:[?#]|$)/i;
/** 判定 url 是否推文形态（/status/<id>）。 */
function isTweetUrl(url) {
	return TWEET_URL_RE.test(url.trim());
}
/**
* 从候选列表抽取推文 URL：保序去重。W-B-35 纪律——url 保留首见原样，
* 不做任何规范化改写（带查询串的变体是不同字符串，身份归一只发生在
* 缓存指纹内部）；此处仅对完全相同的字符串按首见保留。
*/
function extractTweetUrls(urls) {
	const seen = /* @__PURE__ */ new Set();
	const out = [];
	for (const raw of urls) {
		const url = raw.trim();
		if (!isTweetUrl(url) || seen.has(url)) continue;
		seen.add(url);
		out.push(url);
	}
	return out;
}
/** 组装腿 1 的 site: 限域双站 OR 查询（硬约束片段直拼 query，ddg 同款语义）。 */
function buildXSearchQuery(topic) {
	return `site:x.com OR site:twitter.com ${topic}`;
}
/** X 官方公开 oEmbed 端点基址。 */
const OEMBED_ENDPOINT = "https://publish.twitter.com/oembed";
/** G4 有界响应体上限：oEmbed JSON 极小，256KB 封顶。 */
const OEMBED_MAX_BYTES = 262144;
/**
* 组装官方 oEmbed GET URL：url 参数整体百分号编码；omit_script/dnt 固定 true
* （消费端自渲染、不做跟踪加载）。
*/
function buildOembedUrl(tweetUrl) {
	return `${OEMBED_ENDPOINT}?url=${encodeURIComponent(tweetUrl)}&omit_script=true&dnt=true`;
}
/** 安全收窄 unknown → 字符串记录。 */
function narrowRecord(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
	return value;
}
/** 安全收窄 unknown → 非空 string（空白串按缺失处理）。 */
function narrowNonEmptyString(value) {
	if (typeof value !== "string") return void 0;
	const trimmed = value.trim();
	return trimmed === "" ? void 0 : trimmed;
}
/**
* 噪声块（script/style）整块剔除正则。在实体解码**前后各跑一遍**：前扫剥
* 原生块，后扫兜住 `&lt;script&gt;…&lt;/script&gt;` 单遍解码即还原的混淆
* 形态（与 webstack extract.stripNoise 同纪律；全局标志配 String.replace
* 每次调用重置，无 lastIndex 状态泄漏）。
*/
const NOISE_BLOCK_RE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
/**
* 白名单实体单遍解码 + 去标签 → 纯文本（engine.stripHtmlToText 同款语义）。
* W10 审计加固：script/style 整块内容体剥离——oEmbed html 即便来自官方端点，
* 也按不可信输入处理，仅剔标签会把 `<script>` 的 JS 源码文本漏进 snippet。
*/
function stripHtmlToText(fragment) {
	return fragment.replace(NOISE_BLOCK_RE, " ").replace(/&(amp|lt|gt|quot|#x27);/g, (_, name) => {
		switch (name) {
			case "amp": return "&";
			case "lt": return "<";
			case "gt": return ">";
			case "quot": return "\"";
			default: return "'";
		}
	}).replace(NOISE_BLOCK_RE, " ").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}
/** 解析 oEmbed JSON 文本；任何异常返回 undefined（数据不是错误 W-B-46）。 */
function parseOembedJson(text) {
	try {
		return narrowRecord(JSON.parse(text));
	} catch {
		return;
	}
}
/** 富化成功后的 provenance.note 键（i18n 键引用，禁止自由文本 W-B-53）。 */
const X_OEMBED_NOTE_KEY = "webstack.verticals.x.degraded-oembed";
/** 腿 1 直通（未经 oEmbed 富化）结果的 via 标注。 */
const VIA_SITE_SEARCH = "site-search";
/** 腿 2 富化结果的 via 标注（任务契约字面值）。 */
const VIA_OEMBED = "oembed";
/**
* X 垂直频道（id `x-vertical`）。实例持有两级状态：
* - `inflight`：主题级单飞锁（并发 run 共享同一 Promise，结算后释放）；
* - `oembedCache`：URL → 富化文本缓存（空串 = 会话内已失败的终局标记，
*   不再重试——「每 URL 一次」的会话纪律）。
* 两级状态均为实例级会话生命周期，随装配层销毁一并丢弃。
*/
var XVerticalChannel = class {
	id = X_VERTICAL_ID;
	inflight = /* @__PURE__ */ new Map();
	oembedCache = /* @__PURE__ */ new Map();
	/**
	* canHandle 判定矩阵（确定性、不打网）：
	* - hints.siteFilter 落在 x.com/twitter.com 及其子域 → 出手；
	* - hard/soft 片段含显式 `site:` 限域或站点指称（x.com/twitter.com）→ 出手；
	* - 其余（含空 hints）→ 不出手，交常规引擎。
	*/
	canHandle(hints) {
		const siteFilter = hints.siteFilter?.toLowerCase().replace(/\.+$/, "");
		if (siteFilter === "x.com" || siteFilter === "twitter.com" || (siteFilter?.endsWith(".x.com") ?? false) || (siteFilter?.endsWith(".twitter.com") ?? false)) return true;
		const corpus = [...hints.hard, ...hints.soft].join(" ");
		return /(?:^|\s)(?:site:)?(?:www\.)?(?:x|twitter)\.com(?:\s|$)/i.test(` ${corpus} `);
	}
	/** 单飞入口：同主题并发共享一次执行；失败路径同样释放锁。 */
	run(req, deps) {
		const topic = req.hints.topic !== void 0 && req.hints.topic !== "" ? req.hints.topic : req.query;
		const existing = this.inflight.get(topic);
		if (existing !== void 0) return existing;
		const job = this.runOnce(req, topic, deps).finally(() => {
			this.inflight.delete(topic);
		});
		this.inflight.set(topic, job);
		return job;
	}
	/** 全链执行：任一环节异常一律收敛为空数组（两腿全失败静默语义）。 */
	async runOnce(req, topic, deps) {
		try {
			const legOne = await deps.search({
				query: buildXSearchQuery(topic),
				hints: {
					...req.hints,
					topic
				},
				count: req.count,
				...req.signal !== void 0 ? { signal: req.signal } : {}
			});
			const outbound = typeof deps.outboundFetch === "function" ? deps.outboundFetch : void 0;
			const seen = /* @__PURE__ */ new Set();
			const out = [];
			for (const hit of legOne) {
				if (out.length >= Math.max(0, req.count)) break;
				if (seen.has(hit.url)) continue;
				seen.add(hit.url);
				out.push(await this.enrich(hit, outbound));
			}
			return out;
		} catch {
			return [];
		}
	}
	/** 单条结果富化：推文 + 出站可用才走腿 2；否则如实标注 site-search 直通。 */
	async enrich(hit, outbound) {
		if (outbound === void 0 || !isTweetUrl(hit.url)) return this.relabel(hit, VIA_SITE_SEARCH);
		let text = this.oembedCache.get(hit.url);
		if (text === void 0) {
			text = await this.fetchOembedText(outbound, hit.url);
			this.oembedCache.set(hit.url, text);
		}
		if (text === "") return this.relabel(hit, VIA_SITE_SEARCH);
		return {
			...hit,
			snippet: text,
			provenance: {
				...hit.provenance,
				via: VIA_OEMBED,
				note: X_OEMBED_NOTE_KEY
			}
		};
	}
	/**
	* 调官方 oEmbed 端点并取纯文本：仅接受 2xx + 可解析 JSON + html 字段；
	* 非 2xx 是「数据」（如实降级），管道故障是异常但在此吞掉换空串。
	*/
	async fetchOembedText(outbound, tweetUrl) {
		try {
			const res = await outbound({
				url: buildOembedUrl(tweetUrl),
				timeoutMs: X_VERTICAL_DESCRIPTOR.latencyBudgetMs,
				maxBytes: OEMBED_MAX_BYTES
			});
			if (res.status < 200 || res.status >= 300) return "";
			const record = parseOembedJson(await res.text());
			if (record === void 0) return "";
			const html = narrowNonEmptyString(record.html);
			if (html === void 0) return "";
			return stripHtmlToText(html);
		} catch {
			return "";
		}
	}
	/** via 重标注：engine 缺失时兜底为本频道 id（W-B-16 出处可解释性）。 */
	relabel(hit, via) {
		const engine = hit.provenance.engine !== "" ? hit.provenance.engine : X_VERTICAL_ID;
		return {
			...hit,
			provenance: {
				...hit.provenance,
				engine,
				via
			}
		};
	}
};
//#endregion
//#region src/cordis.ts
/** Loader/registry 记录名（`registry.ts:322` 取 `plugin.name`）。 */
const name = "dsh-webstack-verticals";
/**
* 无硬注入服务（对齐 f4c 判据「填 inject 即成硬依赖、缺服务装载即挂」）：
* 频道两腿依赖全部经 `VerticalDeps` 在**调用期**显式注入（`run(req, deps)`），
* mount 期不解析任何宿主服务；dsh-webstack peer 缺席也不影响挂载。
*/
const inject = [];
/**
* 挂载 x-vertical 服务：new VerticalRegistry + register(XVerticalChannel) +
* `ctx.provide('x-vertical', service)`；disposer 经 `ctx.effect` 随 fiber 卸载。
* 同名重复 provide 由 cordis 语义处理；本函数返回注册的服务对象便于宿主/测试
* 检视（f4c `mountedFor` 同款意图，此处直接回传、不单设 WeakMap 台账）。
*/
function apply(ctx, config = {}) {
	if ((config.enabled ?? true) === false) return void 0;
	const registry = new VerticalRegistry();
	const channel = new XVerticalChannel();
	const dispose = registry.register(channel);
	const service = {
		registry,
		channel,
		canHandle: (hints) => registry.canRun(X_VERTICAL_ID, hints)
	};
	ctx.provide(X_VERTICAL_ID, service);
	ctx.effect?.(() => dispose, "x-vertical-dispose");
	return service;
}
//#endregion
export { OEMBED_ENDPOINT, OEMBED_MAX_BYTES, VIA_OEMBED, VIA_SITE_SEARCH, VerticalRegistry, XVerticalChannel, X_OEMBED_NOTE_KEY, X_VERTICAL_DESCRIPTOR, X_VERTICAL_ID, apply, buildOembedUrl, buildXSearchQuery, extractTweetUrls, freezeDeep, inject, isTweetUrl, name };
