/**
 * Short summaries of the platform's public docs (github.com/juststealthit/docs), bundled so a client can read them as
 * `stealth://docs/{page}` without leaving the session. The full pages are linked from each one.
 *
 * @module
 */

export interface DocPage {
  slug: string;
  title: string;
  /** One line, for listings. */
  description: string;
  /** Markdown. */
  body: string;
}

const DOCS = "https://github.com/juststealthit/docs/blob/main";

const page = (slug: string, title: string, description: string, body: string): DocPage => ({
  slug,
  title,
  description,
  body: `# ${title}\n\n${body.trim()}\n\nFull page: ${DOCS}/${slug === "index" ? "README" : slug}.md\n`,
});

export const DOC_PAGES: DocPage[] = [
  page(
    "index",
    "Just Stealth It docs",
    "What the platform is, and a map of every page",
    `
Just Stealth It is a multi-chain memecoin launchpad and trading terminal. On **Solana** a coin launches on **Pump.fun**, **Raydium LaunchLab** or **Meteora**; it can also launch on **Robinhood Chain**, **BNB Chain**, **HyperEVM**, **Base** or **Arc**. Avalanche, Arbitrum and X Layer show as coming soon.

Every buy and sell pays a fee. The coin's part of that fee is its **creator fees**, and the coin's **launch type** decides where they go.

Pages: getting-started, launching, venues, curve-and-graduation, fees, launch-types, anti-sniper, marketing, multi-chain, evm-chains, stealth-bc-amm, trading, token-page, social-vaults, feed, telegram, cto, perps, staking, safety, addresses, faq, glossary.

What's on right now: Solana venues on mainnet; EVM contracts on five chains (**not audited**); multi-chain launches. Built and currently off: fees routing home across chains, wallet payouts to other chains, social vaults, the Telegram private chat, Meteora's global tax. Staking is built and tested and opens soon. Stealth BC and Stealth AMM are coming soon and not deployed.

Coins here are created by anyone, and you can lose everything you put in. Nothing here is financial advice or a promise of any return.
`,
  ),
  page(
    "getting-started",
    "Getting started",
    "Ways in, where things are, your first coin",
    `
- **Connect a wallet** from the top bar: Phantom, Solflare, Backpack or another Solana wallet, or the browser's wallet on an EVM chain. The platform never sees that wallet's keys; you sign your own transactions and need a little of the chain's coin for network fees.
- **Sign in with a social account** to post in the Feed or claim a social vault.
- The wallet menu shows live network status: green in sync, amber when the indexer lags, red when it's far behind.

Pages: **Feed** (what's happening on every chain), **Launch**, **Coins** (New, Graduating, Graduated; filter by chain), **Perps**, **Wallet** (portfolio, PnL, trades, earnings, CTO, launched coins, Stake), the **token page**, **Fees** and **Status**.

First coin: connect, open Launch, fill in name, ticker, logo, description and links, pick venue and pair, pick the tax where the venue has a choice, pick the launch type (locked at launch), add an optional first buy, review and sign.
`,
  ),
  page(
    "launching",
    "Launching a coin",
    "The launch flow step by step, and what it costs",
    `
Steps: connect; coin details; where it launches (Pump.fun, Raydium LaunchLab, Meteora, Robinhood Chain, HyperEVM, Base, Arc or BNB Chain); the pair; the tax (1.25%, 2.25%, 3.25%, 4.25% or 5.75% on Raydium LaunchLab, Meteora and EVM; Pump.fun sets its own); the launch type; Singular or Multi-chain; an optional first buy of up to 5% of supply; review and sign.

Logo: PNG, JPG, WebP or GIF up to 2 MB, or an image link.

**Costs:** network fees and rent always; the first buy if any; on EVM from a Solana wallet, gas and the bridge's fee; about 0.01 SOL into the escrow for a coin that keeps a pot on a non-SOL pair; about 0.006 SOL for a Meteora config off the default rate. The EVM contracts can charge a launch fee, capped at 0.1 of the native coin; it's 0 on all five chains today.

**Locked at launch:** venue and pair, tax tier, launch type, team wallets, and on EVM the max wallet, max buy and any first-buy lock. Nobody can change them afterwards, except who receives creator fees after a CTO, through a public notice. On Solana the launch type is applied by the platform's bot; on chain only Pump.fun's split and the EVM contracts' split are locked.

EVM options: max wallet 0.5% to 5% and max buy 0.1% to 5% of supply for up to 60 minutes; a first-buy lock of up to 90 days.
`,
  ),
  page(
    "venues",
    "Venues",
    "Pump.fun, Raydium LaunchLab, Meteora and the EVM chains compared",
    `
| Venue | Pairs | Tax | Anti-sniper | After graduation |
| --- | --- | --- | --- | --- |
| Pump.fun | SOL, or what Pump lists | Pump's own fee | No | PumpSwap pool |
| Raydium LaunchLab | Raydium's pairs, stocks included | 1.25% to 5.75% | No | Raydium CPMM, LP locked forever |
| Meteora | 20 shared pairs, or a searched token | 1.25% to 5.75% | Yes | DAMM v2, locked forever |
| EVM chains | The native coin (USDC on Arc) | 1.25% to 5.75% | Yes | Same pool, locked from launch |

Robinhood Chain, HyperEVM, Base and Arc run on Uniswap v4; BNB Chain on PancakeSwap Infinity. On EVM there's no migration: graduation is a price level.

Meteora's default 1.25% rate uses shared configs; any other rate or pair makes the coin's own config for about 0.006 SOL. Tokenized stocks and tokens with extra Token-2022 extensions can't launch on Meteora yet.

Comparing venues compares percentages only: what a coin earns depends entirely on trading.
`,
  ),
  page(
    "curve-and-graduation",
    "Bonding curve and graduation",
    "Supply, pairs, targets, what happens when a curve fills",
    `
Every coin has a fixed supply of **1,000,000,000**; nobody can mint more. Solana coins have 6 decimals, EVM coins 18.

Sold along the curve: 79.31% on Pump.fun and Raydium LaunchLab, 80% on Meteora; on EVM, 800M from launch price to graduation price and 200M beyond, all in two locked positions from the first block.

A SOL-pair curve on Raydium LaunchLab or Meteora raises **85 SOL** before it graduates; other pairs have targets of about the same value. EVM launches pick a target inside the factory's range (defaults today: 3.5 ETH on Robinhood Chain and Base, 11 BNB, 90 HYPE, 8,000 USDC on Arc).

At graduation the coin moves into its pool: PumpSwap, Raydium CPMM (LP locked forever) or Meteora DAMM v2 (locked forever). On EVM, graduation is a flag set at a price level; it moves no money. Don't treat graduation or volume as proof of demand: a launcher holding the coin's part gets most of the tier back on their own trades, so wash trades are cheap.

The first buy goes in with the launch, capped at 5% of supply, and pays the tier rather than the anti-sniper fee.

Tokenized stocks are not for US persons.
`,
  ),
  page(
    "fees",
    "Fees and tax tiers",
    "Every rate on every venue, and who gets what",
    `
Every trade pays the coin's fee in the pair token. Of it, **70** goes to the coin's launch type (its **creator fees**) and **30** to Just Stealth It, after the venue's own cut where it has one. "100% of creator fees" never means 100% of the tax.

What a coin gets of each trade, on the curve:

| Tier | EVM chains | Meteora | Raydium LaunchLab |
| --- | --- | --- | --- |
| 1.25% | 0.875% | 0.70% | 0.50% |
| 2.25% | 1.575% | 1.26% | 0.50% |
| 3.25% | 2.275% | 1.82% | 0.50% |
| 4.25% | 2.975% | 2.38% | 0.50% |
| 5.75% | 4.025% | 3.22% | 0.50% |

- **Pump.fun** sets its own fee. Of Pump's creator fee, 70% goes to the coin's escrow and 30% to Just Stealth It, locked on chain.
- **Raydium LaunchLab** caps the creator fee at 0.5%, so higher tiers add only to Just Stealth It's share after Raydium's 0.25%.
- **Meteora** keeps 20% of the pool fee; the rest splits 70/30. After graduation the fee goes to the LP.
- **EVM**: the 70/30 split of the tier is written in the contract. Anything above the tier (the anti-sniper fee) goes to Just Stealth It.

Creator fees land in the coin's escrow (on EVM, the fee vault) and are acted on by the launch type: paid to wallets, paid to holders in rounds, spent on buy-backs, held for marketing, or added to liquidity. Just Stealth It adds no separate fee on top of the tax.
`,
  ),
  page(
    "launch-types",
    "Launch types",
    "The 11 places creator fees can go",
    `
Picked at launch and **locked**. Every type gets 100% of creator fees (the coin's part of the fee, not the whole tax).

| Type | Where creator fees go |
| --- | --- |
| Social | A vault for a named social account, until that person claims. The launcher gets none |
| Creator | The creator's wallet, in the pair token. The default |
| Wallet | An address picked at launch |
| Team | 2 to 10 wallets, by fixed shares |
| Holders | Holders of at least 10,000 tokens, every 10 minutes, in the pair token |
| Diamond Hands | Like Holders, but a wallet that sells or moves tokens out stops earning for good |
| Buy back and burn | Buying the coin and burning it, on each claim |
| Feed a Coin | Buying another coin and burning it, on each claim |
| Auto Liquidity | A wallet of the coin's own, then its pool after graduation |
| Marketing | The coin's marketing ladder. The creator takes none |
| Mix | 2 to 5 of the above, each at least 1%, adding up to 100% |

Holders: wallets above 40,000,000 tokens, pools and the platform's own wallets are left out; tiny amounts carry over. Buy-backs need about 0.006 SOL in the escrow to start and are limited by price impact and size per run. On EVM, Wallet, Diamond Hands, Feed a Coin, Auto Liquidity and Mix use the contract's general Pot type, run by the ops bot, and a direct contract launch can pick Creator, Team, Marketing, Holders or Buy back and burn.

A burn reduces supply; it isn't a promise of any price or value. A person named in a Social launch hasn't agreed to anything.
`,
  ),
  page(
    "anti-sniper",
    "Anti-sniper fee",
    "The first 15 seconds of a Meteora or EVM coin",
    `
Meteora and EVM launches start at **90%** and step down every whole second to the coin's tax over the first **15 seconds**, on buys and sells alike:

\`rate = 90% − (90% − tier) × seconds since launch / 15\`

On a 1.25% coin: 0 s 90%, 3 s 72.25%, 6 s 54.5%, 9 s 36.75%, 12 s 19%, 14 s 7.17%, 15 s 1.25%.

The launcher's first buy, inside the launch, pays the tier instead. On Meteora the surplus splits like the tax; on EVM the coin still gets 70% of its tier and everything above the tier goes to Just Stealth It, so self-sniping gains a launcher nothing. On EVM the line is a compiled constant and the block timestamp decides each step. Pump.fun and Raydium LaunchLab have no anti-sniper fee.
`,
  ),
  page(
    "marketing",
    "Marketing ladder",
    "How a Marketing coin spends its pot",
    `
On a Marketing coin, 100% of creator fees go into its **marketing pot**, credited in US dollars when each fee is earned. The pot climbs a ladder of 21 promotions in order. A step is **ready** once the pot covers its price plus a $5 buffer; an admin picks it up (**processing**), buys it and records the real cost with proof (**completed**). Only the first unbought step can be ready.

The ladder runs from a DexScreener profile ($299) and boosts, DEXTools and GeckoTerminal products, ads, KOL posts and a press release, up to a trending bar, a CoinGecko listing ($4,000) and a CoinMarketCap listing ($6,000). Prices are list prices and can change; the coin's page shows the current ones.

Steps are bought by people, not a contract. A step is a purchase, not a guaranteed result; listings can be refused by the sites that run them.
`,
  ),
  page(
    "multi-chain",
    "Multi-chain launches",
    "One payment, one separate coin per chain",
    `
One payment makes one launch on each chain that can take it. **These are separate coins**: each has its own address, supply, price, pool and holders. They aren't bridged and can't be swapped for one another, and the site never adds their numbers together.

Flow: the **home** chain pays; a simulation prices every chain with real bridge quotes (an estimate that expires after 2 minutes); one transfer pays the home hidden wallet; each chain then launches on its own. It isn't atomic: some chains can land while others fail, failed chains retry, and a chain out of tries returns its share less what was spent. Unused money comes back.

Fees across chains: Creator, Team, Wallet, Social, Marketing and Feed a Coin go home through the bridge; Holders, Diamond Hands, Buy back and burn and Auto Liquidity stay on their own chain. Routing home is **built and currently off**, so home-bound fees wait in that chain's pot.

Dev buys are set chain by chain and each stops at 5% of supply. Default per-launch and per-wallet limits apply.
`,
  ),
  page(
    "evm-chains",
    "EVM chains",
    "Hidden wallets, contracts and what to know",
    `
| Chain | Id | Gas and pair | DEX |
| --- | --- | --- | --- |
| Robinhood Chain | 4663 | ETH | Uniswap v4 |
| HyperEVM | 999 | HYPE | Uniswap v4 |
| Base | 8453 | ETH | Uniswap v4 |
| Arc | 5042 | USDC | Uniswap v4 |
| BNB Chain | 56 | BNB | PancakeSwap Infinity |

**The contracts are unaudited.** On Holders and Pot coins the ops bot's key can pay a pot to any address; the ledger keeps it honest, and it wouldn't stop a stolen key.

On the site, launching and trading on these chains run from a Solana wallet through a **hidden wallet** the platform holds the key of: one per Solana wallet, the same address on every EVM chain, signing only set actions (launch, buy, approve, sell, claim, bridge deposit). Sale proceeds stay there until withdrawn to the Solana wallet that owns it. Default per-request and daily limits apply.

Each launch deploys the token and opens its pool in one transaction; the locker owns the liquidity forever; the hook takes the tax, the sniper fee and the max buy; the fee vault books every fee and pays claims. Creators claim from the fee vault. Arc's gas coin is USDC; scanners may read token clones as proxies (they aren't upgradeable); tax-free side pools can exist.
`,
  ),
  page(
    "stealth-bc-amm",
    "Stealth BC and Stealth AMM",
    "The platform's own Solana curve and pool. Coming soon",
    `
**Coming soon.** Neither program is deployed or audited, and neither has a program id yet. Today Solana coins launch on Pump.fun, Raydium LaunchLab and Meteora.

- **Stealth BC**: the platform's own bonding curve. The creator picks where a coin graduates (Stealth AMM by default, or Raydium, PumpSwap or Meteora), locked at launch.
- **Stealth AMM**: one coin / SOL pool per coin, its liquidity locked for good.

Planned: a 70/30 split of the tier on every tier, and the anti-sniper fee on every coin. The numbers in the design repositories are defaults and describe a design, not a live product.
`,
  ),
  page(
    "trading",
    "Trading",
    "Quotes, routes, slippage",
    `
Trades are built by the API. On Solana you sign them in your wallet; on EVM chains through the site, a hidden wallet signs after your wallet signs for it.

Before graduation a coin trades on its bonding curve (Solana) or its pool (EVM); after, on PumpSwap, Raydium CPMM, Meteora DAMM v2, or the same EVM pool. These are standard programs, so coins trade in other apps too, at the same fees.

A quote shows what you receive, the tax on this trade, the price impact and the **minimum received** your slippage allows: if the price moves further, the trade is refused and nothing is spent. In a coin's first 15 seconds on Meteora or EVM the anti-sniper fee applies to every trade but the launcher's first buy.
`,
  ),
  page(
    "token-page",
    "The token page",
    "Chart, bubbles, activity, holders and risk",
    `
**Chart**: candles from 1s to 1D, price or market cap, USD or the pair token. Bubbles mark the launcher's trades, platform events (burns, graduation, marketing steps, claims), Feed callouts, posts on X that reached the Stealth agent, and your own trades.

**Activity** tags: First buy, Launcher, Creator (after a CTO), Sniper (paid the sniper-window fee).

**Risk card** (pools and the platform's wallets never count as holders):

| Line | Green | Amber | Red |
| --- | --- | --- | --- |
| Top 10 holders' share | up to 30% | up to 50% | above |
| Launcher + creator hold | up to 5% | up to 10% | above |
| Launcher or creator sold | | amber when they did | |
| Snipers still hold | up to 5% | up to 15% | above |

First-block buyers besides the launcher's first buy can mean a bundled launch.

Top traders show bought, sold, unrealized and PnL. Holders, Buy back and Marketing coins show their payouts, burns or ladder. Multi-chain coins have a tab per chain, never summed. The official $STEALTH page adds its burnt-tokens and dev-wallet-lock panels. A buy-back or burn isn't a promise of any price or value.
`,
  ),
  page(
    "social-vaults",
    "Social vaults",
    "Fees for a named account, and claiming them",
    `
Built and **currently off**. A Social launch names a person by their account on X, Twitch or GitHub; creator fees wait in a vault for them and **the launcher gets none**. A live lookup binds the coin to the account's permanent id, so a rename doesn't break it.

**The person named hasn't agreed to anything** and doesn't endorse the coin unless they say so. To claim, they sign in with that account and sign with a wallet; the first claim binds that wallet. Every coin naming them stacks in one vault. Per-claim and daily limits apply, and fees never go back to the launcher.

Just Stealth It holds the keys of every social vault.
`,
  ),
  page(
    "feed",
    "The Feed",
    "Posts, profiles and the Fees tab",
    `
The Feed shows what's happening on every chain: automated platform posts made from on-chain events (launches, graduations, marketing steps, burns, dev buys, claims) and what people post. Its Fees tab shows payouts by launch type.

Posting needs a proven wallet or a verified social account. Posts are up to 500 characters with up to 3 https links and 1 image. Moderators can hide posts and ban profiles. Posts are their authors' views and platform posts are automated; none of it is advice.
`,
  ),
  page(
    "telegram",
    "Telegram and X",
    "The group, the X account and the bot's private chat",
    `
Launches and events post to the group at t.me/juststealthit, by topic. The X account (x.com/juststealthit) posts platform updates and memes, and the Stealth agent replies to questions about coins; its generated text can be wrong, so check the transaction and the coin's page. Neither is a support channel.

The bot's private chat (a Solana launch terminal and wallet whose key the platform holds) is built and **currently off**.
`,
  ),
  page(
    "cto",
    "CTO (community takeover)",
    "How holders take over an abandoned coin's creator fees",
    `
If a creator walks away, holders who keep the coin alive can apply to receive its creator fees. The applicant holds the amount the form asks for, posts a verification on X, shows their work for the coin, answers a few questions and signs a message (nothing moves). The team reviews every application by hand.

An approved change is announced on the token page with a **24-hour notice**, during which it can be cancelled. After it, creator fees go to the new wallet. **The backlog stays with the old creator.** On EVM the new creator must also accept, and the admin can cancel.
`,
  ),
  page(
    "perps",
    "Perps",
    "Perpetuals and spot on Hyperliquid, Jupiter and Aster",
    `
The Perps section (juststealthit.xyz/perps) shows markets from three venues side by side. You trade on the venue itself, from your own wallet.

| Venue | Chain | Markets | Trading on the site |
| --- | --- | --- | --- |
| Hyperliquid | HyperCore | Every listed perp, and spot pairs | On, from an EVM wallet |
| Jupiter Perps | Solana | SOL, ETH and BTC | On, from a Solana wallet |
| Aster | BNB Chain | USDT perps, some stocks and commodities | Markets and charts now; trading coming soon |

Positions are held by the venue, not by Just Stealth It, which holds no keys for perps. This server reads market data only and places no orders.

Perpetuals use leverage and can lose more than you expect; a position can be liquidated. Perps aren't available in every country. Nothing here is advice or a promise of any return.
`,
  ),
  page(
    "staking",
    "Staking",
    "Stake $STEALTH, hold stSTEALTH, earn $STEALTH. Opening soon",
    `
Built, tested and **opening soon**; rates are announced at launch. Staking runs on Solana, from **Wallet → Stake**.

1. **Stake**: $STEALTH goes into an escrow wallet of your own and you get **stSTEALTH** 1:1, the receipt.
2. **Earn**: rewards accrue every second, in $STEALTH, at the pool's published rate.
3. **Boost**: the rate rises in steps the longer the stake stays open, counted from the first stake.
4. **Unstake**: hand back stSTEALTH; your $STEALTH comes back **6 hours** later with its share of rewards, by itself. Coins on their way back don't earn.

A first stake also puts a small SOL deposit in your escrow for payout network fees, returned when you've unstaked everything. Keep stSTEALTH in the wallet that staked: without it you can't unstake.

Rewards come from a reward pool and stop while it's empty. Estimates use today's rate and aren't promises. The platform holds each staking escrow's key. Staking isn't audited.
`,
  ),
  page(
    "safety",
    "Safety and trust",
    "What the platform can and can't do, and how far it's tested",
    `
A wallet you connect stays yours; the platform never sees its keys.

**Can't:** mint coins; change a coin's tax or launch type after launch; pull the liquidity of a graduated Raydium LaunchLab or Meteora coin or an EVM coin; stop a coin trading on chain (it can only hide a coin from its own lists).

**Can:** control each coin's escrow and act on it by the launch type; apply launch types with its bot (only Pump.fun's split and the EVM split are locked on chain); move a coin's creator fees to a new wallet only through a CTO with public notice; change launch settings for future launches; move funds in a social vault.

**Keys it holds:** Telegram wallets, hidden wallets, social vaults, Auto Liquidity wallets, every coin's escrow and, once staking opens, every staking escrow. None for perps.

**EVM roles:** the distributor (ops bot) is the main trust point: a compromised key could pay a Holders or Pot pot to any address and spend a Buyback pot at a bad price, bounded by the pots.

**Audit:** none. The EVM contracts are unaudited, and no independent audit of servers, bots or fee logic is claimed. Every launch type ran on all three Solana venues on devnet; the EVM contracts have unit, fork, differential and invariant tests.

Nobody from Just Stealth It will ever ask for your recovery phrase. Support is the form at juststealthit.xyz/status.
`,
  ),
  page(
    "addresses",
    "Addresses",
    "The official coin, programs and contracts",
    `
**$STEALTH** on Solana: \`GoDSW31bTxfkoup9yA1qcGGx9RMXdTEWgApv3xzBmoA\`. Any other address claiming to be the official coin isn't.

Solana programs belong to the venues: Pump.fun \`6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P\`, PumpSwap \`pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA\`, Raydium LaunchLab \`LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj\`, Raydium CPMM \`CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C\`, Meteora DBC \`dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN\`, Meteora DAMM v2 \`cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG\`.

EVM (Robinhood Chain, Base, Arc and BNB Chain share most addresses): factory \`0xF828FD2DB63E3aF84f950eFcF601dE1B679B567d\`, fee vault \`0x5F15d599BA849554A40975333a7e39F537c37e61\`, locker \`0x6e0C6a185ACd0b5CB8050823aB570A5565Bebf34\`, router \`0x887724eBE323e7C4aBF4a240DDBa6828Bc89F6a6\`. Hooks differ by chain, and HyperEVM has its own set. An address can mean different contracts on different chains: always match the chain to the table on the full page.
`,
  ),
  page(
    "faq",
    "FAQ",
    "Short answers",
    `
- **Can a creator mint more or pull liquidity?** No. Supply is fixed, and liquidity is locked at graduation (Raydium LaunchLab, Meteora) or from launch (EVM).
- **Is a multi-chain launch one coin?** No: a separate coin per chain, not bridged.
- **Refunds?** A launch that landed can't be undone or refunded.
- **Does "100% of creator fees" mean 100% of the tax?** No, it's the coin's part of the fee.
- **When do holders get paid?** Every 10 minutes on Holders coins, for wallets with 10,000+ tokens, in the pair token.
- **Why is the Raydium coin share smaller at high tiers?** Raydium caps the creator fee at 0.5%.
- **Does the platform hold perps positions?** No, the venue does.
- **Is staking open?** Not yet; it opens soon. stSTEALTH is the 1:1 receipt; unstaking takes 6 hours.
- **Are the contracts audited?** No.
- **Did a person named on a coin agree to it?** No.
- **Is any of this advice?** No. Coins are created by anyone, and you can lose everything you put in.
`,
  ),
  page(
    "glossary",
    "Glossary",
    "The words used across the platform",
    `
- **Anti-sniper fee**: 90% at launch falling to the tax over 15 s, on Meteora and EVM.
- **Bonding curve**: the pricing a coin trades on before it graduates.
- **Creator fees**: the coin's part of the fee; the launch type decides where it goes.
- **CTO**: community takeover of a coin's creator fees, after public notice.
- **Distributor**: the ops bot's role in the EVM contracts.
- **Escrow**: the coin's own account creator fees land in (on EVM, the fee vault).
- **Graduation**: the curve sells out and the coin moves to a pool (on EVM, a price level).
- **Hidden wallet**: an EVM wallet the platform holds for a Solana wallet.
- **Launch type**: where creator fees go, locked at launch.
- **Mix**: 2 to 5 launch types in fixed shares.
- **Pair**: what a coin trades against.
- **Pot**: money a coin keeps to spend on its launch type.
- **stSTEALTH**: the 1:1 receipt for staked $STEALTH.
- **Tax tier**: the fee every trade pays, 1.25% to 5.75%.
- **Venue**: where a coin launches.
`,
  ),
];

export const DOC_SLUGS = DOC_PAGES.map((p) => p.slug);
export const docPage = (slug: string) => DOC_PAGES.find((p) => p.slug === slug) ?? null;
