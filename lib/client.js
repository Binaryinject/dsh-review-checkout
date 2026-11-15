window.__ModuleLoader__.load({
	id: "dsh-review-checkout",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		// The shell's own file-type mark (primitives' FileTypeIcon: full-color brand
		// artwork for code files, category-colored glyphs otherwise). The web boot
		// seeds this package as a STATIC module, so a plain require resolves it — no
		// need to inline the icon set, and the marks stay in sync with the shell.
		// Absent in compositions without it (Desktop, DOM-less smoke tests) -> the
		// letter chip below is the fallback.
		const OfficialFileTypeIcon = (() => {
			try {
				const api = require("@deepseek-ai/dsh-client-ui-primitives");
				return api && typeof api.FileTypeIcon === "function" ? api.FileTypeIcon : null;
			} catch (e) { return null; }
		})();
		// The shell's own hover-preview primitive. The official changed-files card
		// previews its rows with exactly this component (`variant:"preview"` = a
		// height-capped panel placed above or below the hovered row, sized from an
		// anchor element, repositioned on scroll/resize) — so a card row here gets the
		// same popup behaviour instead of a hand-rolled one. Absent in compositions
		// without the primitives module: rows then keep their plain behaviour.
		const OfficialHoverCard = (() => {
			try {
				const api = require("@deepseek-ai/dsh-client-ui-primitives");
				return api && typeof api.HoverCard === "function" ? api.HoverCard : null;
			} catch (e) { return null; }
		})();

		// ── color configuration (persisted to localStorage) ────────────────
		const LS_KEY = "dsh.diff-review.colors";
		// The per-turn card and the running chip are skinned with DSH theme tokens
		// (.cdx-cf-* / .cdx-pill), so the palette below only covers the diff view and
		// the tab badge — there is no "conversation footer" palette any more.
		const LIGHT = { addBg: "#e6ffec", addFg: "#1a7f37", delBg: "#ffebe9", delFg: "#cf222e", ctxBg: "#f6f8fa", gutter: "#57606a", badgeBg: "#0969da", badgeFg: "#ffffff" };
		const DARK = { addBg: "#10251c", addFg: "#7ee787", delBg: "#2d1415", delFg: "#ffa198", ctxBg: "#161b22", gutter: "#8b949e", badgeBg: "#4493f8", badgeFg: "#0d1117" };
		const DEFAULTS = Object.assign({}, LIGHT);
		const COLOR_KEYS = Object.keys(DEFAULTS);
		// Syntax-token and plain-line label colors are theme-derived (no user
		// key): the diff surface uses ctxBg/addBg/delBg, so token colors must
		// flip with the DSH theme to stay readable on both.
		const SYNTAX = {
			light: { kw: "#cf222e", str: "#0a3069", com: "#6e7781", num: "#0550ae" },
			dark: { kw: "#ff7b72", str: "#a5d6ff", com: "#8b949e", num: "#79c0ff" }
		};
		function themeLabel(dark) { return dark ? "#e6edf3" : "#24292f"; }

		function mergeSet(base, obj) {
			const out = Object.assign({}, base);
			if (!obj || typeof obj !== "object") return out;
			let ok = false;
			for (const k of COLOR_KEYS) {
				const parsed = parseColor(obj[k]);
				if (parsed) { out[k] = formatRgba(parsed); ok = true; }
			}
			return ok ? out : base;
		}
		// Two independent color sets (light/dark) + a flat legacy format migration.
		function loadColorSets() {
			const def = { light: Object.assign({}, LIGHT), dark: Object.assign({}, DARK) };
			try {
				const raw = localStorage.getItem(LS_KEY);
				if (!raw) return def;
				const obj = JSON.parse(raw);
				if (!obj || typeof obj !== "object") return def;
				if (obj.light && obj.dark) {
					return { light: mergeSet(LIGHT, obj.light), dark: mergeSet(DARK, obj.dark) };
				}
				// legacy flat shape: treat as the CURRENT theme's set, other = default
				const cur = detectTheme();
				if (cur === "dark") return { light: def.light, dark: mergeSet(DARK, obj) };
				return { light: mergeSet(LIGHT, obj), dark: def.dark };
			} catch (e) {
				return def;
			}
		}
		function saveColorSets(sets) {
			try {
				localStorage.setItem(LS_KEY, JSON.stringify(sets));
			} catch (e) {}
		}

		// ── color value helpers (hex #rrggbb and rgba(r,g,b,a) both supported) ──
		function parseColor(v) {
			if (typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v)) {
				return { r: parseInt(v.slice(1, 3), 16), g: parseInt(v.slice(3, 5), 16), b: parseInt(v.slice(5, 7), 16), a: 1 };
			}
			if (typeof v === "string") {
				const m = v.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+)\s*)?\)$/);
				if (m) {
					const a = m[4] === undefined ? 1 : Number(m[4]);
					return {
						r: Math.min(255, Math.max(0, parseInt(m[1], 10))),
						g: Math.min(255, Math.max(0, parseInt(m[2], 10))),
						b: Math.min(255, Math.max(0, parseInt(m[3], 10))),
						a: Math.min(1, Math.max(0, a))
					};
				}
			}
			return null;
		}
		function formatRgba(c) {
			return "rgba(" + c.r + ", " + c.g + ", " + c.b + ", " + (Math.round(c.a * 100) / 100) + ")";
		}
		function hexOf(c) {
			const pad = (n) => n.toString(16).padStart(2, "0");
			return "#" + pad(c.r) + pad(c.g) + pad(c.b);
		}

		// ── shared store ───────────────────────────────────────────────────
		const EDITOR_LS_KEY = "dsh.diff-review.editor";
		const VIEW_MODE_LS_KEY = "dsh.diff-review.viewMode";
		const FONT_LS_KEY = "dsh.diff-review.font";
		const FONT_DELTA_LS_KEY = "dsh.diff-review.fontDelta";
		// Bounds for the plugin's own font-size offset, in px. 0 = follow DSH.
		const FONT_DELTA_MIN = -4;
		const FONT_DELTA_MAX = 8;
		// Dragged width of the split view's file list (px). Absent = the responsive
		// default (min(270px, 46%) of the pane), so a stale drag never pins a bad
		// width on a much narrower/wider panel.
		const SPLIT_LS_KEY = "dsh.diff-review.splitWidth";
		// 官方 deliverables 的每轮卡片与交付文件卡片也挂在同一个 turnTail 槽里；
		// 默认由本插件接管（隐藏它们），可在设置里恢复。值为 "0" 时显示官方卡片。
		const HIDE_OFFICIAL_LS_KEY = "dsh.diff-review.hideOfficialCards";
		// Pick the color preset matching the DSH theme: the LIGHT preset's pale
		// context lines read as white cards on a dark page — follow the theme.
		// The DSH design platform marks dark mode with `body[data-ds-dark-theme]`
		// (presence = dark, absence = light); older builds only carried the
		// `--dsw-alias-*` tokens. The previously used `--dsw-alias-surface-2`
		// token does not exist in the current token set, so detection silently
		// fell through to the OS `prefers-color-scheme` and never followed the
		// in-app theme switch. Read the marker first, then a real background
		// token's brightness (`--dsw-alias-bg-base`), then the OS preference.
		function bodyThemeMarker() {
			try {
				// The bundle can initialize before <body> exists; that is "unknown"
				// (null), NOT "no marker => light". Returning false here would
				// silently pin the LIGHT set while the real theme is still to be
				// applied by the ThemePresenter, and the MutationObserver only
				// fires on attribute *changes* — so a stale "light" could stick
				// until the 5s poll. Only a mounted, marker-less body means light.
				if (typeof document === "undefined" || document.body === null) return null;
				return document.body.hasAttribute("data-ds-dark-theme");
			} catch (e) { return null; }
		}
		function tokenBrightness(name) {
			try {
				const v = getComputedStyle(document.body).getPropertyValue(name) || "";
				const m = v.match(/\d+/g);
				if (m && m.length >= 3) {
					const r = Number(m[0]), g = Number(m[1]), b = Number(m[2]);
					return (r * 299 + g * 587 + b * 114) / 1000;
				}
			} catch (e) {}
			return null;
		}
		function detectTheme() {
			const marker = bodyThemeMarker();
			if (marker === true) return "dark";
			if (marker === false) return "light";
			for (const token of ["--dsw-alias-bg-base", "--dsw-alias-bg-layer-1"]) {
				const lum = tokenBrightness(token);
				if (lum !== null) return lum < 128 ? "dark" : "light";
			}
			try {
				if (typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
			} catch (e) {}
			return "light";
		}
		const store = {
			files: null, loadingFiles: false,
			selected: null, detail: null, loadingDetail: false, error: null,
			colors: Object.assign({}, DEFAULTS), currentSession: null,
			latestTurn: 0, activeTurn: 0, turnData: null, hostWindow: null,
			// 当前 files 列表的来源：true = 已采纳宿主 summary（宿主对该会话权威），
			// false = 本地转录解析（Desktop / 旧宿主 / 宿主无数据）。
			filesFromHost: false,
			reviewTurn: null, reviewFile: null, reviewScope: "turn",
			// 审查视图模式：split = 左文件列表 + 右详情；cards = 逐文件卡片列表。
			// 持久化到 localStorage——重启/刷新后保持用户选择。
			viewMode: (() => {
				try { return localStorage.getItem(VIEW_MODE_LS_KEY) === "cards" ? "cards" : "split"; }
				catch (e) { return "split"; }
			})(),
			// 左栏（文件列表）宽度：null = 用 CSS 的响应式默认值；
			// 拖过分隔线后记住像素宽度（下次打开仍是这个宽度）。
			splitWidth: (() => {
				try {
					const raw = Number(localStorage.getItem(SPLIT_LS_KEY));
					return Number.isFinite(raw) && raw >= 140 ? Math.round(raw) : null;
				} catch (e) { return null; }
			})(),
			// true（默认）= 用 CSS 隐藏官方 deliverables 的每轮「已编辑 N 个文件」卡片
			//（选择器只打 [data-changed-files]，交付文件卡片不受影响）；false = 两套并存。
			hideOfficialCards: (() => {
				try { return localStorage.getItem(HIDE_OFFICIAL_LS_KEY) !== "0"; }
				catch (e) { return true; }
			})(),
			expanded: {},
			editors: [], editorLoading: false, selectedEditor: null,
			fontChoice: (() => { try { const v = localStorage.getItem(FONT_LS_KEY); return v && v.trim() ? v : null; } catch (e) { return null; } })(),
			fontDelta: (() => { try { return clampFontDelta(Number(localStorage.getItem(FONT_DELTA_LS_KEY)), FONT_DELTA_MIN, FONT_DELTA_MAX); } catch (e) { return 0; } })(),
			fonts: [], fontLoading: false, fontSource: null,
			colorSets: null,
			colorTab: "light",
			themeNow: "light",
			running: false,
			// 审查偏好：与宿主 settings.json 同源。ignoreWhitespace 影响本地兜底 diff
			// 与统计；hideGitIgnored 主要作用在宿主列表上（浏览器跑不了 git check-ignore）。
			reviewPrefs: { ignoreWhitespace: false, hideGitIgnored: true },
			hiddenIgnored: 0
		};
		{
			const sets = loadColorSets();
			store.colorSets = sets;
			store.colorTab = detectTheme();
			store.themeNow = store.colorTab;
			store.colors = sets[store.colorTab];
			try {
				const ed = localStorage.getItem(EDITOR_LS_KEY);
				if (ed) store.selectedEditor = JSON.parse(ed);
			} catch (e) {}
		}
		let lastTheme = detectTheme();
		function syncThemeColors() {
			const t = detectTheme();
			if (t === lastTheme) return;
			lastTheme = t;
			try {
				const sets = store.colorSets || { light: Object.assign({}, LIGHT), dark: Object.assign({}, DARK) };
				// themeNow rides along so components that theme-derive text /
				// syntax colors re-render on the same tick.
				setState({ colors: sets[t], themeNow: t });
			} catch (e) {}
		}
		function updateRunning() {
			try {
				const svc = ctxRef && ctxRef.get ? ctxRef.get("sessions") : null;
				const snap = svc && svc.list && typeof svc.list.getSnapshot === "function" ? svc.list.getSnapshot() : null;
				const sid = store.currentSession;
				const r = !!(snap && snap.byId && sid && snap.byId[sid] && snap.byId[sid].running);
				if (r !== store.running) {
					setState({ running: r });
					// 新一轮开始（idle → running）时立即刷一次历史：activeTurn 依赖
					// 历史窗口里的 turn/start，若只靠 5s 轮询，pill 会在新一轮开头
					// 继续显示上一轮的统计。
					if (r && sid) rebuildReview();
				}
			} catch (e) {}
		}
		const listeners = new Set();
		function clampFontDelta(n, min, max) {
			const v = Math.round(Number(n));
			if (!Number.isFinite(v)) return 0;
			const lo = Number.isFinite(min) ? min : -4;
			const hi = Number.isFinite(max) ? max : 8;
			return Math.min(hi, Math.max(lo, v));
		}
		function fontDeltaLabel(delta) {
			const v = Math.round(Number(delta) || 0);
			if (v === 0) return "跟随";
			return (v > 0 ? "+" : "−") + Math.abs(v);
		}
		function setState(patch) {
			Object.assign(store, patch);
			if (patch.colorSets) saveColorSets(patch.colorSets);
			listeners.forEach((fn) => fn());
		}
		function useStore(selector) {
			const [v, setV] = React.useState(() => selector(store));
			React.useEffect(() => {
				const fn = () => setV(selector(store));
				listeners.add(fn);
				return () => listeners.delete(fn);
			}, []);
			return v;
		}

		// ── fetch sequencing: every async load stamps a token; a stale response
		// (previous session / superseded file) is dropped instead of clobbering the UI
		let reqSeq = 0

		// ── host file-open helper (chat's openFile equivalent, built from ctx).
		// If the user picked an editor in the header chooser, open through the
		// Host's /diff-review/open-with-editor route; otherwise OS default.
		let ctxRef = null
		// The shell hands `conversation.view` entries the official store action
		// openView(...) as a prop; the pill's slot (composer dock) gets neither that
		// nor the store, so the action is captured where it IS available and reused
		// by openReviewTab(). Null means "keep using the DOM fallback".
		let openViewRef = null
		let completeViewRef = null
		// The chat hands its turn cards the shell's file opener (`openFile(path,
		// {line})` → right-sidebar preview at that line); the review tab's own slot
		// does not get it, so it is captured where it exists and reused by the
		// open-at-line buttons as the no-editor default and as a fallback.
		let openFileRef = null
		function resolveAbsPath(sessionId, path, cwd) {
			try {
				if (!ctxRef) return path
				const p = String(path == null ? "" : path)
				// Already absolute? Hand it back untouched. The shell's
				// resolveWorkspacePath does NOT check this, so an absolute path was
				// joined onto the cwd a second time — the editor was asked to open
				// `D:\ws\D:\ws\README.md`, which no editor can open (and it slipped past
				// the host's path fence, because relative(cwd, that) has no `..`).
				if (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("/") || /^\\\\/.test(p)) return p
				// Use the provided cwd (from file data) first, then fall back to session's current cwd
				if (!cwd && ctxRef.sessions && ctxRef.sessions.list) {
					const byId = ctxRef.sessions.list.getSnapshot().byId
					cwd = byId && byId[sessionId] && byId[sessionId].cwd
				}
				if (cwd && typeof path === "string") {
					return cwd.replace(/[\/]+$/, "") + "/" + p.replace(/^[\/]+/, "")
				}
				return p
			} catch (e) { return path }
		}
		// The official remote face (ctx.get("remote.session")) — the same one the
		// shell's own "打开方式" controller uses for external opens. It is the only
		// route that exists: this code used to call `workspaces.openPath`, but no
		// official client composition provides a `workspaces` service at all (the
		// client-side workspace controller has create/rename/pin/archive and no
		// openPath), so that step silently returned false on both web and desktop.
		function sessionRemoteFace() {
			try {
				if (ctxRef && ctxRef.get) return ctxRef.get("remote.session");
			} catch (e) {}
			return null;
		}
		// THE one path for every open action — cards, review tab rows and the pill all
		// end up here; there was a thin `openFileFor` wrapper around it that nothing
		// called any more. The host's open-with-editor already accepts line/col, so a
		// jump costs no host change; without a chosen editor the file still opens
		// through the official remote, just without the jump (only an editor command
		// can position a cursor).
		function openFileAtLine(sessionId, path, cwd, line) {
			try {
				if (!ctxRef) return
				const ed = store.selectedEditor
				const abs = resolveAbsPath(sessionId, path, cwd)
				// 3rd: the shell's own opener (captured from the chat's turnTail props)
				// shows the file — and the line — in the right sidebar. Needs no host
				// config, so it is the least disruptive option and the final fallback.
				const preview = (why) => {
					try {
						if (!openFileRef) return false
						openFileRef(path, line != null ? { line: line } : undefined)
						setState({ error: why ? ("外部打开失败（" + why + "）；已在右侧内置预览中打开。") : null })
						return true
					} catch (e) { return false }
				}
				// 2nd: the OS default application, through the official remote verb the
				// shell's own card uses ("用默认应用打开"). On a machine where .js is
				// associated with VS Code this opens VS Code even when no editor CLI was
				// chosen/detected, which is what the user sees working on the shell's card.
				// It cannot position a cursor, so it stays behind the chosen editor.
				const openDefault = (why) => {
					try {
						const remote = sessionRemoteFace()
						const openFn = remote && typeof remote.openWorkspacePath === "function" ? remote.openWorkspacePath.bind(remote) : null
						if (!openFn) return false
						Promise.resolve(openFn({ path: abs })).then(() => {
							setState({ error: why ? ("已用系统默认应用打开（外部编辑器失败：" + why + "）") : null })
						}).catch((e) => {
							const msg = why || String((e && e.message) || e)
							if (!preview(msg)) setState({ error: "打开失败：" + msg })
						})
						return true
					} catch (e) { return false }
				}
				// 1st: a CHOSEN editor. The shell's opener does NOT hand off to it —
				// measured: with VS Code selected, `openFile(path, {line})` still showed
				// the sidebar preview — and only an editor command can place the cursor.
				if (ed && ed.id) {
					apiOpenWithEditor(sessionId, ed.id, abs, line != null ? line : null, null).then((v) => {
						if (v && v.ok) { setState({ error: null }); return }
						// Report WHY instead of doing nothing: a rejected path fence or an
						// undetected editor used to look exactly like a dead button.
						const why = (v && v.error) ? String(v.error) : "宿主未返回成功"
						if (!openDefault(why) && !preview(why)) setState({ error: "打开失败：" + why })
					}).catch((e) => {
						const why = String((e && e.message) || e)
						if (!openDefault(why) && !preview(why)) setState({ error: "打开失败：" + why })
					})
					return
				}
				// No editor chosen: preview first (cheap, no focus stealing), else the
				// default application — never a silent no-op.
				if (preview("")) return
				if (openDefault("")) return
				setState({ error: "没有可用的打开方式：请在上方选择一个编辑器（或确认宿主提供侧栏预览）。" })
			} catch (e) {
				setState({ error: "打开失败：" + String((e && e.message) || e) })
			}
		}



		// ── host data via the official transport ─────────────────────────────
		// v3: no self-built HTTP routes. rpc.call goes through the official
		// transport (web fetch / desktop IPC bridge) to /diff-review/<ep>;
		// the Host serves that path directly on webServer.
		// NOTE: the channel must be a SINGLE path segment (assertTarget rejects
		// slashes) — '/api' would produce /api/session.list-style dotted names
		// that never match a prefix route; '/diff-review' is the correct shape.
		let connRef = null;
		// The official Web transport resolves every call with the parsed
		// envelope { ok: true, value } | { ok: false, error: { code, message } },
		// while the Desktop bridge / older hosts hand back the bare payload.
		// Unwrap tolerantly, and turn a transport-level failure into a
		// rejection so the callers' local-history fallbacks keep working.
		// A payload-level `ok` (open-with-editor, revert) is NOT an envelope —
		// its `error` is a string, so it is passed through untouched.
		function hostValueOf(resp) {
			if (resp === null || typeof resp !== "object" || Array.isArray(resp)) return resp;
			if (resp.ok === true && Object.prototype.hasOwnProperty.call(resp, "value")) return resp.value;
			if (resp.ok === false && resp.error !== null && typeof resp.error === "object" && !Array.isArray(resp.error)) {
				throw new Error(String(resp.error.message || resp.error.code || "host rpc failed"));
			}
			return resp;
		}
		function rpcCall(endpoint, payload) {
			return new Promise((resolve, reject) => {
				const conn = connRef;
				if (!conn || !conn.rpc || typeof conn.rpc.call !== "function") {
					reject(new Error("connection channel unavailable"));
					return;
				}
				conn.rpc.call("/diff-review", endpoint, payload || {}).then((resp) => {
					try { resolve(hostValueOf(resp)); } catch (e) { reject(e); }
				}, reject);
			});
		}
		function apiFile(session, path) { return rpcCall("file", { session, path }); }
		function apiTurn(session, turn) { return rpcCall("turn", { session, turn }); }
		function apiSummary(session) { return rpcCall("summary", { session }); }
		function apiClear(session) { return rpcCall("clear", { session }); }
		// Undo one turn host-side. `turn` -1 = the latest window (the newest card).
		function apiUndoTurn(session, turn) { return rpcCall("undo-turn", { session, turn: turn == null ? -1 : turn }); }
		// Whole-file revert: with no `op` it restores the state before the file's first
		// recorded change. The endpoint has existed since v1, but no client ever called it
		// (the review view built a diff_review_revert instruction instead).
		function apiRevert(session, path) { return rpcCall("revert", { session, path }); }
// 人类可读的字节数（工具条上的"记录占用"）。
function fmtBytes(n) {
	const v = Number(n) || 0;
	if (v < 1024) return v + " B";
	const kb = v / 1024;
	if (kb < 1024) return (kb < 10 ? kb.toFixed(1) : Math.round(kb)) + " KB";
	const mb = kb / 1024;
	if (mb < 1024) return (mb < 10 ? mb.toFixed(1) : Math.round(mb)) + " MB";
	return (mb / 1024).toFixed(2) + " GB";
}
// 中文思考注入（设置页开关）：宿主把「用简体中文思考」注册成系统提示词的段落。
function apiThinking() { return rpcCall("thinking", {}); }
function apiThinkingSet(enabled) { return rpcCall("thinking-set", { enabled: enabled === true }); }
// 审查偏好（忽略空白 / git 忽略文件过滤）：存宿主 settings.json，统计与列表同源。
function apiPrefs() { return rpcCall("prefs", {}); }
function apiPrefsSet(patch) { return rpcCall("prefs-set", patch || {}); }
		function loadPrefs() {
			return apiPrefs().then((v) => {
				if (v && typeof v === "object") {
					setState({
						reviewPrefs: {
							ignoreWhitespace: v.ignoreWhitespace === true,
							hideGitIgnored: v.hideGitIgnored !== false
						}
					});
				}
				return v;
			}).catch(() => null);
		}
		function setPrefs(patch) {
			const next = Object.assign({}, store.reviewPrefs, patch);
			setState({ reviewPrefs: next });
			return apiPrefsSet(patch).then((v) => {
				if (v && typeof v === "object") {
					setState({
						reviewPrefs: {
							ignoreWhitespace: v.ignoreWhitespace === true,
							hideGitIgnored: v.hideGitIgnored !== false
						}
					});
				}
				return v;
			}).catch((e) => { setState({ reviewPrefs: next }); throw e; });
		}
		function wsKeyL(s) {
			return String(s == null ? "" : s).replace(/\s+/g, "");
		}
		function lineEqL(a, b, ignoreWs) {
			return ignoreWs ? wsKeyL(a) === wsKeyL(b) : a === b;
		}
		function apiEditors() { return rpcCall("editors", {}); }
// 记录占用：分片文件 + 它引用的快照 blob（审核 tab 工具条显示，清空按钮就在旁边）。
function apiUsage(session) { return rpcCall("usage", { session }); }
		function apiFonts(refresh) { return rpcCall("fonts", { refresh: refresh === true }); }

		// ── font choice ──────────────────────────────────────────────────────
		// Default is "follow": the stylesheet resolves var(--drv-font-ui, …) straight
		// to the official tokens, so DSH's own content-font-size setting and any
		// skin's font override reach every element this plugin draws — a skin such as
		// dsh-client-ui-skin-claude only rewrites --dsw-font-family /
		// --ds-font-family-code, so nothing here may hardcode a stack.
		// Picking a family writes two variables on the document root instead, with
		// the official stack kept as the fallback behind the chosen family, so a
		// missing glyph still lands on the host's own font.
		function fontStackFor(name, fallback) {
			const family = String(name == null ? "" : name).trim().replace(/["\\]/g, "");
			if (!family) return null;
			return "\"" + family + "\", var(" + fallback + ")";
		}
		function applyFontChoice(name, opts) {
			const chosen = String(name == null ? "" : name).trim();
			const ui = fontStackFor(chosen, "--dsw-font-family");
			const code = fontStackFor(chosen, "--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace");
			try {
				const root = document.documentElement;
				if (ui && code) {
					root.style.setProperty("--drv-font-ui", ui);
					root.style.setProperty("--drv-font-code", code);
				} else {
					root.style.removeProperty("--drv-font-ui");
					root.style.removeProperty("--drv-font-code");
				}
			} catch (e) {}
			if (!opts || opts.persist !== false) {
				try {
					if (chosen) localStorage.setItem(FONT_LS_KEY, chosen);
					else localStorage.removeItem(FONT_LS_KEY);
				} catch (e) {}
			}
			setState({ fontChoice: chosen || null });
		}
		// A browser cannot enumerate local fonts, so the HOST does it (see the
		// /diff-review "fonts" endpoint). The answer is kept for the session and
		// re-read only through the picker's rescan button.
		// The stepper writes one more document-root variable; the stylesheet adds it
		// to every size and line-height, so the whole plugin scales together.
		function applyFontDelta(delta, opts) {
			const value = clampFontDelta(delta, FONT_DELTA_MIN, FONT_DELTA_MAX);
			try {
				const root = document.documentElement;
				if (value === 0) root.style.removeProperty("--drv-font-delta");
				else root.style.setProperty("--drv-font-delta", value + "px");
			} catch (e) {}
			if (!opts || opts.persist !== false) {
				try {
					if (value === 0) localStorage.removeItem(FONT_DELTA_LS_KEY);
					else localStorage.setItem(FONT_DELTA_LS_KEY, String(value));
				} catch (e) {}
			}
			setState({ fontDelta: value });
		}
		function loadFonts(force) {
			if (store.fontLoading) return;
			if (!force && store.fonts.length > 0) return;
			setState({ fontLoading: true });
			apiFonts(force).then((v) => {
				setState({
					fonts: (v && Array.isArray(v.fonts)) ? v.fonts : [],
					fontSource: (v && v.source) || null,
					fontLoading: false
				});
			}).catch(() => {
				setState({ fonts: [], fontSource: null, fontLoading: false });
			});
		}
		// Restore the saved choice on boot, before any component renders: the
		// variables live on the document root, so one call covers every mount.
		applyFontChoice(store.fontChoice, { persist: false });
		applyFontDelta(store.fontDelta, { persist: false });
		// The session id rides along so the host can scope its path fence to THAT
		// session's workspace (live agent → session store → persisted header) instead
		// of trusting any path the renderer names.
		function apiOpenWithEditor(session, editor, path, line, col) { return rpcCall("open-with-editor", { session: session || null, editor, path, line: line || null, col: col || null }); }
		// Probing editors is real work on the host (it shells out to `where` and stats
		// install paths), and the review tab remounts its picker on every visit — so the
		// result is cached for the session and only re-probed on demand ("重新检测" in the
		// picker) or after EDITOR_CACHE_MS, whichever comes first.
		const EDITOR_CACHE_MS = 10 * 60 * 1000;
		let editorsLoadedAt = 0;
		function loadEditors(force) {
			const fresh = Array.isArray(store.editors) && store.editors.length > 0 && (Date.now() - editorsLoadedAt) < EDITOR_CACHE_MS;
			if (!force && (store.editorLoading || fresh)) return;
			setState({ editorLoading: true });
			apiEditors().then((v) => {
				const editors = (v && v.editors) || [];
				editorsLoadedAt = Date.now();
				// Never overwrite selectedEditor — it's persisted from localStorage
				// and only changed by the user's explicit selection via selectEditor().
				setState({ editors, editorLoading: false });
			}).catch(() => {
				setState({ editorLoading: false });
			});
		}
		function selectEditor(ed) {
			setState({ selectedEditor: ed });
			try {
				if (ed && ed.id) localStorage.setItem(EDITOR_LS_KEY, JSON.stringify({ id: ed.id, name: ed.name }));
				else localStorage.removeItem(EDITOR_LS_KEY);
			} catch (e) {}
		}

		// ── official history API ─────────────────────────────────────────────
		// 0.1.2+ hosts serve gateway remotes (ctx.remote.session): follow() opens
		// a snapshot whose cursor is the authoritative last seq, page() reads
		// backwards, list() carries projections.asOfSeq as a fallback cursor.
		// pre-0.1.2 verb (connection.api.sessions.history) stays as last resort.
		const HISTORY_PAGE = 100;
		const HISTORY_MAX_PAGES = 2;
		let historyAbort = null;
		function splitLinesL(s) {
			if (s === "") return [];
			return s.split("\n");
		}
		// Client mirror of the host's locateFragment: recover a fragment's real file
		// line from a before-snapshot. Matching is text-level, NOT whole-line — an
		// old_string is frequently only part of a line (`foo` inside `  foo = 1;`),
		// and `\r?\n` between the fragment's lines tolerates a CRLF checkout whose
		// old_string arrives with bare `\n`. Only the HOST has `before` today (the
		// transcript carries tool args + the result's rendered text, never the raw
		// before/after value), so on the local-parse path this returns null and the
		// section is flagged lineExact:false instead of faking absolute numbers.
		// Self-contained on purpose: it is extracted and run on its own in tests.
		function locateFragmentL(beforeText, fragmentText) {
			if (typeof beforeText !== "string" || typeof fragmentText !== "string" || fragmentText === "") return null;
			const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const needle = fragmentText.replace(/\r\n?/g, "\n");
			const pattern = new RegExp(needle.split("\n").map(escape).join("\\r?\\n"), "g");
			let first = -1, count = 0, m;
			while ((m = pattern.exec(beforeText)) !== null) {
				count++;
				if (first < 0) first = m.index;
			}
			if (count === 0) return null;
			let line = 1;
			for (let i = 0; i < first; i++) if (beforeText.charCodeAt(i) === 10) line++;
			return { line: line, count: count };
		}
		// Minimal line diff (same contract as host): [{type,a,b,text}]
		// `ignoreWs` treats whitespace-only line changes as equal (git -w).
		function diffLinesLocal(a, b, aStart, bStart, ignoreWs) {
			const n = a.length, m = b.length, w = m + 1;
			const eq = (i, j) => lineEqL(a[i], b[j], ignoreWs === true);
			const dp = new Int32Array((n + 1) * w);
			for (let i = n - 1; i >= 0; i--) {
				for (let j = m - 1; j >= 0; j--) {
					dp[i * w + j] = eq(i, j) ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
				}
			}
			const out = [];
			let pending = [];
			const flush = () => { for (const h of pending) out.push(h); pending = []; };
			// Seeded starts let a diff of a FILE FRAGMENT report real file lines.
			let i = 0, j = 0, aNo = aStart || 1, bNo = bStart || 1;
			while (i < n && j < m) {
				if (eq(i, j)) {
					// Whitespace-equal but not identical: show the NEW side, matching
					// jsdiff's comparator behaviour and the host renderer.
					const text = (ignoreWs === true && a[i] !== b[j]) ? b[j] : a[i];
					pending.push({ type: "ctx", a: aNo, b: bNo, text: text });
					i++; j++; aNo++; bNo++;
				}
				else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) { flush(); out.push({ type: "del", a: aNo, b: null, text: a[i] }); i++; aNo++; }
				else { flush(); out.push({ type: "add", a: null, b: bNo, text: b[j] }); j++; bNo++; }
			}
			flush();
			while (i < n) { out.push({ type: "del", a: aNo, b: null, text: a[i] }); i++; aNo++; }
			while (j < m) { out.push({ type: "add", a: null, b: bNo, text: b[j] }); j++; bNo++; }
			return out;
		}
		// pre-0.1.2 verb (conn.api.sessions.history) — last-resort fallback.
		function historyApi() {
			const conn = connRef;
			const api = conn && conn.api && conn.api.sessions && typeof conn.api.sessions.history === "function" ? conn.api.sessions.history : null;
			return api;
		}
		// 0.1.2+ gateway remote face (ctx.remote.session). The gateway reuses the
		// WebSocket / worker-local transport for both stream and unary calls.
		function sessionRemote() {
			try {
				if (ctxRef && ctxRef.get) {
					const r = ctxRef.get("remote.session");
					if (r && (typeof r.follow === "function" || typeof r.page === "function")) return r;
				}
			} catch (e) {}
			return null;
		}
		// Tolerant envelope unwrap for every face these transports ever served:
		// {result:{ok,value}} (old verb) | {ok,value} (gateway remotes) | direct payload.
		function remoteValueOf(resp) {
			let payload = resp;
			if (payload !== null && typeof payload === "object" && payload.result !== null && typeof payload.result === "object") payload = payload.result;
			if (payload !== null && typeof payload === "object" && !Array.isArray(payload) && "ok" in payload) {
				if (payload.ok !== true || payload.value === null || typeof payload.value !== "object") {
					if (payload.error) throw new Error(String(payload.error.message || String(payload.error)));
					throw new Error("history rpc failed");
				}
				payload = payload.value;
			}
			if (payload === null || typeof payload !== "object") throw new Error("history rpc failed");
			return payload;
		}
		async function loadFullHistory(sessionId) {
			if (historyAbort) historyAbort.abort();
			historyAbort = new AbortController();
			const signal = historyAbort.signal;
			const address = { kind: "session", sessionId: sessionId };
			const events = [];
			const seen = new Set();
			const push = (records) => {
				if (!Array.isArray(records)) return;
				for (const rec of records) {
					const ev = rec && rec.event;
					if (ev && !seen.has(ev.seq)) { seen.add(ev.seq); events.push(ev); }
				}
			};

			const remote = sessionRemote();
			const conn = connRef;
			const rpcOpen = conn && conn.rpc && typeof conn.rpc.open === "function" ? conn.rpc.open.bind(conn.rpc) : null;
			const rpcCall = conn && conn.rpc && typeof conn.rpc.call === "function" ? conn.rpc.call.bind(conn.rpc) : null;

			// ── 0.1.2+ gateway remote face (or raw connection RPC) ────────────
			if (remote || rpcOpen || rpcCall) {
				let cursor = null;
				let hasMore = false;
				let firstSeq = null;

				// (1) follow opening snapshot: authoritative cursor + latest records.
				const followFn = remote && typeof remote.follow === "function" ? remote.follow.bind(remote) : null;
				const stream = followFn
					? followFn({ address: address, maxMessages: HISTORY_PAGE }, signal)
					: rpcOpen
						? rpcOpen("/api", "session/follow", { args: { address: address, maxMessages: HISTORY_PAGE } }, signal)
						: null;
				if (stream) {
					for await (const frame of stream) {
						if (signal.aborted) break;
						if (frame && frame.type === "snapshot") {
							const records = frame.records || [];
							push(records);
							if (records.length) {
								const first = records[0] && records[0].event ? records[0].event.seq : null;
								if (first != null) firstSeq = first;
							}
							cursor = typeof frame.cursor === "number" ? frame.cursor : null;
							hasMore = !!frame.hasMore;
						}
						break; // only the opening snapshot; never consume the live tail
					}
				}

				// (2) throughSeq cursor for page(): the follow cursor is authoritative;
				//     fall back to session.list projections.asOfSeq.
				let throughSeq = (cursor != null && cursor >= 0) ? cursor : null;
				if (throughSeq == null) {
					try {
						const listFn = remote && typeof remote.list === "function" ? remote.list.bind(remote) : null;
						const listResp = listFn
							? await listFn({})
							: rpcCall
								? await rpcCall("/api", "session/list", { args: {} }, signal)
								: null;
						const listValue = listResp ? remoteValueOf(listResp) : null;
						const items = listValue && Array.isArray(listValue.items) ? listValue.items : [];
						const item = items.find((it) => it && it.sessionId === sessionId);
						const asOf = item && item.projections ? item.projections.asOfSeq : undefined;
						if (Number.isFinite(asOf) && asOf >= 0) throughSeq = asOf;
					} catch (e) {}
				}

				// (3) page: with no snapshot (follow unavailable) page the latest
				//     window directly; otherwise page one older window to keep the
				//     old two-page semantics.
				if (throughSeq != null && throughSeq >= 0) {
					const needPage = firstSeq == null ? true : (hasMore && firstSeq > 0);
					const pageThrough = firstSeq == null ? throughSeq : firstSeq - 1;
					if (needPage && pageThrough >= 0) {
						try {
							const pageFn = remote && typeof remote.page === "function" ? remote.page.bind(remote) : null;
							const pageResp = pageFn
								? await pageFn({ address: address, throughSeq: pageThrough, maxMessages: HISTORY_PAGE }, signal)
								: rpcCall
									? await rpcCall("/api", "session/page", { args: { address: address, throughSeq: pageThrough, maxMessages: HISTORY_PAGE } }, signal)
									: null;
							const value = pageResp ? remoteValueOf(pageResp) : null;
							if (value && Array.isArray(value.records)) {
								const older = [];
								for (const rec of value.records) {
									const ev = rec && rec.event;
									if (ev && !seen.has(ev.seq)) { seen.add(ev.seq); older.push(ev); }
								}
								events.unshift(...older);
							}
						} catch (e) { /* older page is best-effort */ }
					}
				}
				return events;
			}

			// ── pre-0.1.2 verb fallback ────────────────────────────────────────
			const api = historyApi();
			if (!api) throw new Error("history API unavailable");
			let beforeSeq;
			for (let page = 0; page < HISTORY_MAX_PAGES; page++) {
				if (signal.aborted) break;
				const resp = await api({
					sessionId: sessionId,
					maxMessages: HISTORY_PAGE,
					...(beforeSeq === undefined ? {} : { beforeSeq: beforeSeq })
				}, signal);
				const value = remoteValueOf(resp);
				const entries = Array.isArray(value.records) ? value.records : (Array.isArray(value.events) ? value.events : null);
				if (!entries) throw new Error("history page failed");
				if (!entries.length) break;
				const next = [];
				for (const entry of entries) {
					const ev = entry && entry.event;
					if (!ev || seen.has(ev.seq)) continue;
					seen.add(ev.seq);
					next.push(ev);
				}
				events.unshift(...next);
				if (!value.hasMore) break;
				beforeSeq = Math.min(...entries.map((e) => e.event.seq));
				if (!Number.isFinite(beforeSeq)) break;
			}
			return events;
		}
		// Parse tool events into review records (path -> ops), same op shape as host.
		function parseReviewEvents(events) {
			const files = new Map();
			let turn = 0;
			const pending = new Map(); // callId -> {name,path,input,turn,at}
			const MAX_OPS = 100;
			for (const ev of events) {
				try {
					const data = ev.data || {};
					if (ev.type === "turn/start") {
						const t = data.turn;
						if (typeof t === "number") turn = t;
					} else if (ev.type === "tool/call") {
						const name = String(data.name || data.toolName || "");
						if (name !== "write" && name !== "edit") continue;
						let args = data.arguments;
						if (typeof args === "string") { try { args = JSON.parse(args); } catch (e) { args = null; } }
						if (!args || typeof args !== "object") args = {};
						const path = String(args.file_path || args.file || args.path || "");
						if (!path) continue;
						const callId = String(data.callId || ev.seq);
						pending.set(callId, { name: name, path: path, input: args, turn: turn, at: ev.time || Date.now() });
					} else if (ev.type === "tool/code-dispatch" || ev.type === "tool/ptc-dispatch") {
						// 嵌套工具调用(run_code 程序内的 write/edit)只以自包含的
						// dispatch 事件落转录(name + arguments + isError),
						// 不会出现顶层 tool/call + tool/result 配对——不解析则整段会话的
						// 文件修改在审查页里不可见。DSH 后续把事件名从
						// tool/code-dispatch 改成了 tool/ptc-dispatch(且 arguments
						// 直接是对象而非 JSON 字符串),两个名字都要认;
						// tool/ptc-dispatch-start 是配对的开始事件(无结果字段),
						// 类型串不同不会被这里误捕。
						const name = String(data.name || data.toolName || "");
						if (name !== "write" && name !== "edit") continue;
						if (data.isError === true) continue;
						let args = data.arguments;
						if (typeof args === "string") { try { args = JSON.parse(args); } catch (e) { args = null; } }
						if (!args || typeof args !== "object") args = {};
						const path = String(args.file_path || args.file || args.path || "");
						if (!path) continue;
						let rec = files.get(path);
						if (!rec) { rec = { path: path, cwd: (args.cwd || args.workspace) || null, ops: [] }; files.set(path, rec); }
						if (rec.ops.length >= MAX_OPS) rec.ops.shift();
						rec.ops.push({
							kind: name === "edit" ? "edit" : "write",
							at: ev.time || Date.now(),
							turn: turn,
							oldString: typeof args.old_string === "string" ? args.old_string : undefined,
							newString: typeof args.new_string === "string" ? args.new_string : undefined,
							content: typeof args.content === "string" ? args.content : undefined
						});
					} else if (ev.type === "tool/result") {
						const message = data.message || {};
						const callId = String(data.callId || (message.source && message.source.callId) || "");
						const p = pending.get(callId);
						if (!p) continue;
						const isError = message.isError === true || data.error !== undefined;
						pending.delete(callId);
						if (isError) continue;
						let rec = files.get(p.path);
						if (!rec) { rec = { path: p.path, cwd: (p.input && (p.input.cwd || p.input.workspace)) || null, ops: [] }; files.set(p.path, rec); }
						if (rec.ops.length >= MAX_OPS) rec.ops.shift();
						const input = p.input;
						rec.ops.push({
							kind: p.name === "edit" ? "edit" : "write",
							at: p.at,
							turn: p.turn,
							oldString: typeof input.old_string === "string" ? input.old_string : undefined,
							newString: typeof input.new_string === "string" ? input.new_string : undefined,
							content: typeof input.content === "string" ? input.content : undefined
						});
					}
				} catch (e2) {}
			}
			return { files: files, activeTurn: turn };
		}
		// ── line counting for the local (transcript) fallback ────────────────────
		// The transcript carries only fragments (old_string / new_string / content), so
		// this is the client-side counterpart of the host's line diff. It strips the
		// lines the two sides share at the head and tail and counts what is left: the
		// fragment's context lines are therefore never reported as changes. Five copies
		// of `splitLinesL(op.newString).length` used to do that instead — a one-line
		// change wrapped in three context lines read as +4/−4, and the card disagreed
		// with both the review tab and the shell's own changed-files card.
		function opLineCounts(op, ignoreWs) {
			// Self-contained (no shared helpers) so the counting rule is testable on its own.
			const split = (s) => {
				const t = typeof s === "string" ? s : "";
				return t === "" ? [] : t.split("\n");
			};
			if (!op) return { added: 0, removed: 0 };
			if (op.kind !== "edit") {
				// A write's `content` IS the new file; without a snapshot there is no old
				// side to subtract (the host, which has one, reports the net difference).
				return { added: split(op.content).length, removed: 0 };
			}
			const a = split(op.oldString);
			const b = split(op.newString);
			const key = (s) => (ignoreWs === true ? String(s).replace(/\s+/g, "") : s);
			const eq = (x, y) => key(x) === key(y);
			let head = 0;
			while (head < a.length && head < b.length && eq(a[head], b[head])) head++;
			let tail = 0;
			while (tail < a.length - head && tail < b.length - head && eq(a[a.length - 1 - tail], b[b.length - 1 - tail])) tail++;
			return { added: Math.max(0, b.length - head - tail), removed: Math.max(0, a.length - head - tail) };
		}
		function summaryFromFiles(files) {
			const ignoreWs = store.reviewPrefs && store.reviewPrefs.ignoreWhitespace === true;
			const items = [];
			for (const rec of files.values()) {
				let added = 0, removed = 0, writes = 0, edits = 0;
				for (const op of rec.ops) {
					if (op.kind === "edit") edits++; else writes++;
					const own = opLineCounts(op, ignoreWs);
					added += own.added; removed += own.removed;
				}
				const last = rec.ops[rec.ops.length - 1];
				items.push({ path: rec.path, name: displayName(rec.path, rec.cwd), cwd: rec.cwd, ops: rec.ops.length, writes: writes, edits: edits, added: added, removed: removed, lastTime: last ? last.at : 0 });
			}
			items.sort((x, y) => y.lastTime - x.lastTime);
			let latestTurn = 0;
			for (const rec of files.values()) for (const op of rec.ops) if (typeof op.turn === "number" && op.turn > latestTurn) latestTurn = op.turn;
			return { files: items, latestTurn: latestTurn, filesMap: files };
		}
		// One section per op; opIndex always indexes the FULL ops array so the
		// diff_review_revert tool can target the exact recorded operation.
		// Line numbers: an `edit` only carries fragments, so the real file offset is
		// recovered from the before-snapshot when one exists (host path). Without a
		// snapshot the numbering stays fragment-relative and `lineExact: false` tells
		// the UI to mark it, rather than presenting 1..N as if it were the file.
		function sectionFromOp(rec, i, op) {
			let hunks;
			let lineExact = true;
			let lineBase = 1;
			let multiMatch = 0;
			if (op.kind === "edit") {
				const oldL = splitLinesL(op.oldString || "");
				const newL = splitLinesL(op.newString || "");
				const located = locateFragmentL(op.before, typeof op.oldString === "string" ? op.oldString : "");
				const base = located ? located.line : 1;
				lineExact = !!located;
				lineBase = located ? located.line : null;
				if (located && located.count > 1) multiMatch = located.count;
				if (op.oldString === "") hunks = newL.map((t, k) => ({ type: "add", a: null, b: k + 1, text: t }));
				else if (op.newString === "") hunks = oldL.map((t, k) => ({ type: "del", a: base + k, b: null, text: t }));
				else hunks = diffLinesLocal(oldL, newL, base, base, !!(store.reviewPrefs && store.reviewPrefs.ignoreWhitespace));
			} else {
				hunks = splitLinesL(op.content || "").map((t, k) => ({ type: "add", a: null, b: k + 1, text: t }));
			}
			const section = { kind: op.kind, at: op.at, hunks: hunks, wholeFile: op.kind === "write", opIndex: i, revertible: false, canUndo: false, lineExact: lineExact, lineBase: lineBase };
			if (multiMatch > 1) section.multiMatch = multiMatch;
			return section;
		}
		function detailFromRecIdx(rec, indices) {
			if (!rec) return { path: "", sections: [] };
			const sections = [];
			for (const i of indices) {
				const op = rec.ops[i];
				if (op) sections.push(sectionFromOp(rec, i, op));
			}
			return { path: rec.path, sections: sections, revertible: false };
		}
		function detailFromRec(rec) {
			if (!rec) return { path: "", sections: [] };
			return detailFromRecIdx(rec, rec.ops.map((_, i) => i));
		}
		// review build cache / mode flags
		let reviewFiles = new Map();
		let reviewAsync = null;
		let reviewRid = 0;
		// ── host-first adoption of the session-wide list ─────────────────────
		// Subagent (child-session) writes are folded into the ROOT session
		// bucket by the host and can never appear in the parent transcript the
		// local parser reads, so a NON-EMPTY host summary is authoritative for
		// every path IT KNOWS. Merge is by path with the host winning: one entry
		// per path, so a file touched by both the parent and a subagent is still
		// counted exactly once, while a path only the transcript knows (plugin
		// loaded mid-session, cleared/corrupt state, crash before the debounced
		// save) is kept instead of silently dropped by a replace. An empty/failed
		// host payload keeps the local result untouched (identical to the
		// previous behavior). Pure — smoke-tested directly.
		function adoptHostSummary(host, localFiles, localLatestTurn) {
			const hostFiles = host && Array.isArray(host.files) ? host.files : null;
			const hiddenIgnored = host && typeof host.hiddenIgnored === "number" ? host.hiddenIgnored : 0;
			if (!hostFiles || hostFiles.length === 0) {
				return { files: localFiles, latestTurn: localLatestTurn, fromHost: false, hiddenIgnored: 0 };
			}
			const byPath = new Map();
			for (const f of hostFiles) if (f && f.path) byPath.set(f.path, f);
			const merged = [...byPath.values()];
			for (const f of (Array.isArray(localFiles) ? localFiles : [])) {
				if (f && f.path && !byPath.has(f.path)) merged.push(f);
			}
			merged.sort((a, b) => (b.lastTime || 0) - (a.lastTime || 0));
			const hostLatest = (typeof host.latestTurn === "number" && Number.isFinite(host.latestTurn)) ? host.latestTurn : 0;
			const localLatest = (typeof localLatestTurn === "number" && Number.isFinite(localLatestTurn)) ? localLatestTurn : 0;
			// The host tags turns itself; a local-only file can still carry the
			// newest turn, so the window cursor takes the higher of the two.
			return { files: merged, latestTurn: Math.max(hostLatest, localLatest), fromHost: true, hiddenIgnored };
		}
		// RUNNING-PILL face of the host window: follows the current in-flight
		// turn (upstream 55fbef3) — a brand-new turn with no writes must not
		// keep showing the previous turn's payload as if it were this round.
		// Pure — smoke-tested.
		function hostWindowItems(hostWindow, activeTurn) {
			if (!hostWindow || !Array.isArray(hostWindow.files) || hostWindow.files.length === 0) return null;
			const t = (typeof hostWindow.turn === "number") ? hostWindow.turn : null;
			if (t !== null && activeTurn > 0 && t < activeTurn) return null;
			return hostWindow.files;
		}
		// TAB-BADGE face of the host window: NO in-flight-turn guard. Used as the
		// badge source only when the session-wide host summary was NOT adopted
		// (a host that answers turn(-1) but has no summary list): the host's
		// latest activity stays honest even when a fresh turn has not written
		// anything yet. Applying the pill's guard here made the badge vanish
		// between turns — and since subagent changes exist only in the host, the
		// badge then read 0 exactly whenever the user opened a new turn. Pure.
		function badgeHostItems(hostWindow) {
			return (hostWindow && Array.isArray(hostWindow.files) && hostWindow.files.length) ? hostWindow.files : null;
		}
		// A host-sourced list entry carries no op sections, and the host is the
		// only source that knows about ops the transcript never saw (subagent
		// writes). Two cases must go through the host file endpoint instead of
		// rendering a partial/empty body:
		//   - a file the local parse never saw at all (subagent-only), and
		//   - ANY file while the list is host-adopted ('all' scope): the row
		//     counts come from the host, so the hunks must too — otherwise a file
		//     edited by BOTH the parent and a subagent shows the host's op count
		//     above a body that only contains the parent's op.
		// loadDetail falls back to the local record when the host has nothing,
		// so a Desktop/legacy host (no summary) keeps the transcript behavior.
		// Pure — smoke-tested directly.
		function needHostDetail(scope, item, rec, fromHost) {
			if (scope !== "all") return false;
			if (!item || !item.path) return false;
			if (item.sections && item.sections.length) return false;
			return !!fromHost || !rec;
		}
		// ── change detection: a poll tick must not repaint an unchanged list ──
		// The tab used to commit TWICE per tick (the transcript parse first, the host
		// summary second) and every commit handed React a fresh array, which re-rendered
		// the file list and re-ran the turn-loader effect. During a running turn that is
		// exactly the "list is flickering" the user sees, so a tick now commits once and
		// only when a row actually moved.
		function sameFileRows(a, b) {
			if (a === b) return true;
			if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
			for (let i = 0; i < a.length; i++) {
				const x = a[i] || {}, y = b[i] || {};
				if (x.path !== y.path || x.added !== y.added || x.removed !== y.removed ||
					x.ops !== y.ops || x.writes !== y.writes || x.edits !== y.edits ||
					x.estimated !== y.estimated || x.cwd !== y.cwd) return false;
			}
			return true;
		}
		/** Structural equality for the small JSON payloads (turn data, host window). */
		function samePayload(a, b) {
			if (a === b) return true;
			if (!a || !b) return false;
			try { return JSON.stringify(a) === JSON.stringify(b); } catch (e) { return false; }
		}
		function rebuildReview() {
			const session = store.currentSession;
			if (!session) return;
			const rid = ++reviewRid;
			// Parallel host read: the summary replaces the list wholesale when
			// it has data (see adoptHostSummary).
			const hostP = apiSummary(session).catch(() => null);
			reviewAsync = loadFullHistory(session).then((events) => {
				if (rid !== reviewRid || store.currentSession !== session) return null;
				const parsed = parseReviewEvents(events);
				reviewFiles = parsed.files;
				const s = summaryFromFiles(reviewFiles);
				// Both sources are in: commit ONE list, host first when it has data.
				// (dsh-44: the tab used to commit twice per tick — a fresh array every
				// time re-rendered the list and re-ran the turn loader, which is the
				// flicker. Commit once, and only when a row actually moved.)
				return hostP.then((host) => {
					if (rid !== reviewRid || store.currentSession !== session) return;
					const adopted = adoptHostSummary(host, s.files, s.latestTurn);
					const nextFiles = adopted.fromHost ? adopted.files : s.files;
					const nextLatest = adopted.fromHost ? adopted.latestTurn : s.latestTurn;
					const nextFromHost = adopted.fromHost === true;
					const nextHidden = adopted.hiddenIgnored || 0;
					const changed = store.loadingFiles ||
						store.latestTurn !== nextLatest ||
						store.filesFromHost !== nextFromHost ||
						store.activeTurn !== parsed.activeTurn ||
						(store.hiddenIgnored || 0) !== nextHidden ||
						!sameFileRows(store.files, nextFiles);
					if (changed) {
						setState({
							files: nextFiles, latestTurn: nextLatest, filesFromHost: nextFromHost,
							hiddenIgnored: nextHidden,
							activeTurn: parsed.activeTurn, loadingFiles: false, error: null
						});
					}
					// Host payload also carries the live prefs — keep the local
					// fallback renderer in lockstep without an extra round trip.
					if (host && typeof host.ignoreWhitespace === "boolean") {
						setState({
							reviewPrefs: {
								ignoreWhitespace: host.ignoreWhitespace === true,
								hideGitIgnored: host.hideGitIgnored !== false
							}
						});
					}
					loadTurn(store.reviewTurn);
					// Latest-activity window for the badge / pill (reuses the turn
					// request inflight dedupe, so loadTurn(-1) shares it).
					fetchTurnData(session, -1).then((w) => {
						if (rid !== reviewRid || store.currentSession !== session) return;
						const nextWindow = (w && w.fromHost && Array.isArray(w.files) && w.files.length)
							? { turn: typeof w.turn === "number" ? w.turn : -1, files: w.files }
							: null;
						if (!samePayload(store.hostWindow, nextWindow)) setState({ hostWindow: nextWindow });
					}).catch(() => {});
				});
			}).catch((e) => {
				// superseded/aborted reads are cancellation, not failure — stay silent
				if (rid !== reviewRid || store.currentSession !== session) return;
				if (e && (e.name === "AbortError" || (historyAbort && historyAbort.signal && historyAbort.signal.aborted))) return;
				setState({ error: "会话历史读取失败：" + String((e && e.message) || e) + "（可用官方「轨迹」标签查看工具 diff）", loadingFiles: false });
			});
		}

		function loadSummary() {
			const session = store.currentSession;
			if (!session) return;
			++reqSeq;
			// A remount or a poll with rows already in hand refreshes silently; only an
			// empty list shows the blocking placeholder. Otherwise every visit to the tab
			// (and every session switch back) flashed "加载中…" for a beat.
			if (!store.files || store.files.length === 0) setState({ loadingFiles: true, error: null });
			else if (store.error) setState({ error: null });
			rebuildReview();
		}
		// Latest-turn view: files + sections for the most recent recorded turn.
		// Local aggregation for an arbitrary turn (used as the Desktop / host-
		// channel fallback; the host's turn RPC is authoritative when live).
		// turnNo null/NaN/-1 = "latest activity": newest labeled turn plus
		// in-flight unlabeled ops newer than it (same window the pill uses).
		function localTurnData(turnNo) {
			const latest = store.latestTurn || 0;
			const windowMode = turnNo == null || turnNo === -1 || !Number.isFinite(turnNo);
			const turn = windowMode ? latest : turnNo;
			let latestLabeledAt = 0;
			if (windowMode) latestLabeledAt = lastLabeledAtOf(reviewFiles);
			const items = [];
			for (const rec of reviewFiles.values()) {
				const indices = [];
				for (let i = 0; i < rec.ops.length; i++) {
					const op = rec.ops[i];
					if (windowMode ? !inLatestWindow(turn, op, latestLabeledAt) : op.turn !== turn) continue;
					indices.push(i);
				}
				if (indices.length === 0) continue;
				const ops = indices.map((i) => rec.ops[i]);
				let added = 0, removed = 0, writes = 0, edits = 0;
				for (const op of ops) {
					if (op.kind === "edit") edits++; else writes++;
					const own = opLineCounts(op, !!(store.reviewPrefs && store.reviewPrefs.ignoreWhitespace));
					added += own.added; removed += own.removed;
				}
				items.push({ path: rec.path, name: displayName(rec.path, rec.cwd), cwd: rec.cwd, ops: ops.length, writes: writes, edits: edits, added: added, removed: removed, lastTime: ops[ops.length - 1].at, revertible: false, sections: detailFromRecIdx(rec, indices).sections });
			}
			items.sort((x, y) => y.lastTime - x.lastTime);
			return { turn: turn, files: items };
		}
		// Per-turn payload: prefer the host channel (authoritative turn tags,
		// full records incl. revert snapshots), fall back to local history.
		// `turn` null/NaN resolves to the latest activity window (-1): newest
		// labeled turn + in-flight unlabeled ops (0 = no turn/start window,
		// matches the card's window semantics).
		const turnInflight = new Map(); // (session|turn) -> Promise, dedupes concurrent fetches
		function fetchTurnData(session, turnNo) {
			const turn = (turnNo == null || !Number.isFinite(turnNo)) ? -1 : turnNo;
			const key = String(session) + "|" + String(turn);
			const inf = turnInflight.get(key);
			if (inf) return inf;
			const p = apiTurn(session, turn).then((v) => {
				// Empty-but-valid arrays from the host block the local fallback
				// (host ops can be turn-0-tagged after a DSH event rename while
				// the parsed transcript has the correct turns) — only trust a
				// NON-empty payload as authoritative.
				return (v && Array.isArray(v.files) && v.files.length) ? { turn: typeof v.turn === "number" ? v.turn : turn, files: v.files, fromHost: true } : localTurnData(turn);
			}).catch(() => localTurnData(turn));
			const done = () => { if (turnInflight.get(key) === p) turnInflight.delete(key); };
			p.then(done, done);
			turnInflight.set(key, p);
			return p;
		}
		function loadTurn(turnNo) {
			const session = store.currentSession;
			if (!session) { setState({ turnData: null }); return; }
			const seq = ++reqSeq;
			fetchTurnData(session, turnNo).then((data) => {
				if (seq !== reqSeq || store.currentSession !== session) return;
				const next = { turn: data.turn, files: data.files || [] };
				// An unchanged tick keeps the previous object: the list, the turn
				// switcher and the detail pane are all derived from it, so committing a
				// structurally identical payload re-rendered them for nothing.
				if (samePayload(store.turnData, next)) return;
				setState({ turnData: next });
			});
		}
		// Select a file: latest mode shows the turn payload's inline sections.
		function loadDetail(path) {
			const session = store.currentSession;
			if (!session) return;
			// local review data (official history API) is the primary source
			setState({ selected: path, detail: null, loadingDetail: true, error: null });
			// Prefer the host channel when it is live (web profile) for full
			// records incl. revert snapshots; fall back to local history.
			apiFile(session, path).then((v) => {
				if (store.currentSession !== session || store.selected !== path) return;
				// Only a payload WITH hunks is authoritative. An empty host reply
				// must not blank a file the transcript does know about (Desktop /
				// legacy host with no record, cleared bucket, plugin loaded
				// mid-session) — the local record is then the better answer.
				const rec = reviewFiles.get(path);
				const local = rec ? detailFromRec(rec) : null;
				if (v && Array.isArray(v.sections) && v.sections.length) { setState({ detail: v, loadingDetail: false }); return; }
				if (local && local.sections && local.sections.length) { setState({ detail: local, loadingDetail: false }); return; }
				setState({ detail: v && Array.isArray(v.sections) ? v : { path: path, sections: [] }, loadingDetail: false });
			}).catch(() => {
				if (store.currentSession !== session) return;
				setState({ detail: detailFromRec(reviewFiles.get(path)), loadingDetail: false, error: null });
			});
		}
		function refreshFromServer() {
			// Polling tick: rebuild from the official history API. Each rebuild
			// aborts the in-flight history read first, so ticks never pile up.
			const session = store.currentSession;
			if (!session) return;
			rebuildReview();
		}

		// v3: polling over the official connection RPC channel. No SSE — the
		// channel is request/response only, and this one code path works on both
		// Web and Desktop (the transport differs, the API does not).
		function connectEvents() {
			let closed = false;
			let timer = null;
			let themeObserver = null;
			const tick = () => {
				if (closed) return;
				syncThemeColors();
				updateRunning();
				if (store.currentSession) refreshFromServer();
				timer = setTimeout(tick, 5000);
			};
			tick();
			// Follow theme switches immediately (the app toggles
			// `body[data-ds-dark-theme]`), not just on the 5s poll tick.
			try {
				if (typeof MutationObserver === "function" && typeof document !== "undefined" && document.body) {
					themeObserver = new MutationObserver(() => { syncThemeColors(); });
					themeObserver.observe(document.body, { attributes: true, attributeFilter: ["data-ds-dark-theme"] });
				}
			} catch (e) {}
			return () => { closed = true; if (timer) clearTimeout(timer); if (themeObserver) themeObserver.disconnect(); };
		}

		function fmtTime(t) {
			if (!t) return "";
			const d = new Date(t);
			const p = (x) => String(x).padStart(2, "0");
			return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
		}


		const COLOR_ROWS = [
			["addBg", "新增行背景"], ["addFg", "新增行文字"],
			["delBg", "删除行背景"], ["delFg", "删除行文字"],
			["ctxBg", "上下文背景"], ["gutter", "行号 / 标记"],
			["badgeBg", "角标背景"], ["badgeFg", "角标文字"]
			// 每轮卡片与运行中小胶囊现在都用 DSH 主题 token（见 .cdx-cf-* / .cdx-pill），
			// 所以不再有"对话底部"专属的四个自定义项——它们跟随主题，不能也不会被改。
		];

		function ColorRows() {
			const tab = useStore((s) => s.colorTab);
			const sets = useStore((s) => s.colorSets);
			const colors = (sets && sets[tab]) || (tab === "dark" ? DARK : LIGHT);
			const update = (key, value) => {
				const next = Object.assign({}, sets || {}, { [tab]: Object.assign({}, colors, { [key]: value }) });
				const patch = { colorSets: next };
				if (tab === detectTheme()) patch.colors = next[tab];
				setState(patch);
			};
			return COLOR_ROWS.map((row) => {
				const key = row[0];
				const parsed = parseColor(colors[key]) || { r: 128, g: 128, b: 128, a: 1 };
				return React.createElement("label", { key: key, className: "drv-color-row" },
					React.createElement("span", null, row[1]),
					React.createElement("div", { className: "drv-color-controls" },
						React.createElement("input", {
							type: "color",
							value: hexOf(parsed),
							onChange: (e) => update(key, formatRgba(Object.assign({}, parsed, parseColor(e.target.value))))
						}),
						React.createElement("input", {
							type: "range",
							min: 0,
							max: 100,
							value: Math.round(parsed.a * 100),
							title: "透明度",
							onChange: (e) => update(key, formatRgba(Object.assign({}, parsed, { a: Number(e.target.value) / 100 })))
						}),
						React.createElement("span", { className: "drv-color-alpha" }, Math.round(parsed.a * 100) + "%"))
				);
			});
		}

		function PresetButtons() {
			const tab = useStore((s) => s.colorTab);
			return React.createElement("div", { className: "drv-presets" },
				React.createElement("button", {
					onClick: () => {
						const next = Object.assign({}, store.colorSets, { [tab]: Object.assign({}, LIGHT) });
						setState(Object.assign({ colorSets: next }, tab === detectTheme() ? { colors: next[tab] } : {}));
					}
				}, "浅色预设"),
				React.createElement("button", {
					onClick: () => {
						const next = Object.assign({}, store.colorSets, { [tab]: Object.assign({}, DARK) });
						setState(Object.assign({ colorSets: next }, tab === detectTheme() ? { colors: next[tab] } : {}));
					}
				}, "深色预设"),
				React.createElement("button", {
					onClick: () => {
						const base = tab === "dark" ? DARK : LIGHT;
						const next = Object.assign({}, store.colorSets, { [tab]: Object.assign({}, base) });
						setState(Object.assign({ colorSets: next }, tab === detectTheme() ? { colors: next[tab] } : {}));
					}
				}, "恢复默认"));
		}


		function SessionProbe(props) {
			React.useEffect(() => {
				if (props.sessionId && store.currentSession !== props.sessionId) {
					reqSeq++; // 丢弃上一个会话仍在途的请求
					setState({ currentSession: props.sessionId, files: null, selected: null, detail: null, turnData: null, hostWindow: null, latestTurn: 0, error: null, loadingFiles: true, filesFromHost: false });
					updateRunning();
					refreshFromServer();
				}
			}, [props.sessionId]);
			return null;
		}

		// ── View tab label ──────────────────────────────────────────────────────
		// The host projects the View tab from the slot entry, and that projection is
		// TEXT: `label: string | (() => string)`. Client 44.x sizes every tab with
		// `for (const glyph of label)` (ui-conversation's ViewTabLabel), so a React
		// element here throws "label is not iterable" inside the tab row and takes
		// the whole strip down with it — which is exactly how the review tab
		// "disappeared" after the upgrade. A plain string keeps the tab alive; the
		// count deliberately stays OFF the tab (the pill and the panel carry it), so
		// there is nothing to re-project when files change.
		const REVIEW_TAB_LABEL = "审查";

		// Codex-style per-turn card (conversation.chat.turnTail)
		/** Rows shown before the fold, matching the official card's summary height. */
		const CF_COLLAPSED_ROWS = 3;
		/** Angle brackets — the code mark the official changed-files card shows in its header
		 *  tile. Inlined from @deepseek-ai/dsh-client-ui-deliverables (a plugin bundle cannot
		 *  require the shell's primitives package). */
		function CodeBracketsIcon({ size = 16 }) {
			return React.createElement("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: "none", xmlns: "http://www.w3.org/2000/svg", "aria-hidden": "true" },
				React.createElement("path", { d: "M5.6 3.4 1 8l4.6 4.6M10.4 3.4 15 8l-4.6 4.6", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round" }));
		}
		/** Chevron for the card's fold row (up = collapsed list is open again). */
		function ChevronIcon14({ up }) {
			const d = up
				? "M2.15137 8.5L2.57617 8.07617L5.30273 5.34863C5.55843 5.09294 5.78438 4.86618 5.98828 4.70215C6.20088 4.53117 6.44405 4.38244 6.75 4.33398C6.91565 4.30778 7.08435 4.30778 7.25 4.33398C7.55595 4.38244 7.79912 4.53117 8.01172 4.70215C8.21561 4.86618 8.44157 5.09294 8.69727 5.34863L11.4238 8.07617L11.8486 8.5L11 9.34863L10.5762 8.92383L7.84863 6.19727C7.57405 5.92269 7.40124 5.75152 7.25977 5.6377C7.12709 5.53096 7.07728 5.52187 7.0625 5.51953C7.02105 5.51297 6.97895 5.51297 6.9375 5.51953C6.92272 5.52187 6.87291 5.53096 6.74023 5.6377C6.59876 5.75152 6.42595 5.92268 6.15137 6.19727L3.42383 8.92383L3 9.34863L2.15137 8.5Z"
				: "M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z";
			return React.createElement("svg", { width: 14, height: 14, viewBox: "0 0 14 14", fill: "none", xmlns: "http://www.w3.org/2000/svg", "aria-hidden": "true" },
				React.createElement("path", { d: d, fill: "currentColor" }));
		}
		function fmtDayTime(t) {
			if (!t) return "";
			const d = new Date(t);
			const p = (x) => String(x).padStart(2, "0");
			return ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"][d.getDay()] + " " + p(d.getHours()) + ":" + p(d.getMinutes());
		}
		function collectTurn(turnNo) {
			let added = 0, removed = 0, lastAt = 0, opCount = 0;
			const files = [];
			for (const rec of reviewFiles.values()) {
				const ops = [];
				for (const op of rec.ops) { if (op.turn === turnNo) ops.push(op); }
				if (ops.length === 0) continue;
				let a = 0, r = 0, writes = 0, edits = 0;
				for (const op of ops) {
					if (op.kind === "edit") edits++; else writes++;
					const own = opLineCounts(op, !!(store.reviewPrefs && store.reviewPrefs.ignoreWhitespace));
					a += own.added; r += own.removed;
				}
				added += a; removed += r; opCount += ops.length;
				lastAt = Math.max(lastAt, ops[ops.length - 1].at || 0);
				files.push({ path: rec.path, name: displayName(rec.path, rec.cwd), added: a, removed: r, ops: ops.length, writes: writes, edits: edits });
			}
			files.sort((x, y) => y.ops - x.ops);
			return { files: files, added: added, removed: removed, lastAt: lastAt, opCount: opCount };
		}
		function openReviewTab() {
			let viaStore = false
			try {
				if (openViewRef) { openViewRef("review", "diff-review"); viaStore = true }
			} catch (e) { viaStore = false }
			if (!viaStore) { clickReviewTab(); return }
			// A shell that does not know the id (older/newer contract) would silently
			// ignore the action — verify, then fall back to clicking our own tab.
			setTimeout(() => { if (!reviewTabShown()) clickReviewTab() }, 80)
		}
		// The tab strip is rendered by the shell from the slot entries. Older shells
		// rendered OUR label element (data-dsh-view); 44.x projects the label as text
		// inside the strip's own button (`[data-conversation-tabs]`), so the button is
		// located by that text when the marker is absent.
		function reviewTabButton() {
			try {
				const own = document.querySelector('[data-dsh-view="review"]')
				const marked = own && own.closest ? own.closest('button, [role=tab]') : null
				if (marked) return marked
			} catch (e) {}
			try {
				const scopes = document.querySelectorAll('[data-conversation-tabs], [role=tablist]')
				for (const scope of scopes) {
					const els = scope.querySelectorAll('[role=tab], button')
					for (const el of els) {
						const t = (el.textContent || "").trim()
						// Exact text: the settings row reads "修改审查", never just ours.
						if (t === REVIEW_TAB_LABEL) return el
					}
				}
			} catch (e) {}
			return null
		}
		function clickReviewTab() {
			const btn = reviewTabButton()
			if (btn && typeof btn.click === "function") { btn.click(); return true }
			try {
				const els = document.querySelectorAll('[role=tablist] [role=tab], [role=tab], button, [role=button], [data-view]')
				for (const el of els) {
					const t = (el.textContent || "").trim()
					if (t === REVIEW_TAB_LABEL && el.clientWidth > 0) { el.click(); return true }
				}
			} catch (e) {}
			return false
		}
		function reviewTabShown() {
			try {
				const btn = reviewTabButton()
				return !!(btn && btn.getAttribute && btn.getAttribute("aria-selected") === "true")
			} catch (e) { return false }
		}
		// Normalize per-turn payloads (host turn RPC / local aggregation /
		// collectTurn) into one card model.
		function toCardModel(d) {
			const files = d && d.files ? d.files : [];
			if (!files.length) return null;
			let added = 0, removed = 0, lastAt = 0, opCount = 0;
			for (const f of files) {
				added += f.added || 0; removed += f.removed || 0;
				lastAt = Math.max(lastAt, f.lastTime || 0);
				opCount += f.ops || 0;
			}
			return { files: files, added: added, removed: removed, lastAt: lastAt, opCount: opCount };
		}
		function TurnReview({ matched, sessionId, turn: turnLoc, seq, inputActions, openFile }) {
			// Capture the shell's file opener (see openFileRef) — the chat supplies it
			// to every turn card, and it can position the right-sidebar preview at a line.
			if (typeof openFile === "function") openFileRef = openFile;
			// Turn number: host 0.1.6 declares this slot `list`, so there is no chain
			// election and no `matched` prop any more — the owner props carry the
			// TurnLocation itself. Older chain hosts send both, so `matched.turn`
			// stays as the fallback.
			const turnNo = (turnLoc && turnLoc.turn != null) ? turnLoc.turn : (matched && matched.turn);
			const latestTurn = useStore((s) => s.latestTurn); // re-render as the review data refreshes
			const filesTick = useStore((s) => s.files); // poll refresh signal
			const colors = useStore((s) => s.colors);
			const dark = useStore((s) => s.themeNow) === "dark";
			const [revertStatus, setRevertStatus] = React.useState("");
			// 撤销现在由宿主直接执行（`undo-turn`），不再把一串 diff_review_revert 指令
			// 填进 composer 让模型跑，所以需要防误触：第一次点击只"武装"，3 秒内再点一次
			// 才真的撤。
			const [revertArmed, setRevertArmed] = React.useState(false);
			const [revertBusy, setRevertBusy] = React.useState(false);
			// The official card folds a long file list behind a "全部 N 个文件" row; ours
			// keeps the same default (3 rows) so the two cards look identical.
			const [filesExpanded, setFilesExpanded] = React.useState(false);
			// Anchor for the row hover previews: the shell's HoverCard sizes a "preview"
			// panel from this element's width and horizontal position, so the popup lines
			// up with the card exactly like the official card's preview does.
			const cardRef = React.useRef(null);
			// Per-turn card data: the host turn RPC is authoritative (tags ops
			// with the live turn scan, full history — not the 2-page client
			// window); local history aggregation is the Desktop fallback.
			const effectiveTurn = (turnNo == null || !Number.isFinite(turnNo)) ? (latestTurn || 0) : turnNo;
			const [turnData, setTurnData] = React.useState(null);
			React.useEffect(() => {
				let alive = true;
				const sid = sessionId || store.currentSession;
				if (!sid) return;
				fetchTurnData(sid, effectiveTurn).then((d) => { if (alive) setTurnData(d); });
				return () => { alive = false; };
			}, [effectiveTurn, sessionId, filesTick]);
			// Synchronous fallback while the async payload is in flight: the
			// slot's own turn number, if the client window carries it.
			let local = turnData ? toCardModel(turnData) : null;
			if (!local) {
				const collected = collectTurn(effectiveTurn);
				local = collected && collected.opCount > 0 ? {
					files: collected.files, added: collected.added, removed: collected.removed,
					lastAt: collected.lastAt, opCount: collected.opCount
				} : null;
			}
			const noChanges = !local;
			const first = local ? local.files[0] : null;
			const sid = sessionId || store.currentSession;
			// Workspace-relative paths (relative to each record's cwd), never a
			// bare basename — falls back to the full path when no cwd matches.
			const showName = (f) => shortPathOf(f, sid);
			// A number that could only be estimated (a snapshot cut by the storage cap,
			// or a record predating snapshots) is marked with ≈ and says why: the shell's
			// own card counts a git diff between turn boundaries, so a silently different
			// magnitude is worse than an honest "≈".
			const approxNote = !!(local && local.files.some((f) => f && f.estimated === true));
			const title = first ? (local.files.length === 1 ? showName(first) : showName(first) + " 等 " + local.files.length + " 个文件") : "";
			const go = (path) => {
				try { setState({ reviewTurn: effectiveTurn, reviewFile: path || null }); } catch (e) {}
				openReviewTab();
			};
			const goFile = (e, path) => {
				e.stopPropagation(); // 单行点击不触发整卡跳转
				go(path);
			};
			if (noChanges) {
				return React.createElement("div", { className: "cdx-cf-card cdx-cf-empty", "data-dsh-review-card": true, title: "本轮无文件修改" },
					React.createElement("div", { className: "cdx-cf-header" },
						React.createElement("span", { className: "cdx-cf-tile cdx-cf-tile-muted" },
							React.createElement(CodeBracketsIcon, { size: 18 })),
						React.createElement("span", { className: "cdx-cf-titles" },
							React.createElement("span", { className: "cdx-cf-title cdx-cf-title-muted" }, "本轮无文件修改"))));
			}
			// Same visuals as the shell's own changed-files card (see CSS): header opens the
			// turn's review on its first file, each row opens it on that row's file, and a
			// long list folds behind one row. 撤销 / 审核 are this plugin's own additions.
			const total = local.files.length;
			const foldable = total > CF_COLLAPSED_ROWS;
			const shown = (foldable && !filesExpanded) ? local.files.slice(0, CF_COLLAPSED_ROWS) : local.files;
			return React.createElement("div", { className: "cdx-cf-card", "data-dsh-review-card": true, ref: cardRef },
				React.createElement("div", {
					className: "cdx-cf-header cdx-cf-header-btn",
					role: "button",
					tabIndex: 0,
					title: "打开审查视图",
					onClick: () => go(total === 1 ? first.path : null),
					// The official header is a real <button>; ours hosts a second button
					// (审核), so it is a div and has to take Enter/Space itself.
					onKeyDown: (e) => {
						if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(total === 1 ? first.path : null); }
					}
				},
					React.createElement("span", { className: "cdx-cf-tile" },
						React.createElement(CodeBracketsIcon, { size: 18 })),
					React.createElement("span", { className: "cdx-cf-titles" },
						React.createElement("span", { className: "cdx-cf-title", title: first.path }, "已编辑 " + (total === 1 ? showName(first) : total + " 个文件")),
						React.createElement("span", { className: "cdx-cf-stat", title: approxNote ? ESTIMATED_NOTE : undefined },
							React.createElement("span", { className: "cdx-cf-added" }, (approxNote ? "≈" : "") + "+" + local.added),
							React.createElement("span", { className: "cdx-cf-deleted" }, (approxNote ? "≈" : "") + "−" + local.removed),
							React.createElement("span", { className: "cdx-cf-time" }, fmtDayTime(local.lastAt)))),
					React.createElement("span", { className: "cdx-cf-actions" },
						React.createElement("button", {
							type: "button",
							className: "cdx-cf-btn" + (revertArmed ? " cdx-cf-btn-armed" : ""),
							disabled: revertBusy,
							title: "直接撤回这一轮的修改（宿主执行，不走模型）",
							onClick: async (e) => {
								e.stopPropagation(); // 卡片整卡点击会跳审查——按钮内拦截
								// 防误触：第一次点击只武装，3 秒内再点一次才真的撤。
								if (!revertArmed) {
									setRevertArmed(true);
									setRevertStatus("再点一次确认");
									setTimeout(() => { setRevertArmed(false); setRevertStatus(""); }, 3000);
									return;
								}
								setRevertArmed(false);
								setRevertBusy(true);
								try {
									const res = await apiUndoTurn(sessionId, effectiveTurn);
									if (res && res.ok) {
										setRevertStatus("已撤回 ✓");
										refreshFromServer();
									} else {
										setRevertStatus((res && res.error) || "撤回失败");
									}
								} catch (e2) {
									setRevertStatus("撤回失败");
								}
								setRevertBusy(false);
								setTimeout(() => setRevertStatus(""), 2200);
							}
						}, revertBusy ? "撤回中…" : (revertStatus || "撤销")),
						React.createElement("button", {
							type: "button",
							className: "cdx-cf-btn",
							onClick: (e) => {
								e.stopPropagation();
								go(null);
							}
						}, "审核"))),
				React.createElement("ul", { className: "cdx-cf-list" },
					shown.map((f) => {
						const row = React.createElement("button", {
							type: "button",
							className: "cdx-cf-row",
							title: "查看 " + f.path + " 的修改",
							onClick: (e) => goFile(e, f.path)
						},
							React.createElement("span", { className: "cdx-cf-path", title: f.estimated ? ESTIMATED_NOTE : undefined }, showName(f)),
							React.createElement("span", { className: "cdx-cf-counts" },
								React.createElement("span", { className: "cdx-cf-added" }, (f.estimated ? "≈" : "") + "+" + f.added),
								React.createElement("span", { className: "cdx-cf-deleted" }, (f.estimated ? "≈" : "") + "−" + f.removed)));
						// Hovering a row previews that file's diff in place — the shell's own
						// HoverCard primitive (the official changed-files card previews its rows
						// the same way), sized from the card so the panel lines up with it. The
						// content is ours (see RowPreview), so the plugin's diff colours apply.
						return React.createElement("li", { key: f.path },
							OfficialHoverCard
								? React.createElement(OfficialHoverCard, {
									variant: "preview",
									widthAnchorRef: cardRef,
									openDelayMs: PREVIEW_OPEN_DELAY_MS,
									anchor: row,
									content: React.createElement(RowPreview, { sessionId: sid, item: f })
								})
								: row);
					})),				foldable ? React.createElement("button", {
					type: "button",
					className: "cdx-cf-toggle",
					"aria-expanded": filesExpanded,
					"aria-label": (filesExpanded ? "收起文件列表" : "展开全部 " + total + " 个文件"),
					onClick: (e) => {
						e.stopPropagation();
						setFilesExpanded(!filesExpanded);
					}
				},
					React.createElement("span", null, filesExpanded ? "收起" : "全部 " + total + " 个文件"),
					React.createElement(ChevronIcon14, { up: filesExpanded })) : null);
		}
		// ── Codex-style review view ────────────────────────────────────────
		// Lightweight syntax highlighting for diff lines (no external deps).
		const LANG_BY_EXT = {
			"js": ["js", "ts", "jsx", "tsx", "mjs", "cjs", "json", "jsonl", "css", "mjs.map"],
			"cpp": ["cpp", "cc", "cxx", "h", "hpp", "hh", "c", "cs", "swift", "java", "kt", "rs", "go", "ino"],
			"py": ["py", "pyw", "rb", "sh", "bash", "zsh", "ps1", "cmd", "bat", "vim", "yml", "yaml", "toml", "ini", "conf", "env", "cmake", "txt"]
		};
		const KEYWORDS = {
			js: "async|await|break|case|catch|class|const|continue|default|delete|do|else|enum|export|extends|finally|for|from|function|get|if|import|in|instanceof|let|new|of|return|set|static|super|switch|this|throw|try|typeof|var|void|while|with|yield|interface|type|implements|namespace|declare|readonly|abstract|as|satisfies|keyof|infer|any|boolean|never|number|string|symbol|unknown|void|true|false|null|undefined",
			cpp: "alignas|and|asm|auto|bool|break|case|catch|char|class|const|constexpr|continue|default|delete|do|double|else|enum|explicit|export|extern|false|float|for|friend|goto|if|inline|int|long|mutable|namespace|new|noexcept|nullptr|operator|override|private|protected|public|register|reinterpret_cast|return|short|signed|sizeof|static|struct|switch|template|this|throw|true|try|typedef|typename|union|unsigned|using|virtual|void|volatile|while|std|string|uint32_t|int32_t|uint64_t|size_t|constexpr",
			py: "and|as|assert|async|await|break|class|continue|def|del|elif|else|except|False|finally|for|from|global|if|import|in|is|lambda|None|nonlocal|not|or|pass|raise|return|True|try|while|with|yield|self|self|match|case|type"
		};
		// The alternation is tested against one identifier at a time, so each language's
		// pattern is compiled once instead of being rebuilt for every token.
		const KEYWORD_RE = {
			js: new RegExp("(^|\\W)(" + KEYWORDS.js + ")(\\W|$)"),
			cpp: new RegExp("(^|\\W)(" + KEYWORDS.cpp + ")(\\W|$)"),
			py: new RegExp("(^|\\W)(" + KEYWORDS.py + ")(\\W|$)")
		};
		function langOf(path) {
			const ext = String(path || "").split(".").pop().toLowerCase();
			if (ext === "md" || ext === "mdx") return "md";
			for (const k of Object.keys(LANG_BY_EXT)) {
				if (LANG_BY_EXT[k].indexOf(ext) >= 0) return k;
			}
			return null;
		}
		function tokenizeLine(line, lang) {
			const out = [];
			let i = 0;
			const n = line.length;
			let buf = "";
			const push = (t) => { if (buf) { out.push({ t: t, s: buf }); buf = ""; } };
			const lineComment = lang === "py" ? "#" : lang === "md" ? null : "//";
			const blockOpen = lang === "cpp" ? "/*" : null;
			const strings = lang === "py" || lang === "md" ? ["\"", "'", "\"\""] : ["\"", "'", "`"];
			const kw = lang === "js" ? KEYWORD_RE.js : lang === "cpp" ? KEYWORD_RE.cpp : lang === "py" ? KEYWORD_RE.py : null;
			while (i < n) {
				const ch = line[i];
				// line comment
				if (lineComment && line.startsWith(lineComment, i)) { push("plain"); buf = line.slice(i); push("com"); break; }
				// block comment
				if (blockOpen && line.startsWith(blockOpen, i)) {
					push("plain");
					const end = line.indexOf("*/", i + 2);
					if (end < 0) { buf = line.slice(i); push("com"); break; }
					buf = line.slice(i, end + 2); push("com");
					i = end + 2; continue;
				}
				// strings
				let strHit = null;
				for (const q of strings) { if (line.startsWith(q, i)) { strHit = q; break; } }
				if (strHit) {
					push("plain");
					const end = line.indexOf(strHit, i + strHit.length);
					if (end < 0) { buf = line.slice(i); push("str"); break; }
					buf = line.slice(i, end + strHit.length); push("str");
					i = end + strHit.length; continue;
				}
				// number
				if (/\d/.test(ch)) {
					push("plain");
					let j = i + 1;
					while (j < n && /[\w.]/.test(line[j])) j++;
					buf = line.slice(i, j); push("num");
					i = j; continue;
				}
				// identifier / keyword
				if (/[A-Za-z_$@]/.test(ch)) {
					push("plain");
					let j = i + 1;
					while (j < n && /[A-Za-z0-9_$-]/.test(line[j])) j++;
					const word = line.slice(i, j);
					if (kw && kw.test(" " + word + " ")) { buf = word; push("kw"); }
					else { buf = word; push("plain"); }
					i = j; continue;
				}
				buf += ch; i++;
			}
			push("plain");
			return out;
		}
		function CodexLine({ h, lang, rel, openLine, openAnchor }) {
			const colors = useStore((s) => s.colors);
			const dark = useStore((s) => s.themeNow) === "dark";
			let sign = " ";
			let cls = "cdx-line";
			let bg = colors.ctxBg;
			let fg = null;
			if (h.type === "add") { sign = "+"; cls += " cdx-add"; bg = colors.addBg; fg = colors.addFg; }
			else if (h.type === "del") { sign = "−"; cls += " cdx-del"; bg = colors.delBg; fg = colors.delFg; }
			const no = h.type === "add" ? h.b : h.a;
			const tokens = lang ? tokenizeLine(h.text || "", lang) : null;
			const pal = dark ? SYNTAX.dark : SYNTAX.light;
			// `rel`: the section has no before-snapshot, so this number is a
			// fragment-local index, not a file line. Prefix it with ~ so it cannot be
			// mistaken for an absolute line number.
			const gutter = rel && no != null
				? React.createElement("span", { className: "cdx-gutter cdx-gutter-rel", style: { color: colors.gutter }, title: "片段内相对行号（该记录未保存编辑前快照）" }, "~" + no)
				: React.createElement("span", { className: "cdx-gutter", style: { color: colors.gutter } }, no != null ? String(no) : "");
			// Per-change "open in editor at this line": additions jump to their own
			// new-side line; deletions jump to the section's new-side anchor (the line
			// they were removed from no longer exists). Context rows get no button, and
			// neither do fragment-relative rows — a jump to a made-up line is worse
			// than no button at all.
			const target = h.type === "add" ? h.b : openAnchor;
			const openBtn = (openLine && !rel && h.type !== "ctx" && target != null) ? openButton(openLine, target, "line-open") : null;
			return React.createElement("div", { className: cls, style: { background: bg } },
				gutter,
				React.createElement("span", { className: "cdx-sign", style: { color: fg } }, sign),
				React.createElement("span", { className: "cdx-text", style: { color: fg || themeLabel(dark) } },
					tokens ? tokens.map((tk, i) => tk.t === "plain" ? tk.s : React.createElement("span", { key: i, className: "cdx-tok-" + tk.t, style: { color: pal[tk.t] } }, tk.s))
						: (h.text === "" ? " " : h.text)),
				openBtn);
		}
		// Where a section's change sits in the NEW file: the smallest new-side line
		// number it touches. Deletions have no new-side line of their own, so they
		// jump here (the position the removed lines were at) — which is also why a
		// per-line button on a `del` row targets this anchor instead of `h.a`.
		function sectionOpenLine(sec) {
			if (!sec || sec.lineExact === false) return null;
			let min = null;
			for (const h of sec.hunks || []) {
				if (typeof h.b === "number" && (min === null || h.b < min)) min = h.b;
			}
			if (min !== null) return min;
			return typeof sec.lineBase === "number" && sec.lineBase > 0 ? sec.lineBase : null;
		}
		// `openLine(line)` is null when the view cannot open a file at all; the
		// buttons are then omitted (and never shown for sections whose numbers are
		// fragment-relative — jumping to a made-up line would be worse than nothing).
		function openButton(openLine, line, key) {
			if (!openLine || line == null) return null;
			const ed = store.selectedEditor;
			const title = ed && ed.name
				? "在 " + ed.name + " 中打开第 " + line + " 行"
				: "打开文件（顶栏选择编辑器后可跳转到第 " + line + " 行）";
			return React.createElement("button", {
				key: key || "open",
				type: "button",
				className: "cdx-open",
				title: title,
				onClick: (e) => { if (e && e.stopPropagation) e.stopPropagation(); openLine(line); }
			}, "↗");
		}
		// Section header shared by the split and card views: kind + time, the
		// line-number provenance when the numbers are not real file lines (or the
		// change landed on several sites via replace_all), and an open-at-line button.
		function sectionHead(sec, openLine) {
			const marks = [];
			if (sec.lineExact === false) marks.push(React.createElement("span", { key: "rel", className: "cdx-sec-note", title: "该记录没有编辑前快照，行号是片段内序号，不是文件行号" }, "相对行号"));
			if (sec.multiMatch > 1) marks.push(React.createElement("span", { key: "multi", className: "cdx-sec-note", title: "replace_all：该片段在文件中出现 " + sec.multiMatch + " 处，行号对应第 1 处" }, "多处替换×" + sec.multiMatch));
			const open = openButton(openLine, sectionOpenLine(sec), "sec-open");
			return React.createElement("div", { className: "cdx-sec-head" },
				React.createElement("span", { className: "cdx-sec-tag cdx-sec-" + sec.kind }, sec.kind === "edit" ? "编辑" : "写入"),
				React.createElement("span", { className: "cdx-sec-time" }, fmtTime(sec.at)),
				React.createElement("span", { className: "cdx-sec-marks" }, marks.length ? marks : null, open));
		}
		// ── hover preview for a card row ─────────────────────────────────────────
		// The panel chrome is the shell's theme; the DIFF itself is drawn by our own
		// CodexLine renderer on purpose. The official DiffBlock/preview would bring the
		// official palette, and this plugin's diff colours are user-configurable
		// (设置 → 修改审查) — a hover preview that ignored them would disagree with the
		// review tab about the very same change.
		const PREVIEW_MAX_ROWS = 400;
		const PREVIEW_OPEN_DELAY_MS = 350;
		function RowPreview({ sessionId, item }) {
			// Mounted by HoverCard only while the popup is open, which is what makes this
			// lazy load affordable. The host's `preview` rows are a FULL-FILE diff trimmed
			// to three context lines around each change — the same shape the shell's own
			// preview shows. The per-op `sections` are the fallback (they only carry the
			// fragments the model wrote, so a one-line edit would show a bare +/− pair).
			const inline = item && item.preview && Array.isArray(item.preview.rows) && item.preview.rows.length ? item.preview.rows : null;
			const [detail, setDetail] = React.useState(null);
			const path = item && item.path ? item.path : "";
			React.useEffect(() => {
				if (inline || !path) return undefined;
				let alive = true;
				apiFile(sessionId || store.currentSession, path)
					.then((d) => { if (alive) setDetail(d); })
					.catch(() => { if (alive) setDetail({ sections: [] }); });
				return () => { alive = false; };
			}, [inline, path, sessionId]);
			const remoteRows = detail && detail.preview && Array.isArray(detail.preview.rows) && detail.preview.rows.length ? detail.preview.rows : null;
			const rows = inline || remoteRows;
			const sections = rows ? null : (item && Array.isArray(item.sections) && item.sections.length
				? item.sections
				: (detail && Array.isArray(detail.sections) ? detail.sections : null));
			const lang = langOf(path);
			const body = [];
			let total = 0;
			if (rows) {
				total = rows.length;
				const capped = rows.length > PREVIEW_MAX_ROWS;
				const shownRows = capped ? rows.slice(0, PREVIEW_MAX_ROWS) : rows;
				for (let i = 0; i < shownRows.length; i++) {
					const row = shownRows[i];
					if (row.type === "gap") body.push(React.createElement("div", { key: "g" + i, className: "cdx-preview-gap" }, row.text || "⋯"));
					else body.push(React.createElement(CodexLine, { key: i, h: row, lang: lang, rel: row.lineExact === false, openLine: null, openAnchor: null }));
				}
				if (capped) body.push(React.createElement("div", { key: "cap", className: "cdx-preview-note" }, "仅显示前 " + PREVIEW_MAX_ROWS + " 行，完整对比见审查视图"));
			} else if (sections) {
				const flat = [];
				for (const sec of sections) {
					const hs = Array.isArray(sec.hunks) ? sec.hunks : [];
					total += hs.length;
					for (const h of hs) flat.push({ h: h, rel: sec.lineExact === false });
				}
				const capped = flat.length > PREVIEW_MAX_ROWS;
				const shown = capped ? flat.slice(0, PREVIEW_MAX_ROWS) : flat;
				for (let i = 0; i < shown.length; i++) {
					body.push(React.createElement(CodexLine, { key: i, h: shown[i].h, lang: lang, rel: shown[i].rel, openLine: null, openAnchor: null }));
				}
				if (capped) body.push(React.createElement("div", { key: "cap", className: "cdx-preview-note" }, "仅显示前 " + PREVIEW_MAX_ROWS + " 行（共 " + total + " 行），完整对比见审查视图"));
			}
			return React.createElement("div", { className: "cdx-preview" },
				React.createElement("div", { className: "cdx-preview-head" },
					React.createElement("span", { className: "cdx-preview-path", title: path }, shortPathOf(item, sessionId)),
					React.createElement("span", { className: "cdx-preview-counts" },
						React.createElement("span", { className: "cdx-cf-added" }, "+" + (item && item.added || 0)),
						React.createElement("span", { className: "cdx-cf-deleted" }, "−" + (item && item.removed || 0)))),
				React.createElement("div", { className: "cdx-preview-body" },
					rows === null && sections === null
						? React.createElement("div", { className: "cdx-preview-note" }, "载入中…")
						: (body.length === 0
							? React.createElement("div", { className: "cdx-preview-note" }, "本轮没有可展示的差异")
							: body)));
		}
		// Codex-style file-type badge (colored square + short label)
		function relOf(path, cwd) {
			const p = String(path || "");
			const c = String(cwd || "");
			if (!c || p === c) return null;
			const norm = (x) => x.replace(/\\/g, "/").replace(/\/+$/, "");
			const pn = norm(p), cn = norm(c);
			if (pn.indexOf(cn + "/") !== 0) return null;
			return pn.slice(cn.length + 1);
		}
		function displayName(path, cwd) {
			return relOf(path, cwd) || basenameOf(path);
		}
		function basenameOf(p){var s=String(p||"");var i=Math.max(s.lastIndexOf("/"),s.lastIndexOf("\\"));return i>=0?s.slice(i+1):s;}
		// Session cwd fallback (client-side session list) for local-history
		// records whose tool input carried no cwd.
		function sessionCwdOf(sessionId) {
			try {
				if (ctxRef && ctxRef.sessions && ctxRef.sessions.list && typeof ctxRef.sessions.list.getSnapshot === "function") {
					const byId = ctxRef.sessions.list.getSnapshot().byId;
					return byId && byId[sessionId] ? byId[sessionId].cwd : null;
				}
			} catch (e) {}
			return null;
		}
		// Workspace-relative path for display: relative to the record's cwd
		// (fallback: session cwd); never a bare basename — falls back to the
		// full path when no cwd matches.
		function shortPathOf(item, sessionId) {
			const cwd = (item && item.cwd) || sessionCwdOf(sessionId);
			if (cwd && item && item.path) {
				const rel = relOf(item.path, cwd);
				if (rel) return rel;
			}
			return (item && item.path) || "";
		}

		const FILE_TYPES = {
			js: ["#f7df1e", "JS"], jsx: ["#f7df1e", "JS"], mjs: ["#f7df1e", "JS"], cjs: ["#f7df1e", "JS"],
			ts: ["#3178c6", "TS"], tsx: ["#3178c6", "TS"],
			json: ["#8a63d2", "{}"], jsonl: ["#8a63d2", "{}"],
			css: ["#663399", "#"], scss: ["#cd6799", "#"], html: ["#e44d26", "<>"], htm: ["#e44d26", "<>"],
			md: ["#6f42c1", "M"], mdx: ["#6f42c1", "M"],
			py: ["#3572A5", "PY"], pyw: ["#3572A5", "PY"],
			cpp: ["#00599c", "C++"], cc: ["#00599c", "C++"], cxx: ["#00599c", "C++"], c: ["#659ad2", "C"],
			h: ["#8a63a6", "H"], hpp: ["#8a63a6", "H"], hh: ["#8a63a6", "H"],
			cs: ["#68217a", "C#"], java: ["#e76f00", "J"], kt: ["#7f52ff", "K"], rs: ["#dea584", "RS"], go: ["#00ADD8", "GO"], swift: ["#f05138", "SW"], ino: ["#00979D", "AR"],
			rb: ["#701516", "RB"], sh: ["#4eaa25", "SH"], bash: ["#4eaa25", "SH"], zsh: ["#4eaa25", "SH"], ps1: ["#012456", "PS"],
			bat: ["#4eaa25", "BAT"], cmd: ["#4eaa25", "CMD"], vim: ["#019733", "VI"],
			yml: ["#cb171e", "Y"], yaml: ["#cb171e", "Y"], toml: ["#9c4221", "TO"], ini: ["#4eaa25", "INI"], conf: ["#6a737d", "CFG"], env: ["#6a737d", "ENV"],
			cmake: ["#064F8C", "CM"], txt: ["#6a737d", "TXT"], csv: ["#237346", "CSV"], log: ["#6a737d", "LOG"], lock: ["#8a63d2", "LK"]
		};
		function fileTypeOf(path) {
			const ext = String(path || "").split(".").pop().toLowerCase();
			const hit = FILE_TYPES[ext];
			if (hit) return hit;
			return ["#6a737d", ext && ext.length <= 3 ? ext.toUpperCase() : "FI"];
		}
		function FileTypeBadge({ path, size }) {
			// Same mark the rest of the DSH UI draws for this path; the hand-rolled
			// letter chip only shows where the official module is unavailable.
			if (OfficialFileTypeIcon) {
				return React.createElement("span", { className: "cdx-fileicon" },
					React.createElement(OfficialFileTypeIcon, { path: path, size: size || 18 }));
			}
			const [color, label] = fileTypeOf(path);
			return React.createElement("span", { className: "cdx-filetype", style: { background: color } }, label);
		}
		// Per-turn sections for a file from the local review window (used when
		// the payload carries no prebuilt sections, e.g. the latest-window
		// fallback path). `turn` null/NaN means the whole window.
		function detailFromRecTurn(rec, turn) {
			if (!rec) return { path: "", sections: [] };
			if (turn == null || !Number.isFinite(turn)) return detailFromRec(rec);
			const indices = [];
			for (let i = 0; i < rec.ops.length; i++) if (rec.ops[i].turn === turn) indices.push(i);
			if (indices.length === 0) return { path: rec.path, sections: [] };
			return detailFromRecIdx(rec, indices);
		}
		function CodexFileCard({ item, expanded, onToggle, turn, scope }) {
			// Prefer the payload's own per-turn sections (host turn RPC / local
			// turn aggregation); fall back to the reviewed window. An 'all'-scope
			// entry whose row counts came from the host (host-adopted list, or a
			// file the transcript never saw) loads its hunks from the host file
			// endpoint, so the body can never show fewer ops than the header.
			const remote = useStore((s) => s.detail);
			const loadingDetail = useStore((s) => s.loadingDetail);
			const filesFromHost = useStore((s) => s.filesFromHost);
			const rec = reviewFiles.get(item.path);
			const needRemote = needHostDetail(scope, item, rec, filesFromHost);
			const remoteReady = !!(remote && remote.path === item.path);
			const detail = expanded
				? ((item.sections && item.sections.length)
					? { path: item.path, sections: item.sections }
					: needRemote
						? (remoteReady ? remote : { path: item.path, sections: [] })
						: detailFromRecTurn(rec, turn))
				: null;
			const lang = langOf(item.path);
			const colors = useStore((s) => s.colors);
			// "Open at this line" for every change in the card, resolved against the
			// same session/cwd the chat's file-open uses.
			const openLine = (line) => openFileAtLine(store.currentSession, item.path, item.cwd || (rec && rec.cwd), line);
			const head = React.createElement("button", { type: "button", className: "cdx-file-head", onClick: onToggle },
				React.createElement(FileTypeBadge, { path: item.path, size: 18 }),
				React.createElement("span", { className: "cdx-file-path", title: item.path }, shortPathOf(item, store.currentSession)),
				React.createElement("span", { className: "cdx-file-cnt" }, (item.writes > 0 ? "写入×" + item.writes + " " : "") + (item.edits > 0 ? "编辑×" + item.edits : "")),
				React.createElement("span", { className: "cdx-file-stats" },
					React.createElement("span", { className: "cdx-plus", style: { color: colors.addFg } }, "＋" + item.added),
					React.createElement("span", { className: "cdx-minus", style: { color: colors.delFg } }, "－" + item.removed)),
				React.createElement("span", { className: "cdx-chevron" }, expanded ? "▾" : "▸"));
			let body = null;
			if (expanded && detail) {
				if (detail.sections.length === 0) {
					// Host-only entry whose hunks are still in flight (or really
					// empty): say so instead of rendering a blank card body.
					body = React.createElement("div", { className: "cdx-file-body" },
						React.createElement("div", { className: "cdx-empty" },
							(needRemote && !remoteReady && loadingDetail) ? "加载中…" : "该文件没有可展示的修改"));
				} else {
					body = React.createElement("div", { className: "cdx-file-body" },
						detail.sections.map((sec, i) => React.createElement("div", { key: i, className: "cdx-sec" },
							sectionHead(sec, openLine),
							React.createElement("div", { className: "cdx-diff" },
								sec.hunks.map((h, k) => React.createElement(CodexLine, { key: k, h: h, lang: lang, rel: sec.lineExact === false, openLine: openLine, openAnchor: sectionOpenLine(sec) }))))));
				}
			}
			return React.createElement("div", { className: "cdx-file", "data-path": item.path, style: { background: colors.ctxBg } }, head, body);
		}
		// Whether an op belongs to the pill / tab-badge "latest activity"
		// window: ops of the newest labeled turn, plus unlabeled ops newer
		// than that turn's last op — an in-flight turn whose turn/start has
		// not landed in the history window yet. Older unlabeled ops (a
		// window cut inside an earlier turn — its turn/start fell outside)
		// drop out, so the running pill never mixes in previous turns.
		// Pure — smoke-tested directly.
		function inLatestWindow(turn, op, latestLabeledAt) {
			if (op.turn === turn) return true;
			if (op.turn === 0 || op.turn === undefined) return (op.at || 0) > latestLabeledAt;
			return false;
		}
		// Cutoff that separates an IN-FLIGHT (unlabeled) op from a leftover of an
		// earlier round: the newest op time among ops that carry a real turn tag.
		// Seeding it globally — instead of from the requested turn alone — is what
		// keeps a brand-new turn from inheriting the previous round: when turn N has
		// no ops yet, the cutoff is the last write of turn N-1, so only ops genuinely
		// newer than it (the ones actually in flight) join turn N's window. With no
		// tagged ops at all it stays 0, so a session whose ops are all unlabeled (the
		// DSH event-rename era) behaves exactly as before. Pure — smoke-tested.
		function lastLabeledAtOf(files) {
			let at = 0;
			for (const rec of files.values()) for (const op of rec.ops) {
				if (typeof op.turn === "number" && op.turn > 0 && (op.at || 0) > at) at = op.at || 0;
			}
			return at;
		}
		function windowList(turn) {
			// Fallback aggregation straight from the parsed window: ops of
			// the newest labeled turn plus unlabeled ops newer than that
			// turn's last op; older unlabeled ops drop out (see
			// inLatestWindow).
			const latestLabeledAt = lastLabeledAtOf(reviewFiles);
			const items = [];
			for (const rec of reviewFiles.values()) {
				let added = 0, removed = 0, writes = 0, edits = 0, at = 0;
				for (const op of rec.ops) {
					if (!inLatestWindow(turn, op, latestLabeledAt)) continue;
					if (op.kind === "edit") edits++; else writes++;
					const own = opLineCounts(op, !!(store.reviewPrefs && store.reviewPrefs.ignoreWhitespace));
					added += own.added; removed += own.removed;
					at = Math.max(at, op.at || 0);
				}
				if (!(writes + edits)) continue;
				items.push({ path: rec.path, name: displayName(rec.path, rec.cwd), cwd: rec.cwd, ops: writes + edits, writes: writes, edits: edits, added: added, removed: removed, lastTime: at });
			}
			items.sort((x, y) => y.lastTime - x.lastTime);
			return items;
		}
		// Whether a chat-card jump target (turn + file) can be considered
		// already applied to the review view: turn scope active, that file
		// selected, and the target turn's payload loaded (turnShown). Pure
		// predicate — smoke-tested directly.
		function jumpApplied(scope, selected, reviewFile, turnShown, targetTurn) {
			return scope === "turn" && selected === reviewFile && turnShown === targetTurn;
		}
		// Card-view expanded set: at most one card open at a time — focusing
		// `path` collapses every other file, matching the v0.6.0 "expand
		// the chosen file, all others stay collapsed" behavior requested for
		// list mode. Pure — smoke-tested directly.
		function focusFile(expanded, path) {
			return path ? { [path]: true } : {};
		}
		// Split-view resizer math: the dragged file-list width stays usable on both
		// sides — the list never drops below `minList`, and the diff keeps at least
		// `minDetail` of the pane. An unknown pane width (0/NaN: before layout, or in
		// a DOM-less smoke test) enforces only the floor instead of collapsing the
		// list. Pure — smoke-tested directly.
		function clampListWidth(width, paneWidth, minList, minDetail) {
			const w = Number(width);
			const floor = Math.max(0, Number(minList) || 0);
			const known = Number.isFinite(paneWidth) && paneWidth > 0;
			const ceil = known ? Math.max(floor, paneWidth - (Number(minDetail) || 0)) : Infinity;
			return Math.min(Math.max(Number.isFinite(w) ? Math.round(w) : floor, floor), ceil);
		}
		// Shown on an ≈ number: the exact net needs the whole file before and after the
		// range, and the storage cap keeps 120k characters per snapshot.
		const ESTIMATED_NOTE = "该文件快照超过存储上限（120k 字符）被截断，数字按每次编辑累加估算";

		// ── running-session pill (small "N files changed" chip above input) ──
		// It sits in `conversation.input.dock`, the shell's own seat for "full-width
		// entries above the composer card", so it is an ordinary in-flow row. An earlier
		// version hung it off `conversation.composer.dock` (the status row UNDER the
		// composer) and then floated it with position:fixed plus a DOM search for the
		// nearest ancestor holding a text input; the official seat needs none of that.
		function ChangePill() {
			useStore((s) => s.files);
			const running = useStore((s) => s.running);
			const latestTurn = useStore((s) => s.latestTurn);
			const activeTurn = useStore((s) => s.activeTurn);
			const hostWindow = useStore((s) => s.hostWindow);
			// 用"当前进行中的轮次"（最后一个 turn/start）而不是 ops 里最大的 turn：
			// 新一轮刚开始、还没产生任何文件修改时，pill 不该继续显示上一轮的结果。
			const pillTurn = (activeTurn > 0) ? activeTurn : latestTurn;
			// Host latest-activity window first (it carries subagent changes);
			// whole-source, never mixed with the locally parsed window.
			const hostItems = hostWindowItems(hostWindow, activeTurn);
			const items = hostItems || windowList(pillTurn);
			const show = !!(running && items.length);
			if (!show) return null;
			let added = 0, removed = 0;
			for (const f of items) { added += f.added || 0; removed += f.removed || 0; }
			return React.createElement("div", {
				// Skinned exactly like the per-turn card (.cdx-cf-card): same fill, border,
				// radius and label/count colors, all from the DSH theme tokens — no plugin
				// palette of its own, so the chip and the card never drift apart.
				className: "cdx-pill",
				onClick: () => {
					// 打开审查视图并定位到最新活动：重置轮次/范围/选择，避免
					// 停留在此前查看过的轮次（"点进去还是别的轮次"）。
					try {
						setState({
							reviewScope: "turn",
							reviewTurn: null, // null = 最新活动（含进行中未标记修改）
							reviewFile: null,
							selected: null,
							detail: null,
							loadingDetail: false
						});
					} catch (e) {}
					openReviewTab();
				},
				title: "打开审查视图"
			},
				React.createElement("span", { className: "cdx-pill-text" }, items.length + " 个文件已更改"),
				React.createElement("span", { className: "cdx-pill-stat" },
					React.createElement("span", { className: "cdx-cf-added" }, "+" + added),
					React.createElement("span", { className: "cdx-cf-deleted" }, " −" + removed)));
		}
		function ReviewView(props) {
			// Capture the official view-switch action (see openViewRef). Assigning a
			// module ref during render is deliberate: the pill, which needs it, is
			// rendered by a slot that never receives it.
			if (props && typeof props.openView === "function") openViewRef = props.openView;
			// Some compositions do hand this slot the shell's file opener; capture it so
			// the open buttons still have their preview fallback when the review tab is
			// opened directly (without the turn cards ever rendering).
			if (props && typeof props.openFile === "function") openFileRef = props.openFile;
			if (props && typeof props.completeViewRequest === "function") completeViewRef = props.completeViewRequest;
			const [revertStatus, setRevertStatus] = React.useState("");
			// 单文件「还原」同样改成宿主直接执行，所以也要防误触。
			const [revertArmed, setRevertArmed] = React.useState(false);
			const [revertBusy, setRevertBusy] = React.useState(false);
			// 记录占用（分片 + 快照 blob）与清空都在审核 tab 上，不再放设置页。
			const [usage, setUsage] = React.useState(null);
			const [clearNote, setClearNote] = React.useState("");
			const loadUsage = React.useCallback(() => {
				const sid = (props && props.sessionId) || store.currentSession;
				if (!sid) return;
				apiUsage(sid).then((u) => { if (u && typeof u.total === "number") setUsage(u); }).catch(() => {});
			}, [props && props.sessionId]);
			React.useEffect(() => {
				loadUsage();
				const id = setInterval(loadUsage, 10000);
				return () => clearInterval(id);
			}, [loadUsage]);
			// 清空：删掉该会话的分片（宿主顺手回收它引用的 blob）。不可恢复，先确认。
			const doClearRecords = () => {
				const sid = (props && props.sessionId) || store.currentSession;
				if (!sid) return;
				if (typeof window !== "undefined" && typeof window.confirm === "function" &&
					!window.confirm("清空本会话的修改记录？将删除该会话的分片与不再被引用的快照，无法恢复。")) return;
				apiClear(sid).then((r) => {
					setState({ files: [], detail: null, selected: null, turnData: null, hostWindow: null, latestTurn: 0, filesFromHost: false });
					setUsage({ ok: true, shard: 0, blobs: 0, blobCount: 0, total: 0, files: 0, ops: 0 });
					const removed = r && typeof r.blobsRemoved === "number" ? r.blobsRemoved : 0;
					setClearNote(removed > 0 ? "已清空，回收 " + removed + " 个快照" : "已清空");
					setTimeout(() => setClearNote(""), 2600);
				}).catch(() => setClearNote("清空失败"));
			};
			// Acknowledge a one-shot focus request addressed to this view, so the shell's
			// request does not linger (the jump itself is driven by our own state).
			React.useEffect(() => {
				const req = props && props.viewRequest;
				if (req && req.view === "review" && completeViewRef) { try { completeViewRef(); } catch (e) {} }
			}, [props && props.viewRequest]);
			React.useEffect(() => {
				if (props.sessionId) {
					if (store.currentSession !== props.sessionId) {
						reqSeq++;
						setState({ currentSession: props.sessionId, files: null, selected: null, detail: null, turnData: null, hostWindow: null, latestTurn: 0, error: null, loadingFiles: true, reviewTurn: null, reviewFile: null, filesFromHost: false });
					}
					loadSummary();
				}
			}, [props.sessionId]);
			const turnData = useStore((s) => s.turnData);
			const reviewTurn = useStore((s) => s.reviewTurn);
			const reviewFile = useStore((s) => s.reviewFile);
			const reviewScope = useStore((s) => s.reviewScope);
			const files = useStore((s) => s.files);
			const latestTurn = useStore((s) => s.latestTurn);
			const selected = useStore((s) => s.selected);
			const detail = useStore((s) => s.detail);
			const loading = useStore((s) => s.loadingFiles);
			const loadingDetail = useStore((s) => s.loadingDetail);
			const filesFromHost = useStore((s) => s.filesFromHost);
			const hiddenIgnored = useStore((s) => s.hiddenIgnored) || 0;
			const error = useStore((s) => s.error);
			const colors = useStore((s) => s.colors);
			const viewMode = useStore((s) => s.viewMode);
			const expanded = useStore((s) => s.expanded);
			const splitWidth = useStore((s) => s.splitWidth);
			const listRef = React.useRef(null);
			// ── split-view resizer: the file list's width follows a dragged divider.
			// The pointer writes the live width straight to the DOM (a store update per
			// pointermove would re-render the whole diff on every frame); the committed
			// value lands in the store on pointerup and is persisted from there.
			const splitRef = React.useRef(null);
			const fileListRef = React.useRef(null);
			const dragRef = React.useRef(null);
			const [splitDragging, setSplitDragging] = React.useState(false);
			const SPLIT_MIN_LIST = 140;   // px: the list stays readable
			const SPLIT_MIN_DETAIL = 260; // px: the diff keeps room for code
			const splitterDown = (e) => {
				const paneEl = splitRef.current, listEl = fileListRef.current;
				const paneW = paneEl && paneEl.getBoundingClientRect ? paneEl.getBoundingClientRect().width : 0;
				const startW = (listEl && listEl.getBoundingClientRect)
					? listEl.getBoundingClientRect().width
					: (store.splitWidth || 270);
				dragRef.current = { startX: e.clientX, startW: startW, paneW: paneW, last: Math.round(startW) };
				setSplitDragging(true);
				try { if (e.currentTarget && e.currentTarget.setPointerCapture) e.currentTarget.setPointerCapture(e.pointerId); } catch (e2) {}
				// Safety net: if the pointer is released outside the pane (or capture is
				// unavailable), the window still commits the drag instead of leaving the
				// page with user-select disabled.
				try { if (typeof window !== "undefined" && window.addEventListener) window.addEventListener("pointerup", splitterUp, { once: true }); } catch (e2) {}
				try { if (document.body && document.body.style) document.body.style.userSelect = "none"; } catch (e2) {}
				if (e.preventDefault) e.preventDefault();
			};
			const splitterMove = (e) => {
				const d = dragRef.current;
				if (!d) return;
				d.last = clampListWidth(d.startW + (e.clientX - d.startX), d.paneW, SPLIT_MIN_LIST, SPLIT_MIN_DETAIL);
				try { if (fileListRef.current && fileListRef.current.style) fileListRef.current.style.width = d.last + "px"; } catch (e2) {}
			};
			const splitterUp = () => {
				const d = dragRef.current;
				if (!d) return;
				dragRef.current = null;
				setSplitDragging(false);
				try { if (document.body && document.body.style) document.body.style.userSelect = ""; } catch (e2) {}
				setState({ splitWidth: d.last });
				try { localStorage.setItem(SPLIT_LS_KEY, String(d.last)); } catch (e2) {}
			};
			const splitterReset = () => {
				dragRef.current = null;
				setSplitDragging(false);
				setState({ splitWidth: null });
				try { localStorage.removeItem(SPLIT_LS_KEY); } catch (e2) {}
			};
			// Load the reviewed turn's payload whenever the session or the target turn
			// changes. It is deliberately NOT keyed on `files`: the rebuild already
			// reloads the turn it just re-read (rebuildReview → loadTurn), so keying on
			// the list meant every poll queued a second, duplicate turn request.
			React.useEffect(() => {
				if (store.currentSession) loadTurn(reviewTurn);
			}, [props.sessionId, reviewTurn]);
			const list = reviewScope === "all"
				? (files || [])
				: ((turnData && Array.isArray(turnData.files)) ? turnData.files : []);
			const turnShown = (turnData && typeof turnData.turn === "number") ? turnData.turn : null;
			const total = list.reduce((acc, f) => ({ added: acc.added + (f.added || 0), removed: acc.removed + (f.removed || 0) }), { added: 0, removed: 0 });
			// ── turn switcher: "全部修改" (session-cumulative), "最新一轮", or
			// any turn seen in the parsed history, newest first. Chat turn-card
			// jumps write reviewTurn/reviewFile directly, so they keep working.
			const knownTurns = [];
			for (const rec of reviewFiles.values()) for (const op of rec.ops) {
				if (typeof op.turn === "number" && knownTurns.indexOf(op.turn) === -1) knownTurns.push(op.turn);
			}
			knownTurns.sort((a, b) => b - a);
			if (turnShown != null && knownTurns.indexOf(turnShown) === -1) knownTurns.push(turnShown);
			const turnLabelOf = (t) => t === 0
				? "未标记轮次"
				: ("第 " + t + " 轮" + (latestTurn && t === latestTurn ? "（最新）" : ""));
			// "最新一轮" has no option of its own — the newest turn option is
			// labeled "第 N 轮（最新）" and IS the default (reviewTurn === null).
			// The "latest" value only appears as a placeholder while no turns
			// have been parsed yet.
			const scopeValue = reviewScope === "all"
				? "all"
				: (reviewTurn == null ? (knownTurns.length ? String(knownTurns[0]) : "latest") : String(reviewTurn));
			const pickScope = (v) => {
				// Guard against the SELECT's current value (scope-aware) — comparing
				// against a reviewTurn-derived value wrongly treated
				// "全部修改" → "最新一轮" as a no-op.
				if (scopeValue === v) return;
				if (v === "all") {
					setState({ reviewScope: "all", reviewFile: null, selected: null, detail: null, loadingDetail: false });
					return;
				}
				setState({ reviewScope: "turn", reviewTurn: v === "latest" ? null : Number(v), reviewFile: null, selected: null, detail: null, loadingDetail: false });
			};
			// Chat turn-card jump: switch back to the turn scope, then locate
			// the clicked file — split view selects it in the detail pane,
			// card view expands exactly that card and scrolls it into view.
			// The old remembered-focus guard broke the "全部修改" (all-scope)
			// case: after switching to the cumulative list, re-clicking a
			// file that was already focused once was treated as applied and
			// no selection happened. The jump now waits for the target turn's
			// payload (so sections are the right turn's), then applies unless
			// the view already shows that file with that data; the payload
			// refresh (turnData) re-runs this effect, so a jump issued
			// before the turn arrived still lands. `expanded` is the shared
			// memory between the two view modes.
			React.useEffect(() => {
				if (!reviewFile) return;
				const targetTurn = (reviewTurn == null || !Number.isFinite(reviewTurn)) ? (latestTurn || 0) : reviewTurn;
				if (jumpApplied(reviewScope, selected, reviewFile, turnShown, targetTurn) && (viewMode === "split" || (expanded && expanded[reviewFile]))) return;
				if (turnShown !== targetTurn) return;
				const n = focusFile(expanded, reviewFile);
				if (viewMode === "cards") {
					setState({ reviewScope: "turn", selected: reviewFile, expanded: n });
					try {
						requestAnimationFrame(() => {
							const root = listRef.current;
							if (!root) return;
							for (const el of root.querySelectorAll(".cdx-file")) {
								if (el.dataset.path === reviewFile) { el.scrollIntoView({ block: "nearest" }); break; }
							}
						});
					} catch (e) {}
				} else {
					const f = list.find((x) => x.path === reviewFile);
					setState({
						reviewScope: "turn",
						selected: reviewFile,
						detail: {
							path: reviewFile,
							sections: (f && f.sections && f.sections.length) ? f.sections : detailFromRecTurn(reviewFiles.get(reviewFile), turnShown).sections
						},
						loadingDetail: false,
						expanded: n
					});
				}
			}, [reviewFile, reviewTurn, reviewScope, turnData, viewMode, expanded]);
			const selItem = selected ? list.find((f) => f.path === selected) : null;
			const selectFile = (f) => {
				if (!f || !f.path) return;
				// 'all' scope: the row counts come from the host whenever the list
				// is host-adopted, so the body must too (a host-only subagent file,
				// or a file the parent and a subagent both edited); loadDetail
				// falls back to the local record when the host has nothing.
				const allScope = reviewScope === "all";
				const needRemote = needHostDetail(reviewScope, f, reviewFiles.get(f.path), filesFromHost);
				setState({
					selected: f.path,
					// 手动点选离开卡片跳转目标：下一次卡片点击仍需重新触发跳转
					reviewFile: null,
					// 与卡片视图共享展开记忆：切到列表时该文件自动展开（其它收起）
					expanded: focusFile(expanded, f.path),
					detail: allScope
						? (needRemote ? null : { path: f.path, sections: detailFromRec(reviewFiles.get(f.path)).sections })
						: { path: f.path, sections: (f.sections && f.sections.length) ? f.sections : detailFromRecTurn(reviewFiles.get(f.path), turnShown).sections }
				});
				if (needRemote) loadDetail(f.path);
			};
			const fileRow = (f) => React.createElement("button", {
				type: "button",
				key: f.path,
				className: "cdx-fl-item" + (f.path === selected ? " cdx-fl-active" : ""),
				title: f.path,
				onClick: () => selectFile(f)
			},
				React.createElement(FileTypeBadge, { path: f.path, size: 16 }),
				React.createElement("span", { className: "cdx-fl-name" }, f.name || displayName(f.path, f.cwd)),
				React.createElement("span", { className: "cdx-fl-meta" },
					(f.writes > 0 ? "写入×" + f.writes + " " : "") + (f.edits > 0 ? "编辑×" + f.edits : ""),
					React.createElement("span", { className: "cdx-plus", style: { color: colors.addFg } }, "  ~+" + f.added),
					React.createElement("span", { className: "cdx-minus", style: { color: colors.delFg } }, " ~−" + f.removed)));
			const fileList = React.createElement("div", {
				className: "cdx-filelist",
				ref: fileListRef,
				// A dragged width wins over the responsive default; null leaves it to CSS.
				style: splitWidth ? { width: splitWidth + "px" } : undefined
			},
				loading ? React.createElement("div", { className: "cdx-empty" }, "加载中…") :
				list.length === 0 ? React.createElement("div", { className: "cdx-empty" },
					reviewScope === "all"
						? "暂无修改记录（进程内通过写入 / 编辑工具产生的文件修改会出现在这里）"
						: "该轮暂无文件修改") :
				list.map(fileRow));
			// ── card view: one expandable card per file (the v0.6.0 list),
			// sticky file headers, per-file click to expand/collapse; the
			// expanded set is the same store field the split view's selection
			// writes to, so both modes remember and restore each other.
			const cardList = React.createElement("div", { className: "cdx-list", ref: listRef },
				loading ? React.createElement("div", { className: "cdx-empty" }, "加载中…") :
				list.length === 0 ? React.createElement("div", { className: "cdx-empty" },
					reviewScope === "all"
						? "暂无修改记录（进程内通过写入 / 编辑工具产生的文件修改会出现在这里）"
						: "该轮暂无文件修改") :
				list.map((f) => React.createElement(CodexFileCard, {
					key: f.path,
					item: f,
					scope: reviewScope,
					turn: reviewScope === "all" ? null : turnShown,
					expanded: !!(expanded && expanded[f.path]),
					onToggle: () => {
						// 互斥展开：点开一个文件时其它全部收起；点击已展开的文件则收起
						const willExpand = !(expanded && expanded[f.path]);
						setState({
							expanded: willExpand ? focusFile(expanded, f.path) : {},
							selected: f.path
						});
						// 'all' scope with a host-sourced row: fetch the hunks from
						// the host file endpoint (host-only file, or one the parent
						// and a subagent both edited).
						if (willExpand && needHostDetail(reviewScope, f, reviewFiles.get(f.path), filesFromHost)) loadDetail(f.path);
					}
				})));
			// View-mode switcher: split vs cards. Selection/expansion live in
			// the store, so switching back and forth restores the same file.
			const switchView = (v) => {
				if (v === viewMode) return;
				// 记住用户选择：重启 / 刷新后仍是该模式
				try { localStorage.setItem(VIEW_MODE_LS_KEY, v); } catch (e) {}
				setState({ viewMode: v, expanded: v === "cards" && selected ? focusFile(expanded, selected) : expanded });
			};
			// ── right pane: ONLY the selected file's diff content ──
			const openLine = (line) => openFileAtLine(store.currentSession, selected, selItem && (selItem.cwd || (reviewFiles.get(selected) || {}).cwd), line);
			let detailBody;
			if (!selected) detailBody = React.createElement("div", { className: "cdx-empty" }, "在左侧选择文件查看修改对比");
			else if (!selItem) detailBody = React.createElement("div", { className: "cdx-empty" }, "没有此文件的修改记录");
			else if (loadingDetail && needHostDetail(reviewScope, selItem, reviewFiles.get(selected), filesFromHost)) detailBody = React.createElement("div", { className: "cdx-empty" }, "加载中…");
			else if (!detail || !detail.sections || detail.sections.length === 0) detailBody = React.createElement("div", { className: "cdx-empty" }, "该文件没有可展示的修改");
			else {
				const lang = langOf(selected);
				detailBody = detail.sections.map((sec, i) => React.createElement("div", { key: i, className: "cdx-sec" },
					sectionHead(sec, openLine),
					React.createElement("div", { className: "cdx-diff" },
						sec.hunks.map((h, k) => React.createElement(CodexLine, { key: k, h: h, lang: lang, rel: sec.lineExact === false, openLine: openLine, openAnchor: sectionOpenLine(sec) })))));
			}
			const detailPane = React.createElement("div", { className: "cdx-detail" },
				selected ? React.createElement("div", { className: "cdx-detail-head" },
					React.createElement(FileTypeBadge, { path: selected, size: 18 }),
					React.createElement("span", { className: "cdx-detail-path", title: selected }, selected),
					selItem ? React.createElement("span", { className: "cdx-file-cnt" },
						(selItem.writes > 0 ? "写入×" + selItem.writes + " " : "") + (selItem.edits > 0 ? "编辑×" + selItem.edits : "")) : null,
					selItem ? React.createElement("span", { className: "cdx-file-stats" },
						React.createElement("span", { className: "cdx-plus", style: { color: colors.addFg } }, "＋" + selItem.added),
						React.createElement("span", { className: "cdx-minus", style: { color: colors.delFg } }, "－" + selItem.removed)) : null,
					selItem && detail && detail.sections ? React.createElement("button", {
						type: "button",
						className: "cdx-turn-btn" + (revertArmed ? " cdx-cf-btn-armed" : ""),
						disabled: revertBusy,
						title: "直接还原这个文件（宿主执行，不走模型）",
						onClick: async (ev) => {
							ev.stopPropagation();
							if (!revertArmed) {
								setRevertArmed(true);
								setRevertStatus("再点一次确认");
								setTimeout(() => { setRevertArmed(false); setRevertStatus(""); }, 3000);
								return;
							}
							setRevertArmed(false);
							setRevertBusy(true);
							try {
								const res = await apiRevert(store.currentSession, selected);
								if (res && res.ok) {
									setRevertStatus("已还原 ✓");
									// 该文件的记录已被清空，详情不再有效：回到列表并重新拉取。
									setState({ detail: null, selected: null, reviewFile: null });
									refreshFromServer();
								} else {
									setRevertStatus((res && res.error) || "还原失败");
								}
							} catch (e2) {
								setRevertStatus("还原失败");
							}
							setRevertBusy(false);
							setTimeout(() => setRevertStatus(""), 2200);
						}
					}, revertBusy ? "还原中…" : (revertStatus || "还原")) : null) : null,
				React.createElement("div", { className: selected && selItem ? "cdx-detail-body" : null, style: selected && selItem ? { background: colors.ctxBg, border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3))", borderRadius: 8 } : null },
					detailBody));
			return React.createElement("div", { className: "drv-view" },
				React.createElement("div", { className: "cdx-toolbar" },
					React.createElement("span", { className: "cdx-title" }, "修改审查"),
					React.createElement("select", {
						className: "cdx-turn-select",
						value: scopeValue,
						onChange: (e) => pickScope(e.target.value),
						title: "选择要审查的范围：全部修改或某一轮"
					},
						React.createElement("option", { value: "all" }, "全部修改"),
						knownTurns.length === 0
							? React.createElement("option", { value: "latest" }, "最新一轮")
							: knownTurns.map((t) => React.createElement("option", { key: t, value: String(t) }, turnLabelOf(t)))),
					React.createElement("div", { className: "cdx-mode" },
						React.createElement("button", {
							type: "button",
							className: "cdx-mode-btn" + (viewMode === "split" ? " cdx-active" : ""),
							title: "双视图：左侧文件列表 + 右侧详情",
							onClick: () => switchView("split")
						}, "双视图"),
						React.createElement("button", {
							type: "button",
							className: "cdx-mode-btn" + (viewMode === "cards" ? " cdx-active" : ""),
							title: "列表：每文件一张可展开的卡片",
							onClick: () => switchView("cards")
						}, "列表")),
					React.createElement("span", { className: "cdx-stats" },
						React.createElement("span", { className: "cdx-plus", style: { color: colors.addFg } }, "＋" + total.added),
						React.createElement("span", { className: "cdx-minus", style: { color: colors.delFg } }, " －" + total.removed),
						React.createElement("span", { className: "cdx-count" }, " " + list.length + " 文件")),
					hiddenIgnored > 0 ? React.createElement("span", {
						className: "cdx-hidden-ignored",
						title: "被 git 忽略规则隐藏的文件（.gitignore / lockfile / 生成物等）。设置 → 修改审查 里可以关掉过滤。"
					}, "隐藏 " + hiddenIgnored) : null,
					React.createElement("span", { className: "cdx-spacer" }),
					// 记录占用 + 清空：都在这个页面上（设置页不再放清空按钮）。
					React.createElement("span", {
						className: "cdx-usage",
						title: usage
							? "本会话的记录占用：分片 " + fmtBytes(usage.shard) + " ＋ 快照 " + fmtBytes(usage.blobs) +
								"（" + usage.blobCount + " 个 blob，按内容共享，可能与其它会话共用）" +
								" · " + usage.files + " 文件 / " + usage.ops + " 次修改"
							: "正在读取记录占用…"
					}, usage ? fmtBytes(usage.total) : "…"),
					React.createElement("button", {
						type: "button",
						className: "cdx-clear-btn",
						title: "清空本会话的修改记录（删除该会话的分片，并回收不再被引用的快照；不可恢复）",
						onClick: doClearRecords
					}, "清空"),
					clearNote ? React.createElement("span", { className: "cdx-clear-note" }, clearNote) : null,
					React.createElement("span", { className: "cdx-toolbar-font" },
						React.createElement(FontSizeControl, null),
						React.createElement(FontPicker, null)),
					// The editor picker lives here now (it used to sit in the session
					// header, right next to the shell's own "open in app" control — two
					// nearly identical chips side by side). The refresh button is gone
					// (the 5s poll already covers it) and "清空记录" moved to
					// Settings → 修改审查, so the picker takes their place.
					React.createElement("span", { className: "cdx-toolbar-editor" },
						React.createElement(EditorPicker, null))),
				error ? React.createElement("div", { className: "cdx-error" }, error) : null,
				viewMode === "cards"
					? cardList
					: React.createElement("div", { className: "cdx-split", ref: splitRef },
						fileList,
						// The divider between the two panes: drag to rebalance them,
						// double-click to fall back to the responsive default.
						React.createElement("div", {
							className: "cdx-splitter" + (splitDragging ? " cdx-dragging" : ""),
							role: "separator",
							"aria-orientation": "vertical",
							"aria-label": "调整文件列表宽度",
							title: "左右拖动调整宽度（双击恢复默认）",
							onPointerDown: splitterDown,
							onPointerMove: splitterMove,
							onPointerUp: splitterUp,
							onPointerCancel: splitterUp,
							onDoubleClick: splitterReset
						}),
						detailPane));
		}

		function SettingsPage() {
			const tab = useStore((s) => s.colorTab);
			// themeNow is store-driven (kept in sync by syncThemeColors on every
			// DSH theme switch), so the "（当前 DSH 主题正在使用这套）" note stays
			// live instead of frozen at the last render.
			const themeNow = useStore((s) => s.themeNow);
			const hideOfficial = useStore((s) => s.hideOfficialCards) !== false;
			const toggleOfficial = (on) => {
				setState({ hideOfficialCards: on });
				try { localStorage.setItem(HIDE_OFFICIAL_LS_KEY, on ? "1" : "0"); } catch (e) {}
				syncOfficialCards();
			};
			// 中文思考注入：宿主侧把规则注册成系统提示词的一个段落，默认开启。开关状态
			// 存在宿主（settings.json），因为注册 section 的是宿主，重启后必须仍然一致。
			const [zh, setZh] = React.useState(null);
			React.useEffect(() => {
				let alive = true;
				apiThinking().then((r) => { if (alive) setZh(r); }).catch((e) => { if (alive) setZh({ enabled: true, error: String((e && e.message) || e) }); });
				return () => { alive = false; };
			}, []);
			const zhEnabled = !zh || zh.enabled !== false;
			const toggleZh = (on) => {
				setZh((prev) => Object.assign({}, prev || {}, { enabled: on, pending: true }));
				apiThinkingSet(on)
					.then((r) => setZh(r))
					.catch((e) => setZh((prev) => Object.assign({}, prev || {}, { enabled: on, pending: false, error: String((e && e.message) || e) })));
			};
			const zhNote = zh === null
				? "读取状态中…"
				: zh.error
					? "注入失败：" + zh.error
					: zhEnabled
						? (zh.registered ? "已注入系统提示词" : "已开启，但 systemPrompt 服务不可用")
						: "已关闭";
			const zhWhen = "改完开关立即生效，无需重启。";
			// 忽略空白 / git 忽略过滤：宿主 settings.json 持久化，统计与列表同源。
			const prefs = useStore((s) => s.reviewPrefs) || { ignoreWhitespace: false, hideGitIgnored: true };
			const [prefsBusy, setPrefsBusy] = React.useState(false);
			const [prefsErr, setPrefsErr] = React.useState(null);
			const togglePref = (key, on) => {
				setPrefsBusy(true);
				setPrefsErr(null);
				const patch = {};
				patch[key] = on;
				setPrefs(patch)
					.then(() => { setPrefsBusy(false); loadSummary(); })
					.catch((e) => { setPrefsBusy(false); setPrefsErr(String((e && e.message) || e)); });
			};
			return React.createElement("div", { className: "drv-settings-page" },
				React.createElement("p", { className: "drv-settings-desc" },
					"追踪写入 / 编辑工具产生的文件修改，并在每轮卡片中展示；下方为 diff 与角标配色："),
				React.createElement("label", { className: "drv-check" },
					React.createElement("input", {
						type: "checkbox",
						className: "drv-official-toggle",
						checked: hideOfficial,
						onChange: (e) => toggleOfficial(!!(e.target && e.target.checked))
					}),
					React.createElement("span", null, "隐藏官方「已编辑 N 个文件」卡片")),
				React.createElement("label", { className: "drv-check" },
					React.createElement("input", {
						type: "checkbox",
						className: "drv-prefs-ignore-ws",
						checked: prefs.ignoreWhitespace === true,
						disabled: prefsBusy,
						onChange: (e) => togglePref("ignoreWhitespace", !!(e.target && e.target.checked))
					}),
					React.createElement("span", null, "忽略空白差异（只影响显示与 +N −M 统计，撤回仍按原文恢复）")),
				React.createElement("label", { className: "drv-check" },
					React.createElement("input", {
						type: "checkbox",
						className: "drv-prefs-hide-ignored",
						checked: prefs.hideGitIgnored !== false,
						disabled: prefsBusy,
						onChange: (e) => togglePref("hideGitIgnored", !!(e.target && e.target.checked))
					}),
					React.createElement("span", null, "隐藏被 git 忽略的文件（.gitignore / lockfile / 生成物等）")),
				React.createElement("p", { className: "drv-prefs-note" },
					prefsErr ? ("设置失败：" + prefsErr) : "过滤规则直接问 git（check-ignore），嵌套 .gitignore、info/exclude 与全局忽略都算数；不在仓库里的文件不会被隐藏。"),
				React.createElement("label", { className: "drv-check" },
					React.createElement("input", {
						type: "checkbox",
						className: "drv-thinking-toggle",
						checked: zhEnabled,
						disabled: zh !== null && zh.pending === true,
						onChange: (e) => toggleZh(!!(e.target && e.target.checked))
					}),
					React.createElement("span", null, "注入「用简体中文思考」规则（默认开启）")),
				React.createElement("p", { className: "drv-settings-note" }, zhNote),
				React.createElement("p", { className: "drv-settings-hint" }, zhWhen),
				React.createElement("p", { className: "drv-settings-desc" },
					"记录占用与清空在**审核 tab 的工具条**上。"),
				React.createElement("div", { className: "drv-color-tabs", role: "tablist" },
					React.createElement("button", {
						className: "drv-color-tab" + (tab === "light" ? " drv-color-tab-active" : ""),
						onClick: () => setState({ colorTab: "light" })
					}, "浅色主题"),
					React.createElement("button", {
						className: "drv-color-tab" + (tab === "dark" ? " drv-color-tab-active" : ""),
						onClick: () => setState({ colorTab: "dark" })
					}, "深色主题"),
					React.createElement("span", { className: "drv-color-now" },
						tab === themeNow ? "（当前 DSH 主题正在使用这套）" : "（当前 DSH 主题使用另一套）")),
				React.createElement(ColorRows, null),
				React.createElement(PresetButtons, null));
		}

		// ── editor picker: choose the default code editor for「打开文件」 ──────
		// Icons come from the shell's own icon route (`GET /open-in-app/icon/<id>`,
		// served by dsh-host-open-in-app out of the icon it extracts from the installed
		// application), so the picker shows the very same marks as the shell's "打开方式"
		// menu — VS Code's blue logo, Cursor's, Zed's… Applications the shell's catalog
		// does not know (VSCodium, Notepad++, Vim…) keep the letter avatar, and a 404
		// falls back to it too (Desktop / no webServer).
		const OFFICIAL_ICON_ID = { vscode: "vscode", vscodeinsiders: "vscodeinsiders", cursor: "cursor", zed: "zed", windsurf: "windsurf", sublime: "sublimetext", xcode: "xcode" };
		function EditorIcon({ id, size }) {
			const px = size || 16;
			const officialId = OFFICIAL_ICON_ID[String(id || "").toLowerCase()];
			const [broken, setBroken] = React.useState(false);
			if (officialId && !broken) {
				return React.createElement("img", {
					className: "drv-editor-icon",
					src: "/open-in-app/icon/" + officialId,
					width: px,
					height: px,
					alt: "",
					onError: () => setBroken(true),
					style: { width: px, height: px, flexShrink: 0, display: "block", objectFit: "contain" }
				});
			}
			const letter = (String(id || "?").charAt(0) || "?").toUpperCase();
			return React.createElement("span", {
				style: { width: px, height: px, display: "inline-flex", alignItems: "center", justifyContent: "center", borderRadius: 3, flexShrink: 0, background: "rgba(80,120,255,0.2)", color: "inherit", fontSize: Math.max(9, Math.round(px * 0.6)), fontWeight: 600, verticalAlign: "middle" }
			}, letter);
		}
		function EditorPicker(props) {
			const editors = useStore((s) => s.editors);
			const editorLoading = useStore((s) => s.editorLoading);
			const selectedEditor = useStore((s) => s.selectedEditor);
			const [open, setOpen] = React.useState(false);
			const rootRef = React.useRef(null);
			React.useEffect(() => { loadEditors(); }, []);
			React.useEffect(() => {
				if (!open) return;
				const onDoc = (e) => {
					if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
				};
				document.addEventListener("mousedown", onDoc, true);
				document.addEventListener("keydown", (e) => { if (e.key === "Escape") setOpen(false); }, true);
				return () => {
					document.removeEventListener("mousedown", onDoc, true);
					document.removeEventListener("keydown", (e) => { if (e.key === "Escape") setOpen(false); }, true);
				};
			}, [open]);
			const detected = (editors || []).filter((e) => e.detected);
			// The button shows the editor's FULL name (no "用…打开" verb): the chip is a
			// single control whose icon already says what it does.
			const label = selectedEditor ? selectedEditor.name : "编辑器";
			// No custom tooltip here: the floating hint it rendered showed up clipped
			// above the header, and the button's own label already says what it does —
			// a native title carries the detail instead.
			return React.createElement("div", { className: "drv-editor", ref: rootRef },
				React.createElement("button", {
					type: "button",
					className: "drv-editor-btn",
					title: selectedEditor
						? "打开修改文件时使用的编辑器：" + selectedEditor.name + "（点击更换）"
						: "选择打开修改文件时使用的代码编辑器（未选择则用系统默认应用或侧栏预览）",
					onClick: () => setOpen(!open)
				},
					React.createElement("span", { className: "drv-editor-label" },
					editorLoading ? "检测中…" : (selectedEditor ? React.createElement(React.Fragment, null,
						React.createElement(EditorIcon, { id: selectedEditor.id, size: 16 }),
						// The icon is a block-level <img>, so the text needs its own box:
						// as one inline run the two wrapped onto separate lines.
						React.createElement("span", { className: "drv-editor-name" }, label)) : label)),
				React.createElement("span", { className: "drv-editor-caret" }, open ? "▴" : "▾")),
				open ? React.createElement("div", { className: "drv-editor-menu" },
					detected.length === 0 ? React.createElement("div", { className: "drv-editor-empty" }, "未检测到已安装的代码编辑器") : null,
					React.createElement("button", {
						type: "button",
						className: "drv-editor-opt" + (!selectedEditor ? " drv-editor-opt-active" : ""),
						onClick: () => { selectEditor(null); setOpen(false); }
					}, "系统默认"),
					detected.map((ed) => React.createElement("button", {
						type: "button",
						key: ed.id,
						className: "drv-editor-opt" + (selectedEditor && selectedEditor.id === ed.id ? " drv-editor-opt-active" : ""),
						style: { display: "flex", alignItems: "center", gap: 6 },
						onClick: () => { selectEditor(ed); setOpen(false); }
					},
						React.createElement(EditorIcon, { id: ed.id, size: 16 }),
						React.createElement("span", null, ed.name))),
					// The probe result is cached (see loadEditors); this is the way to
					// re-run it after installing something new.
					React.createElement("button", {
						type: "button",
						className: "drv-editor-opt drv-editor-rescan",
						onClick: () => { loadEditors(true); }
					}, editorLoading ? "检测中…" : "重新检测编辑器")) : null);
		}

		// Font picker: "follow DSH / skin" by default, or any family the host found on
		// this machine — each row previews itself in its own font, and a typed name
		// that the registry hides (or that only the browser knows) can be applied too.
		// Font size control: nudges THIS plugin's text on top of DSH's own content
		// font size. Zero means "follow" — the centre chip says so and clicking it
		// (or stepping back to zero) removes the variable again, so the plugin never
		// silently drifts away from the host's setting.
		function FontSizeControl() {
			const fontDelta = useStore((s) => s.fontDelta);
			const label = fontDeltaLabel(fontDelta);
			return React.createElement("div", { className: "drv-fontsize" },
				React.createElement("button", {
					type: "button",
					className: "drv-fontsize-btn",
					title: "减小本插件字号（当前 " + label + "）",
					disabled: fontDelta <= FONT_DELTA_MIN,
					onClick: () => applyFontDelta(fontDelta - 1)
				}, "A−"),
				React.createElement("button", {
					type: "button",
					className: "drv-fontsize-value" + (fontDelta === 0 ? "" : " drv-fontsize-active"),
					title: fontDelta === 0
						? "本插件字号跟随 DSH 的「字号大小」设置"
						: "本插件字号 " + label + "（点击恢复跟随 DSH）",
					onClick: () => applyFontDelta(0)
				}, label),
				React.createElement("button", {
					type: "button",
					className: "drv-fontsize-btn",
					title: "增大本插件字号（当前 " + label + "）",
					disabled: fontDelta >= FONT_DELTA_MAX,
					onClick: () => applyFontDelta(fontDelta + 1)
				}, "A+"));
		}
		function FontPicker(props) {
			const fontChoice = useStore((s) => s.fontChoice);
			const fonts = useStore((s) => s.fonts);
			const fontLoading = useStore((s) => s.fontLoading);
			const [open, setOpen] = React.useState(false);
			const [query, setQuery] = React.useState("");
			const rootRef = React.useRef(null);
			React.useEffect(() => {
				if (!open) return;
				const onDoc = (e) => {
					if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
				};
				const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
				document.addEventListener("mousedown", onDoc, true);
				document.addEventListener("keydown", onKey, true);
				return () => {
					document.removeEventListener("mousedown", onDoc, true);
					document.removeEventListener("keydown", onKey, true);
				};
			}, [open]);
			React.useEffect(() => { if (open) loadFonts(false); }, [open]);
			const typed = query.trim();
			const filtered = React.useMemo(() => {
				if (!typed) return fonts;
				const q = typed.toLowerCase();
				return fonts.filter((f) => f.toLowerCase().indexOf(q) >= 0);
			}, [fonts, typed]);
			const exact = filtered.some((f) => f.toLowerCase() === typed.toLowerCase());
			const previewOf = (name) => ({ fontFamily: "\"" + String(name).replace(/["\\]/g, "") + "\"" });
			return React.createElement("div", { className: "drv-editor", ref: rootRef },
				React.createElement("button", {
					type: "button",
					className: "drv-editor-btn",
					title: fontChoice
						? "插件字体：" + fontChoice + "（点击更换，或选回「跟随」。影响本插件的卡片与审查视图）"
						: "插件字体跟随 DSH 与皮肤设置（点击可自选系统字体）",
					onClick: () => setOpen(!open)
				},
					React.createElement("span", { className: "drv-editor-label" }, "字体：" + (fontChoice || "跟随")),
					React.createElement("span", { className: "drv-editor-caret" }, open ? "▴" : "▾")),
				open ? React.createElement("div", { className: "drv-editor-menu drv-font-menu" },
					React.createElement("div", { className: "drv-font-searchbox" },
						React.createElement("input", {
							className: "drv-font-search",
							type: "text",
							placeholder: "搜索字体，或直接输入字体名后回车",
							value: query,
							autoFocus: true,
							onChange: (e) => setQuery(e.target.value),
							onKeyDown: (e) => {
								// An IME commit also raises Enter: never apply a font mid-composition.
								if (e.nativeEvent && e.nativeEvent.isComposing) return;
								if (e.key !== "Enter") return;
								if (typed) { applyFontChoice(typed); setOpen(false); }
								else if (filtered.length > 0) { applyFontChoice(filtered[0]); setOpen(false); }
							}
						}),
						// The clear control swallows mousedown so the caret stays in the box and
						// typing can continue immediately; it only exists while there is input.
						query ? React.createElement("button", {
							type: "button",
							className: "drv-font-clear",
							title: "清空",
							onMouseDown: (e) => e.preventDefault(),
							onClick: () => setQuery("")
						}, "×") : null),
					React.createElement("button", {
						type: "button",
						className: "drv-editor-opt" + (!fontChoice ? " drv-editor-opt-active" : ""),
						onClick: () => { applyFontChoice(null); setOpen(false); }
					}, "跟随 DSH / 皮肤"),
					typed && !exact ? React.createElement("button", {
						type: "button",
						className: "drv-editor-opt drv-font-custom",
						style: previewOf(typed),
						onClick: () => { applyFontChoice(typed); setOpen(false); }
					}, "使用「" + typed + "」") : null,
					fontLoading ? React.createElement("div", { className: "drv-editor-empty" }, "读取系统字体…") : null,
					!fontLoading && fonts.length === 0
						? React.createElement("div", { className: "drv-editor-empty" }, "未读到系统字体，可直接输入字体名")
						: null,
					!fontLoading && fonts.length > 0 && filtered.length === 0
						? React.createElement("div", { className: "drv-editor-empty" }, "没有匹配的字体，回车可直接使用「" + typed + "」")
						: null,
					filtered.map((name) => React.createElement("button", {
						type: "button",
						key: name,
						className: "drv-editor-opt" + (fontChoice === name ? " drv-editor-opt-active" : ""),
						style: previewOf(name),
						onClick: () => { applyFontChoice(name); setOpen(false); }
					}, name)),
					React.createElement("button", {
						type: "button",
						className: "drv-editor-opt drv-editor-rescan",
						onClick: () => loadFonts(true)
					}, fontLoading ? "读取中…" : "重新扫描字体（" + fonts.length + "）")) : null);
		}

		// ── diff_review_revert tool row ─────────────────────────────────────
		// The tool would otherwise render as the shell's generic DetailsRow, which hides
		// the only thing that matters about a revert: whether the file actually came back.
		/** Outcome of one revert call, read from the durable result block. */
		function revertOutcome(block) {
			if (!block || !("kind" in block)) return { state: "running", path: "", message: "" };
			let path = "";
			try {
				const parsed = JSON.parse((block.call && block.call.argsRaw) || "");
				if (parsed && typeof parsed.path === "string") path = parsed.path;
			} catch (e) {}
			let text = "";
			for (const item of block.content || []) {
				if (item && item.type === "text" && typeof item.text === "string") text += (text ? "\n" : "") + item.text;
			}
			let result = null;
			try { result = JSON.parse(text); } catch (e) {}
			const message = result && typeof result.message === "string" ? result.message
				: result && typeof result.error === "string" ? result.error
					: (text.split("\n")[0] || "");
			return { state: block.isError === true ? "error" : "ok", path, message };
		}
		function RevertToolRow(props) {
			const out = revertOutcome(props && props.block);
			const running = out.state === "running";
			return React.createElement("div", { className: "drv-revert", "data-state": out.state },
				React.createElement("span", { className: "drv-revert-mark" }, out.state === "error" ? "✕" : "↺"),
				React.createElement("span", { className: "drv-revert-path" }, out.path || "撤回文件修改"),
				React.createElement("span", { className: "drv-revert-msg" },
					running ? "正在撤回…" : (out.message || (out.state === "error" ? "撤回失败" : "已撤回"))));
		}

		// ── plugin ─────────────────────────────────────────────────────────
		const inject = ["slots", "sessions", "conversation"];
		const CSS = `
.drv-revert { display:flex; align-items:center; gap:8px; padding:5px 10px; border-radius:8px; border:.5px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 2px); line-height:1.5; }
.drv-revert-mark { flex:none; opacity:.8; }
.drv-revert-path { flex:none; max-width:22em; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--dsw-alias-label-primary, #e6edf3); }
.drv-revert-msg { min-width:0; opacity:.72; }
.drv-revert[data-state="error"] .drv-revert-mark, .drv-revert[data-state="error"] .drv-revert-msg { color:var(--dsw-alias-label-error, #e5534b); opacity:1; }
.drv-view { flex:1 1 0; min-height:0; overflow:hidden; display:flex; flex-direction:column; padding:12px 14px; box-sizing:border-box; font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 1px); }
/* Codex-style per-turn card (chat tail) */
/* changed-files card: the visuals are copied from the shell's own card
   (@deepseek-ai/dsh-client-ui-deliverables ChangedFiles.module.css — same tokens,
   radii, paddings, colors and fold row) so a turn looks the same in both. The
   撤销 / 审核 actions and the review jumps are this plugin's own additions. */
.cdx-cf-card, .cdx-cf-card * { box-sizing:border-box; }
.cdx-cf-card { --cdx-cf-fill:var(--dsw-static-neutral-50, #f6f8fa); --cdx-cf-hover:var(--dsw-static-neutral-100, #eef1f4); border:.5px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); min-width:0; color:var(--dsw-alias-label-primary, #e6edf3); border-radius:16px; flex-direction:column; margin-top:4px; display:flex; overflow:hidden; }
body[data-ds-dark-theme] .cdx-cf-card { --cdx-cf-fill:var(--dsw-static-neutral-850, #1c2128); --cdx-cf-hover:var(--dsw-static-neutral-800, #262c36); }
.cdx-cf-header { box-sizing:border-box; background:var(--cdx-cf-fill); width:100%; min-width:0; color:inherit; font:inherit; text-align:left; border:0; align-items:center; gap:12px; margin:0; padding:12px 16px; display:flex; }
.cdx-cf-header-btn { cursor:pointer; transition:background-color .12s; }
.cdx-cf-header-btn:hover, .cdx-cf-header-btn:focus-visible { background:var(--cdx-cf-hover); }
.cdx-cf-header-btn:focus-visible { box-shadow:inset 0 0 0 2px var(--dsw-alias-brand-primary, #4493f8); outline:none; }
.cdx-cf-tile { background:var(--dsw-alias-link, #4493f8); width:36px; height:36px; color:var(--dsw-static-neutral-00, #fff); border-radius:10px; flex:none; place-items:center; display:grid; }
.cdx-cf-tile-muted { background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.16)); color:var(--dsw-alias-label-tertiary, #768390); }
.cdx-cf-titles { flex-direction:column; flex:1; gap:2px; min-width:0; display:flex; }
.cdx-cf-title { text-overflow:ellipsis; white-space:nowrap; font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px)); font-weight:500; line-height:calc(22px + var(--dsh-content-font-delta, 0px) + var(--drv-font-delta, 0px)); overflow:hidden; }
.cdx-cf-title-muted { color:var(--dsw-alias-label-tertiary, #768390); font-weight:400; }
.cdx-cf-stat { font-family:var(--drv-font-code, var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)); color:var(--dsw-alias-label-tertiary, #768390); gap:6px; font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 2px); line-height:calc(18px + var(--dsh-content-font-delta, 0px) + var(--drv-font-delta, 0px)); display:inline-flex; align-items:center; }
.cdx-cf-added { color:var(--dsw-alias-state-success-primary, #1a7f37); }
.cdx-cf-deleted { color:var(--dsw-alias-state-error-primary, #cf222e); }
.cdx-cf-time { color:var(--dsw-alias-label-caption, #8b949e); }
.cdx-cf-actions { flex:none; margin-left:auto; align-items:center; gap:8px; display:flex; }
.cdx-cf-btn { border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); background:transparent; color:var(--dsw-alias-label-primary, #e6edf3); cursor:pointer; border-radius:8px; padding:5px 12px; font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 1.5px); font-family:var(--drv-font-ui, inherit); white-space:nowrap; }
/* 撤销的"武装"状态：第一次点击后，按钮须明显变成"再点一次确认"，否则用户不知道
   第二次点击才真的撤。 */
.cdx-cf-btn-armed { border-color:var(--dsw-alias-label-error, #e5534b); color:var(--dsw-alias-label-error, #e5534b); }
.cdx-cf-btn:disabled { opacity:.6; cursor:default; }
.cdx-cf-btn:hover:not(:disabled) { background:var(--cdx-cf-hover, rgba(128,128,128,0.14)); }
.cdx-cf-btn:disabled { opacity:0.45; cursor:default; }
.cdx-cf-list { border-top:.5px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); margin:0; padding:4px 0; list-style:none; }
/* Row hover preview, rendered inside the shell's own HoverCard (variant "preview"):
   that primitive caps the panel height and repositions it on scroll/resize, so the
   BODY is the scrolling part. Only the chrome comes from theme tokens — the diff
   rows keep the plugin palette (they are CodexLine rows, exactly like the review
   tab's), which is the whole point of not reusing the official DiffBlock here. */
.cdx-preview { display:flex; flex-direction:column; min-width:0; min-height:0; }
.cdx-preview-head { display:flex; align-items:center; gap:10px; padding:8px 12px; border-bottom:.5px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); color:var(--dsw-alias-label-secondary, #adbac7); font-family:var(--drv-font-code, var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)); font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 2px); }
.cdx-preview-path { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.cdx-preview-counts { flex:none; display:inline-flex; align-items:center; gap:6px; }
.cdx-preview-body { overflow:auto; min-height:0; padding:6px 0; overscroll-behavior-x:contain; font-family:var(--drv-font-code, var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)); font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 2px); line-height:calc(18px + var(--dsh-content-font-delta, 0px) + var(--drv-font-delta, 0px)); }
.cdx-preview-body .cdx-line { padding:0 12px; }
.cdx-preview-note { padding:8px 12px; color:var(--dsw-alias-label-tertiary, #768390); }
/* Where the preview skipped unchanged lines between two changes. */
.cdx-preview-gap { padding:2px 12px; color:var(--dsw-alias-label-tertiary, #768390); user-select:none; text-align:center; letter-spacing:2px; }
.cdx-cf-row { box-sizing:border-box; width:100%; min-width:0; color:var(--dsw-alias-label-secondary, #adbac7); cursor:pointer; font-family:var(--drv-font-code, var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)); text-align:left; background:0 0; border:0; justify-content:space-between; align-items:center; gap:12px; margin:0; padding:6px 16px; font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 2px); line-height:calc(18px + var(--dsh-content-font-delta, 0px) + var(--drv-font-delta, 0px)); display:flex; }
.cdx-cf-row:hover, .cdx-cf-row:focus-visible { background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.12)); }
.cdx-cf-row:focus-visible { box-shadow:inset 0 0 0 2px var(--dsw-alias-border-l3, rgba(128,128,128,0.4)); outline:none; }
.cdx-cf-path { text-overflow:ellipsis; white-space:nowrap; min-width:0; overflow:hidden; }
.cdx-cf-counts { white-space:nowrap; color:var(--dsw-alias-label-tertiary, #768390); flex:none; gap:6px; display:inline-flex; }
.cdx-cf-toggle { box-sizing:border-box; border:0; border-top:.5px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); width:100%; color:var(--dsw-alias-label-tertiary, #768390); cursor:pointer; font:inherit; text-align:left; background:0 0; align-items:center; gap:4px; margin:0; padding:8px 16px; font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 2px); line-height:calc(18px + var(--dsh-content-font-delta, 0px) + var(--drv-font-delta, 0px)); display:inline-flex; }
.cdx-cf-toggle:hover { background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.12)); }
.cdx-cf-toggle svg { flex:none; width:14px; height:14px; }
.cdx-cf-empty { cursor:default; }
@media (pointer:coarse) { .cdx-cf-row, .cdx-cf-toggle { min-height:44px; } }
.cdx-turn-btn { border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); background:transparent; color:var(--dsw-alias-label-primary, #e6edf3); cursor:pointer; border-radius:8px; padding:5px 12px; font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 1.5px); font-family:var(--drv-font-ui, inherit); }
.cdx-turn-btn:hover:not(:disabled) { background:rgba(128,128,128,0.14); }
.cdx-turn-btn:disabled { opacity:0.45; cursor:default; }
/* running-session pill.
   Host 0.1.6 wraps the composer-dock slot in a HORIZONTAL flex row
   (.uV2eYG_dock: display:flex; gap:12px) that also holds the built-in
   ContextMeter (flex:none) and other plugins' entries (e.g. dsh-cost-meter).
   Without a shrink guard this pill is the only item that CAN shrink — CJK text
   breaks between every character, so min-content is a single glyph — and it
   collapsed into a one-character-wide column (with border-radius:999px, a ball).
   flex:0 0 auto + white-space:nowrap keep the label on one line; the row
   overflows/wraps as a whole instead of squeezing this chip.
   Skinned with the SAME tokens as .cdx-cf-card (fill / border-l1 / 16px radius /
   success+error counts) so the chip and the per-turn card read as one design: the
   theme decides, and nothing here uses the plugin's own palette. */
.cdx-pill { --cdx-pill-fill:var(--dsw-static-neutral-50, #f6f8fa); display:inline-flex; align-items:center; gap:6px; align-self:center; flex:0 0 auto; white-space:nowrap; max-width:100%; margin:4px 0; padding:5px 14px; border-radius:16px; border:.5px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); background:var(--cdx-pill-fill); color:var(--dsw-alias-label-primary, #e6edf3); font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 2px); cursor:pointer; transition:background-color 0.12s ease; }
body[data-ds-dark-theme] .cdx-pill { --cdx-pill-fill:var(--dsw-static-neutral-850, #1c2128); }
.cdx-pill:hover { background:var(--dsw-static-neutral-100, #eef1f4); }
body[data-ds-dark-theme] .cdx-pill:hover { background:var(--dsw-static-neutral-800, #262c36); }
.cdx-pill-text { color:var(--dsw-alias-label-primary, #e6edf3); }
.cdx-pill-stat { display:inline-flex; align-items:center; gap:6px; font-family:var(--drv-font-code, var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)); }
.cdx-toolbar { display:flex; align-items:center; gap:8px; padding:2px 0 10px; border-bottom:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25)); flex-wrap:wrap; }
.cdx-title { font-weight:600; color:var(--dsw-alias-label-primary, #e6edf3); }
.cdx-mode { display:flex; gap:4px; }
.cdx-mode-btn { border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); background:transparent; color:var(--dsw-alias-label-secondary, #adbac7); cursor:pointer; border-radius:6px; padding:2px 10px; font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 2px); }
.cdx-mode-btn.cdx-active { background:rgba(80,120,255,0.22); border-color:rgba(80,120,255,0.6); color:var(--dsw-alias-label-primary, #e6edf3); }
.cdx-stats { display:inline-flex; gap:6px; font-family:var(--drv-font-code, var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)); font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 2px); margin-left:4px; }
.cdx-hidden-ignored { flex:none; margin-left:6px; padding:1px 7px; border-radius:8px; border:1px dashed var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); color:var(--dsw-alias-label-tertiary, #768390); font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 3px); cursor:help; }
.cdx-plus { color:#7ee787; }
.cdx-minus { color:#ffa198; }
.cdx-count { color:var(--dsw-alias-label-tertiary, #768390); }
.cdx-spacer { flex:1; }
.cdx-toolbar-editor { flex:none; display:inline-flex; align-items:center; }
.cdx-usage { flex:none; font-family:var(--drv-font-code, var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)); font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 3px); color:var(--dsw-alias-label-tertiary, #768390); cursor:help; }
.cdx-clear-btn { flex:none; border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); background:transparent; color:inherit; cursor:pointer; border-radius:6px; padding:2px 8px; font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 2px); }
.cdx-clear-btn:hover { background:rgba(248,81,73,0.14); border-color:rgba(248,81,73,0.5); color:#ffa198; }
.cdx-clear-note { flex:none; font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 3px); color:var(--dsw-alias-state-success-primary, #7ee787); }
.cdx-toolbar-font { flex:none; display:inline-flex; align-items:center; }
.drv-fontsize { flex:none; display:inline-flex; align-items:center; gap:2px; margin-right:4px; }
.drv-fontsize-btn { width:26px; height:26px; display:inline-flex; align-items:center; justify-content:center; padding:0; border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); border-radius:8px; background:transparent; color:var(--dsw-alias-label-primary, #e6edf3); cursor:pointer; font-family:var(--drv-font-ui, inherit); font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 3px); line-height:1; }
.drv-fontsize-btn:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.14)); }
.drv-fontsize-btn:disabled { opacity:0.4; cursor:default; }
.drv-fontsize-value { min-width:46px; height:26px; display:inline-flex; align-items:center; justify-content:center; padding:0 6px; border:0; border-radius:8px; background:transparent; color:var(--dsw-alias-label-tertiary, #768390); cursor:pointer; font-family:var(--drv-font-code, var(--ds-font-family-code, ui-monospace, monospace)); font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 3px); line-height:1; }
.drv-fontsize-value:hover { color:var(--dsw-alias-label-primary, #e6edf3); background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.14)); }
.drv-fontsize-active { color:var(--dsw-alias-state-business-primary, #4c8dff); }
.drv-font-menu { width:264px; max-height:340px; }
.drv-font-searchbox { position:relative; display:flex; align-items:center; margin:0 0 4px; }
.drv-font-search { box-sizing:border-box; width:100%; padding:4px 26px 4px 8px; border:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.35)); border-radius:8px; background:transparent; color:inherit; font-family:var(--drv-font-ui, inherit); font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 2px); }
.drv-font-search:focus { outline:none; border-color:var(--dsw-alias-state-business-primary, #4c8dff); }
.drv-font-clear { position:absolute; right:3px; top:50%; transform:translateY(-50%); width:20px; height:20px; display:inline-flex; align-items:center; justify-content:center; padding:0; border:0; border-radius:50%; background:transparent; color:var(--dsw-alias-label-tertiary, #768390); cursor:pointer; font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 1px); line-height:1; }
.drv-font-clear:hover { background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.14)); color:var(--dsw-alias-label-primary, #e6edf3); }
.drv-font-custom { opacity:0.85; font-style:italic; }
.cdx-error { margin:8px 0 0; padding:8px 10px; border:1px dashed rgba(255,120,120,0.5); border-radius:6px; font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 2px); color:var(--dsw-alias-label-secondary, #adbac7); }
.cdx-list { flex:1; min-height:0; overflow:auto; display:flex; flex-direction:column; gap:10px; margin-top:10px; padding-bottom:8px; }
/* two-pane review view: file list (left) + ONLY the selected file's content
   (right). The two panes scroll independently. */
.cdx-split { flex:1; display:flex; min-height:0; margin-top:10px; border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3)); border-radius:8px; overflow:hidden; container-type:inline-size; }
/* The built-in preview lives in the right sidebar, which can leave this panel very
   narrow. The list therefore never takes more than ~46% of it, and a container
   query drops it entirely below 520px so the diff keeps the whole width instead of
   collapsing to a few pixels (which wrapped every path one character per line). */
.cdx-filelist { flex:0 0 auto; width:min(270px, 46%); overflow:auto; overscroll-behavior:contain; padding:6px 0; }
/* Drag handle between the two panes (the file list and the diff). A 7px
   transparent strip carries the 1px divider line so it still LOOKS like the border
   it replaced, but is far easier to grab; hover/drag thickens it. touch-action:none
   keeps a touch drag from scrolling the pane underneath. */
.cdx-splitter { flex:0 0 7px; align-self:stretch; position:relative; cursor:col-resize; touch-action:none; }
.cdx-splitter:before { content:""; position:absolute; top:0; bottom:0; left:50%; width:1px; margin-left:-0.5px; background:var(--dsw-alias-border-l2, rgba(128,128,128,0.3)); transition:background 0.12s ease, width 0.12s ease; }
.cdx-splitter:hover:before, .cdx-splitter.cdx-dragging:before { width:2px; margin-left:-1px; background:rgba(80,120,255,0.8); }
@container (max-width: 520px) { .cdx-filelist { display:none; } .cdx-splitter { display:none; } }
.cdx-fl-item { display:flex; align-items:center; gap:6px; width:100%; padding:6px 10px; border:none; background:transparent; color:inherit; text-align:left; font-family:var(--drv-font-ui, inherit); font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 1.5px); cursor:pointer; }
.cdx-fl-item:hover { background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.12)); }
.cdx-fl-item.cdx-fl-active { background:rgba(80,120,255,0.18); }
.cdx-fl-name { flex:1 1 auto; min-width:0; font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.cdx-fl-meta { flex:none; font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 3px); opacity:0.75; white-space:nowrap; font-family:var(--drv-font-code, var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)); }
.cdx-turn-select { font:inherit; font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 2px); color:var(--dsw-alias-label-primary, #e6edf3); background:transparent; border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); border-radius:6px; padding:2px 6px; cursor:pointer; }
.cdx-turn-select option { color:#24292f; background:#fff; }
.cdx-detail { flex:1 1 auto; min-width:0; overflow:auto; overscroll-behavior:contain; padding:10px; }
.cdx-detail-head { display:flex; align-items:center; gap:8px; margin-bottom:10px; }
.cdx-detail-path { flex:1 1 auto; min-width:0; font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 2px); opacity:0.8; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-family:var(--drv-font-code, var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)); }
/* The file header itself is sticky inside the scrolling list: the header of
   the file being browsed never scrolls away — the next file's header slides
   in and takes over as the user scrolls past it. Clicking collapses/expands. */
.cdx-file { border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3)); border-radius:8px; background:var(--dsw-alias-surface-2, #161b22); flex-shrink:0; }
.cdx-file-head { display:flex; align-items:center; gap:8px; width:100%; padding:8px 10px; border:none; background:inherit; color:inherit; cursor:pointer; font-family:var(--drv-font-ui, inherit); font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 1.5px); text-align:left; position:sticky; top:0; z-index:5; border-radius:8px 8px 0 0; }
.cdx-filetype { flex:none; width:17px; height:17px; border-radius:4px; color:#fff; font-size:8.5px; font-weight:700; letter-spacing:-0.2px; display:inline-flex; align-items:center; justify-content:center; font-family:var(--drv-font-code, var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)); text-shadow:0 1px 1px rgba(0,0,0,0.4); box-shadow:inset 0 0 0 1px rgba(255,255,255,0.14), 0 1px 2px rgba(0,0,0,0.3); padding:0 1px; }
/* Wrapper for the shell's own file-type mark (primitives FileTypeIcon); the SVG
   carries its own size, this only keeps the row alignment. */
.cdx-fileicon { flex:none; display:inline-flex; align-items:center; justify-content:center; line-height:0; }
.cdx-file-head:hover { background-image:linear-gradient(rgba(128,128,128,0.10), rgba(128,128,128,0.10)); }
.cdx-empty { padding:28px; text-align:center; color:var(--dsw-alias-label-tertiary, #768390); font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 1px); line-height:1.7; }
.cdx-file-path { flex:1 1 auto; min-width:0; font-family:var(--drv-font-code, var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)); font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 2px); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:var(--dsw-alias-label-primary, #e6edf3); }
.cdx-file-cnt { flex:none; font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 3px); color:var(--dsw-alias-label-tertiary, #768390); white-space:nowrap; }
.cdx-file-stats { flex:none; font-family:var(--drv-font-code, var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)); font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 2px); white-space:nowrap; }
.cdx-chevron { flex:none; color:var(--dsw-alias-label-tertiary, #768390); font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 3px); }
.cdx-file-body { border-top:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25)); }
.cdx-sec { border-bottom:1px solid rgba(128,128,128,0.12); }
.cdx-sec:last-child { border-bottom:none; }
.cdx-sec-head { display:flex; align-items:center; gap:8px; padding:5px 10px; background:rgba(128,128,128,0.06); font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 2px); }
.cdx-sec-marks { display:flex; align-items:center; gap:6px; margin-left:auto; }
.cdx-sec-note { font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 4px); padding:0 6px; border-radius:8px; background:rgba(128,128,128,0.18); color:var(--dsw-alias-label-tertiary,#768390); cursor:help; }
.cdx-open { flex:0 0 auto; border:0; background:transparent; color:var(--dsw-alias-label-tertiary,#768390); font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 3px); line-height:1; padding:2px 5px; border-radius:5px; cursor:pointer; opacity:0; transition:opacity .12s ease; }
/* With no wrapping, a long line pushes this button past the right edge — so inside a
   diff line it sticks to the scrollport edge (and needs its own backdrop then). */
.cdx-line .cdx-open { position:sticky; right:6px; background:var(--dsw-alias-bg-layer-1, #22272e); }
.cdx-open:hover { background:rgba(128,128,128,0.22); color:var(--dsw-alias-label-primary,#e6edf3); }
.cdx-line:hover .cdx-open, .cdx-sec-head:hover .cdx-open { opacity:1; }
.cdx-sec-head .cdx-open { opacity:.75; }
.cdx-sec-tag { padding:0 6px; border-radius:6px; font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 4px); font-weight:600; }
.cdx-sec-edit { background:rgba(9,105,218,0.25); color:#79b8ff; }
.cdx-sec-write { background:rgba(46,160,67,0.22); color:#7ee787; }
.cdx-sec-time { color:var(--dsw-alias-label-tertiary, #768390); }
/* Diff lines never wrap: a code line that wraps is unreadable (continuation lines
   read as new lines, and the +/- alignment with the gutter breaks). The scroll
   container is the diff body itself, and each row is max-content wide so its
   add/del background still spans the full scrolled width instead of ending at the
   viewport edge. */
.cdx-diff { font-family:var(--drv-font-code, var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)); font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 2px); line-height:1.6; padding:4px 0 6px; overflow-x:auto; overscroll-behavior-x:contain; }
.cdx-line { display:flex; width:max-content; min-width:100%; padding:0 10px; white-space:pre; word-break:normal; }
.cdx-line.cdx-add { background:linear-gradient(90deg, rgba(46,160,67,0.14), rgba(46,160,67,0.02) 55%, transparent); }
.cdx-line.cdx-del { background:linear-gradient(90deg, rgba(248,81,73,0.14), rgba(248,81,73,0.02) 55%, transparent); }
.cdx-gutter { flex:0 0 40px; text-align:right; padding-right:8px; user-select:none; color:var(--dsw-alias-label-tertiary, #768390); }
.cdx-sign { flex:0 0 16px; user-select:none; }
.cdx-add .cdx-sign { color:#7ee787; }
.cdx-del .cdx-sign { color:#ffa198; }
.cdx-text { flex:1 0 auto; min-width:max-content; color:var(--dsw-alias-label-primary, #e6edf3); }
/* syntax token colors (GitHub-dark-ish, works on both diff tones) */
.cdx-tok-kw { color:#ff7b72; }
.cdx-tok-str { color:#a5d6ff; }
.cdx-tok-com { color:#8b949e; font-style:italic; }
.cdx-tok-num { color:#79c0ff; }
/* themed text selection: the Chromium default is pale (white-ish) on dark,
   which reads as floating white cards over diff lines — pin it to the theme. */
.drv-view ::selection { background: var(--dsw-alias-state-primary-soft, rgba(80,120,255,0.4)); color: inherit; }
.drv-view ::-moz-selection { background: var(--dsw-alias-state-primary-soft, rgba(80,120,255,0.4)); color: inherit; }
.drv-color-row { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:3px 0; font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 2px); }
.drv-color-tabs { display:flex; gap:6px; align-items:center; margin:0 0 10px; flex-wrap:wrap; }
.drv-color-tab { border:1px solid rgba(128,128,128,0.4); background:transparent; color:inherit; cursor:pointer; border-radius:6px; padding:3px 12px; font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 2px); }
.drv-color-tab.drv-color-tab-active { background:rgba(80,120,255,0.25); border-color:rgba(80,120,255,0.6); }
.drv-color-now { font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 3px); opacity:0.6; }
.drv-color-row input[type=color] { width:38px; height:24px; border:none; border-radius:4px; padding:0; background:transparent; cursor:pointer; }
.drv-color-controls { display:flex; align-items:center; gap:6px; }
.drv-color-controls input[type=range] { width:76px; accent-color:var(--dsw-alias-state-business-primary, #4493f8); }
.drv-color-alpha { font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 3px); opacity:0.7; min-width:34px; text-align:right; }
.drv-presets { display:flex; gap:6px; margin-top:8px; }
.drv-presets button { border:1px solid rgba(128,128,128,0.4); background:transparent; color:inherit; cursor:pointer; border-radius:6px; padding:3px 8px; font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 3px); }
.drv-presets button:hover { background:rgba(128,128,128,0.15); }
.drv-settings-page { padding:16px; font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 1px); }
.drv-check { display:flex; align-items:flex-start; gap:8px; margin:0 0 12px; font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 1.5px); line-height:1.5; cursor:pointer; color:var(--dsw-alias-label-secondary, #adbac7); }
.drv-check input { margin:3px 0 0; flex:none; }
.drv-settings-desc { opacity:0.7; margin:0 0 14px; line-height:1.6; }
/* The state of the system-prompt injection under its checkbox (registered, or why not). */
.drv-settings-note { margin:6px 0 14px; opacity:0.65; line-height:1.6; font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 2px); word-break:break-all; }
/* When a change takes effect — the question the injection switch always raises. */
.drv-settings-hint { margin:-8px 0 14px; opacity:0.6; line-height:1.6; font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 2px); }
.drv-prefs-note { margin:6px 0 14px; opacity:0.6; line-height:1.6; font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 2px); }
.drv-tab-label { display:inline-flex; align-items:center; gap:6px; }
.drv-tab-badge { display:inline-block; border-radius:8px; padding:0 5px; font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 4px); line-height:14px; font-weight:600; min-width:16px; text-align:center; }
.drv-detail-toolbar { display:flex; align-items:center; gap:8px; margin-bottom:10px; }
.drv-detail-path { font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 2px); opacity:0.8; word-break:break-all; }
.drv-btn-revert { font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 3px); padding:2px 8px; }
.drv-btn-danger { color:#cf222e; }
.drv-notice { font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 2px); color:#1a7f37; background:rgba(46,160,67,0.15); border-radius:6px; padding:3px 8px; }
.drv-mode { display:flex; gap:4px; }
.drv-mode-btn { border:1px solid rgba(128,128,128,0.4); background:transparent; color:inherit; cursor:pointer; border-radius:6px; padding:2px 8px; font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 3px); }
.drv-mode-btn:hover { background:rgba(128,128,128,0.12); }
.drv-mode-btn.drv-mode-active { background:rgba(80,120,255,0.25); border-color:rgba(80,120,255,0.6); }
.drv-turn { border:1px solid rgba(128,128,128,0.3); border-radius:8px; padding:6px 10px; font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 2px); }
.drv-turn-produced { display:flex; align-items:center; gap:6px; flex-wrap:wrap; padding:0 0 6px; }
.drv-turn-produced-label { font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 3px); opacity:0.7; }
.drv-turn-produced-chip { border:1px solid rgba(128,128,128,0.35); background:transparent; color:inherit; cursor:pointer; border-radius:10px; padding:1px 8px; font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 3px); font-family:var(--drv-font-ui, inherit); }
.drv-turn-produced-chip:hover { background:rgba(128,128,128,0.12); }
.drv-turn-head { display:flex; align-items:center; gap:8px; padding:2px 0 6px; }
.drv-turn-title { font-weight:600; }
.drv-turn-hint { font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 3px); opacity:0.6; }
.drv-turn-file { border-top:1px solid rgba(128,128,128,0.15); }
.drv-turn-file-head { display:flex; align-items:center; gap:8px; width:100%; padding:5px 0; border:none; background:transparent; color:inherit; cursor:pointer; font-family:var(--drv-font-ui, inherit); font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 2px); text-align:left; }
.drv-turn-file-name { font-weight:500; word-break:break-all; }
.drv-turn-chevron { opacity:0.6; }
.drv-turn-file-body { padding:2px 0 8px; }
.drv-turn-file-body .drv-section { margin-bottom:8px; }
.drv-ctx { position:fixed; z-index:20000; min-width:150px; padding:4px; border:1px solid rgba(128,128,128,0.45); border-radius:8px; background:var(--dsw-alias-surface-2, #22272e); box-shadow:0 6px 18px rgba(0,0,0,0.35); }
.drv-ctx-item { display:block; width:100%; border:none; background:transparent; color:inherit; text-align:left; padding:6px 10px; border-radius:6px; font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 2px); font-family:var(--drv-font-ui, inherit); cursor:pointer; }
.drv-ctx-item:hover { background:rgba(80,120,255,0.28); }
.drv-editor { position:relative; display:inline-flex; }
/* Shell-style chip: same tokens as the header controls next to it (border-l2, 24px
   radius, interactive-bg-hover on hover) so the toolbar never looks foreign. */
.drv-editor-btn { display:inline-flex; align-items:center; gap:6px; height:28px; padding:0 10px; border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); border-radius:24px; background:transparent; color:var(--dsw-alias-label-primary, #e6edf3); cursor:pointer; font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 2px); font-family:var(--drv-font-ui, inherit); }
.drv-editor-btn:hover { background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.14)); }
.drv-editor-label { display:inline-flex; align-items:center; gap:5px; min-width:0; }
.drv-editor-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:200px; }
.drv-editor-caret { opacity:0.7; font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 4px); flex:none; }
.drv-editor-menu { position:absolute; top:calc(100% + 4px); right:0; z-index:20000; width:max-content; min-width:170px; max-width:320px; padding:4px; border:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.45)); border-radius:12px; background:var(--dsw-specific-menu, var(--dsw-alias-surface-2, #22272e)); box-shadow:var(--dsw-elevation-prominent, 0 6px 18px rgba(0,0,0,0.35)); max-height:260px; overflow:auto; }
.drv-editor-opt { display:block; width:100%; border:none; background:transparent; color:inherit; text-align:left; padding:6px 10px; border-radius:6px; font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 2px); font-family:var(--drv-font-ui, inherit); cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.drv-editor-opt:hover { background:rgba(128,128,128,0.16); }
.drv-editor-opt.drv-editor-opt-active { background:rgba(80,120,255,0.22); box-shadow:inset 2px 0 0 rgba(80,120,255,0.75); }
.drv-editor-rescan { margin-top:4px; border-top:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.2)); border-radius:0; color:var(--dsw-alias-label-tertiary, #768390); font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 2.5px); }
.drv-editor-empty { white-space:nowrap; padding:6px 10px 8px; margin-bottom:4px; border-bottom:1px solid rgba(128,128,128,0.16); font-size:calc(var(--dsh-content-font-size, 14px) + var(--drv-font-delta, 0px) - 2px); opacity:0.6; }
`;
		// The shell's own deliverables plugin renders in the SAME turnTail slot: a
		// per-turn "已编辑 N 个文件" card whose root carries data-changed-files. It is
		// turned off by default so this plugin's card is the single entry — flipped
		// back on from Settings. The selector is the official semantic data attribute,
		// not a hashed class name; our own card uses data-dsh-review-card and is
		// therefore never caught by it. The delivered-files block (data-after-changes)
		// stays visible: delivery is the shell's feature, not ours. Kept in its own
		// <style> element so the toggle is a sheet.disabled flip instead of a re-render.
		const OFFICIAL_CARD_CSS = "[data-changed-files]{display:none !important}";
		/** The one <style> element carrying OFFICIAL_CARD_CSS (created lazily, toggled
		 *  through sheet.disabled so flipping the setting costs no re-render). */
		let officialCardStyle = null;
		function syncOfficialCards() {
			try {
				if (officialCardStyle === null) {
					officialCardStyle = document.createElement("style");
					officialCardStyle.textContent = OFFICIAL_CARD_CSS;
					document.head.appendChild(officialCardStyle);
				}
				const hide = store.hideOfficialCards !== false;
				if (officialCardStyle.sheet) officialCardStyle.sheet.disabled = !hide;
				else officialCardStyle.disabled = !hide;
			} catch (e) {}
		}
		function apply(ctx) {
			ctxRef = ctx;
			connRef = ctx.get("connection");
			ctx.effect(() => {
				const el = document.createElement("style");
				el.textContent = CSS;
				document.head.appendChild(el);
				return () => el.remove();
			}, "diff-review: styles");
			// Hand the turn cards to this plugin: the shell's own card and presented-files
			// block live in the same slot, so they are hidden by default (see
			// OFFICIAL_CARD_CSS). Applied on boot and re-applied from Settings.
			ctx.effect(() => {
				syncOfficialCards();
				return () => {
					try { if (officialCardStyle) officialCardStyle.remove(); } catch (e) {}
					officialCardStyle = null;
				};
			}, "diff-review: official card takeover");
			loadEditors();
			loadPrefs();
			refreshFromServer();
			ctx.effect(connectEvents, "diff-review: live refresh");
			// The editor picker is NOT registered in the session header: it sat right
			// next to the shell's own "open in app" chip (two near-identical controls).
			// It now lives in the review toolbar, which is where files are opened from.
			//
			// `label` has to be TEXT: 44.x sizes each tab from the string
			// (`for (const glyph of label)`), so a React element throws inside the tab
			// row and the whole strip disappears. The label is a constant string —
			// the count lives on the pill and in the panel, not on the tab — so
			// nothing has to be re-projected when files change.
			ctx.slots.inject("conversation.view", () => ctx.slots.register(
				{
					name: "conversation.view", id: "review", order: 5,
					label: REVIEW_TAB_LABEL
				},
				(props) => React.createElement(ReviewView, props)))
			// Two host generations, one registration. Host <=0.1.5 declares this slot
			// `chain`, where `select` is REQUIRED (it elects the entry per owner); host
			// 0.1.6+ declares it `list`, where a stable `id` is REQUIRED and `select`
			// is ignored (every entry renders, ours returns null for a turn without
			// changes). Registering the chain shape against the list host threw
			// `list slot "conversation.chat.turnTail" requires options.id` and the
			// per-turn card silently disappeared — so send both shapes.
			ctx.slots.inject("conversation.chat.turnTail", () => ctx.slots.register(
				{ name: "conversation.chat.turnTail", id: "diff-review", order: -1, priority: -1, select: (owner) => (owner && owner.turn && owner.turn.turn != null ? { turn: owner.turn.turn } : null) },
				(props) => React.createElement(TurnReview, props)));
			// The shell's own seat for full-width entries above the composer card; the pill
			// was previously registered on `conversation.composer.dock` (the status row
			// below the composer) and floated back up over the input by hand.
			ctx.slots.inject("conversation.input.dock", () => ctx.slots.register(
				{ name: "conversation.input.dock", id: "diff-review-pill", order: 999 },
				(props) => React.createElement(ChangePill, props)));
			ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register(
				{ name: "conversation.session.header.actions", id: "diff-review-session", order: 100 },
				(props) => React.createElement(SessionProbe, props)));
			ctx.slots.inject("settings.section", () => ctx.slots.register(
				{ name: "settings.section", id: "diff-review", order: 25, label: "修改审查" },
				(props) => React.createElement(SettingsPage, props)));
			// Our own tool, keyed by its wire name. The toolview key domain lists every
			// claimed tool name and `diff_review_revert` is not among them, so this adds a
			// view instead of shadowing a shipped one.
			ctx.slots.inject("tool.call.toolview", () => ctx.slots.register(
				{ name: "tool.call.toolview", key: "diff_review_revert" },
				(props) => React.createElement(RevertToolRow, props)));
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});