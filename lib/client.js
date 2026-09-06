window.__ModuleLoader__.load({
	id: "dsh-review-checkout",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");

		// ── color configuration (persisted to localStorage) ────────────────
		const LS_KEY = "dsh.diff-review.colors";
		const LIGHT = { addBg: "#e6ffec", addFg: "#1a7f37", delBg: "#ffebe9", delFg: "#cf222e", ctxBg: "#f6f8fa", gutter: "#57606a", badgeBg: "#0969da", badgeFg: "#ffffff", turnAdd: "#1a7f37", turnDel: "#cf222e", turnBg: "rgba(255, 183, 77, 0.1)", turnBorder: "#ffb74d" };
		const DARK = { addBg: "#10251c", addFg: "#7ee787", delBg: "#2d1415", delFg: "#ffa198", ctxBg: "#161b22", gutter: "#8b949e", badgeBg: "#4493f8", badgeFg: "#0d1117", turnAdd: "#7ee787", turnDel: "#ffa198", turnBg: "rgba(255, 183, 77, 0.1)", turnBorder: "#ffb74d" };
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
			mode: "latest", latestTurn: 0, turnData: null,
			reviewTurn: null, reviewFile: null,
			editors: [], editorLoading: false, selectedEditor: null,
			tip: null,
			colorSets: null,
			colorTab: "light",
			themeNow: "light",
			running: false
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
				if (r !== store.running) setState({ running: r });
			} catch (e) {}
		}
		const listeners = new Set();
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
		let rtApi = null
		try { rtApi = require("@deepseek-ai/dsh-client-runtime/client"); } catch (e) { rtApi = null; }
		function resolveAbsPath(sessionId, path, cwd) {
			try {
				if (!ctxRef) return path
				// Use the provided cwd (from file data) first, then fall back to session's current cwd
				if (!cwd && ctxRef.sessions && ctxRef.sessions.list) {
					const byId = ctxRef.sessions.list.getSnapshot().byId
					cwd = byId && byId[sessionId] && byId[sessionId].cwd
				}
				if (rtApi && rtApi.resolveWorkspacePath) return rtApi.resolveWorkspacePath(cwd, path)
				if (cwd && typeof path === "string" && !path.startsWith("/") && !/^[a-zA-Z]:[\/]/.test(path)) {
					return cwd.replace(/[\/]+$/, "") + "/" + path.replace(/^[\/]+/, "")
				}
				return path
			} catch (e) { return path }
		}
		function openFileFor(sessionId, path, cwd) {
			try {
				if (!ctxRef) return
				const abs = resolveAbsPath(sessionId, path, cwd)
				const ed = store.selectedEditor
				if (ed && ed.id) {
					apiOpenWithEditor(ed.id, abs).then((v) => {
						if (!(v && v.ok)) openViaWorkspace(abs)
					}).catch(() => openViaWorkspace(abs))
					return
				}
				openViaWorkspace(abs)
			} catch (e) {}
		}
		function openViaWorkspace(abs) {
			try {
				if (ctxRef && ctxRef.workspaces && ctxRef.workspaces.openPath && abs) {
					ctxRef.workspaces.openPath(abs).catch(() => {})
				}
			} catch (e) {}
		}



		// ── host data via the official transport ─────────────────────────────
		// v3: no self-built HTTP routes. rpc.call goes through the official
		// transport (web fetch / desktop IPC bridge) to /diff-review/<ep>;
		// the Host serves that path directly on webServer.
		// NOTE: the channel must be a SINGLE path segment (assertTarget rejects
		// slashes) — '/api' would produce /api/session.list-style dotted names
		// that never match a prefix route; '/diff-review' is the correct shape.
		let connRef = null;
		function rpcCall(endpoint, payload) {
			return new Promise((resolve, reject) => {
				const conn = connRef;
				if (!conn || !conn.rpc || typeof conn.rpc.call !== "function") {
					reject(new Error("connection channel unavailable"));
					return;
				}
				conn.rpc.call("/diff-review", endpoint, payload || {}).then(resolve, reject);
			});
		}
		function apiFile(session, path) { return rpcCall("file", { session, path }); }
		function apiTurn(session, turn) { return rpcCall("turn", { session, turn }); }
		function apiClear(session) { return rpcCall("clear", { session }); }
		function apiEditors() { return rpcCall("editors", {}); }
		function apiOpenWithEditor(editor, path, line, col) { return rpcCall("open-with-editor", { editor, path, line: line || null, col: col || null }); }
		function loadEditors() {
			setState({ editorLoading: true });
			apiEditors().then((v) => {
				const editors = (v && v.editors) || [];
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
		// Minimal line diff (same contract as host): [{type,a,b,text}]
		function diffLinesLocal(a, b) {
			const n = a.length, m = b.length, w = m + 1;
			const dp = new Int32Array((n + 1) * w);
			for (let i = n - 1; i >= 0; i--) {
				for (let j = m - 1; j >= 0; j--) {
					dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
				}
			}
			const out = [];
			let pending = [];
			const flush = () => { for (const h of pending) out.push(h); pending = []; };
			let i = 0, j = 0, aNo = 1, bNo = 1;
			while (i < n && j < m) {
				if (a[i] === b[j]) { pending.push({ type: "ctx", a: aNo, b: bNo, text: a[i] }); i++; j++; aNo++; bNo++; }
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
					} else if (ev.type === "tool/code-dispatch") {
						// 嵌套工具调用(run_code 程序内的 write/edit)只以自包含的
						// code-dispatch 事件落转录(name + arguments + isError),
						// 不会出现顶层 tool/call + tool/result 配对——不解析则整段会话的
						// 文件修改在审查页里不可见。
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
			return files;
		}
		function summaryFromFiles(files) {
			const items = [];
			for (const rec of files.values()) {
				let added = 0, removed = 0, writes = 0, edits = 0;
				for (const op of rec.ops) {
					if (op.kind === "edit") { edits++; added += splitLinesL(op.newString || "").length; removed += splitLinesL(op.oldString || "").length; }
					else { writes++; added += splitLinesL(op.content || "").length; }
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
		function sectionFromOp(rec, i, op) {
			let hunks;
			if (op.kind === "edit") {
				const oldL = splitLinesL(op.oldString || "");
				const newL = splitLinesL(op.newString || "");
				if (op.oldString === "") hunks = newL.map((t, k) => ({ type: "add", a: null, b: k + 1, text: t }));
				else if (op.newString === "") hunks = oldL.map((t, k) => ({ type: "del", a: k + 1, b: null, text: t }));
				else hunks = diffLinesLocal(oldL, newL);
			} else {
				hunks = splitLinesL(op.content || "").map((t, k) => ({ type: "add", a: null, b: k + 1, text: t }));
			}
			return { kind: op.kind, at: op.at, hunks: hunks, wholeFile: op.kind === "write", opIndex: i, revertible: false, canUndo: false };
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
		function rebuildReview() {
			const session = store.currentSession;
			if (!session) return;
			const rid = ++reviewRid;
			reviewAsync = loadFullHistory(session).then((events) => {
				if (rid !== reviewRid || store.currentSession !== session) return;
				reviewFiles = parseReviewEvents(events);
				const s = summaryFromFiles(reviewFiles);
				setState({ files: s.files, latestTurn: s.latestTurn, loadingFiles: false, error: null });
				if (store.mode === "latest") loadTurn(store.reviewTurn);
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
			const seq = ++reqSeq;
			setState({ loadingFiles: true, error: null });
			rebuildReview();
		}
		// Latest-turn view: files + sections for the most recent recorded turn.
		// Local aggregation for an arbitrary turn (used as the Desktop / host-
		// channel fallback; the host's turn RPC is authoritative when live).
		function localTurnData(turnNo) {
			const turn = (turnNo == null || !Number.isFinite(turnNo)) ? (store.latestTurn || 0) : turnNo;
			const items = [];
			for (const rec of reviewFiles.values()) {
				const indices = [];
				for (let i = 0; i < rec.ops.length; i++) if (rec.ops[i].turn === turn) indices.push(i);
				if (indices.length === 0) continue;
				const ops = indices.map((i) => rec.ops[i]);
				let added = 0, removed = 0, writes = 0, edits = 0;
				for (const op of ops) {
					if (op.kind === "edit") { edits++; added += splitLinesL(op.newString || "").length; removed += splitLinesL(op.oldString || "").length; }
					else { writes++; added += splitLinesL(op.content || "").length; }
				}
				items.push({ path: rec.path, name: displayName(rec.path, rec.cwd), cwd: rec.cwd, ops: ops.length, writes: writes, edits: edits, added: added, removed: removed, lastTime: ops[ops.length - 1].at, revertible: false, sections: detailFromRecIdx(rec, indices).sections });
			}
			items.sort((x, y) => y.lastTime - x.lastTime);
			return { turn: turn, files: items };
		}
		// Per-turn payload: prefer the host channel (authoritative turn tags,
		// full records incl. revert snapshots), fall back to local history.
		// `turn` null/NaN resolves to the latest recorded turn (0 = no
		// turn/start window, matches the card's window semantics).
		const turnInflight = new Map(); // (session|turn) -> Promise, dedupes concurrent fetches
		function fetchTurnData(session, turnNo) {
			const turn = (turnNo == null || !Number.isFinite(turnNo)) ? (store.latestTurn || 0) : turnNo;
			const key = String(session) + "|" + String(turn);
			const inf = turnInflight.get(key);
			if (inf) return inf;
			const p = apiTurn(session, turn).then((v) => {
				return (v && Array.isArray(v.files)) ? { turn: turn, files: v.files } : localTurnData(turn);
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
				setState({ turnData: { turn: data.turn, files: data.files || [] } });
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
				if (v && v.sections) setState({ detail: v, loadingDetail: false });
				else setState({ detail: detailFromRec(reviewFiles.get(path)), loadingDetail: false });
			}).catch(() => {
				if (store.currentSession !== session) return;
				setState({ detail: detailFromRec(reviewFiles.get(path)), loadingDetail: false, error: null });
			});
		}
		function refresh() {
			loadSummary();
			if (store.mode === "latest") { loadTurn(store.reviewTurn); return; }
			if (store.selected) loadDetail(store.selected);
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
			["badgeBg", "角标背景"], ["badgeFg", "角标文字"],
			["turnAdd", "新增行数（对话底部）"], ["turnDel", "删除行数（对话底部）"],
			["turnBg", "背景色（对话底部）"], ["turnBorder", "边框色（对话底部）"]
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
					setState({ currentSession: props.sessionId, files: null, selected: null, detail: null, mode: "latest", turnData: null, latestTurn: 0, error: null, loadingFiles: true });
					updateRunning();
					refreshFromServer();
				}
			}, [props.sessionId]);
			return null;
		}

		function TabLabel() {
			const files = useStore((s) => s.files);
			const latestTurn = useStore((s) => s.latestTurn);
			const colors = useStore((s) => s.colors);
			const count = files && files.length ? windowList(latestTurn).length : 0;
			return React.createElement("span", { className: "drv-tab-label" },
				React.createElement("span", null, "审查"),
				count > 0 ? React.createElement("span", {
					className: "drv-tab-badge",
					style: { background: colors.badgeBg, color: colors.badgeFg }
				}, String(count)) : null);
		}

		// Codex-style per-turn card (conversation.chat.turnTail)
		function fmtDayTime(t) {
			if (!t) return "";
			const d = new Date(t);
			const p = (x) => String(x).padStart(2, "0");
			return ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"][d.getDay()] + " " + p(d.getHours()) + ":" + p(d.getMinutes());
		}
		function collectTurn(turnNo) {			let added = 0, removed = 0, lastAt = 0, opCount = 0;
			const files = [];
			for (const rec of reviewFiles.values()) {
				const ops = [];
				for (const op of rec.ops) { if (op.turn === turnNo) ops.push(op); }
				if (ops.length === 0) continue;
				let a = 0, r = 0, writes = 0, edits = 0;
				for (const op of ops) {
					if (op.kind === "edit") { edits++; a += splitLinesL(op.newString || "").length; r += splitLinesL(op.oldString || "").length; }
					else { writes++; a += splitLinesL(op.content || "").length; }
				}
				added += a; removed += r; opCount += ops.length;
				lastAt = Math.max(lastAt, ops[ops.length - 1].at || 0);
				files.push({ path: rec.path, name: displayName(rec.path, rec.cwd), added: a, removed: r, ops: ops.length, writes: writes, edits: edits });
			}
			files.sort((x, y) => y.ops - x.ops);
			return { files: files, added: added, removed: removed, lastAt: lastAt, opCount: opCount };
		}
		function openReviewTab() {
			try {
				const els = document.querySelectorAll("button, [role=tab], [role=button], [data-view]");
				for (const el of els) {
					const t = (el.textContent || "").trim();
					if (t.indexOf("审查") >= 0 && t.length < 10 && el.clientWidth > 0) { el.click(); return; }
				}
			} catch (e) {}
		}
		// Only the NEWEST turn's card is shown: turns render in list order, so a
		// plain max-tracked turn number decides the single visible card.
		function windowSummary() {
			// Fallback for turn-number mismatch (window without turn/start):
			// aggregate the parsed window as one card payload.
			let added = 0, removed = 0, lastAt = 0, opCount = 0;
			const files = [];
			for (const rec of reviewFiles.values()) {
				let a = 0, r = 0, n = 0, at = 0, wr = 0, ed = 0;
				for (const op of rec.ops) {
					if (op.kind === "edit") { ed++; a += splitLinesL(op.newString || "").length; r += splitLinesL(op.oldString || "").length; }
					else { wr++; a += splitLinesL(op.content || "").length; }
					n++; at = Math.max(at, op.at || 0);
				}
				if (!n) continue;
				added += a; removed += r; opCount += n; lastAt = Math.max(lastAt, at);
				files.push({ path: rec.path, name: displayName(rec.path, rec.cwd), added: a, removed: r, ops: n, writes: wr, edits: ed });
			}
			files.sort((x, y) => y.ops - x.ops);
			return { files: files, added: added, removed: removed, lastAt: lastAt, opCount: opCount };
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
		// Op indices (into the FULL recorded ops array) belonging to one turn,
		// newest-first — the revert sequence for diff_review_revert.
		function cardOpIndices(item, turnNo) {
			if (item && Array.isArray(item.sections) && item.sections.length) {
				const out = [];
				for (const s of item.sections) if (s && typeof s.opIndex === "number") out.push(s.opIndex);
				if (out.length) return out.sort((a, b) => b - a);
			}
			const rec = item && reviewFiles.get(item.path);
			if (!rec) return [];
			const out = [];
			for (let i = 0; i < rec.ops.length; i++) {
				if (turnNo == null || rec.ops[i].turn === turnNo) out.push(i);
			}
			return out.sort((a, b) => b - a);
		}
		function TurnReview({ matched, sessionId, turn: turnLoc, seq, inputActions }) {
			const turnNo = matched && matched.turn;
			const latestTurn = useStore((s) => s.latestTurn); // re-render as the review data refreshes
			const filesTick = useStore((s) => s.files); // poll refresh signal
			const colors = useStore((s) => s.colors);
			const dark = useStore((s) => s.themeNow) === "dark";
			const [revertStatus, setRevertStatus] = React.useState("");
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
			const title = first ? (local.files.length === 1 ? showName(first) : showName(first) + " 等 " + local.files.length + " 个文件") : "";
			const go = (path) => {
				try { setState({ mode: "latest", reviewTurn: effectiveTurn, reviewFile: path || null }); } catch (e) {}
				openReviewTab();
			};
			const goFile = (e, path) => {
				e.stopPropagation(); // 单行点击不触发整卡跳转
				go(path);
			};
			if (noChanges) {
				return React.createElement("div", { className: "cdx-turn cdx-turn-empty", style: { background: colors.turnBg, borderColor: colors.turnBorder }, title: "本轮无文件修改" },
					React.createElement("div", { className: "cdx-turn-main" },
						React.createElement("div", { className: "cdx-turn-body" },
							React.createElement("div", { className: "cdx-turn-title cdx-turn-title-muted", style: { color: themeLabel(dark) } }, "本轮无文件修改"))));
			}
			return React.createElement("div", { className: "cdx-turn", style: { background: colors.turnBg, borderColor: colors.turnBorder }, onClick: () => go(local.files.length === 1 ? first.path : null), role: "button", title: "打开审查视图" },
				React.createElement(TipLayer, null),
				React.createElement("div", { className: "cdx-turn-main" },
					React.createElement("div", { className: "cdx-turn-icon" },
						React.createElement(FileTypeBadge, { path: first.path })),
					React.createElement("div", { className: "cdx-turn-body" },
						React.createElement("div", { className: "cdx-turn-title", style: { color: themeLabel(dark) }, title: first.path }, "已编辑 " + title),
						React.createElement("div", { className: "cdx-turn-stats" },
							React.createElement("span", { className: "cdx-plus", style: { color: colors.turnAdd } }, "+" + local.added),
							React.createElement("span", { className: "cdx-minus", style: { color: colors.turnDel } }, " −" + local.removed)),
						React.createElement("div", { className: "cdx-turn-time" }, fmtDayTime(local.lastAt))),
					React.createElement("div", { className: "cdx-turn-actions" },
						React.createElement("button", {
							type: "button",
							className: "cdx-turn-btn",
							style: { color: themeLabel(dark) },
							onClick: (e) => {
								e.stopPropagation(); // 卡片整卡点击会跳审查——按钮内拦截
								// 按轮回滚：只撤销这一轮（该卡片）的修改项。op 是文件
								// 修改记录中的操作编号，必须从最后一个操作开始依次撤回。
								const roundText = (effectiveTurn != null && Number.isFinite(effectiveTurn)) ? ("第 " + effectiveTurn + " 轮") : "本轮";
								const lines = [];
								for (const f of local.files) {
									const idxs = cardOpIndices(f, effectiveTurn);
									if (!idxs.length) {
										lines.push('- ' + f.path + '：diff_review_revert(path="' + f.path.replace(/"/g, '\\"') + '")（未找到该轮操作编号，退回撤回该文件全部修改）');
										continue;
									}
									lines.push('- ' + f.path + '：' + idxs.map((i) => 'diff_review_revert(path="' + f.path.replace(/"/g, '\\"') + '", op=' + i + ')').join(' → '));
								}
								const cmd = '请撤回' + roundText + '对以下文件的修改（使用 diff_review_revert 工具；每个文件的 op 已从最后一个操作排到第一个，请按顺序依次调用；若某项因冲突等失败，跳过该项继续）：\n' + lines.join('\n');
								// 优先走官方 inputActions.setDraft 填入 composer（新版 composer 是
								// Lexical 编辑器，不再是 <textarea>，旧 DOM 写入已失效）。
								let filled = false;
								if (inputActions && typeof inputActions.setDraft === "function") {
									try { inputActions.setDraft(cmd); filled = true; } catch (e2) {}
								}
								// 剪贴板兜底：始终写入，便于手动粘贴。
								try {
									if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(cmd).catch(() => {});
									else window.prompt("复制撤回指令", cmd);
								} catch (e2) {}
								setRevertStatus(filled ? "已填入 ✓" : "已复制 ✓");
								setTimeout(() => setRevertStatus(""), 1600);
							}
						}, revertStatus || "撤销"),
						React.createElement("button", {
							type: "button",
							className: "cdx-turn-btn",
							style: { color: themeLabel(dark) },
							onClick: (e) => {
								e.stopPropagation();
								go(null);
							}
						}, "审核"))),
				local.files.length > 1 ? React.createElement("div", { className: "cdx-turn-files" },
					local.files.map((f) => React.createElement("button", { key: f.path, type: "button", className: "cdx-turn-file", onClick: (e) => goFile(e, f.path), title: "查看 " + f.path + " 的修改" },
						React.createElement("span", { className: "cdx-turn-file-name" }, showName(f)),
						React.createElement("span", { className: "cdx-turn-file-stats" },
							React.createElement("span", { className: "cdx-plus", style: { color: colors.turnAdd } }, "+" + f.added),
							React.createElement("span", { className: "cdx-minus", style: { color: colors.turnDel } }, " −" + f.removed))))) : null);
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
			const kw = lang === "js" ? KEYWORDS.js : lang === "cpp" ? KEYWORDS.cpp : lang === "py" ? KEYWORDS.py : null;
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
					if (kw && new RegExp("(^|\\W)(" + kw + ")(\\W|$)").test(" " + word + " ")) { buf = word; push("kw"); }
					else { buf = word; push("plain"); }
					i = j; continue;
				}
				buf += ch; i++;
			}
			push("plain");
			return out;
		}
		function CodexLine({ h, lang }) {
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
			return React.createElement("div", { className: cls, style: { background: bg } },
				React.createElement("span", { className: "cdx-gutter", style: { color: colors.gutter } }, no != null ? String(no) : ""),
				React.createElement("span", { className: "cdx-sign", style: { color: fg } }, sign),
				React.createElement("span", { className: "cdx-text", style: { color: fg || themeLabel(dark) } },
					tokens ? tokens.map((tk, i) => tk.t === "plain" ? tk.s : React.createElement("span", { key: i, className: "cdx-tok-" + tk.t, style: { color: pal[tk.t] } }, tk.s))
						: (h.text === "" ? " " : h.text)));
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
		function FileTypeBadge({ path }) {
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
		function CodexFileCard({ item, expanded, onToggle, turn }) {
			// Prefer the payload's own per-turn sections (host turn RPC / local
			// turn aggregation); fall back to the reviewed window when absent.
			const detail = expanded ? ((item.sections && item.sections.length) ? { path: item.path, sections: item.sections } : detailFromRecTurn(reviewFiles.get(item.path), turn)) : null;
			const lang = langOf(item.path);
			const colors = useStore((s) => s.colors);
			const head = React.createElement("button", { type: "button", className: "cdx-file-head", onClick: onToggle },
				React.createElement(FileTypeBadge, { path: item.path }),
				React.createElement("span", { className: "cdx-file-path", title: item.path }, shortPathOf(item, store.currentSession)),
				React.createElement("span", { className: "cdx-file-cnt" }, (item.writes > 0 ? "写入×" + item.writes + " " : "") + (item.edits > 0 ? "编辑×" + item.edits : "")),
				React.createElement("span", { className: "cdx-file-stats" },
					React.createElement("span", { className: "cdx-plus", style: { color: colors.addFg } }, "＋" + item.added),
					React.createElement("span", { className: "cdx-minus", style: { color: colors.delFg } }, "－" + item.removed)),
				React.createElement("span", { className: "cdx-chevron" }, expanded ? "▾" : "▸"));
			let body = null;
			if (expanded && detail) {
				body = React.createElement("div", { className: "cdx-file-body" },
					detail.sections.map((sec, i) => React.createElement("div", { key: i, className: "cdx-sec" },
						React.createElement("div", { className: "cdx-sec-head" },
							React.createElement("span", { className: "cdx-sec-tag cdx-sec-" + sec.kind }, sec.kind === "edit" ? "编辑" : "写入"),
							React.createElement("span", { className: "cdx-sec-time" }, fmtTime(sec.at))),
						React.createElement("div", { className: "cdx-diff" },
							sec.hunks.map((h, k) => React.createElement(CodexLine, { key: k, h: h, lang: lang }))))));
			}
			return React.createElement("div", { className: "cdx-file", "data-path": item.path, style: { background: colors.ctxBg } }, head, body);
		}
		function windowList(turn) {
			// Fallback aggregation straight from the parsed window: every op
			// (the window is the newest slice; turn mismatches are tolerated).
			const items = [];
			for (const rec of reviewFiles.values()) {
				let added = 0, removed = 0, writes = 0, edits = 0, at = 0;
				for (const op of rec.ops) {
					if (op.turn !== turn && !(op.turn === 0 || op.turn === undefined)) continue;
					if (op.kind === "edit") { edits++; added += splitLinesL(op.newString || "").length; removed += splitLinesL(op.oldString || "").length; }
					else { writes++; added += splitLinesL(op.content || "").length; }
					at = Math.max(at, op.at || 0);
				}
				if (!(writes + edits)) continue;
				items.push({ path: rec.path, name: displayName(rec.path, rec.cwd), cwd: rec.cwd, ops: writes + edits, writes: writes, edits: edits, added: added, removed: removed, lastTime: at });
			}
			items.sort((x, y) => y.lastTime - x.lastTime);
			return items;
		}
		// ── running-session pill (small "N files changed" chip above input) ──
		function ChangePill() {
			useStore((s) => s.files);
			useStore((s) => s.running);
			const running = useStore((s) => s.running);
			const latestTurn = useStore((s) => s.latestTurn);
			const colors = useStore((s) => s.colors);
			const dark = useStore((s) => s.themeNow) === "dark";
			const items = windowList(latestTurn);
			if (!running || !items.length) return null;
			let added = 0, removed = 0;
			for (const f of items) { added += f.added || 0; removed += f.removed || 0; }
			return React.createElement("div", {
				className: "cdx-pill",
				style: { background: colors.turnBg, borderColor: colors.turnBorder },
				onClick: () => { try { setState({ mode: "latest" }); } catch (e) {} openReviewTab(); },
				title: "打开审查视图"
			},
				React.createElement("span", { className: "cdx-pill-text", style: { color: themeLabel(dark) } }, items.length + " 个文件已更改"),
				React.createElement("span", { className: "cdx-plus", style: { color: colors.turnAdd } }, "+" + added),
				React.createElement("span", { className: "cdx-minus", style: { color: colors.turnDel } }, " −" + removed));
		}
		function ReviewView(props) {
			React.useEffect(() => {
				if (props.sessionId) {
					if (store.currentSession !== props.sessionId) {
						reqSeq++;
						setState({ currentSession: props.sessionId, files: null, selected: null, detail: null, mode: "latest", turnData: null, latestTurn: 0, error: null, loadingFiles: true, reviewTurn: null, reviewFile: null });
					}
					loadSummary();
				}
			}, [props.sessionId]);
			const turnData = useStore((s) => s.turnData);
			const latestTurn = useStore((s) => s.latestTurn);
			const reviewTurn = useStore((s) => s.reviewTurn);
			const reviewFile = useStore((s) => s.reviewFile);
			const files = useStore((s) => s.files);
			const error = useStore((s) => s.error);
			const colors = useStore((s) => s.colors);
			const [expanded, setExpanded] = React.useState({});
			const listRef = React.useRef(null);
			const lastFocus = React.useRef(null);
			// Load the reviewed turn's payload whenever the session, the target
			// turn or the poll tick (files rebuild) changes.
			React.useEffect(() => {
				if (store.currentSession) loadTurn(reviewTurn);
			}, [props.sessionId, reviewTurn, files]);
			// Card jump: expand exactly the chosen file and scroll to it; all
			// other files stay collapsed.
			React.useEffect(() => {
				if (!reviewFile) return;
				const listEl = listRef.current;
				let el = null;
				if (listEl) {
					for (const c of listEl.querySelectorAll(".cdx-file")) {
						if (c.dataset.path === reviewFile) { el = c; break; }
					}
				}
				if (!el) return; // payload not rendered yet — retried on the next tick
				if (lastFocus.current && lastFocus.current.path === reviewFile && lastFocus.current.turn === turnShown) return;
				lastFocus.current = { path: reviewFile, turn: turnShown };
				const n = {};
				n[reviewFile] = true;
				setExpanded(n);
				const top = el.getBoundingClientRect().top - listEl.getBoundingClientRect().top;
				listEl.scrollTop = Math.max(0, listEl.scrollTop + top - 8);
			}, [reviewFile, turnData]);
			const list = (turnData && Array.isArray(turnData.files)) ? turnData.files : [];
			const turnShown = (turnData && typeof turnData.turn === "number") ? turnData.turn : null;
			const total = list.reduce((acc, f) => ({ added: acc.added + (f.added || 0), removed: acc.removed + (f.removed || 0) }), { added: 0, removed: 0 });
			const toggle = (p) => setExpanded((prev) => { const n = Object.assign({}, prev); n[p] = !n[p]; return n; });
			const toggleAll = () => setExpanded((prev) => {
				const all = list.length > 0 && list.every((f) => prev[f.path]);
				const n = {};
				for (const f of list) n[f.path] = !all;
				return n;
			});
			const turnLabel = (reviewTurn != null && Number.isFinite(reviewTurn))
				? (turnShown != null ? "第 " + turnShown + " 轮" : "第 " + reviewTurn + " 轮")
				: "最新一轮";
			return React.createElement("div", { className: "drv-view" },
				React.createElement(TipLayer, null),
				React.createElement("div", { className: "cdx-toolbar" },
					React.createElement("span", { className: "cdx-title" }, "修改审查"),
					React.createElement("span", { className: "cdx-mode-btn" }, turnLabel),
					React.createElement("span", { className: "cdx-stats" },
						React.createElement("span", { className: "cdx-plus", style: { color: colors.addFg } }, "＋" + total.added),
						React.createElement("span", { className: "cdx-minus", style: { color: colors.delFg } }, " －" + total.removed),
						React.createElement("span", { className: "cdx-count" }, " " + list.length + " 文件")),
					React.createElement("span", { className: "cdx-spacer" }),
					React.createElement(Tip, { text: "全部展开/收起" }, React.createElement("button", { className: "cdx-tool-btn", onClick: toggleAll }, "☰")),
					React.createElement(Tip, { text: "刷新" }, React.createElement("button", { className: "cdx-tool-btn", onClick: refresh }, "↻")),
					React.createElement(Tip, { text: "清空记录" }, React.createElement("button", { className: "cdx-tool-btn", onClick: () => { apiClear(store.currentSession).then(() => { setState({ files: [], detail: null, selected: null, turnData: null, latestTurn: 0 }); }); } }, "✕"))),
				error ? React.createElement("div", { className: "cdx-error" }, error) : null,
				React.createElement("div", { className: "cdx-list", ref: listRef },
					list.length === 0 && !error ? React.createElement("div", { className: "cdx-empty" }, "暂无修改记录（进程内通过写入 / 编辑工具产生的文件修改会出现在这里）") : null,
					list.map((f) => React.createElement(CodexFileCard, { key: f.path, item: f, turn: turnShown, expanded: !!expanded[f.path], onToggle: () => toggle(f.path) }))));
		}

		function SettingsPage() {
			const tab = useStore((s) => s.colorTab);
			// themeNow is store-driven (kept in sync by syncThemeColors on every
			// DSH theme switch), so the "（当前 DSH 主题正在使用这套）" note stays
			// live instead of frozen at the last render.
			const themeNow = useStore((s) => s.themeNow);
			return React.createElement("div", { className: "drv-settings-page" },
				React.createElement("p", { className: "drv-settings-desc" },
					"「修改审查」追踪进程内通过写入 / 编辑工具产生的文件修改，并在对话流每轮卡片中展示修改对比。下方可自定义 diff 展示颜色与标签角标颜色：浅色 / 深色两套独立保存，界面会跟随 DSH 主题自动切换使用哪一套（改动即时生效并自动保存）："),
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

		// ── custom tooltip (componentized, follows theme tokens) ─────────────
		// Single global tip state (store.tip) so stale per-instance state can
		// never linger after the host element is replaced by polling rebuilds.
		let tipTimer = null;
		function showTip(text, rect, below) {
			if (tipTimer) { clearTimeout(tipTimer); tipTimer = null; }
			const vw = typeof window !== 'undefined' ? window.innerWidth : 1600;
			const left = Math.min(Math.max(rect.left + rect.width / 2, 230), vw - 230);
			const top = below ? rect.bottom + 14 : Math.max(rect.top - 110, 8);
			setState({ tip: { text: text, top: top, left: left, below: !!below } });
			tipTimer = setTimeout(() => { tipTimer = null; setState({ tip: null }); }, 4000);
		}
		function hideTip() {
			if (tipTimer) { clearTimeout(tipTimer); tipTimer = null; }
			try { setState({ tip: null }); } catch (e) {}
		}
		function Tip({ text, children, below }) {
			if (!text) return children;
			const show = (e) => {
				try { showTip(text, e.currentTarget.getBoundingClientRect(), below); } catch (e2) {}
			};
			const hide = () => hideTip();
			return React.createElement("span", { className: "drv-tip-host", onMouseEnter: show, onMouseLeave: hide, onFocus: show, onBlur: hide }, children);
		}
		function TipLayer() {
			const tip = useStore((s) => s.tip);
			if (!tip) return null;
			return React.createElement("div", {
				className: "drv-tip",
				style: tip.below ? { top: tip.top, left: tip.left, transform: "translate(-50%, 0)" } : { top: tip.top, left: tip.left }
			}, tip.text);
		}
		// ── editor picker: choose the default code editor for「打开文件」 ──────
		// v2: icon route is macOS-only. Fall back to a letter avatar when the
		// route 404s or the transport is unavailable (e.g. Desktop without
		// webServer) — no broken-image flash.
		// v3: letter avatar only — the macOS icon route was removed with the
		// HTTP transport; one cross-platform path for Web + Desktop.
		function EditorIcon({ id, size }) {
			const letter = (String(id || "?").charAt(0) || "?").toUpperCase();
			return React.createElement("span", {
				style: { width: size || 16, height: size || 16, display: "inline-flex", alignItems: "center", justifyContent: "center", borderRadius: 3, flexShrink: 0, background: "rgba(80,120,255,0.2)", color: "inherit", fontSize: Math.max(9, Math.round((size || 16) * 0.6)), fontWeight: 600, verticalAlign: "middle" }
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
			const label = selectedEditor ? "用" + selectedEditor.name + "打开" : "编辑器";
			return React.createElement("div", { className: "drv-editor", ref: rootRef },
				React.createElement(Tip, { text: selectedEditor ? "当前默认编辑器：" + selectedEditor.name + "（点击更换）" : "选择打开文件时使用的代码编辑器" },
					React.createElement("button", {
						type: "button",
						className: "drv-editor-btn",
						onClick: () => setOpen(!open)
					},
						React.createElement("span", { className: "drv-editor-label" },
						editorLoading ? "检测中…" : (selectedEditor ? React.createElement(React.Fragment, null,
							React.createElement(EditorIcon, { id: selectedEditor.id, size: 16 }),
							" " + label) : label)),
					React.createElement("span", { className: "drv-editor-caret" }, open ? "▴" : "▾"))),
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
						React.createElement("span", null, ed.name)))) : null);
		}

		// ── plugin ─────────────────────────────────────────────────────────
		const inject = ["slots", "sessions", "conversation"];
		const CSS = `
.drv-view { flex:1 1 0; min-height:0; overflow:hidden; display:flex; flex-direction:column; padding:12px 14px; box-sizing:border-box; font-size:13px; }
/* Codex-style per-turn card (chat tail) */
.cdx-turn, .cdx-turn *, .cdx-turn-main, .cdx-turn-files, .cdx-turn-file { box-sizing:border-box; }
.cdx-turn { display:flex; flex-direction:column; margin:6px 2px; border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); border-radius:12px; background:var(--dsw-alias-surface-2, #161b22); overflow:hidden; max-width:100%; box-sizing:border-box; cursor:pointer; transition:border-color 0.15s ease, background 0.15s ease; }
.cdx-turn:hover { border-color: rgba(80,120,255,0.75); background:var(--dsw-alias-surface-1, #1c2128); }
.cdx-turn-main { display:flex; align-items:center; gap:12px; width:100%; padding:12px 14px; min-width:0; }
.cdx-turn-icon { flex:none; width:34px; height:34px; border-radius:8px; background:rgba(80,120,255,0.14); display:inline-flex; align-items:center; justify-content:center; }
.cdx-turn-icon .cdx-filetype { width:20px; height:20px; font-size:10px; border-radius:5px; }
.cdx-turn-body { flex:1 1 auto; min-width:0; display:flex; flex-direction:column; gap:3px; }
.cdx-turn-title { font-size:13px; font-weight:600; color:var(--dsw-alias-label-primary, #e6edf3); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.cdx-turn-stats { font-family:ui-monospace,Consolas,monospace; font-size:12px; }
.cdx-turn-time { font-size:11px; color:var(--dsw-alias-label-tertiary, #768390); }
.cdx-turn-actions { flex:none; display:flex; gap:8px; align-items:center; }
.cdx-turn-files { display:flex; flex-direction:column; width:100%; border-top:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.18)); }
.cdx-turn-file { display:grid; grid-template-columns: minmax(0,1fr) auto; align-items:center; column-gap:8px; width:100%; padding:7px 14px; font-size:12px; border:none; background:transparent; color:inherit; font-family:inherit; text-align:left; cursor:pointer; }
.cdx-turn-file:hover { background:rgba(80,120,255,0.10); }
.cdx-turn-file + .cdx-turn-file { border-top:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.1)); }
.cdx-turn-file-name { min-width:0; font-family:ui-monospace,Consolas,monospace; color:var(--dsw-alias-label-primary, #e6edf3); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.cdx-turn-file-stats { font-family:ui-monospace,Consolas,monospace; white-space:nowrap; }
.cdx-turn-empty { cursor:default; }
.cdx-turn-empty:hover { border-color:var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); background:var(--dsw-alias-surface-2, #161b22); }
.cdx-turn-title-muted { opacity:0.55; font-weight:500; }
.cdx-turn-btn { border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); background:transparent; color:var(--dsw-alias-label-primary, #e6edf3); cursor:pointer; border-radius:8px; padding:5px 12px; font-size:12.5px; font-family:inherit; }
.cdx-turn-btn:hover:not(:disabled) { background:rgba(128,128,128,0.14); }
.cdx-turn-btn:disabled { opacity:0.45; cursor:default; }
/* running-session pill */
.cdx-pill { display:inline-flex; align-items:center; gap:6px; align-self:center; margin:4px 0; padding:5px 14px; border-radius:999px; border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); background:var(--dsw-alias-surface-2, #161b22); font-size:12px; cursor:pointer; transition:border-color 0.15s ease; }
.cdx-pill:hover { border-color: rgba(80,120,255,0.75); }
.cdx-pill-text { color:var(--dsw-alias-label-primary, #e6edf3); }
.cdx-bar { display:flex; align-items:center; gap:10px; width:auto; max-width:100%; margin:6px 0 0; padding:8px 12px; border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3)); border-radius:10px; background:var(--dsw-alias-surface-2, #161b22); font-size:12.5px; box-sizing:border-box; }
.cdx-bar-body { flex:1 1 auto; min-width:0; display:flex; flex-direction:column; gap:2px; }
.cdx-bar-title { font-weight:600; color:var(--dsw-alias-label-primary, #e6edf3); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.cdx-bar-stats { font-family:ui-monospace,Consolas,monospace; font-size:12px; }
.cdx-toolbar { display:flex; align-items:center; gap:8px; padding:2px 0 10px; border-bottom:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25)); flex-wrap:wrap; }
.cdx-title { font-weight:600; color:var(--dsw-alias-label-primary, #e6edf3); }
.cdx-mode { display:flex; gap:4px; }
.cdx-mode-btn { border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); background:transparent; color:var(--dsw-alias-label-secondary, #adbac7); cursor:pointer; border-radius:6px; padding:2px 10px; font-size:12px; }
.cdx-mode-btn.cdx-active { background:rgba(80,120,255,0.22); border-color:rgba(80,120,255,0.6); color:var(--dsw-alias-label-primary, #e6edf3); }
.cdx-stats { display:inline-flex; gap:6px; font-family:ui-monospace,Consolas,monospace; font-size:12px; margin-left:4px; }
.cdx-plus { color:#7ee787; }
.cdx-minus { color:#ffa198; }
.cdx-count { color:var(--dsw-alias-label-tertiary, #768390); }
.cdx-spacer { flex:1; }
.cdx-tool-btn { border:none; background:transparent; color:var(--dsw-alias-label-secondary, #adbac7); cursor:pointer; font-size:14px; padding:2px 6px; border-radius:6px; }
.cdx-tool-btn:hover { background:rgba(128,128,128,0.15); }
.cdx-error { margin:8px 0 0; padding:8px 10px; border:1px dashed rgba(255,120,120,0.5); border-radius:6px; font-size:12px; color:var(--dsw-alias-label-secondary, #adbac7); }
.cdx-list { flex:1; min-height:0; overflow:auto; display:flex; flex-direction:column; gap:10px; margin-top:10px; padding-bottom:8px; }
/* The file header itself is sticky inside the scrolling list: the header of
   the file being browsed never scrolls away — the next file's header slides
   in and takes over as the user scrolls past it. Clicking collapses/expands. */
.cdx-file { border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3)); border-radius:8px; background:var(--dsw-alias-surface-2, #161b22); flex-shrink:0; }
.cdx-file-head { display:flex; align-items:center; gap:8px; width:100%; padding:8px 10px; border:none; background:inherit; color:inherit; cursor:pointer; font-family:inherit; font-size:12.5px; text-align:left; position:sticky; top:0; z-index:5; border-radius:8px 8px 0 0; }
.cdx-filetype { flex:none; width:17px; height:17px; border-radius:4px; color:#fff; font-size:8.5px; font-weight:700; letter-spacing:-0.2px; display:inline-flex; align-items:center; justify-content:center; font-family:ui-monospace,Consolas,monospace; text-shadow:0 1px 1px rgba(0,0,0,0.4); box-shadow:inset 0 0 0 1px rgba(255,255,255,0.14), 0 1px 2px rgba(0,0,0,0.3); padding:0 1px; }
.cdx-file-head:hover { background-image:linear-gradient(rgba(128,128,128,0.10), rgba(128,128,128,0.10)); }
.cdx-empty { padding:28px; text-align:center; color:var(--dsw-alias-label-tertiary, #768390); font-size:13px; line-height:1.7; }
.cdx-file-path { flex:1 1 auto; min-width:0; font-family:ui-monospace,Consolas,monospace; font-size:12px; word-break:break-all; color:var(--dsw-alias-label-primary, #e6edf3); }
.cdx-file-cnt { flex:none; font-size:11px; color:var(--dsw-alias-label-tertiary, #768390); white-space:nowrap; }
.cdx-file-stats { flex:none; font-family:ui-monospace,Consolas,monospace; font-size:12px; white-space:nowrap; }
.cdx-chevron { flex:none; color:var(--dsw-alias-label-tertiary, #768390); font-size:11px; }
.cdx-file-body { border-top:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25)); }
.cdx-sec { border-bottom:1px solid rgba(128,128,128,0.12); }
.cdx-sec:last-child { border-bottom:none; }
.cdx-sec-head { display:flex; align-items:center; gap:8px; padding:5px 10px; background:rgba(128,128,128,0.06); font-size:12px; }
.cdx-sec-tag { padding:0 6px; border-radius:6px; font-size:10px; font-weight:600; }
.cdx-sec-edit { background:rgba(9,105,218,0.25); color:#79b8ff; }
.cdx-sec-write { background:rgba(46,160,67,0.22); color:#7ee787; }
.cdx-sec-time { color:var(--dsw-alias-label-tertiary, #768390); }
.cdx-diff { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12px; line-height:1.6; padding:4px 0 6px; }
.cdx-line { display:flex; padding:0 10px; white-space:pre-wrap; word-break:break-word; }
.cdx-line.cdx-add { background:linear-gradient(90deg, rgba(46,160,67,0.14), rgba(46,160,67,0.02) 55%, transparent); }
.cdx-line.cdx-del { background:linear-gradient(90deg, rgba(248,81,73,0.14), rgba(248,81,73,0.02) 55%, transparent); }
.cdx-gutter { flex:0 0 40px; text-align:right; padding-right:8px; user-select:none; color:var(--dsw-alias-label-tertiary, #768390); }
.cdx-sign { flex:0 0 16px; user-select:none; }
.cdx-add .cdx-sign { color:#7ee787; }
.cdx-del .cdx-sign { color:#ffa198; }
.cdx-text { flex:1 1 auto; min-width:0; color:var(--dsw-alias-label-primary, #e6edf3); }
/* syntax token colors (GitHub-dark-ish, works on both diff tones) */
.cdx-tok-kw { color:#ff7b72; }
.cdx-tok-str { color:#a5d6ff; }
.cdx-tok-com { color:#8b949e; font-style:italic; }
.cdx-tok-num { color:#79c0ff; }
.drv-tip-host { display:inline-flex; min-width:0; }
.drv-tip { position:fixed; transform:translate(-50%,-100%); max-width:420px; max-height:220px; overflow:auto; padding:8px 10px; border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.45)); border-radius:8px; background:var(--dsw-alias-surface-2, #22272e); color:var(--dsw-alias-label-primary, #e6edf3); font-size:12px; line-height:1.5; box-shadow:0 6px 18px rgba(0,0,0,0.35); z-index:30000; pointer-events:none; white-space:normal; word-break:break-word; text-align:left; }
/* themed text selection: the Chromium default is pale (white-ish) on dark,
   which reads as floating white cards over diff lines — pin it to the theme. */
.drv-view ::selection, .drv-turn ::selection { background: var(--dsw-alias-state-primary-soft, rgba(80,120,255,0.4)); color: inherit; }
.drv-view ::-moz-selection, .drv-turn ::-moz-selection { background: var(--dsw-alias-state-primary-soft, rgba(80,120,255,0.4)); color: inherit; }
.drv-view-header { display:flex; align-items:center; gap:8px; padding:4px 0 10px; border-bottom:1px solid rgba(128,128,128,0.3); }
.drv-title { font-weight:600; }
.drv-count { opacity:0.7; font-size:12px; }
.drv-header-spacer { flex:1; }
.drv-btn { border:none; background:rgba(128,128,128,0.12); color:inherit; cursor:pointer; border-radius:6px; padding:4px 8px; font-size:12px; }
.drv-btn:hover { background:rgba(128,128,128,0.25); }
.drv-view-body { flex:1; display:flex; min-height:0; margin-top:10px; border:1px solid rgba(128,128,128,0.3); border-radius:8px; overflow:hidden; }
.drv-filelist { width:250px; border-right:1px solid rgba(128,128,128,0.3); overflow:auto; overscroll-behavior:contain; flex-shrink:0; padding:6px 0; }
.drv-file { display:flex; align-items:center; gap:6px; width:100%; padding:6px 10px; cursor:pointer; border:none; background:transparent; color:inherit; text-align:left; font-family:inherit; font-size:12.5px; }
.drv-file:hover { background:rgba(128,128,128,0.12); }
.drv-file.drv-selected { background:rgba(80,120,255,0.18); }
.drv-file-name { font-weight:500; word-break:break-all; }
.drv-file-meta { font-size:11px; opacity:0.75; white-space:nowrap; }
.drv-detail { flex:1; overflow:auto; overscroll-behavior:contain; padding:10px; }
.drv-section { margin-bottom:12px; border:1px solid rgba(128,128,128,0.35); border-radius:6px; overflow:hidden; }
.drv-section-head { padding:6px 10px; font-weight:600; background:rgba(128,128,128,0.1); display:flex; gap:8px; align-items:center; }
.drv-section-time { font-weight:400; opacity:0.7; font-size:11px; }
.drv-badge { display:inline-block; padding:0 6px; border-radius:8px; font-size:10px; font-weight:600; }
.drv-badge-new { background:rgba(46,160,67,0.22); color:#1a7f37; }
.drv-badge-edit { background:rgba(9,105,218,0.16); color:#0969da; }
.drv-line { display:flex; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12px; line-height:1.55; position:relative; }
.drv-gutter { flex:0 0 42px; text-align:right; padding:0 6px; user-select:none; opacity:0.9; position:relative; z-index:1; flex-shrink:0; }
.drv-gutter-sign { flex:0 0 18px; text-align:center; padding:0 2px; flex-shrink:0; }
.drv-text { flex:1 1 auto; min-width:0; padding:0 6px; white-space:pre-wrap; word-break:break-word; position:relative; z-index:1; }
.drv-empty { padding:24px; text-align:center; opacity:0.6; }
.drv-settings { border-top:1px solid rgba(128,128,128,0.3); padding:6px 0 0; margin-top:10px; }
.drv-settings-toggle { border:none; background:transparent; color:inherit; cursor:pointer; font-size:12px; padding:4px 0; }
.drv-settings-body { margin-top:6px; }
.drv-color-row { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:3px 0; font-size:12px; }
.drv-color-tabs { display:flex; gap:6px; align-items:center; margin:0 0 10px; flex-wrap:wrap; }
.drv-color-tab { border:1px solid rgba(128,128,128,0.4); background:transparent; color:inherit; cursor:pointer; border-radius:6px; padding:3px 12px; font-size:12px; }
.drv-color-tab.drv-color-tab-active { background:rgba(80,120,255,0.25); border-color:rgba(80,120,255,0.6); }
.drv-color-now { font-size:11px; opacity:0.6; }
.drv-color-row input[type=color] { width:38px; height:24px; border:none; border-radius:4px; padding:0; background:transparent; cursor:pointer; }
.drv-color-controls { display:flex; align-items:center; gap:6px; }
.drv-color-controls input[type=range] { width:76px; accent-color:var(--dsw-alias-state-business-primary, #4493f8); }
.drv-color-alpha { font-size:11px; opacity:0.7; min-width:34px; text-align:right; }
.drv-presets { display:flex; gap:6px; margin-top:8px; }
.drv-presets button { border:1px solid rgba(128,128,128,0.4); background:transparent; color:inherit; cursor:pointer; border-radius:6px; padding:3px 8px; font-size:11px; }
.drv-presets button:hover { background:rgba(128,128,128,0.15); }
.drv-settings-page { padding:16px; font-size:13px; }
.drv-settings-desc { opacity:0.7; margin:0 0 14px; line-height:1.6; }
.drv-detail-toolbar { display:flex; align-items:center; gap:8px; margin-bottom:10px; }
.drv-detail-path { font-size:12px; opacity:0.8; word-break:break-all; }
.drv-btn-revert { font-size:11px; padding:2px 8px; }
.drv-btn-danger { color:#cf222e; }
.drv-notice { font-size:12px; color:#1a7f37; background:rgba(46,160,67,0.15); border-radius:6px; padding:3px 8px; }
.drv-mode { display:flex; gap:4px; }
.drv-mode-btn { border:1px solid rgba(128,128,128,0.4); background:transparent; color:inherit; cursor:pointer; border-radius:6px; padding:2px 8px; font-size:11px; }
.drv-mode-btn:hover { background:rgba(128,128,128,0.12); }
.drv-mode-btn.drv-mode-active { background:rgba(80,120,255,0.25); border-color:rgba(80,120,255,0.6); }
.drv-turn { border:1px solid rgba(128,128,128,0.3); border-radius:8px; padding:6px 10px; font-size:12px; }
.drv-turn-produced { display:flex; align-items:center; gap:6px; flex-wrap:wrap; padding:0 0 6px; }
.drv-turn-produced-label { font-size:11px; opacity:0.7; }
.drv-turn-produced-chip { border:1px solid rgba(128,128,128,0.35); background:transparent; color:inherit; cursor:pointer; border-radius:10px; padding:1px 8px; font-size:11px; font-family:inherit; }
.drv-turn-produced-chip:hover { background:rgba(128,128,128,0.12); }
.drv-turn-head { display:flex; align-items:center; gap:8px; padding:2px 0 6px; }
.drv-turn-title { font-weight:600; }
.drv-turn-hint { font-size:11px; opacity:0.6; }
.drv-turn-file { border-top:1px solid rgba(128,128,128,0.15); }
.drv-turn-file-head { display:flex; align-items:center; gap:8px; width:100%; padding:5px 0; border:none; background:transparent; color:inherit; cursor:pointer; font-family:inherit; font-size:12px; text-align:left; }
.drv-turn-file-name { font-weight:500; word-break:break-all; }
.drv-turn-chevron { opacity:0.6; }
.drv-turn-file-body { padding:2px 0 8px; }
.drv-turn-file-body .drv-section { margin-bottom:8px; }
.drv-tab-label { display:inline-flex; align-items:center; gap:6px; }
.drv-tab-badge { display:inline-block; border-radius:8px; padding:0 5px; font-size:10px; line-height:14px; font-weight:600; min-width:16px; text-align:center; }
.drv-ctx { position:fixed; z-index:20000; min-width:150px; padding:4px; border:1px solid rgba(128,128,128,0.45); border-radius:8px; background:var(--dsw-alias-surface-2, #22272e); box-shadow:0 6px 18px rgba(0,0,0,0.35); }
.drv-ctx-item { display:block; width:100%; border:none; background:transparent; color:inherit; text-align:left; padding:6px 10px; border-radius:6px; font-size:12px; font-family:inherit; cursor:pointer; }
.drv-ctx-item:hover { background:rgba(80,120,255,0.28); }
.drv-editor { position:relative; display:inline-flex; }
.drv-editor-btn { display:inline-flex; align-items:center; gap:4px; height:32px; padding:0 10px; border:1px solid rgba(128,128,128,0.35); background:transparent; color:inherit; cursor:pointer; border-radius:18px; font-size:12px; font-family:inherit; }
.drv-editor-btn:hover { background:rgba(128,128,128,0.14); }
.drv-editor-label { max-width:110px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.drv-editor-caret { opacity:0.7; font-size:10px; flex:none; }
.drv-editor-menu { position:absolute; top:calc(100% + 4px); right:0; z-index:20000; min-width:170px; padding:4px; border:1px solid rgba(128,128,128,0.45); border-radius:8px; background:var(--dsw-alias-surface-2, #22272e); box-shadow:0 6px 18px rgba(0,0,0,0.35); max-height:260px; overflow:auto; }
.drv-editor-opt { display:block; width:100%; border:none; background:transparent; color:inherit; text-align:left; padding:6px 10px; border-radius:6px; font-size:12px; font-family:inherit; cursor:pointer; white-space:nowrap; }
.drv-editor-opt:hover { background:rgba(128,128,128,0.16); }
.drv-editor-opt.drv-editor-opt-active { background:rgba(80,120,255,0.28); }
.drv-editor-empty { padding:6px 10px; font-size:12px; opacity:0.6; }
`;
		function apply(ctx) {
			ctxRef = ctx;
			connRef = ctx.get("connection");
			ctx.effect(() => {
				const el = document.createElement("style");
				el.textContent = CSS;
				document.head.appendChild(el);
				return () => el.remove();
			}, "diff-review: styles");
			loadEditors();
			refreshFromServer();
			ctx.effect(connectEvents, "diff-review: live refresh");
			ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register(
				{ name: "conversation.session.header.utilities", id: "diff-review-editor", order: -1 },
				(props) => React.createElement(EditorPicker, props)));
			ctx.slots.inject("conversation.view", () => ctx.slots.register(
				{
					name: "conversation.view", id: "review", order: 5,
					label: () => React.createElement(TabLabel, null)
				},
				(props) => React.createElement(ReviewView, props)));
			ctx.slots.inject("conversation.chat.turnTail", () => ctx.slots.register(
				{ name: "conversation.chat.turnTail", priority: -1, select: (owner) => (owner && owner.turn && owner.turn.turn != null ? { turn: owner.turn.turn } : null) },
				(props) => React.createElement(TurnReview, props)));
			ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register(
				{ name: "conversation.composer.dock", id: "diff-review-pill", order: 999 },
				(props) => React.createElement(ChangePill, props)));
			ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register(
				{ name: "conversation.session.header.actions", id: "diff-review-session", order: 100 },
				(props) => React.createElement(SessionProbe, props)));
			ctx.slots.inject("settings.section", () => ctx.slots.register(
				{ name: "settings.section", id: "diff-review", order: 25, label: "修改审查" },
				(props) => React.createElement(SettingsPage, props)));
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register(
				{ name: "sidebar.footer.action", id: "diff-review" },
				() => null));
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});