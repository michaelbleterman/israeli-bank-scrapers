# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A TypeScript library providing scrapers for all major Israeli banks and credit card companies. It drives a headless Chromium (via Puppeteer) to log into each provider's web app and extract transactions/balances. The public API is small: `createScraper(options)`, the `CompanyTypes` enum, and the `SCRAPERS` metadata map (all re-exported from `src/index.ts`).

Published twice from the same source: `israeli-bank-scrapers` (default, bundles `puppeteer` + Chromium) and `israeli-bank-scrapers-core` (uses `puppeteer-core`, caller supplies Chromium via `executablePath`). See the `prepare:core` flow below.

## Commands

```sh
npm run build          # lint + clean + emit types (tsc) + transpile (babel) to lib/
npm run type-check     # tsc --noEmit (fast feedback, no output)
npm run lint           # eslint src + prettier --check
npm run lint:fix       # eslint --fix + prettier --write
npm test               # jest (REQUIRES test config file, see below)
```

Run a single test suite / test by name (jest `testNamePattern`):

```sh
npm test -- --testNamePattern="Leumi legacy scraper"
npm test -- --testNamePattern="Leumi legacy scraper should expose login fields in scrapers constant"
```

### Tests require config and have two modes

`npm test` fails unless `src/tests/.tests-config.js` exists. Create it from `src/tests/.tests-config.tpl.js` (the `test:ci` script does this copy automatically; the real file is gitignored — never commit it). Alternatively set the `TESTS_CONFIG` env var to a JSON string.

Tests run against **real bank APIs** using credentials in the config (a company is silently skipped if no credentials are given), OR against mock data. Real-API tests also require `companyAPI.enabled: true`. The `options` object in the config is passed as-is to the scraper.

**Babel ignores test files by default.** When running tests through an IDE, set `BABEL_ENV=test` in the run configuration or tests won't be picked up. (Jest via `npm test` uses `ts-jest`, configured in `jest.config.js`, and is unaffected.)

## Architecture

### Scraper class hierarchy

```
BaseScraper                    src/scrapers/base-scraper.ts
  └─ BaseScraperWithBrowser    src/scrapers/base-scraper-with-browser.ts
       └─ <concrete scrapers>  hapoalim.ts, leumi.ts, max.ts, ...
```

- **`BaseScraper`** orchestrates `scrape()` → `initialize()` → `login()` → `fetchData()` → `terminate()`, wraps each phase in try/catch converting throws into typed error results (`TIMEOUT` vs `GENERIC`), and emits `ScraperProgressTypes` events via `onProgress`. All these methods are meant to be overridden.
- **`BaseScraperWithBrowser`** owns the Puppeteer lifecycle: launches/attaches a browser, manages a `cleanups` stack run in reverse on terminate, and implements a generic form-based `login()` driven by `getLoginOptions()`. Most concrete scrapers only override `getLoginOptions()` and `fetchData()`.
- Some scrapers (e.g. **OneZero**, `one-zero.ts`) are API/GraphQL-based and override more of the flow; `OneZeroScraper` is also re-exported directly from `index.ts`.

Shared base classes for provider families: `base-isracard-amex.ts` (Isracard/Amex), `base-beinleumi-group.ts` (Beinleumi/Massad/Pagi/Otsar Hahayal share login logic).

### Adding / registering a scraper

1. Create `src/scrapers/<name>.ts` extending `BaseScraperWithBrowser`; implement `getLoginOptions(credentials)` and `fetchData()`.
2. Add the company to the `CompanyTypes` enum and the `SCRAPERS` metadata map in `src/definitions.ts` (these keys are **public API** — don't rename existing ones).
3. Add a `case` in `src/scrapers/factory.ts` (the `default` calls `assertNever`, so a missing case is a type error).
4. Add credentials shape — `ScraperCredentials` is a union in `src/scrapers/interface.ts`.

### How data is actually fetched

Browser-based scrapers don't parse HTML. After login they run `fetch` **inside the page context** (`src/helpers/fetch.ts`: `fetchGetWithinPage` / `fetchPostWithinPage`) so requests carry the bank's own session/cookies/headers, then map the JSON responses into the normalized `Transaction` / `TransactionsAccount` shapes (`src/transactions.ts`). Some scrapers read globals injected by the bank's SPA (e.g. Hapoalim's `window.bnhpApp`).

### Login result matching

`getLoginOptions()` returns `possibleResults: PossibleLoginResults` — a map from `LoginResults` (Success/InvalidPassword/ChangePassword/...) to an array of matchers. After submit, the post-login URL is tested against each matcher (string equality, `RegExp`, or an async `({page}) => boolean` predicate) to classify the outcome. This is the main thing to get right for a new scraper.

### Two-factor auth and device trust

Two distinct mechanisms (see README "Two-Factor Authentication Scrapers"):
- **OTP callback / long-term token**: credentials may carry an `otpCodeRetriever` callback (Hapoalim, OneZero) or `otpLongTermToken` (OneZero, which also implements `triggerTwoFactorAuth` / `getLongTermTwoFactorToken`).
- **`deviceTrustData`** (`interface.ts`): cookies + localStorage + the capturing `origin`. `BaseScraperWithBrowser` extracts it after a successful scrape (returned on `result.deviceTrustData`) and injects it on the next run via `options.deviceTrustData` to skip OTP. **localStorage is origin-scoped** — it must be restored on the same `origin` it was captured from, otherwise the bank re-challenges 2FA (this is why `origin` is persisted; see `injectDeviceTrustData`). A runnable end-to-end example is `examples/hapoalim-2fa-device-trust.ts`.

### Conventions

- All scrapers force timezone `Asia/Jerusalem` (`moment.tz.setDefault` in `BaseScraper.initialize`) so date math is correct regardless of host TZ.
- Helpers live in `src/helpers/` — prefer them over ad-hoc Puppeteer calls: `elements-interactions.ts` (fill/click/wait), `navigation.ts`, `waiting.ts` (`sleep`, `waitUntil`, `TimeoutError`), `debug.ts` (`getDebug('<scraper>')`, namespaced under the `debug` package — run with `DEBUG=*` for trace output).
- Error types are centralized in `src/scrapers/errors.ts` (`ScraperErrorTypes`); return these, don't invent strings.

## Building the `-core` variant

`npm run prepare:core` (in `utils/prepare-israeli-bank-scrapers-core.js`) does a `git reset --hard`, swaps `puppeteer` → `puppeteer-core` and renames the package, reinstalls, and rebuilds. Run `npm run reset` afterwards to restore. The Chromium revision the core build expects is hard-coded in `getPuppeteerConfig()` in `src/index.ts` — keep it in sync when bumping puppeteer.
