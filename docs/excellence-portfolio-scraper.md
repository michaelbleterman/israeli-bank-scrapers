# Design: Excellence (Extrade Pro) Portfolio Scraper

| | |
|---|---|
| **Status** | Implemented — scraper + unit tests + live e2e validated (2026-06-24); auth model corrected against live run (§7.1) |
| **Branch** | `feat/excellence-portfolio-scraper` |
| **Target** | `https://extradepro.xnes.co.il` (Excellence Trade / Extrade Pro, owned by The Phoenix) |
| **Goal** | Scrape **live portfolio positions + total account value** (a snapshot) |
| **Non-goal** | Bank-style cash transaction history |
| **Date** | 2026-06-24 |

> Implementation and testing are deliberately out of scope for this document. The API
> surface in Section 7 was captured from a live, logged-in session (DevTools / Playwright);
> field names and types are documented, but no real account values or tokens are recorded
> here.

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
| **2FA**: `otpCodeRetriever` callback pattern | Hapoalim / OneZero | ➖ not needed (no OTP — §7.1); keep defensive detection only |
| **Device trust**: cookies + origin-scoped localStorage inject/extract | `base-scraper-with-browser.ts:337` | ➖ not needed (no client trust artifact — §7.5) |
| In-page JSON fetch | `src/helpers/fetch.ts` | ⚠️ reuse, but must add `session`/`csession` headers (token auth, not cookies — see §7.1) |
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
  name: string;            // security name        <- Meta.Security.HebName/EngName
  symbol?: string;         // ticker               <- Meta.Security.Symbol (often null for IL)
  securityId: string;      // Excellence EquityNumber/Key (their internal id, NOT ISIN)
  isin?: string;           // ISIN if resolvable (not directly in balances response)
  assetType?: AssetType;   // <- Meta.Security.ItemType/StockType/IsEtf/IsForeign
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
- **Identifier reality.** The balances response identifies securities by Excellence's
  internal `EquityNumber` (`securityId`), not ISIN. ISIN is not in that payload; if needed
  it must be resolved via a separate market/security lookup, so `isin` is optional.
- **Quantity/value source.** Use `OnlineNV` for `quantity`, `OnlineVL` for `marketValue`
  (native currency) and keep `OnlineNisVL` as an ILS-converted value; `AveragePrice` →
  `averageCost`. These map cleanly (see §7.4).

> Field names reconciled against the live response in Section 7.

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

## 7. Captured API surface (live session, 2026-06-24)

Captured by driving a logged-in session from an Israeli IP. The site is a **single-page app
backed by a clean REST/JSON API** under `https://extradepro.xnes.co.il/api/v2/json2/`
(a second host prefix `/dapi/v2/json2/` serves delayed/streaming market data). No GraphQL.
HTML is never parsed.

> The WAF that returned **HTTP 473** to an unauthenticated US fetch did **not** block a real
> browser on an Israeli IP — the login page and API loaded normally. A headed Puppeteer
> Chromium on an Israeli IP is expected to get through; an Israeli IP is likely required.

### 7.1 Authentication
> **Corrected against the live implementation run (2026-06-24).** The login *body* and the
> `session`/`csession` relationship below supersede the earlier capture notes (the Hebrew
> strings `שם משתמש`/`סיסמה` are the on-screen field **labels**, not the JSON keys).

- **Login:** `POST /api/v2/json2/login` with the JSON body
  **`{"Login":{"User":"<username>","Password":"<password>"}}`** and a `csession` request
  header (see below). Response body: `Login.SessionKey` (a UUID — the session token), plus
  `-LastLogin`, `-PasswordExpiry`, `Capabilities`, `Attributes` (incl. display name `Name`).
- **Session is token-based, not cookie-based.** Authenticated calls carry two **custom
  request headers**:
  - **`session`** = the `Login.SessionKey` UUID from the login response.
  - **`csession`** = a **client-generated** value (the SPA uses `String(Math.random())`,
    e.g. `"0.4381..."`). It is sent on **every** request **including `/login` itself**, and
    the server binds the issued `SessionKey` to whatever `csession` accompanied the login —
    so the **same** `csession` must be reused for the whole session. It is not derived from
    `SessionKey`.
  - There is no `Authorization` header and no auth cookie. **Implication for the scraper:**
    the in-page `fetch` helpers must set both headers explicitly; a plain cookie-based
    `fetchGetWithinPage` will **not** auto-authenticate. (Implemented in
    `src/scrapers/excellence.ts`.)
- **2FA / OTP — validated, none required.** Two logins were tested: (a) the normal session,
  and (b) a login from a **fully cleared context** — `context.clearCookies()` plus wiped
  localStorage, sessionStorage, and IndexedDB, i.e. a brand-new-device equivalent. **Both
  reached `/app` with username + password only; no OTP/SMS was ever prompted.** This rules
  out client-side device trust (there was nothing to carry, yet a clean device still logged
  in). See §7.5 for the storage audit. **Conclusion:** the scraper needs only
  username + password — no `otpCodeRetriever`, no `deviceTrustData`. (Caveat: tested on one
  account; 2FA could be enabled per-account, so the scraper should still *detect* an OTP
  challenge defensively — see §8.)

### 7.2 Post-login flow (observed order)
1. `POST /api/v2/json2/login` → `SessionKey`.
2. `GET  /api/v2/json2/settings/web-trader-excellence` → UI settings.
3. `GET  /api/v2/json2/accounts?top=10` → account list (see §7.3).
4. `POST /api/v2/json2/account/init?account=<acct>` → activates the account for the
   session (returns `SessionKey`, capabilities again).
5. `GET  /api/v2/json2/account/view/balances?account=<acct>&currency=ILS&fields=...`
   → **positions + account totals** (see §7.4). This single call covers the whole goal.

Post-login landing URL: `https://extradepro.xnes.co.il/app` (for `possibleResults`:
success = URL is `/app`; failure stays on `/login`).

### 7.3 Account enumeration — `GET /accounts?top=10`
```
UserAccounts.UserAccount[]   // one per portfolio
  -key      // account number, format "NN-NNNNNN" (e.g. "00-000000")
  -name     // account holder display name
  -telCode  -relation  -nickName  -type
```

### 7.4 ★ Holdings + totals — `GET /account/view/balances?account=<acct>&currency=ILS`
Single response gives both the account summary and every position.

**Account-level totals** (`View.Account`):
```
OnlineValue              // current total portfolio value  -> PortfolioAccount.totalValue
MorningValue             // start-of-day total value
OnlineCash               // current cash                   -> PortfolioAccount.cash
MorningCash
OnlineCashByCurrency[]    { Code, Value }   // multi-currency cash breakdown
CurrencyCode             // account base currency (ILS)    -> PortfolioAccount.baseCurrency
ProfitLoss, ProfitLossPercentage
OnlineBuyingPower, ExistingCollateral, IncomeToReceive, ... (margin/collateral fields)
BalanceCacheDate         // ISO timestamp of the snapshot   -> Position.asOf
```

**Positions** (`View.Account.AccountPosition.Balance[]`, one per holding) joined with
**security metadata** (`View.Meta.Security[]`) on `EquityNumber` == `-Key`:
```
Balance[]                                  Meta.Security[] (joined by Key)
  EquityNumber  // security id (Excellence    -Key      // == EquityNumber
                //  internal "key", not ISIN)  HebName / EngName   -> Position.name
  OnlineNV      // current quantity            HebSymbol/EngSymbol/Symbol -> Position.symbol
  AvailableNV   // available quantity                              //  (often null for IL)
  LastRate / BaseRate   -> Position.marketPrice  ItemType / StockType / IsEtf / IsForeign
  OnlineVL      // market value (security ccy)                     //  -> Position.assetType
  OnlineNisVL   // market value in ILS
  AveragePrice  -> Position.averageCost
  ProfitLoss, AveragePriceProfitLoss, AveragePriceProfitLossPercentage -> P/L fields
  OnlinePercentage   // weight in portfolio
  CurrencyCode  -> Position.currency
  ExpiryDate, ValueDate, SubAccount, SubAccountName, LienNv, LoanNv
```
Terminology: `NV` = nominal value (quantity / face value), `VL` = value (market value),
`Nis` = ILS. Sample account had 17 positions.

### 7.5 Storage audit — no persistent auth or device-trust artifact
Full client-storage audit of a logged-in session (values redacted throughout):

| Store | Entries | Auth/trust relevant? |
|---|---|---|
| Cookies | `_ga`, `_ga_XB6GC1W64C` (Google Analytics, `.xnes.co.il`, ~400d), `GCLB` (httpOnly, **session-scoped** GCP load-balancer affinity) | **No** |
| localStorage | `lastActive`, `SOLITICS_CONFIGURATION` (marketing SDK), `TRANSACTIONS_QUEUE_NAME`, `recentKeys` | **No** |
| sessionStorage | `state` (~33 KB app state), `csession`, `orders-cart` | Holds the **ephemeral** `session`/`csession` tokens — **tab-scoped, wiped on close** |
| IndexedDB | `firebase-heartbeat-database` (push-notification heartbeat) | **No** |

Findings:
- The `session`/`csession` auth tokens live **only in sessionStorage** (ephemeral) and are
  regenerated on every login from the `SessionKey` returned by `POST /login`.
- There is **no long-lived device-trust token** anywhere on the client.
- A login from a **fully wiped context still required no OTP** (§7.1), so trust is not
  client-side. Whatever suppresses OTP is server-side (e.g. account 2FA disabled, or
  IP/fingerprint recognition) and is outside the scraper's control or need.

**Design consequence:** drop `deviceTrustData` and `otpCodeRetriever` from this scraper's
required path — plain username + password is sufficient. This unknown is now **closed**.

---

## 8. Implementation change list (deferred)

Standard "register a scraper" path; only step 1 and the `portfolioAccounts` field are
genuinely new.

1. **New** `src/portfolio.ts` — `AssetType`, `Position`, `PortfolioAccount`.
2. **Edit** `src/scrapers/interface.ts` — add `portfolioAccounts?` to
   `ScraperScrapingResult`; add Excellence credentials shape to the `ScraperCredentials`
   union: **`{ username; password }`** (validated: no OTP / no device trust — §7.1/§7.5).
3. **Edit** `src/definitions.ts` — add `excellence` to `CompanyTypes` and a `SCRAPERS`
   entry (`name: 'Excellence'`, `loginFields: ['username', PASSWORD_FIELD]`).
4. **New** `src/scrapers/excellence.ts` — `extends BaseScraperWithBrowser`:
   - `getLoginOptions()` — `loginUrl` `/login`, fields `שם משתמש`/`סיסמה`, success when the
     post-login URL is `/app`. (The actual submit may be a JSON `POST /login`; if the DOM
     form is awkward to drive, override `login()` to POST directly like OneZero.)
   - `fetchData()` — call `GET /accounts` → for each account `POST /account/init` then
     `GET /account/view/balances?account=<acct>&currency=ILS`, and map `View.Account` +
     `AccountPosition.Balance[]` ⨝ `Meta.Security[]` into `portfolioAccounts` (§7.4).
   - **Auth detail:** authenticated requests need the custom `session` / `csession`
     headers (from `SessionKey`), so the in-page fetch must set them explicitly — a plain
     cookie-based `fetchGetWithinPage` is insufficient (§7.1).
5. **Edit** `src/scrapers/factory.ts` — one `case CompanyTypes.excellence`.
6. **Edit** `src/index.ts` — export `Position` / `PortfolioAccount` / `AssetType`.
   - **Defensive 2FA detection:** although this account needs no OTP, add an OTP/2FA
     challenge screen as a recognized `possibleResults` outcome so accounts that *do* have
     2FA fail loudly (clear error) instead of silently — full OTP support can come later if
     a 2FA-enabled account is available to capture.
7. **Tests** — mock-data unit test for the §7.4 mapping; real-API test gated on credentials
   per `CONTRIBUTING.md`.

### Open items
- _None blocking._ Device-trust/OTP question is **closed** (§7.5). If a 2FA-enabled account
  becomes available, capture its OTP flow to implement `otpCodeRetriever` for that case.

---

## 9. Legal note (carried from feasibility review)

Not legal advice. Relative to existing bank scrapers, a broker is **higher-risk**:
brokerage T&C typically prohibit automation; market data is often **exchange-licensed** with
redistribution limits; Excellence is **ISA-regulated**; and the active WAF is itself a
signal that automated access is unwelcome. It nonetheless rests on the same basis the
project already operates on — the user accessing **their own account, with their own
credentials, on their own machine**, for personal use. Confirm against Excellence's actual
Terms of Service before relying on it.
