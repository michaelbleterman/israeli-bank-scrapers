# Design: Excellence (Extrade Pro) Portfolio Scraper

| | |
|---|---|
| **Status** | Draft — design complete, empirical research pending |
| **Branch** | `feat/excellence-portfolio-scraper` |
| **Target** | `https://extradepro.xnes.co.il` (Excellence Trade / Extrade Pro, owned by The Phoenix) |
| **Goal** | Scrape **live portfolio positions + total account value** (a snapshot) |
| **Non-goal** | Bank-style cash transaction history |
| **Date** | 2026-06-24 |

> Implementation and testing are deliberately out of scope for this document. Section 7
> ("Empirical research") lists the live-capture work that must be completed **before**
> implementation can begin.

---

## 1. Summary

Excellence's Extrade Pro is a **brokerage** platform, not a bank. The library's existing
data model (`TransactionsAccount` / `Transaction`) is a cash ledger and does not represent
securities holdings. However, the scraper *foundations* (browser lifecycle, login, 2FA,
device trust, in-page JSON fetch) are output-shape-agnostic and fully reusable.

The plan: add a new `excellence` scraper that `extends BaseScraperWithBrowser` like every
other scraper, reusing all foundations, and returns a **new portfolio result shape**
(`portfolioAccounts`) added additively alongside the existing `accounts` field.

---

## 2. Why a new data model (not `Transaction`)

A bank/card account is a ledger of cash movements. A brokerage account is a **snapshot of
holdings**: per-security quantity, market price, market value, average cost, unrealized
P/L, asset class, and a per-instrument currency, plus an account-level total value and cash
balance. None of this maps onto the `Transaction` interface (`date`, `chargedAmount`,
`description`, …). Forcing it would discard exactly the data the user wants.

So positions need their own model. Crucially, this does **not** require new foundations —
only a new return shape.

---

## 3. The core insight: only the output shape diverges

`BaseScraper.scrape()` (`src/scrapers/base-scraper.ts:29`) runs
`initialize → login → fetchData → terminate`, wraps each phase in typed error handling,
emits progress events, and **passes `fetchData()`'s return value straight through** without
inspecting its shape.

Therefore the single seam that must change for a portfolio scraper is **what `fetchData()`
returns**. Everything else is reused verbatim.

---

## 4. Reuse map (the "strong foundations")

| Foundation | Where | Reused? |
|---|---|---|
| `scrape()` orchestration, error → `TIMEOUT`/`GENERIC`, progress events | `base-scraper.ts` | ✅ as-is |
| Timezone forced to `Asia/Jerusalem` | `base-scraper.ts:26` | ✅ as-is |
| Browser launch / attach / context, viewport, `cleanups` stack | `base-scraper-with-browser.ts` | ✅ as-is |
| Generic form login via `getLoginOptions()` + `possibleResults` URL matching | `base-scraper-with-browser.ts:245` | ✅ as-is |
| `navigateTo`, screenshot-on-failure, `defaultTimeout` | `base-scraper-with-browser.ts` | ✅ as-is |
| **2FA**: `otpCodeRetriever` callback pattern | Hapoalim / OneZero | ✅ reuse |
| **Device trust**: cookies + origin-scoped localStorage inject/extract | `base-scraper-with-browser.ts:337` | ✅ as-is |
| In-page JSON fetch (carries the platform's own session/cookies) | `src/helpers/fetch.ts` | ✅ reuse |
| Element/navigation/waiting helpers, `getDebug('excellence')` | `src/helpers/` | ✅ reuse |
| Registration path (`CompanyTypes` + `SCRAPERS` + `factory.ts` + credentials union) | `definitions.ts`, `factory.ts`, `interface.ts` | ✅ same pattern, additive |

The Excellence scraper still `extends BaseScraperWithBrowser` and overrides only
`getLoginOptions()` and `fetchData()` — identical to a normal scraper. It just populates a
different result field.

---

## 5. New data model (`src/portfolio.ts`)

```ts
export enum AssetType {
  Stock = 'stock',
  Bond = 'bond',
  Etf = 'etf',
  Fund = 'fund',
  Option = 'option',
  Future = 'future',
  Cash = 'cash',
  Other = 'other',
}

export interface Position {
  name: string;            // security name
  symbol?: string;         // ticker
  isin?: string;           // security id (IL "paper number" / ISIN)
  assetType?: AssetType;
  exchange?: string;

  quantity: number;
  currency: string;        // per-instrument currency (accounts are multi-currency)
  marketPrice?: number;    // current price per unit, in `currency`
  marketValue: number;     // quantity * price, in `currency`

  averageCost?: number;    // avg purchase price per unit
  costBasis?: number;
  unrealizedPnl?: number;
  unrealizedPnlPct?: number;

  asOf?: string;           // ISO timestamp of the snapshot
  rawPosition?: unknown;   // mirrors the `rawTransaction` convention
}

export interface PortfolioAccount {
  accountNumber: string;
  baseCurrency?: string;   // currency the account total is expressed in (e.g. ILS)
  totalValue?: number;     // total portfolio value as REPORTED by the platform
  cash?: number;           // uninvested cash balance
  positions: Position[];
}
```

### Design decisions
- **Snapshot, not time series.** `startDate` / `futureMonthsToScrape` /
  `enableTransactionsFilterByDate` are irrelevant and should be ignored by this scraper. No
  date filtering applies.
- **Multi-currency.** Keep currency **per position**; express `totalValue` in the account's
  `baseCurrency`.
- **Prefer reported totals over computed.** Capture `totalValue` / `marketValue` as the
  platform displays them rather than recomputing from price × qty, to avoid FX/rounding
  drift. Keep `rawPosition` for fidelity.
- **`includeRawPosition`** — reuse the existing `includeRawTransaction` option flag (or add
  a parallel one) to gate `rawPosition`.

> Field names above are provisional and will be reconciled against the actual platform
> response in Section 7.

---

## 6. Integration approach — recommended: additive result field

Add one optional field to `ScraperScrapingResult` (`src/scrapers/interface.ts`):

```ts
export interface ScraperScrapingResult {
  success: boolean;
  accounts?: TransactionsAccount[];       // existing bank/card scrapers
  portfolioAccounts?: PortfolioAccount[]; // NEW — brokerage scrapers
  futureDebits?: FutureDebit[];
  errorType?: ScraperErrorTypes;
  errorMessage?: string;
  deviceTrustData?: DeviceTrustData;
}
```

- **Purely additive / non-breaking.** Existing scrapers and consumers untouched.
- `Scraper<TCredentials>` interface and `createScraper()` need **no signature change** —
  they already return `ScraperScrapingResult`.
- Excellence's `fetchData()` fills `portfolioAccounts`, leaves `accounts` undefined.

**Rejected alternatives:**
- *Generic result type* `Scraper<TCredentials, TResult>` — more type-safe but ripples
  through the factory and every consumer; effectively breaking.
- *Separate base class / `fetchPortfolio()` method* — breaks the uniform `fetchData()`
  contract the orchestration relies on and duplicates wiring. Overkill.

---

## 7. Empirical research (MUST complete before implementation)

The login surface is gated behind a WAF (the login page returned **HTTP 473** to an
unauthenticated, non-Israeli fetch) and almost certainly requires an Israeli IP, a real
account, and 2FA. These items can only be resolved with the account holder's participation
and a live, logged-in session.

**Capture checklist** (do a manual login with browser DevTools → Network open, then export
a HAR, or drive a local browser session):

- [ ] **Login URL & flow** — confirm `https://extradepro.xnes.co.il/login`; record any
      redirects and the post-login landing URL (needed for `possibleResults`).
- [ ] **Login fields** — exact input selectors and which identifiers are required
      (username? ID? password? client number?).
- [ ] **2FA** — is OTP/SMS enforced on every login? Is there a "trust this device" option?
      Capture whether device-trust cookies/localStorage suppress re-challenge (drives
      reuse of `otpCodeRetriever` + `deviceTrustData`).
- [ ] **Bot protection** — what triggers the 473 / any challenge page; whether a normal
      Puppeteer Chromium with an Israeli IP gets through.
- [ ] **Holdings endpoint** — the XHR/GraphQL call(s) that return positions; capture the
      full request (method, URL, headers, body) and the JSON response shape.
- [ ] **Account total / cash endpoint** — the call returning total portfolio value, cash
      balance, and base currency (may be the same response as holdings).
- [ ] **Account enumeration** — how multiple accounts/portfolios per login are listed.
- [ ] **Field mapping** — map the real response fields onto Section 5's `Position` /
      `PortfolioAccount` (symbol, ISIN, quantity, price, market value, avg cost, P/L,
      asset type, currency).

**How the user can help (credentials never pasted into chat):**
- Option A — perform a manual login and **export a HAR file** of the holdings page load;
  share the (redacted) HAR so endpoints/response shapes can be mapped.
- Option B — run a **local browser-automation session** (e.g. Playwright MCP on the user's
  own Israeli-IP machine) where the user enters credentials/OTP directly into the browser,
  and we observe the network calls.

Once Section 7 is filled in, Section 5's model is finalized and implementation (Section 8)
can proceed.

---

## 8. Implementation change list (deferred)

Standard "register a scraper" path; only step 1 and the `portfolioAccounts` field are
genuinely new.

1. **New** `src/portfolio.ts` — `AssetType`, `Position`, `PortfolioAccount`.
2. **Edit** `src/scrapers/interface.ts` — add `portfolioAccounts?` to
   `ScraperScrapingResult`; add Excellence credentials shape to the `ScraperCredentials`
   union (likely `{ username; password; otpCodeRetriever? }`, pending Section 7).
3. **Edit** `src/definitions.ts` — add `excellence` to `CompanyTypes` and a `SCRAPERS`
   entry (`name: 'Excellence'`, `loginFields`).
4. **New** `src/scrapers/excellence.ts` — `extends BaseScraperWithBrowser`; implement
   `getLoginOptions()` and `fetchData()` (call holdings/total endpoints in-page → map to
   `portfolioAccounts`).
5. **Edit** `src/scrapers/factory.ts` — one `case CompanyTypes.excellence`.
6. **Edit** `src/index.ts` — export `Position` / `PortfolioAccount` / `AssetType`.
7. **Tests** — mock-data unit test for the mapping; real-API test gated on credentials per
   `CONTRIBUTING.md`.

---

## 9. Legal note (carried from feasibility review)

Not legal advice. Relative to existing bank scrapers, a broker is **higher-risk**:
brokerage T&C typically prohibit automation; market data is often **exchange-licensed** with
redistribution limits; Excellence is **ISA-regulated**; and the active WAF is itself a
signal that automated access is unwelcome. It nonetheless rests on the same basis the
project already operates on — the user accessing **their own account, with their own
credentials, on their own machine**, for personal use. Confirm against Excellence's actual
Terms of Service before relying on it.
