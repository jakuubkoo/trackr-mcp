# trackr-mcp

MCP server for the ForexTrackr read-only API. On startup it loads the API's public OpenAPI spec
(`/api/public/docs.json`) and exposes every operation your API key may call as a tool
(account lookup, current session, dashboard, executive, operations, payments, retention, sales, management).

Get an API key from a ForexTrackr admin (Admin Settings > User Management > API Keys). Tools outside
the key's scopes answer 401.

## Install (Claude Code plugin)

Requires Node.js 20+. In Claude Code:

```
/plugin marketplace add jakuubkoo/trackr-mcp
/plugin install trackr@forextrackr
```

Claude Code asks for your ForexTrackr address and API key when the plugin is enabled (firm 1, plus an optional
firm 2) and keeps the keys in the system keychain (`~/.claude/.credentials.json` on Linux). Change them later with
`/plugin configure trackr@forextrackr`, then restart Claude Code. Updates: `/plugin marketplace update forextrackr`.

## Several firms

Each firm is a ForexTrackr instance with its own address and key. Ask Claude "which firms do I have?" or "switch
to firm2": the `switch_firm` tool lists the firms and switches every tool to another one; the choice is kept
across restarts. More firms than the two in the plugin settings: "log in to firm3 at https://... with trk_..."
(the `login` tool saves it under that name), `logout` forgets one.

### Claude Desktop or without the plugin

Clone the repository and point the client at `dist/index.js` (no `npm install` needed):

```json
{
  "mcpServers": {
    "trackr": { "command": "node", "args": ["/path/to/trackr-mcp/dist/index.js"] }
  }
}
```

## Development

`npm install`, edit `index.js`, then `npm run build` and commit `dist/index.js` with it (the plugin runs the bundle).

## Sign in without the plugin

Claude Desktop or a cloned copy: tell Claude "log in to ForexTrackr at https://... with trk_..." once. The
`login` tool checks the key and saves it with the address in `~/.config/trackr-mcp/config.json` (readable only
by you); `logout` deletes the key. `TRACKR_FIRM1_URL` / `TRACKR_FIRM1_API_KEY` (and
`FIRM2`) environment variables work too; `TRACKR_URL` / `TRACKR_API_KEY` set firm1.

Dates are `YYYY-MM-DD`, and `to` includes its own day. Some tools are precomputed once a night and answer only
the preset ranges their description lists.

The `overrides` table in `index.js` corrects the generated tools: it hides misleading or duplicate ones (the
`*_all` concatenations, the 5 MB balances list, leverage distribution), drops ignored parameters, trims large
payloads and says in each description whose P&L a figure is (broker or client).

## License

MIT
