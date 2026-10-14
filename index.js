#!/usr/bin/env node
// MCP server for the ForexTrackr read-only API: one tool per operation of the public OpenAPI spec,
// loaded at startup, so the tools always match the API. The key comes from the plugin's settings
// (TRACKR_API_KEY), or from the "login" tool, which keeps it in ~/.config/trackr-mcp/config.json (mode 600).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const config_file = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'trackr-mcp', 'config.json');
const public_headers = { Accept: 'application/json', 'User-Agent': 'trackr-mcp/1.0' };

let saved = {};
try
{
    saved = JSON.parse(readFileSync(config_file, 'utf8'));
}
catch
{
    // Not signed in yet.
}

// The plugin's userConfig (passed as env) wins over a chat login; an unset option may arrive unexpanded.
const env_url = /\$\{/.test(process.env.TRACKR_URL ?? '') ? '' : process.env.TRACKR_URL;
const env_key = /\$\{/.test(process.env.TRACKR_API_KEY ?? '') ? '' : process.env.TRACKR_API_KEY;
let base_url = normalize_url(env_url || saved.url || '');
let api_key = env_key || saved.api_key || '';

/** @type {Map<string, {method: string, path: string, params: object[], body_fields: string[], tool: object}>} */
let tools = new Map();
let spec_error = '';

const auth_tools = [
    {
        name: 'login',
        description: 'Sign in to ForexTrackr with an API key (trk_..., an admin creates it in Admin Settings > User Management > API Keys). '
            + 'The key and URL are checked and saved on this computer, so this is needed only once.',
        inputSchema: {
            type: 'object',
            properties: {
                api_key: { type: 'string', description: 'The API key, starting with trk_' },
                url: { type: 'string', description: 'The ForexTrackr address, e.g. https://trackr.example.com (needed the first time)' },
            },
            required: ['api_key'],
        },
    },
    { name: 'logout', description: 'Forget the saved ForexTrackr API key.', inputSchema: { type: 'object', properties: {} } },
];

// Corrections to the generated tools, from a review of every endpoint (2026-10-14): tools that mislead are
// hidden, ignored params dropped, payloads trimmed, and each figure says whose P&L it is.
const hidden = new Set([
    'dashboard_account_balances_list', // 5 MB, every client with e-mail; dashboard_account_balances has the totals
    'executive_retention_rate', // same figures as payments_deposit_withdrawal_ratio
    'payments_avg_deposit_by_type', // same as sales_avg_deposit_size, but counts failed deposits too
    'operations_leverage_distribution', // derives leverage from raw MT5 volume: everything lands in 1:500+
    'executive_all', 'operations_all', 'payments_all', 'retention_all', 'sales_all', // concatenations of the single tools
]);

const broker_view = 'Broker view: positive = the broker earned (clients lost), negative = the broker lost (clients won).';
const client_view = 'Client view: negative = clients lost money (the broker earned).';
const cache_note = 'Precomputed once a night (about 00:30 server time, UTC+3), so it answers only these ranges, with to = today '
    + '(server date): from = today, from = to = yesterday, from = Monday of this week, the 1st of this month, the 1st of this quarter, '
    + 'January 1st, or today minus 7, 30 or 90 days. Today\'s trading is not included. Other ranges have no data.';
const active_note = (definition) => `Active traders here: ${definition}. The tools count "active" differently; `
    + 'operations_total_trades.unique_traders (accounts with at least one buy/sell deal) is the main figure.';
const periods = ['today', 'yesterday', 'this_week', 'this_month', 'mtd', 'qtd', 'ytd', 'trailing_7', 'trailing_30', 'trailing_90'];
const period_param = { period: { type: 'string', enum: periods, default: 'this_month', description: 'Time period' } };
const today = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
const current_state = { drop_params: ['from', 'to'], fixed: () => ({ from: today(), to: today() }),
    note: 'Current state, not tied to a period.', shape: (d) => omit(d, ['period_from', 'period_to']) };

/**
 * @type {Object<string, {note?: string, drop_params?: string[], params?: object, fixed?: function(): object,
 *     to_next_day?: boolean, shape?: function(*, object): *}>}
 */
const overrides = {
    current_session_summary: {
        note: `${broker_view} sessionRealizedPnl includes pnlCorrections, sessionTotalPnl does not. sessionUnrealizedPnl is the full `
            + 'floating P&L of open B-Book positions now (not the change since the session start). A = A-Book, B = B-Book.',
        shape: (d) => omit(d, Object.keys(d).filter((k) => /^(dd|raw|unrealized)|Raw$|^changeUnrealizedPnl$/.test(k))),
    },
    current_session_pnl_trend: {
        note: broker_view,
        shape: (d) => ({ ...d, points: d.points.filter((p, i, all) => i === all.length - 1 || bucket(p) !== bucket(all[i - 1] ?? {})) }),
    },
    current_session_pnl_details: { note: `${broker_view} The breakdowns don't add up to totalPnl: take the total from current_session_summary.` },
    current_session_daily_pnl_trend: { note: `${broker_view} Closed days only; today is in current_session_summary.` },
    current_session_winners_losers: {
        note: `${broker_view} So "winners" are accounts the broker earned on (the client lost), "losers" accounts the broker lost on `
            + '(the client won). session_pnl = realized + change of floating since the session start + commission + swap.',
        drop_params: ['minSessionPnL', 'groupFilter'],
        shape: (d) => omit(d, ['logins']),
    },
    current_session_top_symbols_volumes_buyers_sellers: {
        note: 'The symbol must match exactly; variants such as XAUUSD, XAUUSD.n and XAUUSD.p are separate symbols.',
        params: { top: { type: 'integer', default: 10, description: 'How many top buyers and sellers to return (default 10)' } },
        fixed: () => ({ top: 10 }),
    },
    dashboard_summary: {
        note: 'Broker profit for the range. percentageChanges compare with the previous range of the same length; their sign says '
            + 'whether the figure went up, not whether that is good.',
        to_next_day: true,
        shape: (d, args) =>
        {
            const { realizedProfit, ...summary } = d.summary;
            const changes = Object.fromEntries(Object.entries(summary.percentageChanges ?? {})
                .filter(([k]) => k !== 'realizedProfit').map(([k, v]) => [k, v && num(v.value)]));
            return { ...d, to: args.to ?? d.to, summary: { ...numbers(summary), percentageChanges: changes } };
        },
    },
    dashboard_account_groups_list: {
        note: 'profit is the broker\'s profit. bookType is unreliable (taken from one account of the group): the group name says '
            + 'A-Book or B-Book.',
        to_next_day: true,
    },
    dashboard_monthly_financial_data: { note: 'Months before the trading data starts (2025-11) show 0 for every trading figure.' },
    account_lookup_by_login: { shape: (d) => tidy_accounts(d) },
    account_lookup_by_email: { shape: (d) => tidy_accounts(d) },
    account_lookup_by_cid_ip: { shape: (d) => tidy_accounts(d) },
    account_lookup_client_overview: {
        note: 'Demo accounts are left out of every figure unless include_demo is true (demo_accounts says how many there are). '
            + 'profit is the client\'s own P&L. MT5 deposits count from 2025-11-01 per account; '
            + 'crm deposits are all deposits of the e-mail.',
    },
    account_lookup_client_overview_activity: {
        note: 'trades holds the 50 newest trades; by_symbol sums the newest trades the API returns (at most 1000, count in '
            + 'by_symbol_trades), statistics_by_currency covers all trades. profit is the client\'s own P&L.',
        shape: (d) => activity(d),
    },
    executive_active_traders_snapshot: { note: 'Counts accounts that are not archived, NOT accounts with an open position.' },
    management_active_accounts: { note: 'Counts accounts that are not archived, NOT accounts with an open position.', params: period_param,
        shape: (d) => omit(d, ['trend', 'periodChange']) },
    management_deposits: { params: period_param, shape: (d) => omit(d, ['byCountry']) },
    management_net_deposits: { params: period_param },
    management_redepositing_clients: { params: period_param, shape: (d) => omit(d, ['trend']) },
    management_active_trading_accounts: {
        note: active_note('accounts with a non-zero trading P&L in the period, demo and excluded accounts not filtered'),
        params: period_param, shape: (d) => omit(d, ['trend']),
    },
    management_active_accounts_percentage: {
        note: active_note('accounts with a non-zero trading P&L in the period'), params: period_param, shape: (d) => omit(d, ['trend']),
    },
    executive_arpu: {
        note: `${broker_view} Known backend issue: total_revenue leaves out the "to" day, active_traders includes it. `
            + active_note('accounts with a non-zero trading P&L in the period'),
    },
    executive_active_traders_by_country: {
        note: active_note('accounts with any trading-day record, demo and excluded accounts removed'), to_next_day: true,
    },
    executive_revenue_by_region: { note: client_view, to_next_day: true, shape: (d) => ({ ...d, breakdown: d.breakdown?.map((r) => omit(r, ['percentage'])) }) },
    executive_ltv: { note: `${client_view} Average lifetime P&L of accounts with no trade for 90+ days.` },
    executive_funded_account_growth: { note: 'Accounts whose first deposit falls in the range (new depositors).' },
    sales_deposit_frequency: { note: 'All accounts that deposited in the range, new or not.' },
    operations_total_trades: { note: active_note('accounts with at least one buy/sell deal in the period (unique_traders)') },
    operations_most_traded_instruments: {
        note: 'total_volume is in raw MT5 units, not lots. Symbol variants (XAUUSD, XAUUSD.n, XAUUSD.p) are separate rows: add them up '
            + 'for the underlying. total_trades covers only the listed top 20.',
    },
    retention_active_traders: { note: `${cache_note} ${active_note('A/B-Book accounts with any trading-day record, excluded accounts removed')}` },
    retention_idle_balance: current_state,
    retention_idle_segmentation: current_state,
    retention_lapsed_high_value: { ...current_state, note: `${current_state.note} Known backend issue: deposit totals are inflated `
        + '(counted once per MT5 account of the e-mail).' },
    sales_deposited_never_traded: { note: 'Known backend issue: deposit totals are inflated (counted once per MT5 account of the e-mail).' },
};
for (const name of ['executive_swap_income', 'retention_dormant_traders', 'retention_idle_to_active', 'retention_trades_per_day',
    'retention_winning_losing_streak', 'sales_time_deposit_to_trade'])
{
    overrides[name] = { note: cache_note };
}

/**
 * @param {object} o
 * @param {string[]} keys
 * @returns {object}
 */
function omit(o, keys)
{
    return Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => !keys.includes(k)));
}

/**
 * @param {*} v
 * @returns {*} a numeric string as a number, anything else unchanged
 */
function num(v)
{
    return typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v)) ? Number(v) : v;
}

/**
 * @param {object} o
 * @returns {object}
 */
function numbers(o)
{
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, num(v)]));
}

/**
 * @param {{timestamp?: string}} point
 * @returns {string} the 15-minute slot of the point
 */
function bucket(point)
{
    const t = point.timestamp ?? '';
    return t.slice(0, 14) + Math.floor(Number(t.slice(14, 16)) / 15);
}

/**
 * Unix times to ISO dates and balances to numbers in the account lookup answers.
 * @param {object} d
 * @returns {object}
 */
function tidy_accounts(d)
{
    const iso = (s) => (s ? new Date(s * 1000).toISOString() : s);
    const tidy = (a) => a && { ...a, balance: num(a.balance), registration: iso(a.registration), lastAccess: iso(a.lastAccess) };
    return { ...d, account: tidy(d.account), accounts: d.accounts?.map(tidy), relatedAccounts: d.relatedAccounts?.map(tidy) };
}

/**
 * @param {object} d
 * @returns {object}
 */
function activity(d)
{
    const trades = d.trades ?? [];
    const by_symbol = {};
    for (const t of trades)
    {
        const s = by_symbol[t.symbol] ??= { trades: 0, volume: 0, profit: 0 };
        s.trades++;
        s.volume += t.volume;
        s.profit += t.profit + t.swap + t.commission;
    }
    for (const s of Object.values(by_symbol))
    {
        s.volume = Math.round(s.volume * 100) / 100;
        s.profit = Math.round(s.profit * 100) / 100;
    }
    const stats = Object.fromEntries(Object.entries(d.statistics_by_currency ?? {}).map(([c, s]) => [c, omit(s, ['max_drawdown_percent'])]));
    return { ...d, trades: trades.slice(0, 50), by_symbol_trades: trades.length, by_symbol, statistics_by_currency: stats };
}

/**
 * @param {string} url
 * @returns {string}
 */
function normalize_url(url)
{
    return url.trim().replace(/\/+$/, '');
}

/**
 * @param {string} text
 * @param {boolean} is_error
 * @returns {object}
 */
function result(text, is_error = false)
{
    return { isError: is_error, content: [{ type: 'text', text }] };
}

/**
 * Loads the public OpenAPI spec of base_url and turns every operation into a tool.
 * @returns {Promise<void>}
 */
async function load_tools()
{
    if (!base_url)
    {
        tools = new Map();
        spec_error = 'No ForexTrackr URL set: ask the user for their ForexTrackr address and API key and call the login tool.';
        return;
    }
    // The spec is public; sending the key would make the API reject it (the route is in no scope).
    const response = await fetch(`${base_url}/api/public/docs.json`, { headers: public_headers }).catch((e) => ({ ok: false, status: e.message }));
    tools = new Map();
    if (!response.ok)
    {
        spec_error = `Loading ${base_url}/api/public/docs.json failed: ${response.status}`;
        return;
    }
    spec_error = '';
    const spec = await response.json();
    for (const [path, operations] of Object.entries(spec.paths ?? {}))
    {
        for (const [method, op] of Object.entries(operations))
        {
            // operationId is "<method>_api_<route>"; the route part is a readable, unique tool name.
            const name = op.operationId.replace(new RegExp(`^${method}_(api_)?`), '').slice(0, 64);
            if (hidden.has(name))
            {
                continue;
            }
            const override = overrides[name] ?? {};
            const params = [...(op.parameters ?? []).filter((p) => !override.drop_params?.includes(p.name)),
                ...Object.keys(override.params ?? {}).filter((n) => !op.parameters?.some((p) => p.name === n)).map((n) => ({ name: n, in: 'query' }))];
            const body_schema = op.requestBody?.content?.['application/json']?.schema ?? { properties: {} };
            const properties = { ...body_schema.properties };
            const required = [...(body_schema.required ?? [])];
            for (const p of params)
            {
                properties[p.name] = override.params?.[p.name]
                    ?? { ...p.schema, description: p.description, ...(p.example !== undefined && { examples: [p.example] }) };
                if (p.required)
                {
                    required.push(p.name);
                }
            }
            const description = [op.summary, op.description, override.note, `Scope: ${op['x-scope']}.`].filter(Boolean).join('\n\n');
            tools.set(name, {
                method: method.toUpperCase(),
                path,
                params,
                override,
                body_fields: Object.keys(body_schema.properties ?? {}),
                tool: { name, description, inputSchema: { type: 'object', properties, required }, annotations: { readOnlyHint: true } },
            });
        }
    }
}

/**
 * Checks the key without reading any data: the spec route belongs to no scope, so a valid key gets
 * "This endpoint is not available with an API key" there and an unknown one "Invalid API key".
 * @param {string} url
 * @param {string} key
 * @returns {Promise<string>} empty when the key is valid, otherwise the reason
 */
async function check_key(url, key)
{
    const response = await fetch(`${url}/api/public/docs.json`, { headers: { ...public_headers, Authorization: `ApiKey ${key}` } })
        .catch((e) => ({ status: e.message, text: async () => '' }));
    const text = await response.text();
    if (response.status === 401 && text.includes('not available with an API key'))
    {
        return '';
    }

    return response.status === 401 ? 'The API key is invalid or was deleted.' : `Unexpected answer from ${url}: ${response.status} ${text.slice(0, 200)}`;
}

/**
 * @param {object} args
 * @returns {Promise<object>}
 */
async function login(args)
{
    const key = String(args.api_key ?? '').trim().replace(/^ApiKey\s+/, '');
    const url = normalize_url(String(args.url || base_url));
    if (!/^https?:\/\//.test(url))
    {
        return result('Pass the ForexTrackr address as url, e.g. https://trackr.example.com.', true);
    }
    if (!key.startsWith('trk_'))
    {
        return result('An API key starts with trk_.', true);
    }
    const error = await check_key(url, key);
    if (error)
    {
        return result(error, true);
    }

    const reload = url !== base_url || spec_error !== '';
    base_url = url;
    api_key = key;
    mkdirSync(dirname(config_file), { recursive: true, mode: 0o700 });
    writeFileSync(config_file, JSON.stringify({ url, api_key: key }), { mode: 0o600 });
    if (reload)
    {
        await load_tools();
        await server.sendToolListChanged();
    }

    return result(`Signed in to ${url}. ${spec_error || `${tools.size} ForexTrackr tools are available.`} `
        + 'Tools outside the scopes ticked on this key answer 401.');
}

const server = new Server({ name: 'trackr', version: '1.2.0' }, { capabilities: { tools: { listChanged: true } } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...auth_tools, ...[...tools.values()].map((t) => t.tool)] }));

server.setRequestHandler(CallToolRequestSchema, async (request) =>
{
    const args = request.params.arguments ?? {};
    if (request.params.name === 'login')
    {
        return login(args);
    }
    if (request.params.name === 'logout')
    {
        api_key = '';
        rmSync(config_file, { force: true });
        return result('Signed out; the saved API key is deleted.');
    }

    const t = tools.get(request.params.name);
    if (!t)
    {
        return result(spec_error || `Unknown tool ${request.params.name}`, true);
    }
    if (!api_key)
    {
        return result('Not signed in: ask the user for their ForexTrackr address and API key (trk_...) and call the login tool.', true);
    }

    let path = t.path;
    const query = new URLSearchParams();
    const values = { ...t.override.fixed?.(), ...omit(args, t.override.drop_params ?? []) };
    for (const p of t.params.concat((t.override.drop_params ?? []).map((name) => ({ name, in: 'query' }))))
    {
        let value = values[p.name];
        if (value === undefined)
        {
            continue;
        }
        // The services end a range before "to": a date-only end would leave its own day out.
        if (/(^|_)to$/.test(p.name) && /^\d{4}-\d{2}-\d{2}$/.test(String(value)))
        {
            value = t.override.to_next_day
                ? new Date(Date.parse(value) + 86400e3).toISOString().slice(0, 10)
                : `${value} 23:59:59`;
        }
        if (p.in === 'path')
        {
            path = path.replace(`{${p.name}}`, encodeURIComponent(String(value)));
        }
        else
        {
            query.set(p.name, String(value));
        }
    }
    const headers = { ...public_headers, Authorization: `ApiKey ${api_key}` };
    const body = Object.fromEntries(t.body_fields.filter((f) => args[f] !== undefined).map((f) => [f, args[f]]));
    const response = await fetch(`${base_url}${path}${query.size ? `?${query}` : ''}`, {
        method: t.method,
        headers: t.method === 'POST' ? { ...headers, 'Content-Type': 'application/json' } : headers,
        body: t.method === 'POST' ? JSON.stringify(body) : undefined,
    }).catch((e) => ({ ok: false, status: e.message, text: async () => '' }));
    const text = await response.text();
    if (!response.ok)
    {
        return result(`HTTP ${response.status}: ${text.slice(0, 500)}`, true);
    }
    let data;
    try
    {
        data = JSON.parse(text);
    }
    catch
    {
        return result(text);
    }
    if (data?.cache_warming)
    {
        return result(`No precomputed data for this range. ${cache_note}`, true);
    }

    return result(JSON.stringify(t.override.shape ? t.override.shape(data, args) : data));
});

await load_tools();
await server.connect(new StdioServerTransport());
