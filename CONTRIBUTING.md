# Contributing

Thanks for helping. Issues and pull requests are welcome at [github.com/juststealthit/mcp](https://github.com/juststealthit/mcp).

## Setup

Node 20 or newer.

The server depends on [`@juststealthit/sdk`](https://github.com/juststealthit/sdk), which is **published separately**. Until it's on npm, install it from a local checkout next to this one, without saving a path into `package.json`:

```bash
git clone https://github.com/juststealthit/sdk ../sdk
(cd ../sdk && npm install && npm run build)

npm install --no-save --install-links ../sdk   # installs everything, with the SDK from ../sdk
npm run typecheck
npm test
npm run build
```

`--install-links` copies the SDK in rather than linking it, so the SDK and the server share one copy of `@solana/web3.js` and `viem`. `--no-save` keeps `package.json` declaring `"@juststealthit/sdk": "^0.3.0"` and writes no lockfile pointing at a local path. Once the SDK is on npm, a plain `npm install` works.

| Script | What it runs |
| --- | --- |
| `npm test` | Every test, in memory: MCP sessions over the SDK's in-memory transport, a fake API, a fake WebSocket. No network and no real keys |
| `npm run typecheck` | `tsc` over `src` and `test` |
| `npm run build` | Compiles to `dist/` |
| `npm run inspect` | Opens the built server in the MCP Inspector |

## Layout

| Path | What's there |
| --- | --- |
| `src/cli.ts` | Flags, signing set-up, transports, shutdown |
| `src/server.ts` | One MCP session: tools, resources, prompts, logging |
| `src/context.ts` | What sessions share: clients, cache, prepared actions, the signer |
| `src/tools/` | One file per area. Every tool goes through `defineTool` in `define.ts` |
| `src/actions/` | Building transactions (`solana.ts`, `evm.ts`), prepared actions, the spend ledger and the signer |
| `src/resources.ts`, `src/subscriptions.ts` | Resources and live updates |
| `src/prompts.ts` | Prompts |
| `src/docs/pages.ts` | The bundled docs summaries |
| `src/config.ts`, `src/keystore.ts` | The config directory shared with the Stealth CLI |
| `src/http.ts` | Streamable HTTP, auth and origin checks |

## Guidelines

- **Never write to stdout** outside `--help` and `--version`: on stdio it carries the protocol. Log through `ctx.logger`. A test checks this.
- **Prepare, don't spend.** A new action tool returns transactions for the user's wallet and says so. Anything that signs goes through `LocalSigner`, its caps and its confirmation, and stays Solana-only while the caps are in SOL.
- **Check what you're handed.** A transaction from the API is decoded and its fee payer checked before it's returned or signed.
- **Every tool has an output schema** and returns structured content that matches it. Missing numbers are `null`, never a made-up `0`. Pick the right annotations preset (`READ`, `PURE`, `PREPARE`, `SIGN`).
- **Use only public routes** of the API, through the SDK. Nothing internal or privileged belongs here.
- **Assume no server limits.** Don't hard-code rate limits; the SDK honours `Retry-After`.
- **Make no promises.** Descriptions, prompts and docs must never suggest returns or price outcomes, and perps stay read-only.
- **Test with the fake API** in `test/helpers.ts` (`harness`, `fakeApi`, `call`, `callError`), asserting on the exact requests sent. Generate keys at run time in a temporary directory; never commit one.

## Pull requests

1. Branch from `main`.
2. Add or update tests and the README alongside the code.
3. Run `npm run typecheck && npm test && npm run build`.
4. Describe the change in `CHANGELOG.md`.

## Security

Please don't open a public issue for a vulnerability. Report it privately through the contacts on [juststealthit.xyz](https://juststealthit.xyz).
