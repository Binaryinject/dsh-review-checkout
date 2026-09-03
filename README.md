# dsh-review-checkout

File-change review for [DeepSeek Harness](https://github.com/deepseek-ai/dsh) (DSH) sessions — a hardened, Codex-style rewrite of `cirelir/dsh-change-review` for DSH Desktop and `dsh --profile web`.

Every file the agent writes or edits inside a session is tracked and surfaced as:

- **Codex-style per-turn cards** at the tail of each turn — file-type badge, `＋N −M` stats, timestamp, plus a file list with per-file stats (relative paths), one-click jump to the review tab
- **A review tab** (conversation view) aggregating the **latest turn** — file cards with line numbers, `+ / −` prefixes, edge color bars and **syntax highlighting** (JS/TS/JSON/C++/Python/YAML/Shell/CMake… auto-detected by extension)
- **A live pill** above the composer while the session is running — `N 个文件已更改 ＋X −X` (auto-hides when idle)
- **Theme-aware theming** — light/dark color presets stored independently, auto-follows the DSH theme; custom tooltips and text selection styled with DSH design tokens

## Installation

```bash
dsh plugin add dsh-review-checkout
```

Then make sure the bundle patch is present in your profile (`~/.dsh/profiles/<profile>/cordis.patch.yml`):

```yaml
- insert:
    - id: diff-review
      name: 'dsh-review-checkout'
```

**Restart DSH Desktop** (or `dsh --profile web`) after a host-side change. Client-side changes only need a page refresh.

## Features

| Area | Detail |
|---|---|
| Data channel | Official `session/follow` + `session/page` RPC via the DSH transport (RPC fetch on web, IPC bridge on Desktop) — no self-built HTTP routes; works in the layered Desktop composition |
| Per-turn cards | Latest turn only: `已编辑 client.js 等 2 个文件 ＋N −M`, file list with per-file stats (relative paths, full path on hover), `撤销` (Web composition only), `审核` jumps to the review tab; clicking the card anywhere jumps too |
| Review tab | Latest-turn aggregation: file cards → expandable syntax-highlighted diffs (hunks, line numbers, `+ / −`), expand/collapse all, refresh, clear |
| Live refresh | Polls every 5 s; running-status pill and theme sync included |
| Colors | Two independent presets (light/dark, 12 colors each) with a tab switcher in **设置 → 修改审查**; auto-switches with the DSH theme; CSS `::selection` follows the theme |
| Revert | Per-op and whole-file revert (busy-guarded, confirmation dialog) — requires the `webServer`-hosted channel, so it works on `dsh --profile web`; hidden on Desktop where the channel is not mounted |
| Misc | Editor picker (session header), custom themed tooltips, path-aware display, atomic state writes |

## Configuration

- **设置 → 修改审查**: light/dark tabs, 12 colors each (add/del backgrounds & text, context rows, gutters, tab badge), preset buttons, persisted in `localStorage`
- State file: `~/.dsh/profiles/<profile>/diff-review-state.json` (delete to reset recorded history)

## Architecture

- `lib/index.js` (host): records `write`/`edit` tool calls into per-session state; exposes agent API helpers; atomic JSON state persistence
- `lib/client.js` (client): loads session history through the official channel (`session/follow` snapshot + `session/page` paging), parses `tool/call` / `tool/result` into review records, renders the Codex-style UI
- Third-party constraints honored: no private-layer services (`webServer`, `connection` proxies), no cross-fiber RPC interception — only official slot registrations and the history API

## Compatibility

- ✅ DSH Desktop (layered scope — renderer + official slots)
- ✅ `dsh --profile web` (full revert available)
- ⚠️ Revert on Desktop is disabled by design (the private web-app layer owns `webServer`)

## Development

```bash
pnpm install
pnpm test        # 24 unit + smoke tests
```

The client bundle is loaded by DSH's `client-modules`; host changes need a Desktop restart, client changes only a page refresh.

## Credits

Inspired by [cirelir/dsh-change-review](https://github.com/cirelir/dsh-change-review). Built on community findings around the official session-history channel.

## License

MIT
