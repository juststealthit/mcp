/**
 * Links into juststealthit.xyz and the chains' explorers. The site's address follows the API's: `https://host/api` → `https://host`,
 * so a staging API links to its own site.
 *
 * @module
 */
import { coinPageUrl, explorerUrl } from "@juststealthit/sdk/utils";

export class Links {
  readonly site: string;

  constructor(apiUrl: string, siteUrl?: string) {
    this.site = (siteUrl ?? siteFromApi(apiUrl)).replace(/\/+$/, "");
  }

  /**
   * A coin's page on the site, where it can be traded from a connected wallet. A coin launched here has a token page (`?chain=` on
   * EVM, since sibling multi-chain coins share an address); an external coin has a trending page.
   */
  coin(address: string, chain = "solana", onPlatform = true): string {
    return coinPageUrl({ address, chain, onPlatform }, this.site);
  }

  perps(): string {
    return `${this.site}/perps`;
  }

  status(): string {
    return `${this.site}/status`;
  }

  home(): string {
    return this.site;
  }

  tx(chain: string, hash: string): string | null {
    return explorerUrl(chain, "tx", hash);
  }

  address(chain: string, address: string): string | null {
    return explorerUrl(chain, chain === "solana" ? "address" : "token", address);
  }
}

export function siteFromApi(apiUrl: string): string {
  try {
    const u = new URL(apiUrl);
    const p = u.pathname.replace(/\/+$/, "");
    return `${u.origin}${p.endsWith("/api") ? p.slice(0, -4) : ""}`;
  } catch {
    return "https://juststealthit.xyz";
  }
}
