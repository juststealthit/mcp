# Changelog

This project follows [Semantic Versioning](https://semver.org). Until 1.0, a minor version may change behaviour, and every such change is listed here.

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
