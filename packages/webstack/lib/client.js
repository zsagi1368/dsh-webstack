window.__ModuleLoader__.load({ id: 'webstack', factory: (require) => { var module = { exports: {} }; var exports = module.exports;
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
let _deepseek_ai_dsh_client_store = require("@deepseek-ai/dsh-client-store");
let react = require("react");
let react_jsx_runtime = require("react/jsx-runtime");
//#region src/settings/schema.ts
/**
* 默认配置快照（与分册 04 §1 schema 总表一致的全键集）。
* 数值语义：fusion 三参为融合排序权重；cache.ttl*Min 与缓存分域 TTL 表
* 对齐（search 10min / fetch 60min）。
*/
const DEFAULT_SETTINGS = Object.freeze({
	enabled: true,
	search: {
		layer: "free",
		autoFallback: true,
		maxResults: 8,
		fusion: {
			enabled: true,
			/** 时效半衰期（小时）：越旧命中衰减越多。 */
			timeDecayHalfLifeH: 24,
			/** 权威域加成系数。 */
			authorityBoost: 1,
			/** 同域重复结果折价系数。 */
			diversityDiscount: .85
		},
		/** 查询复杂度分档路由（W-B-14）开关。 */
		complexityRouting: true
	},
	fetch: {
		pipeline: "t1",
		defaultMode: "raw",
		maxContentChars: 12e3
	},
	mode: { sessionOnline: "off" },
	cache: {
		enabled: true,
		ttlSearchMin: 10,
		ttlFetchMin: 60,
		persist: "memory"
	},
	safety: { ssrfExempts: [] },
	/** 引擎级覆盖表：键 = engineId；增删需重载插件（见 HOT_RELOADABLE）。 */
	engines: {},
	/** 启用的 MCP server 名单；增删需重载插件。 */
	mcpServers: [],
	verticals: {
		/** 垂直卫星包总闸（实验性）：默认关闭，须用户显式开启。 */
		packEnabled: false,
		/** 逐频道开关：全部默认关闭，且受 packEnabled 总闸约束。 */
		channels: { x: false },
		/** 站选定制源规则（F-203）：抓取入口 host 最长后缀命中后优先选择器抽取。 */
		selectorRules: []
	},
	advanced: {
		/** hints 提取词表语言：'auto' 跟随查询语言，或固定 'zh'/'en'。 */
		hintsLocale: "auto",
		/**
		* Windows 系统代理兜底（默认 false）：开启后 activate 早期探测一次
		* 系统代理并注入 HTTPS_PROXY/HTTP_PROXY（尽力而为层，见 safety/winproxy）。
		*/
		winProxyFallback: false
	}
});
Object.freeze({
	enabled: true,
	"search.layer": true,
	"search.autoFallback": true,
	"search.maxResults": true,
	"search.fusion.enabled": true,
	"search.fusion.timeDecayHalfLifeH": true,
	"search.fusion.authorityBoost": true,
	"search.fusion.diversityDiscount": true,
	"search.complexityRouting": true,
	"fetch.pipeline": true,
	"fetch.defaultMode": true,
	"fetch.maxContentChars": true,
	"mode.sessionOnline": true,
	"cache.enabled": true,
	"cache.ttlSearchMin": true,
	"cache.ttlFetchMin": true,
	"cache.persist": true,
	"safety.ssrfExempts": true,
	engines: false,
	mcpServers: false,
	"verticals.packEnabled": true,
	"verticals.channels.x": true,
	"verticals.selectorRules": true,
	"advanced.hintsLocale": true,
	"advanced.winProxyFallback": true
});
//#endregion
//#region src/client/draft-state.ts
/** 路由层合法字面值（与 kernel/types.ts SearchLayer 一致，此处本地镜像避免类型耦合）。 */
const LAYERS = [
	"native",
	"free",
	"api",
	"selfhosted",
	"mcp"
];
/**
* host:port 单行格式校验：主机名为域名标签序列 / IPv4 点分十进制 /
* `localhost`，端口必填且落在 1–65535。CIDR 与裸主机名不在卡片编辑面
* （组合入口配置档负责），此处从严——拒绝即高亮，不静默改写。
*/
function isValidSsrfLine(raw) {
	const line = raw.trim();
	const at = line.lastIndexOf(":");
	if (at <= 0 || at === line.length - 1) return false;
	const host = line.slice(0, at);
	const portText = line.slice(at + 1);
	if (!/^\d{1,5}$/.test(portText)) return false;
	const port = Number.parseInt(portText, 10);
	if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
	if (host === "localhost") return true;
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
	const label = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
	return host.split(".").every((part) => label.test(part));
}
/** 行文本 → 豁免数组：去空白行、trim、按首次出现去重。 */
function parseSsrfExempts(text) {
	const seen = /* @__PURE__ */ new Set();
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line !== "") seen.add(line);
	}
	return [...seen];
}
const NUMERIC_FIELDS = /* @__PURE__ */ new Set([
	"maxResults",
	"timeDecayHalfLifeH",
	"authorityBoost",
	"diversityDiscount",
	"maxContentChars"
]);
function validateShape(draft) {
	const issues = [];
	if (!Number.isInteger(draft.maxResults) || draft.maxResults < 1 || draft.maxResults > 50) issues.push({
		field: "maxResults",
		message: "errMaxResults"
	});
	if (!Number.isInteger(draft.timeDecayHalfLifeH) || draft.timeDecayHalfLifeH < 1 || draft.timeDecayHalfLifeH > 8760) issues.push({
		field: "timeDecayHalfLifeH",
		message: "errHalfLife"
	});
	if (!(draft.authorityBoost >= 0 && draft.authorityBoost <= 10)) issues.push({
		field: "authorityBoost",
		message: "errAuthority"
	});
	if (!(draft.diversityDiscount >= 0 && draft.diversityDiscount <= 1)) issues.push({
		field: "diversityDiscount",
		message: "errDiversity"
	});
	if (!Number.isInteger(draft.maxContentChars) || draft.maxContentChars < 200 || draft.maxContentChars > 8e6) issues.push({
		field: "maxContentChars",
		message: "errMaxContentChars"
	});
	if (parseSsrfExempts(draft.ssrfExemptsText).some((line) => !isValidSsrfLine(line))) issues.push({
		field: "ssrfExemptsText",
		message: "errSsrfLine"
	});
	if (!LAYERS.includes(draft.layer)) issues.push({
		field: "layer",
		message: "errLayer"
	});
	return issues;
}
function sameShape(a, b) {
	return a.enabled === b.enabled && a.layer === b.layer && a.autoFallback === b.autoFallback && a.maxResults === b.maxResults && a.fusionEnabled === b.fusionEnabled && a.timeDecayHalfLifeH === b.timeDecayHalfLifeH && a.authorityBoost === b.authorityBoost && a.diversityDiscount === b.diversityDiscount && a.maxContentChars === b.maxContentChars && a.ssrfExemptsText === b.ssrfExemptsText;
}
/** 以 committed 基线构造 clean 相。 */
function cleanDraft(committed) {
	return {
		phase: "clean",
		draft: { ...committed },
		committed: { ...committed }
	};
}
/**
* 唯一迁移入口。saving 相闸掉 load/edit/discard/save（写入在途不允许旁路
* 变更）；save 只接受「合法的 dirty」或「failed 重试」；saveSuccess 把草稿
* 升格为已提交基线并回到 clean。
*/
function reduceDraft(state, event) {
	switch (event.type) {
		case "load":
			if (state.phase === "saving") return state;
			return cleanDraft(event.value);
		case "edit": {
			if (state.phase === "saving") return state;
			const next = { ...state.draft };
			const { field, value } = event;
			if (typeof value === "boolean") next[field] = value;
			else if (NUMERIC_FIELDS.has(field)) {
				const parsed = typeof value === "number" ? value : Number.parseFloat(value);
				if (!Number.isFinite(parsed)) return {
					...state,
					phase: "invalid"
				};
				next[field] = parsed;
			} else if (field === "layer") {
				const layer = String(value);
				if (!LAYERS.includes(layer)) return {
					...state,
					phase: "invalid"
				};
				next.layer = layer;
			} else next.ssrfExemptsText = String(value);
			if (sameShape(next, state.committed)) return cleanDraft(state.committed);
			return {
				phase: validateShape(next).length > 0 ? "invalid" : "dirty",
				draft: next,
				committed: state.committed
			};
		}
		case "discard":
			if (state.phase === "saving") return state;
			return cleanDraft(state.committed);
		case "save":
			if (state.phase === "dirty" || state.phase === "failed") {
				if (validateShape(state.draft).length > 0) return state;
				return {
					...state,
					phase: "saving"
				};
			}
			return state;
		case "saveSuccess":
			if (state.phase !== "saving") return state;
			return cleanDraft(state.draft);
		case "saveFailure":
			if (state.phase !== "saving") return state;
			return {
				...state,
				phase: "failed"
			};
	}
}
/** 卡片按钮/提示用的派生只读量。 */
function draftIssues(state) {
	return validateShape(state.draft);
}
function canSave(state) {
	return (state.phase === "dirty" || state.phase === "failed") && validateShape(state.draft).length === 0;
}
/** 宿主设置 section（嵌套结构，缺字段回落默认）→ 扁平形状。 */
function shapeFromSection(section, fallback) {
	const root = typeof section === "object" && section !== null ? section : {};
	const search = root.search ?? {};
	const fusion = search.fusion ?? {};
	const fetchNode = root.fetch ?? {};
	const safety = root.safety ?? {};
	const num = (value, alt) => typeof value === "number" && Number.isFinite(value) ? value : alt;
	const bool = (value, alt) => typeof value === "boolean" ? value : alt;
	const layer = LAYERS.includes(search.layer) ? search.layer : fallback.layer;
	const exempts = Array.isArray(safety.ssrfExempts) ? safety.ssrfExempts.filter((entry) => typeof entry === "string") : [];
	return {
		enabled: bool(root.enabled, fallback.enabled),
		layer,
		autoFallback: bool(search.autoFallback, fallback.autoFallback),
		maxResults: num(search.maxResults, fallback.maxResults),
		fusionEnabled: bool(fusion.enabled, fallback.fusionEnabled),
		timeDecayHalfLifeH: num(fusion.timeDecayHalfLifeH, fallback.timeDecayHalfLifeH),
		authorityBoost: num(fusion.authorityBoost, fallback.authorityBoost),
		diversityDiscount: num(fusion.diversityDiscount, fallback.diversityDiscount),
		maxContentChars: num(fetchNode.maxContentChars, fallback.maxContentChars),
		ssrfExemptsText: exempts.length > 0 ? `${exempts.join("\n")}\n` : fallback.ssrfExemptsText
	};
}
/** 草稿与基线的差异 → 宿主点路径写入清单（顺序稳定，供 scope.set 逐条排队）。 */
function diffToWrites(draft, committed) {
	const writes = [];
	if (draft.enabled !== committed.enabled) writes.push({
		field: "enabled",
		value: draft.enabled
	});
	if (draft.layer !== committed.layer) writes.push({
		field: "search.layer",
		value: draft.layer
	});
	if (draft.autoFallback !== committed.autoFallback) writes.push({
		field: "search.autoFallback",
		value: draft.autoFallback
	});
	if (draft.maxResults !== committed.maxResults) writes.push({
		field: "search.maxResults",
		value: draft.maxResults
	});
	if (draft.fusionEnabled !== committed.fusionEnabled) writes.push({
		field: "search.fusion.enabled",
		value: draft.fusionEnabled
	});
	if (draft.timeDecayHalfLifeH !== committed.timeDecayHalfLifeH) writes.push({
		field: "search.fusion.timeDecayHalfLifeH",
		value: draft.timeDecayHalfLifeH
	});
	if (draft.authorityBoost !== committed.authorityBoost) writes.push({
		field: "search.fusion.authorityBoost",
		value: draft.authorityBoost
	});
	if (draft.diversityDiscount !== committed.diversityDiscount) writes.push({
		field: "search.fusion.diversityDiscount",
		value: draft.diversityDiscount
	});
	if (draft.maxContentChars !== committed.maxContentChars) writes.push({
		field: "fetch.maxContentChars",
		value: draft.maxContentChars
	});
	if (draft.ssrfExemptsText !== committed.ssrfExemptsText) writes.push({
		field: "safety.ssrfExempts",
		value: parseSsrfExempts(draft.ssrfExemptsText)
	});
	return writes;
}
//#endregion
//#region src/client/input-toggle.tsx
/** 三态循环序。 */
const ONLINE_MODE_CYCLE = [
	"off",
	"on",
	"ask"
];
/** 循环取下一态。 */
function nextOnlineMode(mode) {
	const at = ONLINE_MODE_CYCLE.indexOf(mode);
	return ONLINE_MODE_CYCLE[(at + 1) % ONLINE_MODE_CYCLE.length] ?? "off";
}
const TIP_KEY = {
	off: "tipOff",
	on: "tipOn",
	ask: "tipAsk"
};
const MODE_KEY = {
	off: "modeOff",
	on: "modeOn",
	ask: "modeAsk"
};
function OnlineModeToggle(props) {
	const [mode, setMode] = (0, react.useState)(props.initial ?? "off");
	const click = () => {
		const next = nextOnlineMode(mode);
		if (props.requestChange?.(next) ?? true) setMode(next);
	};
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
		type: "button",
		"data-webstack-online": "",
		"data-mode": mode,
		"aria-pressed": mode !== "off",
		title: mode === "off" && props.requestChange === void 0 ? props.t("tipLocalOnly") : props.t(TIP_KEY[mode]),
		onClick: click,
		children: `${props.t("toggleLabel")}:${props.t(MODE_KEY[mode])}`
	});
}
//#endregion
//#region src/client/locale.ts
/** 设置卡字典命名空间（settings.plugin.item 条目声明 locale 用）。 */
const CARD_NS = "webstack.card";
/** 联网模式按钮字典命名空间（conversation.input.left 条目声明 locale 用）。 */
const TOGGLE_NS = "webstack.toggle";
const cardZh = {
	title: "网栈（WebStack）",
	subtitle: "聚合搜索与抓取内核的运行参数；改动经暂存草稿统一保存。",
	readOnlyBadge: "只读",
	degradedNotice: "当前宿主未暴露可写的设置通道（或偏好为进程内记忆模式），此处仅展示生效值；修改请使用配置档（webstack 段）。",
	fieldEnabled: "总开关",
	fieldLayer: "默认路由层",
	fieldMaxResults: "结果条数上限",
	fieldAutoFallback: "候选展开",
	fieldFusionEnabled: "多引擎融合",
	fieldHalfLife: "时效半衰期（小时）",
	fieldAuthority: "权威域加成",
	fieldDiversity: "同域折价系数",
	fieldMaxContentChars: "抓取字符上限",
	fieldSsrfExempts: "SSRF 豁免清单",
	ssrfHint: "每行一条 host:port，例如 example.com:8443。",
	valueOn: "开启",
	valueOff: "关闭",
	actionSave: "保存",
	actionDiscard: "放弃改动",
	phaseClean: "已同步",
	phaseDirty: "有未保存改动",
	phaseInvalid: "存在校验错误",
	phaseSaving: "正在保存…",
	phaseFailed: "上次保存失败",
	errMaxResults: "结果条数须为 1–50 的整数。",
	errHalfLife: "时效半衰期须为 1–8760 的整数小时。",
	errAuthority: "权威域加成须在 0–10 之间。",
	errDiversity: "同域折价系数须在 0–1 之间。",
	errMaxContentChars: "抓取字符上限须为 200–8000000 的整数。",
	errSsrfLine: "豁免清单每行须为 host:port 格式（端口 1–65535）。",
	errLayer: "路由层取值不合法。"
};
const cardEn = {
	title: "WebStack",
	subtitle: "Runtime parameters of the aggregated search and fetch kernel; edits save via a staged draft.",
	readOnlyBadge: "Read-only",
	degradedNotice: "The host exposes no writable settings channel (or preferences are process-local memory mode). This card shows the effective values only; edit the webstack section of the config profile instead.",
	fieldEnabled: "Master switch",
	fieldLayer: "Default routing layer",
	fieldMaxResults: "Result cap",
	fieldAutoFallback: "Candidate expansion",
	fieldFusionEnabled: "Multi-engine fusion",
	fieldHalfLife: "Recency half-life (hours)",
	fieldAuthority: "Authority boost",
	fieldDiversity: "Same-domain discount",
	fieldMaxContentChars: "Fetch character cap",
	fieldSsrfExempts: "SSRF exemptions",
	ssrfHint: "One host:port per line, e.g. example.com:8443.",
	valueOn: "on",
	valueOff: "off",
	actionSave: "Save",
	actionDiscard: "Discard changes",
	phaseClean: "In sync",
	phaseDirty: "Unsaved changes",
	phaseInvalid: "Validation errors",
	phaseSaving: "Saving…",
	phaseFailed: "Last save failed",
	errMaxResults: "Result cap must be an integer between 1 and 50.",
	errHalfLife: "Recency half-life must be an integer between 1 and 8760 hours.",
	errAuthority: "Authority boost must be within 0-10.",
	errDiversity: "Same-domain discount must be within 0-1.",
	errMaxContentChars: "Fetch character cap must be an integer between 200 and 8000000.",
	errSsrfLine: "Each exemption line must be host:port (port 1-65535).",
	errLayer: "Unknown routing layer value."
};
const toggleZh = {
	toggleLabel: "联网",
	modeOff: "关",
	modeOn: "开",
	modeAsk: "询问",
	tipOff: "联网已关闭：点击切换为始终联网。",
	tipOn: "始终联网：点击切换为每次询问。",
	tipAsk: "每次询问：点击关闭联网。",
	tipLocalOnly: "当前会话本地生效；宿主写入通道不可用。"
};
const toggleEn = {
	toggleLabel: "Web",
	modeOff: "off",
	modeOn: "on",
	modeAsk: "ask",
	tipOff: "Web access is off; click to switch to always-on.",
	tipOn: "Always-on web access; click to switch to ask-every-time.",
	tipAsk: "Asks every time; click to turn web access off.",
	tipLocalOnly: "Effective for this session locally; the host write channel is unavailable."
};
//#endregion
//#region src/client/settings-card.tsx
const PHASE_LABEL_KEY = {
	clean: "phaseClean",
	dirty: "phaseDirty",
	invalid: "phaseInvalid",
	saving: "phaseSaving",
	failed: "phaseFailed"
};
const rowStyle = {
	display: "flex",
	alignItems: "baseline",
	justifyContent: "space-between",
	gap: 12,
	padding: "4px 0"
};
const labelStyle = { flexShrink: 0 };
const inputStyle = {
	flex: "1 1 auto",
	minWidth: 0,
	boxSizing: "border-box"
};
function BoolRow(props) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
		style: rowStyle,
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
			style: labelStyle,
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
					type: "checkbox",
					checked: props.value,
					disabled: props.disabled,
					onChange: (event) => props.onChange(event.target.checked)
				}),
				" ",
				props.label
			]
		})
	});
}
function NumRow(props) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		style: rowStyle,
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
			style: labelStyle,
			children: props.label
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
			style: inputStyle,
			type: "number",
			value: String(props.value),
			disabled: props.disabled,
			onChange: (event) => props.onEdit(props.field, event.target.value)
		})]
	});
}
/**
* 设置卡组件。纯展示层：一切数据经 useWebstackCard 选择器读视图快照，
* 一切变更经 editField/save/discard 回调上行——组件自身零副作用。
*/
function WebstackSettingsCard(props) {
	const view = props.useWebstackCard((snapshot) => snapshot);
	const machine = view.machine;
	const issues = draftIssues(machine);
	const editable = !view.readOnly && machine.phase !== "saving";
	const phaseLabel = props.t(PHASE_LABEL_KEY[machine.phase]);
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
		"data-webstack-card": "",
		"data-phase": machine.phase,
		"data-readonly": view.readOnly,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
				style: {
					display: "flex",
					alignItems: "center",
					gap: 8
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: props.t("title") }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: phaseLabel }),
					view.readOnly ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: props.t("readOnlyBadge") }) : null
				]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: props.t("subtitle") }),
			view.readOnly ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				"data-webstack-degraded": "",
				children: props.t("degradedNotice")
			}) : null,
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(BoolRow, {
					label: props.t("fieldEnabled"),
					value: (view.readOnly ? machine.committed : machine.draft).enabled,
					onChange: (next) => props.editField("enabled", next),
					disabled: !editable
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: rowStyle,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: labelStyle,
						children: props.t("fieldLayer")
					}), view.readOnly ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: machine.committed.layer }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
						style: inputStyle,
						value: machine.draft.layer,
						disabled: !editable,
						onChange: (event) => props.editField("layer", event.target.value),
						children: LAYERS.map((layer) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: layer,
							children: layer
						}, layer))
					})]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(NumRow, {
					label: props.t("fieldMaxResults"),
					value: (view.readOnly ? machine.committed : machine.draft).maxResults,
					field: "maxResults",
					onEdit: props.editField,
					disabled: !editable
				}),
				!view.readOnly ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(BoolRow, {
						label: props.t("fieldAutoFallback"),
						value: machine.draft.autoFallback,
						onChange: (next) => props.editField("autoFallback", next),
						disabled: !editable
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(BoolRow, {
						label: props.t("fieldFusionEnabled"),
						value: machine.draft.fusionEnabled,
						onChange: (next) => props.editField("fusionEnabled", next),
						disabled: !editable
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(NumRow, {
						label: props.t("fieldHalfLife"),
						value: machine.draft.timeDecayHalfLifeH,
						field: "timeDecayHalfLifeH",
						onEdit: props.editField,
						disabled: !editable
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(NumRow, {
						label: props.t("fieldAuthority"),
						value: machine.draft.authorityBoost,
						field: "authorityBoost",
						onEdit: props.editField,
						disabled: !editable
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(NumRow, {
						label: props.t("fieldDiversity"),
						value: machine.draft.diversityDiscount,
						field: "diversityDiscount",
						onEdit: props.editField,
						disabled: !editable
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(NumRow, {
						label: props.t("fieldMaxContentChars"),
						value: machine.draft.maxContentChars,
						field: "maxContentChars",
						onEdit: props.editField,
						disabled: !editable
					})
				] }) : null,
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: { padding: "4px 0" },
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: labelStyle,
						children: props.t("fieldSsrfExempts")
					}), view.readOnly ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
						style: {
							whiteSpace: "pre-wrap",
							margin: "4px 0 0"
						},
						children: machine.committed.ssrfExemptsText.trim() === "" ? "-" : machine.committed.ssrfExemptsText.trim()
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
						style: {
							...inputStyle,
							display: "block",
							width: "100%"
						},
						rows: 3,
						value: machine.draft.ssrfExemptsText,
						disabled: !editable,
						onChange: (event) => props.editField("ssrfExemptsText", event.target.value)
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: props.t("ssrfHint") })] })]
				})
			] }),
			issues.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
				"data-webstack-issues": "",
				children: issues.map((issue) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: props.t(issue.message) }, `${issue.field}:${issue.message}`))
			}) : null,
			!view.readOnly ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("footer", {
				style: {
					display: "flex",
					gap: 8,
					marginTop: 8
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					"data-webstack-save": "",
					disabled: !canSave(machine) || machine.phase === "saving",
					onClick: () => props.save(),
					children: props.t("actionSave")
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					"data-webstack-discard": "",
					disabled: machine.phase === "clean" || machine.phase === "saving",
					onClick: () => props.discard(),
					children: props.t("actionDiscard")
				})]
			}) : null
		]
	});
}
//#endregion
//#region src/client/index.ts
/** 必需服务：槽注册表与字典服务。settingsScope 为软依赖（缺席降级），不入清单。 */
const inject = ["slots", "locale"];
/** 本插件的设置命名空间（宿主 settings.yaml 的 `webstack:` 段）。 */
const SETTINGS_NS = "webstack";
function defaultShape() {
	return {
		enabled: DEFAULT_SETTINGS.enabled,
		layer: DEFAULT_SETTINGS.search.layer,
		autoFallback: DEFAULT_SETTINGS.search.autoFallback,
		maxResults: DEFAULT_SETTINGS.search.maxResults,
		fusionEnabled: DEFAULT_SETTINGS.search.fusion.enabled,
		timeDecayHalfLifeH: DEFAULT_SETTINGS.search.fusion.timeDecayHalfLifeH,
		authorityBoost: DEFAULT_SETTINGS.search.fusion.authorityBoost,
		diversityDiscount: DEFAULT_SETTINGS.search.fusion.diversityDiscount,
		maxContentChars: DEFAULT_SETTINGS.fetch.maxContentChars,
		ssrfExemptsText: ""
	};
}
/** 结构探测 settingsScope 服务；访问未装载服务的属性会抛错而非 undefined。 */
function peekScopeBinder(ctx) {
	try {
		const candidate = ctx.settingsScope;
		if (typeof candidate === "object" && candidate !== null && typeof candidate.bind === "function") return candidate;
		return;
	} catch {
		return;
	}
}
/** 会话在线模式字面值守卫。 */
function asOnlineMode(value) {
	return value === "off" || value === "on" || value === "ask" ? value : void 0;
}
/**
* 客户端组合入口：字典 + 设置卡 + 联网按钮。
* @param ctx - 客户端根上下文。
*/
function apply(ctx) {
	ctx.effect(() => ctx.locale.register(CARD_NS, {
		zh: cardZh,
		en: cardEn
	}), "dsh-webstack: card dictionaries");
	ctx.effect(() => ctx.locale.register(TOGGLE_NS, {
		zh: toggleZh,
		en: toggleEn
	}), "dsh-webstack: toggle dictionaries");
	const view = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)({
		machine: cleanDraft(defaultShape()),
		readOnly: true,
		scopeStatus: "unbound"
	});
	const dispatch = (event) => {
		view.set({
			...view.getSnapshot(),
			machine: reduceDraft(view.getSnapshot().machine, event)
		});
	};
	const binder = peekScopeBinder(ctx);
	let scope;
	if (binder !== void 0) try {
		scope = binder.bind({ namespace: SETTINGS_NS });
	} catch {
		scope = void 0;
	}
	/** scope 快照 → 视图同步（只读位随 writable 翻转）。 */
	const syncFromScope = () => {
		if (scope === void 0) return;
		const snapshot = scope.getSnapshot();
		const machine = reduceDraft(view.getSnapshot().machine, {
			type: "load",
			value: shapeFromSection(snapshot.value, defaultShape())
		});
		view.set({
			machine,
			readOnly: !snapshot.writable,
			scopeStatus: snapshot.status === "unavailable" ? "unavailable" : snapshot.status
		});
	};
	if (scope !== void 0) {
		syncFromScope();
		ctx.effect(() => scope.subscribe(syncFromScope), "dsh-webstack: settings scope mirror");
	}
	const editField = (field, value) => {
		dispatch({
			type: "edit",
			field,
			value
		});
	};
	const save = () => {
		if (scope === void 0) return;
		const before = view.getSnapshot();
		if (before.readOnly || before.machine.phase !== "dirty") return;
		dispatch({ type: "save" });
		const saving = view.getSnapshot().machine;
		if (saving.phase !== "saving") return;
		diffToWrites(saving.draft, saving.committed).reduce((chain, write) => chain.then(() => scope.set(write.field, write.value)), Promise.resolve()).then(() => dispatch({ type: "saveSuccess" }), () => {
			dispatch({ type: "saveFailure" });
			syncFromScope();
		});
	};
	const discard = () => {
		dispatch({ type: "discard" });
	};
	ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
		name: "settings.plugin.item",
		key: SETTINGS_NS,
		locale: CARD_NS,
		inject: () => ({
			hooks: { webstackCard: view },
			editField,
			save,
			discard
		})
	}, WebstackSettingsCard));
	const onlineWritable = () => scope?.getSnapshot().writable === true && scope.getSnapshot().status === "ready" && view.getSnapshot().readOnly === false;
	ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
		name: "conversation.input.left",
		id: "webstack-online-mode",
		order: 30,
		locale: TOGGLE_NS,
		inject: () => ({
			initial: asOnlineMode((scope?.getSnapshot().value)?.mode?.sessionOnline),
			requestChange: onlineWritable() ? (next) => {
				scope?.set("mode.sessionOnline", next);
				return true;
			} : void 0
		})
	}, OnlineModeToggle));
}
//#endregion
exports.apply = apply;
exports.inject = inject;

return module.exports; } });
