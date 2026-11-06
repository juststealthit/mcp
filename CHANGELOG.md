# Changelog

This project follows [Semantic Versioning](https://semver.org). Until 1.0, a minor version may change behaviour, and every such change is listed here.

## 0.2.0 (2026-11-06)

On `@juststealthit/sdk` 0.3.

### Added

- **External coins from every live chain.** `get_coin_report`, `get_candles` and the `stealth://coin/{address}` resource now find coins that didn't launch here on BNB Chain, Base, HyperEVM, Robinhood Chain and Arc as well as on Solana, with market figures, risk and their trending page. Without `chain`, a 0x address is looked up on every chain's launchpad first, then among each chain's trending coins.
- **`get_trending`**: Trending across chains, as the site shows it: coins launched here mixed with external coins trending on Solana and the other live chains, each with its chain, launchpad and page. Filter by chain, or by source (`launched_here`, `external`).
- **`get_wallet_overview`**: one Solana wallet in one call: SOL, holdings by value, the coins it launched with their unclaimed fees, $STEALTH staking (or that it isn't open yet), and its hidden EVM wallet on every EVM chain. Parts that can't be read are listed in `unavailable`, never shown as empty.
- **Live list resources**: `stealth://feed` (the newest 20 Feed items) and `stealth://trending`, both subscribable: a subscriber is told when a new Feed item lands, or when the top 20 trending coins change.
- **Coming-soon chains**: Ethereum, Arbitrum One and Avalanche C-Chain (contracts being deployed, `deploying: true`) and X Layer are listed by `list_chains`, `get_platform_status` (`comingSoonChains`) and `get_launch_options` (`evm.comingSoon`), with no addresses. Passed as a `chain`, they're refused with code `unsupported` and a message that says they're coming soon.
- `get_staking_pools` returns `state` (`open` or `not_open`) and a `message` while staking isn't open; it's built and tested, and opens soon.
- `get_stealth_burns` returns `buybackBot`: the buy-back bot's state, mode, cadence, next buy and totals.
- `get_board` and `search_coins` rows carry `onPlatform` and `launchpad`. External rows on the All list come back as `stage: "external"`, with their chain and their trending page, and `null` for launchpad fields they don't have.
- `get_candles` takes `to` for external coins, paging back through their history.
- The `trending_now` prompt; `review_wallet` starts from `get_wallet_overview`; `analyze_coin` skips holders and trades for external coins. Chain arguments complete.
- Server instructions and tool descriptions say which tool to pick for what.
- `config.json`'s `wallet` (the CLI's default wallet) is the default wallet here too, for `prepare_*`, the wallet tools and `--allow-signing`, when it's of the right kind.
- Two docs pages: `whats-new` and `external-tokens`.
- Library: `errorOf`, `ERROR_META_KEY`, `ALL_CHAIN_KEYS`, `KDF_MIN_N`, `parseKeystore`, `logScope`, `routeConsoleToLogger`.

### Changed

- **Candles start at 1 minute.** `get_candles` takes `1m`, `5m`, `15m`, `1h`, `4h` or `1D`; the platform dropped `1s`.
- **Tool errors carry no `structuredContent`.** A result with `isError: true` has a readable line, the error as JSON in a second text block, and the same object in `_meta["io.github.juststealthit/error"]`. Before, the error object sat in `structuredContent`, where clients that check it against the tool's output schema (the official TypeScript client does, once it has listed the tools) threw a schema error instead of showing the real one.
- The keystore format, its checks and the config-directory rule now come from `@juststealthit/sdk/keystore`, so the CLI and this server read the same files the same way. Keystore error codes follow the SDK: `keystore_bad_keystore` replaces `keystore_invalid`. A 0.1 CLI folder at `$XDG_CONFIG_HOME/stealth` that already holds the files keeps being used. `KeystoreFileSchema` is gone from the library exports; use `parseKeystore`.
- The chain lists come from the SDK's registry instead of a copy here.
- `get_coin_report` reports an external coin as `stage: "external"` even while it's on its launchpad's curve (`graduation.graduated` says which); `new`, `graduating` and `migrated` are for coins launched here.
- `get_board` and `get_trades` cursors may now be this server's own (`p1.…`), so a `limit` under the API's page size never skips rows; an API cursor from 0.1 still works. `truncated` counts the rows `nextCursor` reaches first.
- `quote_trade`, `prepare_buy` and `prepare_sell` on an external EVM coin refuse with `trade_on_site` and its page: those trade on the site through Relay, which this server doesn't build. `get_trades`, `get_holders` and `get_top_traders` on an external coin say `not_on_platform` with its page.
- `sign_and_send` results link the page the action was prepared for.

### Fixed

- Links to coins that didn't launch here pointed at `/token/…`, which shows Not found for them; they now go to the coin's `/trending/…` page (with `?chain=` off Solana). EVM coin links carry `?chain=`, since sibling multi-chain coins share an address.
- The daily SOL cap could be overspent by two servers sharing a config directory (two clients, each starting its own): each read the same ledger total. A reservation now holds a lock file next to `mcp-spend.json`, waits for another holder, and takes over a lock left by a process that died. A damaged ledger is refused with a clear message instead of a JSON error.
- A client that offers only URL elicitation was treated as able to show the signing confirmation, so `sign_and_send` failed with an internal error; it now counts as a client that can't confirm (refused under `--require-elicitation`), and `get_signing_status` says so.
- Subscribing to the same resource twice at once started two watchers, and unsubscribing (or closing the session) while a coin was still being looked up left its watcher running. Both are fixed; a session can watch at most 50 resources, and a subscription to a docs page that doesn't exist is refused.
- Streamable HTTP: the idle sweep closed sessions with an open stream (a client waiting for resource updates); sessions with a request or stream open aren't idle now. Concurrent initialize requests could overshoot the session cap; sessions still starting now count. An initialize the transport refused left its server behind.
- Streamable HTTP: one session's tool logs (addresses, errors) went out to every connected session as log notifications. A session now gets only its own calls' lines, plus server-wide ones.
- stdio: a dependency printing to the console could write to stdout and break the protocol; the console's log, info and debug now go to the logger (stderr).

## 0.1.0

The first release.

### Added

- **Server**: the official MCP server for Just Stealth It, on the official MCP TypeScript SDK and `@juststealthit/sdk` 0.2. Binary `stealth-mcp`, runnable with `npx @juststealthit/mcp`.
- **Transports**: stdio by default; Streamable HTTP with `--http`, bound to loopback by default, optional bearer auth, origin and Host checks against DNS rebinding, per-client sessions with an idle timeout and a cap, and `/healthz`.
- **Read tools**: `search_coins`, `get_board`, `get_coin_report`, `get_candles`, `get_trades`, `get_holders`, `get_top_traders`, `get_chart_events`, `get_stealth_burns`, `get_feed`, `get_fee_board`, `get_platform_status`, `get_platform_stats`, `get_launch_options`, `list_chains`, `get_staking_pools`, `get_staking_position`, `get_wallet_analytics`, `get_perps_markets`, `get_perps_candles`, `get_signing_status`, `get_transaction_status`.
- **Maths tools**: `quote_trade`, `calc_sniper_fee`, `calc_fee_split`, `calc_curve_quote`, `calc_staking_estimate`.
- **Action tools**, prepare-only: `prepare_buy`, `prepare_sell`, `prepare_stake`, `prepare_unstake`, `prepare_launch`, on Solana (the coin's own venue, or Jupiter for any token) and on the five EVM chains (direct against the router and factory). Each returns the transactions, a plain summary, next steps and a page to finish on.
- **Local signing**, opt-in with `--allow-signing`: `sign_and_send` signs prepared Solana actions with a wallet from the shared keystore (scrypt + AES-256-GCM), after checking the wallet and fee payer, the fee limit, per-transaction and rolling daily SOL caps from `config.json` with a persistent spend ledger, and a confirmation through elicitation where the client supports it (`--require-elicitation` to insist).
- **Resources**: `stealth://coin/{address}`, `stealth://docs/{page}`, `stealth://staking/{pool}` and `stealth://chains`, with templates, listings, argument completion and subscriptions (the live stream for Solana coins, polling for EVM coins and pools), throttled per resource.
- **Prompts**: `analyze_coin`, `compare_coins`, `explain_launch_type`, `daily_burn_report`, `review_wallet`, `plan_launch`.
- **Robustness**: output schemas with structured content on every tool, annotations, typed errors mapped to tool errors and JSON-RPC codes, request cancellation, timeouts, retries and caching through the SDK, logging to stderr and to the client as MCP log notifications with credentials redacted, and graceful shutdown.
- **Shared config** with the Stealth CLI: `$XDG_CONFIG_HOME/stealth`, `~/.config/stealth` or `%APPDATA%\stealth`.
- `server.json` for the MCP registry.
