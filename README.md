# Stealth MCP

The official [Model Context Protocol](https://modelcontextprotocol.io) server for [Just Stealth It](https://juststealthit.xyz) ($STEALTH), the multi-chain memecoin launchpad and trading terminal.

It lets any MCP client (a desktop assistant, a code editor, an agent framework) **read the whole platform** and **prepare actions on it safely**:

- **Read everything**: coins on Solana, Robinhood Chain, BNB Chain, HyperEVM, Base and Arc, and the external coins trending on those chains; the board by stage and chain; Trending across chains; a full coin report with price, market cap, volume, holders, graduation, launch type, fee routing and holder risk; candles, trades, top holders and traders, chart events; the $STEALTH buy back and burn; the Feed and its fee board; staking pools and positions; a one-call wallet overview and wallet analytics; read-only perps markets; platform status. Ethereum, Arbitrum One, Avalanche C-Chain and X Layer are listed as coming soon.
- **Do the maths**: live quotes, the anti-sniper fee line, fee splits per venue and tier, bonding-curve previews and staking estimates.
- **Prepare, don't spend**: `prepare_buy`, `prepare_sell`, `prepare_stake`, `prepare_unstake` and `prepare_launch` return the transaction for **your own wallet** to sign, a plain-language summary and a link to finish on juststealthit.xyz. Nothing is signed or sent.
- **Sign locally, only if you ask**: an opt-in mode signs prepared Solana actions with your local keystore wallet, inside SOL caps you set, after you confirm in the client.

```bash
npx -y @juststealthit/mcp
```

Node 20 or newer. No account and no API key needed.

> [!WARNING]
> Coins on the platform are created by anyone, and you can lose everything you put in. The EVM contracts are not audited. Nothing this server says is financial advice or a promise of any return: every prepared trade is your own decision.

## Contents

[Install](#install) · [Client setup](#client-setup) · [Tools](#tools) · [Resources](#resources) · [Prompts](#prompts) · [Safety model](#safety-model) · [Configuration](#configuration) · [Questions to ask](#questions-to-ask) · [Library use](#library-use) · [Development](#development)

## Install

Most clients start the server for you with `npx`, so there's nothing to install. To pin it instead:

```bash
npm install -g @juststealthit/mcp
stealth-mcp --help
```

| Command | What it does |
| --- | --- |
| `stealth-mcp` | stdio transport, prepare-only. What MCP clients launch |
| `stealth-mcp --http --port 8765` | Streamable HTTP on `http://127.0.0.1:8765/mcp` |
| `stealth-mcp --http --host 0.0.0.0 --auth-token <token>` | HTTP beyond loopback. A bearer token is required |
| `stealth-mcp --allow-signing` | Turns on local signing. See [Safety model](#safety-model) |

## Client setup

### Any MCP client (generic JSON)

Most clients take this shape:

```json
{
  "mcpServers": {
    "stealth": {
      "command": "npx",
      "args": ["-y", "@juststealthit/mcp"]
    }
  }
}
```

On Windows, clients that can't run `npx` directly need `"command": "cmd", "args": ["/c", "npx", "-y", "@juststealthit/mcp"]`.

### Desktop assistants

Desktop apps that support MCP read the same `mcpServers` block from their settings (look for a Developer or MCP section that opens the config file). Add the block above, then restart the app: the tools show up in its tools menu and the prompts with its attachments.

### Command-line agents

Agents that add servers from the command line take the same command:

```bash
<agent> mcp add stealth -- npx -y @juststealthit/mcp
```

### Cursor

`~/.cursor/mcp.json` (every project) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "stealth": { "command": "npx", "args": ["-y", "@juststealthit/mcp"] }
  }
}
```

### VS Code

`.vscode/mcp.json` in your workspace, or **MCP: Add Server** from the command palette:

```json
{
  "servers": {
    "stealth": { "type": "stdio", "command": "npx", "args": ["-y", "@juststealthit/mcp"] }
  }
}
```

### Windsurf

`~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "stealth": { "command": "npx", "args": ["-y", "@juststealthit/mcp"] }
  }
}
```

### Agent frameworks and remote clients (Streamable HTTP)

Run the server once and point any Streamable HTTP client at it:

```bash
STEALTH_MCP_TOKEN="$(openssl rand -hex 24)" stealth-mcp --http --port 8765
```

```json
{
  "mcpServers": {
    "stealth": {
      "url": "http://127.0.0.1:8765/mcp",
      "headers": { "Authorization": "Bearer <the token>" }
    }
  }
}
```

With the TypeScript SDK:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "my-agent", version: "1.0.0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8765/mcp"), {
    requestInit: { headers: { Authorization: `Bearer ${process.env.STEALTH_MCP_TOKEN}` } },
  }),
);
const report = await client.callTool({ name: "get_coin_report", arguments: { address: "GoDSW31bTxfkoup9yA1qcGGx9RMXdTEWgApv3xzBmoA" } });
```

`GET /healthz` answers `{ "status": "ok" }` for health checks.

### Debugging

```bash
npx @modelcontextprotocol/inspector npx -y @juststealthit/mcp
```

## Tools

Every tool has a zod-validated input schema, an output schema with structured content (mirrored as JSON text for clients that only read text), and annotations. Amounts go in as whole units (`"0.1"` SOL, `"25000"` tokens) and come back both raw and formatted. Failures come back as tool errors with a stable `code` and whether retrying could help.

### Market

| Tool | What it returns |
| --- | --- |
| `search_coins` | Coins launched here, by name, ticker (`$` optional) or address prefix, across every live chain |
| `get_board` | The board by stage (new, graduating, graduated) and chain, sorted and filtered like the Coins page, with paging and counts. The All list (every stage) mixes in external trending coins, marked `onPlatform: false` |
| `get_trending` | Trending across chains, as the site shows it: coins launched here and external coins trending on Solana and the other live chains, each with its chain, launchpad and page. Filter by chain or by source |
| `get_coin_report` | One coin, any chain: price, market cap, liquidity, volume, holders, graduation progress, venue and pair, tax and anti-sniper state, launch type and where creator fees go, holder risk with the token page's green / amber / red bands, buy-backs, holder rewards and multi-chain siblings. Coins launched elsewhere work too (any Solana token, or a coin trending on a live EVM chain) and get market figures, risk and their page |
| `get_candles` | OHLC candles from 1m to 1D (the 1s interval is gone). External coins page back through their history with `to` |
| `get_trades` | Trades, newest first, with anti-sniper and first-buy flags. Paged with `cursor`, without skipping rows when `limit` is small |
| `get_holders` | Top holders with the pool, escrow, creator, locks, snipers and burns labelled |
| `get_top_traders` | Traders ranked by PnL |
| `get_chart_events` | The chart's bubbles: launcher trades, burns, graduation, marketing steps, claims, Feed callouts, posts on X |

### Platform

| Tool | What it returns |
| --- | --- |
| `get_stealth_burns` | The $STEALTH buy back and burn: supply and share burned, the fees behind it, recent burns with transactions, the next run, the coins that fund it most |
| `get_feed` | The Feed: launches, graduations, burns, claims and posts |
| `get_fee_board` | Creator fees paid out over 7 or 30 days by launch type, chain and coin |
| `get_platform_status` | Site state, every system's status and uptime, open incidents, open and coming-soon EVM chains, indexer lag |
| `get_platform_stats` | Platform totals: launches, graduations, volume, holder rewards, launch-type and pair mix |
| `get_launch_options` | What a launch can pick right now: venues, tax tiers and who gets what, launch types, open and coming-soon chains |
| `list_chains` | Every live and coming-soon chain, with `deploying` for the ones whose contracts are being deployed (Ethereum, Arbitrum One, Avalanche C-Chain). Coming-soon chains have no addresses and are refused as inputs |

### Staking and wallets

| Tool | What it returns |
| --- | --- |
| `get_staking_pools` | Whether staking is open (`state`: `open` or `not_open`; it's built and tested, and opens soon), and the pools: today's rate and boosts, cooldown, totals and what the reward pool can still pay |
| `get_staking_position` | A wallet's stake, rewards, boost, unstakes on their way back and history |
| `calc_staking_estimate` | What an amount would earn over N days at today's rate, stepping through boosts. An estimate, not a promise |
| `get_wallet_overview` | One Solana wallet in one call: SOL, holdings by value, coins it launched with unclaimed fees, staking, and its hidden EVM wallet on every EVM chain. Parts that can't be read are listed, not shown as empty |
| `get_wallet_analytics` | A Solana wallet's profile, PnL by period, positions, trades, rewards, portfolio, and its hidden EVM wallet |

### Perps (read-only)

| Tool | What it returns |
| --- | --- |
| `get_perps_markets` | Hyperliquid, Aster and Jupiter Perps markets grouped by coin: price, 24 h change and volume, open interest, max leverage |
| `get_perps_candles` | Candles for one market |

There is no perps trading here: no orders, no accounts, nothing to sign.

### Quotes and maths

| Tool | What it returns |
| --- | --- |
| `quote_trade` | A live quote from the coin's pool: amount out, minimum after slippage, the fee charged right now, price impact, route |
| `calc_sniper_fee` | The anti-sniper fee for a tier and second, or for a coin right now, with the whole 15-second line |
| `calc_fee_split` | How a trade's fee splits between the coin, the platform and the venue, per venue and tier, plus the docs' full table |
| `calc_curve_quote` | An offline constant-product bonding-curve preview |

### Actions (prepare-only by default)

| Tool | What it returns |
| --- | --- |
| `prepare_buy` | A buy for your wallet to sign: on the coin's curve or pool, through Jupiter for other Solana tokens, or through the chain's router on EVM. Refused while the anti-sniper fee is above `maxFeeBps`. An external coin on an EVM chain trades on the site through Relay: the refusal links its page |
| `prepare_sell` | A sell by amount or by percentage of the wallet's balance |
| `prepare_stake` | A $STEALTH stake, co-signed by the staking wallet, for your signature |
| `prepare_unstake` | An unstake by amount or percentage of what's staked |
| `prepare_launch` | A coin launch on Solana (built by the API) or an EVM chain (built against the factory) |
| `get_signing_status` | Whether this server can sign, with which wallet, the caps and what was spent in the last 24 hours |
| `get_transaction_status` | Whether a Solana transaction is pending, confirmed or failed |
| `sign_and_send` | **Only with `--allow-signing`.** Signs a prepared Solana action with your keystore wallet and sends it, after the checks below |

Every `prepare_*` result has the same shape: `summary`, `details`, `format` (`solana-base64` or `evm-unsigned`), `transactions` in order, `finishOnSite`, `nextSteps`, `warnings`, a `disclaimer`, and a `preparedId` when local signing is on for that wallet. Solana transactions lapse about a minute after they're prepared; EVM swaps carry a deadline.

| Tools | `readOnlyHint` | `destructiveHint` | `idempotentHint` | `openWorldHint` |
| --- | --- | --- | --- | --- |
| Reads (market, platform, staking, wallets, perps) | true | false | true | true |
| `list_chains`, `get_signing_status` | true | false | true | false |
| `quote_trade`, `get_transaction_status` (live answers) | true | false | false | true |
| `calc_fee_split`, `calc_curve_quote` (pure maths) | true | false | true | false |
| `calc_sniper_fee`, `calc_staking_estimate` (may read a coin or pool) | true | false | true | true |
| `prepare_*` | false | false | false | true |
| `sign_and_send` | false | **true** | false | true |

## Resources

| URI | What it is |
| --- | --- |
| `stealth://coin/{address}` | A coin's full report, as JSON. **Subscribable**: Solana coins update from the platform's live stream, EVM coins by polling their trades |
| `stealth://docs/{page}` | Short summaries of the [platform docs](https://github.com/juststealthit/docs), one per topic. Start with `stealth://docs/index` |
| `stealth://staking/{pool}` | A staking pool, as JSON. Subscribable |
| `stealth://feed` | The newest 20 Feed items. **Subscribable**: told when a new item lands on top |
| `stealth://trending` | Trending across chains, as `get_trending` returns it. **Subscribable**: told when the top 20 change |
| `stealth://chains` | The chain registry |

Docs pages: `index`, `whats-new`, `getting-started`, `launching`, `venues`, `curve-and-graduation`, `fees`, `launch-types`, `anti-sniper`, `marketing`, `multi-chain`, `evm-chains`, `stealth-bc-amm`, `trading`, `external-tokens`, `token-page`, `social-vaults`, `feed`, `telegram`, `cto`, `perps`, `staking`, `safety`, `addresses`, `faq`, `glossary`.

A subscriber gets `notifications/resources/updated` when the resource changes, at most once every two seconds per resource, and reads it again when it wants the new state. After the live stream reconnects, subscribers are told to read again, since messages sent while it was down are gone. One session can watch up to 50 resources at once. Template arguments and prompt arguments support completion.

## Prompts

| Prompt | Arguments | What it does |
| --- | --- | --- |
| `analyze_coin` | `coin`, `chain?` | Market, graduation, launch type and fee routing, holder risk and the last day of activity |
| `compare_coins` | `first`, `second` | Two coins side by side in one table |
| `explain_launch_type` | `type` | What a launch type does with creator fees, with the docs attached and a worked example |
| `daily_burn_report` | none | The last day of the $STEALTH buy back and burn |
| `review_wallet` | `address` | What a wallet holds now, then its PnL, positions, rewards and trading style |
| `trending_now` | `chain?` | What's trending, launched here and elsewhere, with the facts behind the top coins |
| `plan_launch` | `idea`, `chain?` | Walks through every launch choice, then prepares the launch for you to sign |

Every prompt asks for facts with their numbers and links, and no predictions, promises or buy and sell calls.

## Safety model

**By default the server holds no key and can't move money.** It reads public data and builds transactions. You sign them, in your own wallet, if you choose to.

### Prepare-only (the default)

- Solana transactions are built by the platform's API, which is how the site builds them too (a launch has to be built there: the new coin's escrow key and its mint are the server's to sign). Every one is decoded and **checked to be paid by the wallet it was built for** before it's returned; anything else is refused.
- EVM transactions are built here, directly against the chain's contracts, with the quote read from the chain's own quoter at that moment, slippage applied, a deadline and any ERC-20 approval listed first.
- Trades inside a coin's anti-sniper window (up to 90% in its first seconds on Meteora and EVM) are refused above `maxFeeBps`, 10% by default.
- Every result says plainly that nothing has been sent, and carries a disclaimer: the decision is yours.

### Local signing (opt-in)

Start the server with `--allow-signing` (or set `"mcp": { "allowSigning": true }` in `config.json`). It then reads the shared keystore, unlocks one Solana wallet and offers one extra tool, `sign_and_send`. Before anything is signed:

1. The prepared action must exist, be unexpired and unused, and have been prepared **for the signing wallet**. Each one can be used once.
2. Every transaction in it must be **paid by that wallet**. Staking transactions are signed exactly as the staking wallet co-signed them, never rebuilt.
3. A trade's quoted fee must be within the `maxFeeBps` you accepted.
4. Its SOL spend must be within **`mcp.maxSolPerTx`**, and within **`mcp.maxSolPerDay`** over a rolling 24 hours. Spends are recorded in `mcp-spend.json` (mode 0600) in the config directory, so the daily cap survives restarts, and the ledger is locked while a spend is reserved, so two servers sharing the folder (two clients, each starting its own) can't both spend the same allowance. Defaults: 0.25 SOL per transaction and 1 SOL per day.
5. **You confirm in the client** through an MCP elicitation form, where the client supports one (a client that offers only URL elicitation counts as one that can't ask). With `--require-elicitation`, a client that can't ask you is refused outright; otherwise the client's own tool approval is relied on (`sign_and_send` is annotated as destructive).

Spends count the SOL an action spends by intent (the buy amount, a first buy, a staking escrow deposit), not network fees and rent. A sell or unstake spends no SOL but still goes through every other check.

More guard rails:

- The passphrase comes from `STEALTH_KEYSTORE_PASSPHRASE` or a no-echo prompt on the controlling terminal, never from stdin or the protocol, and never from the client. The variable is removed from the environment once read. Without a passphrase, signing stays off and everything else works.
- A wrong passphrase stops the server, rather than running in a mode you didn't ask for. A decrypted key that doesn't match the wallet's address is refused, and so is a keystore entry sealed with a scrypt cost below 2^14.
- Caps are in SOL, so **only Solana actions are signed**. EVM transactions are always returned unsigned.
- Signing is refused while the HTTP server is bound beyond loopback, and when `config.json` has problems.
- `--read-only` turns signing off whatever the config says.

### Transport and logging

- stdio: logs go to stderr only, never stdout, and to the client as MCP log notifications at the level it asks for. Anything a dependency prints to the console goes to stderr too. Credentials are redacted from every log line.
- Tool errors come back as results with `isError: true`, a readable line and the error as JSON (also in `_meta["io.github.juststealthit/error"]`), never as structured content a client would check against the tool's output schema.
- HTTP: binds to `127.0.0.1` by default; binding elsewhere needs a bearer token of 16+ characters, compared in constant time. Requests from browser origins other than loopback are refused unless allowed with `--allow-origin`, and a loopback server refuses foreign `Host` headers (DNS rebinding). Sessions are capped (sessions still starting count) and closed when idle; a session with a stream open isn't idle. Over HTTP, a session's log notifications carry only its own calls.
- Reads use the SDK's retries with backoff (honouring `Retry-After`), a per-request timeout, cancellation from the client, and a short response cache.

## Configuration

The server shares its config directory with the Stealth CLI:

| Platform | Directory |
| --- | --- |
| macOS, Linux | `$XDG_CONFIG_HOME/stealth` (when it's an absolute path), else `~/.config/stealth` |
| Windows | `%APPDATA%\stealth` |

The rule and the keystore format come from the SDK (`@juststealthit/sdk/keystore`), so the CLI follows the same ones. A 0.1 CLI folder at `$XDG_CONFIG_HOME/stealth` that already holds the files keeps being used.

`config.json` (every field optional):

```json
{
  "apiUrl": "https://juststealthit.xyz/api",
  "defaultChain": "solana",
  "slippageBps": 300,
  "theme": "dark",
  "wallet": "main",
  "mcp": { "allowSigning": false, "maxSolPerTx": 0.25, "maxSolPerDay": 1 }
}
```

`keystore.json` is written by the CLI and only read here: `{ version: 1, wallets: [{ name, kind: "solana" | "evm", address, crypto: { kdf: "scrypt", kdfparams: { n: 131072, r: 8, p: 1, salt }, cipher: "aes-256-gcm", iv, tag, ciphertext } }] }`, hex fields, mode 0600. Its public addresses are the default wallets for `prepare_*` and the wallet tools, so you don't have to paste them: `wallet` in `config.json` (the CLI's default wallet) first, when it's of the right kind, else the first of that kind.

| Flag | Environment | Default |
| --- | --- | --- |
| `--http` | | stdio |
| `--port <n>` | | 8765 |
| `--host <addr>` | | 127.0.0.1 |
| `--auth-token <token>` | `STEALTH_MCP_TOKEN` | none |
| `--allow-origin <origin>` (repeatable) | | loopback origins only |
| `--allowed-host <host>` (repeatable) | | any, when bound beyond loopback |
| `--api-url <url>` | `STEALTH_API_URL` | config.json, else the official API |
| `--config-dir <dir>` | `XDG_CONFIG_HOME` | see above |
| `--rpc <chain=url>` (repeatable) | `STEALTH_RPC_BASE`, `STEALTH_RPC_BNB`, … | each chain's public RPC |
| `--timeout <ms>` | | 15000 |
| `--cache-ttl <ms>` | | 5000 |
| `--allow-signing` | | off |
| `--wallet <name>` | | config.json's `wallet`, else the keystore's first Solana wallet |
| | `STEALTH_KEYSTORE_PASSPHRASE` | prompt on the terminal |
| `--require-elicitation` | | off |
| `--read-only` | | off |
| `--log-level <level>` | `STEALTH_MCP_LOG_LEVEL` | info |
| `--log-json` | | off |

To turn signing on from a desktop client, pass the flag and the passphrase in its config:

```json
{
  "mcpServers": {
    "stealth": {
      "command": "npx",
      "args": ["-y", "@juststealthit/mcp", "--allow-signing", "--require-elicitation"],
      "env": { "STEALTH_KEYSTORE_PASSPHRASE": "…" }
    }
  }
}
```

That puts the passphrase in a file on disk. Keep the wallet small, set tight caps, and prefer starting the server from a terminal where it can ask.

## Questions to ask

- "What's on the Just Stealth It board right now? Show the 10 busiest graduating coins on Solana."
- "Give me a full report on `GoDSW31bTxfkoup9yA1qcGGx9RMXdTEWgApv3xzBmoA`, including holder risk."
- "Compare these two coins side by side: `<address>` and `<address>`."
- "How much $STEALTH has been burned, and when's the next buy-back?"
- "Explain the Diamond Hands launch type, with an example on a 2.25% Meteora coin."
- "What does a 3.25% tax tier pay the coin on Raydium LaunchLab versus Base?"
- "What would a buy pay 4 seconds after a 1.25% EVM launch?"
- "Is staking open? What would 50,000 $STEALTH earn over 90 days at today's rate?"
- "What's trending across chains right now, and which of those coins launched here?"
- "What do I hold right now, on Solana and in my EVM wallet?"
- "Show my wallet's PnL over the last 30 days and my open positions."
- "Which perps venues list BTC, and what's the open interest on each?"
- "Quote 0.25 SOL of this coin, then prepare the buy for my wallet."
- "Help me plan a launch for a coin called Night Owl, $OWL, on Base."
- "Is anything down on the platform right now?"

## Library use

The server is also a library, for embedding in your own process or transport:

```ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StealthContext, createStealthServer, loadConfig } from "@juststealthit/mcp";

const { config, dir } = await loadConfig();
const ctx = new StealthContext({ config, configDir: dir });
const { server } = createStealthServer(ctx);
await server.connect(new StdioServerTransport());
```

It's built on the official [TypeScript SDK](https://github.com/juststealthit/sdk) (`@juststealthit/sdk`).

## Development

```bash
npm run typecheck
npm test        # in-memory MCP sessions over a fake API: no network, no keys
npm run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup (the SDK is published separately) and the [CHANGELOG](CHANGELOG.md).

## Links

[Website](https://juststealthit.xyz) · [Docs](https://github.com/juststealthit/docs) · [SDK](https://github.com/juststealthit/sdk) · [Contracts](https://github.com/juststealthit/smart-contracts) · [Status](https://juststealthit.xyz/status) · [X](https://x.com/juststealthit) · [Telegram](https://t.me/juststealthit)

Just Stealth It is not affiliated with Pump.fun, Raydium, Meteora, Jupiter, Relay, Hyperliquid, Aster, Robinhood, BNB Chain, Base, Circle or Solana Foundation, nor with the makers of the MCP clients named above.

MIT License.
