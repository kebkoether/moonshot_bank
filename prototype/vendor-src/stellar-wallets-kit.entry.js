/**
 * Bundle entry for the self-hosted Stellar Wallets Kit.
 *
 * public/index.html previously imported this library — the code that runs
 * fetchAddress() and signMessage() — as six separate live ES modules from
 * https://esm.sh/@creit.tech/stellar-wallets-kit@2.3.0?bundle. `?bundle` means
 * a third party resolved the transitive dependency graph at request time, so
 * the exact bytes executing in every visitor's browser were never pinned, and
 * a hijacked response could have swapped in a fake wallet modal.
 *
 * Re-exports exactly what the page uses, and nothing else, so the bundle stays
 * small and the surface is obvious.
 *
 * Rebuild with:  npm run build:vendor
 * (The version is pinned in package.json; keep the output filename in step.)
 */
// The kit 2.3.0 renders its modal with preact + htm + twind, not web
// components — so there is nothing to register via customElements.define() and
// no side-effect import is needed here. The modal UI does come through: the
// bundle contains the auth-options page and twind's runtime, reached via the
// SDK's own imports. There is a test asserting that.
//
// twind injects a <style> element at runtime, which is one of the reasons the
// CSP keeps style-src 'unsafe-inline'.

export { StellarWalletsKit, Networks } from "@creit.tech/stellar-wallets-kit";
// Freighter is now Varial (kit 2.8.0): same extension and API, new name and
// wallet id ("varial"). The old FreighterModule / FREIGHTER_ID names are
// deprecated aliases of these.
export { VarialModule, VARIAL_ID } from "@creit.tech/stellar-wallets-kit/modules/varial";
export { LobstrModule, LOBSTR_ID } from "@creit.tech/stellar-wallets-kit/modules/lobstr";
export { AlbedoModule, ALBEDO_ID } from "@creit.tech/stellar-wallets-kit/modules/albedo";
export { HanaModule, HANA_ID } from "@creit.tech/stellar-wallets-kit/modules/hana";
export { RabetModule, RABET_ID } from "@creit.tech/stellar-wallets-kit/modules/rabet";
