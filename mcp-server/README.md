# page-screenshot-mcp

MCP bridge for **[Page Screenshot Pro](https://chromewebstore.google.com/detail/page-screenshot-pro/bjmglonhfpengikcjhcajojcdadggjkb)** — lets Claude Desktop, Cursor, Claude Code (or any MCP client) drive the Chrome extension's screenshot tools.

**Nothing is uploaded.** This package is a bridge and nothing else: it opens a WebSocket on `127.0.0.1` that the extension dials into, and image bytes travel from your browser to your AI client over that loopback socket. There is no account, no analytics, and no server.

---

## Install

Two pieces, and you need both:

1. **The Chrome extension** — [install from the Chrome Web Store](https://chromewebstore.google.com/detail/page-screenshot-pro/bjmglonhfpengikcjhcajojcdadggjkb) (Chrome 116+), then open its **Settings → AI / MCP access** and tick the checkbox. The card shows a token and a ready-made JSON block.
2. **This package** — you do not install it by hand. Your MCP client runs it with `npx`, which fetches it on first launch and caches it after that.

Node **≥ 20** is required.

## Configure your client

The extension's settings card generates exactly this, with your own token filled in — copy it rather than typing it:

```json
{
  "mcpServers": {
    "page-screenshot": {
      "command": "npx",
      "args": ["-y", "page-screenshot-mcp"],
      "env": { "PSP_MCP_TOKEN": "…" }
    }
  }
}
```

Then restart the client. The status dot on the extension's card turns green once the bridge connects.

> **`PSP_MCP_TOKEN` comes from the environment, never from a command-line argument.** A token passed as `argv` is visible in `ps` to every user on the machine. If the variable is missing or malformed the process exits immediately with an explanation on stderr.

## Tools

Eight tools. `psp_status` works on the free tier; the rest need Pro.

| Tool | What it does | Tier |
|---|---|---|
| `psp_status` | Connection and licence state, and which tools are available. **Call this first when something fails.** | Free |
| `capture_visible` | The active tab's visible area | Pro |
| `capture_full_page` | The whole scrollable page, stitched. Slower on long pages | Pro |
| `capture_element` | One element, chosen by CSS selector (first match) | Pro |
| `ocr_capture` | OCR over the visible area, or one element when a selector is given | Pro |
| `history_list` | Recent screenshots: id, kind, size, timestamp. No images | Pro |
| `history_get` | One stored screenshot by id, as an image | Pro |
| `export_pdf` | One stored screenshot rendered to a single-page PDF | Pro |

Captures run through the extension's normal pipeline, so the daily quota, `file://` permission, infinite-scroll expansion, lazy-image preloading and seam correction all apply exactly as they do for a click.

## `needs_user_gesture` — read this before filing a bug

Chrome requires a **real user click** before a page can be captured. An AI-initiated call has no click, so:

- If you just opened a tab and immediately asked the AI to screenshot it, the call fails with `needs_user_gesture`.
- **Click the extension's toolbar icon once** (or press `Alt+Shift+D`, which starts a full-page capture), then let the AI retry. It will work.

This is a browser rule, not a defect, and no amount of extension code can bypass it without asking for `<all_urls>` — which this extension deliberately does not do.

## Security model

| Concern | Mitigation |
|---|---|
| Another program on the LAN reaching the port | The server binds **`127.0.0.1` only** |
| A web page you visit connecting to the port | Non-extension `Origin` headers are rejected with close code `4003` |
| A leaked token | 128-bit random, stored in `storage.local` (never synced), one-click reset in settings which disconnects immediately |
| The bridge being used to smuggle code | **No `execute_script`-class tool exists.** No tool accepts a script, an expression, or a URL to navigate to. `capture_element` takes a CSS selector and nothing else — a Chrome Web Store Remote Hosted Code requirement, and a permanent non-goal |
| Screenshots of things you did not mean to share | Captures are always of the **active tab**, which you can see |

The free/Pro gate lives in the extension, not here — the bridge only forwards, so editing this package's source cannot unlock Pro.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Client says the server failed to start; stderr mentions `PSP_MCP_TOKEN` | The `env` block is missing or the token doesn't match. Re-copy the JSON from the settings card. |
| `extension_not_connected` | The extension is not running, the MCP toggle is off, or an older Chrome. Open the settings card and check the status dot. |
| `needs_user_gesture` | See above — click the extension icon. |
| `pro_required` | Pro-only tool on the free tier. `psp_status` stays free so the AI can tell you this itself. |
| Only one client connects at a time | v1 limitation: the bridge binds the first free port in `39127–39137` and the extension dials the first one that answers. |
| Ports all taken | Another bridge is still running. Both are exited by their client; check `ps` for a stray `page-screenshot-mcp`. |

Logs go to **stderr only** — stdout carries the MCP protocol, and a stray write there corrupts the JSON-RPC stream.

## Links

- Product site: <https://screenshotpro.agentsblockchains.com/>
- Support and issue reporting: <https://screenshotpro.agentsblockchains.com/support/>
- Privacy policy: <https://screenshotpro.agentsblockchains.com/privacy/>

## License

MIT — see [LICENSE](./LICENSE).
