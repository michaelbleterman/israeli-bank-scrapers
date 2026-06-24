"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;
exports.detectOtpChallenge = detectOtpChallenge;
exports.mapAssetType = mapAssetType;
exports.mapBalancesToPortfolioAccount = mapBalancesToPortfolioAccount;
var _debug = require("../helpers/debug");
var _transactions = require("../helpers/transactions");
var _portfolio = require("../portfolio");
var _baseScraperWithBrowser = require("./base-scraper-with-browser");
var _errors = require("./errors");
const debug = (0, _debug.getDebug)('excellence');
const BASE_URL = 'https://extradepro.xnes.co.il';
const API_BASE = `${BASE_URL}/api/v2/json2`;

// The `fields` query param tells the API which security-metadata columns to include
// in the balances response (`View.Meta.Security[]`). Without it, the Meta join is
// empty and positions lose their names/symbols/asset type. Mirrors the live SPA call.
const BALANCE_FIELDS = 'EngName,EngSymbol,HebName,HebSymbol,Symbol,ExpirationDate,ItemType,StockType,IsEtf,IsForeign';

// ---------------------------------------------------------------------------
// API response shape interfaces (based on live capture, 2026-06-24)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Asset type mapping
// ---------------------------------------------------------------------------

/**
 * Map Excellence ItemType/StockType/IsEtf flags to AssetType.
 *
 * Values confirmed against a live balances response (2026-06-24): `ItemType` is a
 * string label such as "Equity" or "Fund"; `StockType` may be null, "Equity", or
 * "ETF"; `IsEtf` is a boolean. We treat an ETF marker (IsEtf true, or StockType
 * "ETF") as ETF first, since an ETF is also reported with ItemType "Equity"/"Fund".
 * Numeric/string fallbacks are kept defensively for codes we may not have observed.
 */
function mapAssetType(meta) {
  const itemType = String(meta.ItemType ?? '').toLowerCase();
  const stockType = String(meta.StockType ?? '').toLowerCase();
  const isEtf = meta.IsEtf === true || meta.IsEtf === 1 || meta.IsEtf === '1' || meta.IsEtf === 'true' || stockType === 'etf';
  if (isEtf) return _portfolio.AssetType.Etf;
  if (itemType === 'bond' || stockType === 'bond' || itemType === '2') return _portfolio.AssetType.Bond;
  if (itemType === 'fund' || stockType === 'fund' || itemType === '3') return _portfolio.AssetType.Fund;
  if (itemType === 'option' || stockType === 'option' || itemType === '4') return _portfolio.AssetType.Option;
  if (itemType === 'future' || stockType === 'future' || itemType === '5') return _portfolio.AssetType.Future;
  if (itemType === 'cash' || stockType === 'cash') return _portfolio.AssetType.Cash;
  // "Equity" is Excellence's label for a plain stock; "" / "1" / "stock" kept as fallbacks.
  if (itemType === 'equity' || itemType === 'stock' || itemType === '1' || itemType === '') return _portfolio.AssetType.Stock;
  return _portfolio.AssetType.Other;
}

// ---------------------------------------------------------------------------
// Portfolio mapping (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Map the balances API response for a single account into a PortfolioAccount.
 *
 * @param accountNumber - The account key (e.g. "00-000000")
 * @param balancesResponse - The raw JSON from GET /account/view/balances
 * @param options - Scraper options (used to gate rawPosition via includeRawTransaction)
 */
function mapBalancesToPortfolioAccount(accountNumber, balancesResponse, options) {
  const view = balancesResponse.View;
  const account = view?.Account;
  const asOf = account?.BalanceCacheDate;

  // Build a lookup map: security key (string) → SecurityMeta
  const rawMeta = view?.Meta?.Security;
  const metaArray = rawMeta == null ? [] : Array.isArray(rawMeta) ? rawMeta : [rawMeta];
  const metaByKey = new Map();
  for (const m of metaArray) {
    const key = String(m['-Key'] ?? '');
    if (key) {
      metaByKey.set(key, m);
    }
  }

  // Map positions
  const rawBalances = account?.AccountPosition?.Balance;
  const balances = rawBalances == null ? [] : Array.isArray(rawBalances) ? rawBalances : [rawBalances];
  const positions = balances.map(bal => {
    const secKeyStr = String(bal.EquityNumber ?? '');
    const meta = metaByKey.get(secKeyStr);

    // Use || (not ??) so that null values fall through to the next candidate
    const name = meta?.HebName || meta?.EngName || secKeyStr;
    const rawSymbol = meta?.Symbol || meta?.HebSymbol || meta?.EngSymbol || null;
    const symbol = rawSymbol ?? undefined;
    const assetType = meta ? mapAssetType(meta) : _portfolio.AssetType.Other;
    const marketPrice = bal.LastRate ?? bal.BaseRate ?? undefined;
    const quantity = bal.OnlineNV ?? 0;
    const marketValue = bal.OnlineVL ?? 0;
    const currency = bal.CurrencyCode ?? 'ILS';
    const position = {
      name,
      securityId: secKeyStr,
      quantity,
      currency,
      marketValue
    };
    if (symbol !== undefined) {
      position.symbol = symbol;
    }
    if (assetType !== undefined) {
      position.assetType = assetType;
    }
    if (marketPrice !== undefined) {
      position.marketPrice = marketPrice;
    }
    if (bal.AveragePrice !== undefined) {
      position.averageCost = bal.AveragePrice;
    }
    if (bal.AveragePriceProfitLoss !== undefined) {
      position.unrealizedPnl = bal.AveragePriceProfitLoss;
    }
    if (bal.AveragePriceProfitLossPercentage !== undefined) {
      position.unrealizedPnlPct = bal.AveragePriceProfitLossPercentage;
    }
    if (asOf !== undefined) {
      position.asOf = asOf;
    }
    if (options?.includeRawTransaction) {
      position.rawPosition = (0, _transactions.getRawTransaction)({
        balance: bal,
        meta: meta ?? null
      });
    }
    return position;
  });
  return {
    accountNumber,
    baseCurrency: account?.CurrencyCode,
    totalValue: account?.OnlineValue,
    cash: account?.OnlineCash,
    positions
  };
}

// ---------------------------------------------------------------------------
// OTP / 2FA detection helper (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Defensive best-effort 2FA/OTP challenge detector.
 *
 * Because no confirmed OTP CSS selector is available from the live capture, this
 * tries a few heuristic selectors and always returns false when uncertain.
 * The intent is to fail loudly (TwoFactorRetrieverMissing) for accounts that DO
 * have 2FA enabled, rather than silently looping.
 *
 * TODO: once a 2FA-enabled Excellence account is available, capture the exact OTP
 *       form selector and replace the heuristics here.
 */
async function detectOtpChallenge(page) {
  if (!page) return false;
  try {
    // Heuristic selectors — adjust after live 2FA capture
    const candidates = ['input[type="tel"]',
    // typical OTP digit input
    '[class*="otp"]', '[class*="two-factor"]', '[class*="2fa"]', '[id*="otp"]'];
    for (const selector of candidates) {
      const el = await page.$(selector);
      if (el) return true;
    }
    return false;
  } catch {
    // If the page is navigating or the evaluation context is destroyed, err on the safe side.
    return false;
  }
}
function getPossibleLoginResults() {
  const results = {};

  // Success: after login the SPA navigates to /app
  results[_baseScraperWithBrowser.LoginResults.Success] = [/\/app/i];

  // Defensive 2FA detection — no confirmed selector, best-effort heuristics
  results[_baseScraperWithBrowser.LoginResults.TwoFactorRetrieverMissing] = [async options => detectOtpChallenge(options?.page)];
  return results;
}

// ---------------------------------------------------------------------------
// In-page authenticated fetch helper
// ---------------------------------------------------------------------------

/**
 * Authenticated request tokens (confirmed against a live session, 2026-06-24):
 *   - `session`  header = the `SessionKey` (a UUID) returned by POST /login.
 *   - `csession` header = a client-generated random value, sent on EVERY request
 *     (including /login itself). The server binds the issued SessionKey to whatever
 *     csession accompanied the login, so the SAME csession must be reused throughout.
 * Auth is header-based, not cookie-based.
 *
 * IMPORTANT: NEVER log session, csession, or SessionKey values.
 */

/**
 * Perform an authenticated GET inside the Puppeteer page context.
 */
async function fetchWithSessionHeaders(page, url, tokens) {
  const result = await page.evaluate(async (innerUrl, innerTokens) => {
    try {
      const response = await fetch(innerUrl, {
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          session: innerTokens.session,
          csession: innerTokens.csession
        }
      });
      if (response.status === 204) return null;
      const text = await response.text();
      return JSON.parse(text);
    } catch {
      return null;
    }
  }, url, tokens);
  return result;
}

/**
 * Perform an authenticated POST inside the Puppeteer page context.
 */
async function postWithSessionHeaders(page, url, body, tokens) {
  const result = await page.evaluate(async (innerUrl, innerBody, innerTokens) => {
    try {
      const response = await fetch(innerUrl, {
        method: 'POST',
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          session: innerTokens.session,
          csession: innerTokens.csession
        },
        body: JSON.stringify(innerBody)
      });
      if (response.status === 204) return null;
      const text = await response.text();
      return JSON.parse(text);
    } catch {
      return null;
    }
  }, url, body, tokens);
  return result;
}

// ---------------------------------------------------------------------------
// Credentials type
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Scraper class
// ---------------------------------------------------------------------------

class ExcellenceScraper extends _baseScraperWithBrowser.BaseScraperWithBrowser {
  /** The SessionKey (UUID) from the /login response, used as the `session` header. Never logged. */
  sessionKey = '';

  /**
   * Client-generated `csession` value. Generated once per scrape and reused on the
   * login request and every authenticated call (the server binds the SessionKey to it).
   * Never logged.
   */
  csession = '';
  get tokens() {
    return {
      session: this.sessionKey,
      csession: this.csession
    };
  }
  get baseUrl() {
    return BASE_URL;
  }
  getLoginOptions(credentials) {
    // We override login() to do a direct in-page POST rather than driving the DOM
    // form, because DOM selectors have not been confirmed from a live capture.
    // getLoginOptions() is still required by the base class interface, so we return
    // a minimal stub. The actual login logic is in login() below.
    return {
      loginUrl: `${BASE_URL}/login`,
      fields: [
      // Stub — not used because login() overrides the form-drive flow
      {
        selector: '[name="username"]',
        value: credentials.username
      }, {
        selector: '[name="password"]',
        value: credentials.password
      }],
      submitButtonSelector: async () => {
        // No-op: login() handles submission directly
      },
      possibleResults: getPossibleLoginResults()
    };
  }

  /**
   * Override login() to authenticate via a direct in-page JSON POST.
   *
   * Rationale: rather than driving the SPA's DOM form, we POST directly to the
   * stable JSON API endpoint. Request/response shapes confirmed against a live
   * session (2026-06-24).
   *
   * Flow:
   *  1. Navigate to the login page to establish the correct same-origin context.
   *  2. Generate a `csession` value and POST /api/v2/json2/login with the
   *     {Login:{User,Password}} body and the csession header.
   *  3. Parse response: extract Login.SessionKey on success, detect errors.
   */
  async login(credentials) {
    debug('navigating to login page');
    // Navigate to the login page to establish origin context for in-page fetch
    try {
      await this.navigateTo(`${BASE_URL}/login`, 'domcontentloaded');
    } catch (e) {
      debug('navigateTo login page failed: %s', e.message);
      // Non-fatal: continue — the page might be partially loaded, and the in-page POST
      // may still work if the origin is set correctly.
    }

    // Generate the per-session csession token. The live SPA uses a Math.random() float
    // string (e.g. "0.4381..."), so we mirror that exact format to avoid any server-side
    // shape validation. It is client-chosen and only needs to stay consistent across the
    // session (the server binds the issued SessionKey to it).
    this.csession = String(Math.random());
    debug('posting credentials to login API');
    // NEVER log credentials, sessionKey, session, or csession values.
    const loginResponse = await this.page.evaluate(async (apiUrl, username, password, csession) => {
      try {
        const response = await fetch(apiUrl, {
          method: 'POST',
          credentials: 'include',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            csession
          },
          body: JSON.stringify({
            Login: {
              User: username,
              Password: password
            }
          })
        });
        const text = await response.text();
        return {
          ok: response.ok,
          status: response.status,
          body: text
        };
      } catch (e) {
        return {
          ok: false,
          status: 0,
          body: String(e)
        };
      }
    }, `${API_BASE}/login`, credentials.username, credentials.password, this.csession);
    if (!loginResponse.ok) {
      debug('login HTTP error: status=%d', loginResponse.status);
      return {
        success: false,
        errorType: _errors.ScraperErrorTypes.General,
        errorMessage: `Login request failed with HTTP ${loginResponse.status}`
      };
    }
    let parsed;
    try {
      parsed = JSON.parse(loginResponse.body);
    } catch {
      debug('failed to parse login response JSON');
      return {
        success: false,
        errorType: _errors.ScraperErrorTypes.General,
        errorMessage: 'Login response was not valid JSON'
      };
    }

    // Check for API-level error
    if (parsed.Error || parsed.error) {
      const code = parsed.Error?.Code ?? parsed.error ?? 'unknown';
      const msg = parsed.Error?.Message ?? parsed.message ?? '';
      debug('login API error: code=%s', code);

      // Heuristic: treat "invalid" / "wrong" credential errors as InvalidPassword
      const isInvalidCreds = typeof msg === 'string' && (msg.toLowerCase().includes('invalid') || msg.toLowerCase().includes('wrong') || msg.toLowerCase().includes('שגוי') || msg.toLowerCase().includes('incorrect'));
      if (isInvalidCreds) {
        return {
          success: false,
          errorType: _errors.ScraperErrorTypes.InvalidPassword,
          errorMessage: `Login failed: ${msg}`
        };
      }
      return {
        success: false,
        errorType: _errors.ScraperErrorTypes.General,
        errorMessage: `Login API error (code ${code}): ${msg}`
      };
    }
    const sessionKey = parsed.Login?.SessionKey;
    if (!sessionKey) {
      debug('login response missing SessionKey');
      // Check for OTP challenge heuristically before giving up
      const hasOtp = await detectOtpChallenge(this.page);
      if (hasOtp) {
        return {
          success: false,
          errorType: _errors.ScraperErrorTypes.TwoFactorRetrieverMissing,
          errorMessage: 'Excellence 2FA/OTP challenge detected. Full OTP support is not yet implemented ' + '(no 2FA-enabled test account was available during development). ' + 'If your account requires 2FA, please open an issue.'
        };
      }
      return {
        success: false,
        errorType: _errors.ScraperErrorTypes.General,
        errorMessage: 'Login succeeded but SessionKey was not returned'
      };
    }

    // Store for use in fetchData(). NEVER log this value.
    this.sessionKey = sessionKey;
    debug('login successful, SessionKey captured (not logged)');

    // No further navigation needed: authenticated API calls are made from this
    // same-origin page using explicit session/csession headers (see fetchData).
    return {
      success: true
    };
  }
  async fetchData() {
    debug('fetching account list');
    const accountsResp = await fetchWithSessionHeaders(this.page, `${API_BASE}/accounts?top=10`, this.tokens);
    const rawAccounts = accountsResp?.UserAccounts?.UserAccount;
    const accounts = rawAccounts == null ? [] : Array.isArray(rawAccounts) ? rawAccounts : [rawAccounts];
    debug('found %d accounts', accounts.length);
    const portfolioAccounts = [];
    for (const account of accounts) {
      const accountNumber = account['-key'];
      if (!accountNumber) {
        debug('skipping account with missing key');
        continue;
      }
      debug('initialising account %s', accountNumber);
      // POST /account/init activates the account for the session
      await postWithSessionHeaders(this.page, `${API_BASE}/account/init?account=${encodeURIComponent(accountNumber)}`, {}, this.tokens);
      debug('fetching balances for account %s', accountNumber);
      const balancesResp = await fetchWithSessionHeaders(this.page, `${API_BASE}/account/view/balances?account=${encodeURIComponent(accountNumber)}&fields=${BALANCE_FIELDS}&currency=ILS`, this.tokens);
      if (!balancesResp) {
        debug('no balances response for account %s, skipping', accountNumber);
        continue;
      }
      const portfolioAccount = mapBalancesToPortfolioAccount(accountNumber, balancesResp, this.options);
      portfolioAccounts.push(portfolioAccount);
    }
    debug('fetchData complete, %d portfolio accounts', portfolioAccounts.length);
    return {
      success: true,
      portfolioAccounts
    };
  }
}
var _default = exports.default = ExcellenceScraper;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfZGVidWciLCJyZXF1aXJlIiwiX3RyYW5zYWN0aW9ucyIsIl9wb3J0Zm9saW8iLCJfYmFzZVNjcmFwZXJXaXRoQnJvd3NlciIsIl9lcnJvcnMiLCJkZWJ1ZyIsImdldERlYnVnIiwiQkFTRV9VUkwiLCJBUElfQkFTRSIsIkJBTEFOQ0VfRklFTERTIiwibWFwQXNzZXRUeXBlIiwibWV0YSIsIml0ZW1UeXBlIiwiU3RyaW5nIiwiSXRlbVR5cGUiLCJ0b0xvd2VyQ2FzZSIsInN0b2NrVHlwZSIsIlN0b2NrVHlwZSIsImlzRXRmIiwiSXNFdGYiLCJBc3NldFR5cGUiLCJFdGYiLCJCb25kIiwiRnVuZCIsIk9wdGlvbiIsIkZ1dHVyZSIsIkNhc2giLCJTdG9jayIsIk90aGVyIiwibWFwQmFsYW5jZXNUb1BvcnRmb2xpb0FjY291bnQiLCJhY2NvdW50TnVtYmVyIiwiYmFsYW5jZXNSZXNwb25zZSIsIm9wdGlvbnMiLCJ2aWV3IiwiVmlldyIsImFjY291bnQiLCJBY2NvdW50IiwiYXNPZiIsIkJhbGFuY2VDYWNoZURhdGUiLCJyYXdNZXRhIiwiTWV0YSIsIlNlY3VyaXR5IiwibWV0YUFycmF5IiwiQXJyYXkiLCJpc0FycmF5IiwibWV0YUJ5S2V5IiwiTWFwIiwibSIsImtleSIsInNldCIsInJhd0JhbGFuY2VzIiwiQWNjb3VudFBvc2l0aW9uIiwiQmFsYW5jZSIsImJhbGFuY2VzIiwicG9zaXRpb25zIiwibWFwIiwiYmFsIiwic2VjS2V5U3RyIiwiRXF1aXR5TnVtYmVyIiwiZ2V0IiwibmFtZSIsIkhlYk5hbWUiLCJFbmdOYW1lIiwicmF3U3ltYm9sIiwiU3ltYm9sIiwiSGViU3ltYm9sIiwiRW5nU3ltYm9sIiwic3ltYm9sIiwidW5kZWZpbmVkIiwiYXNzZXRUeXBlIiwibWFya2V0UHJpY2UiLCJMYXN0UmF0ZSIsIkJhc2VSYXRlIiwicXVhbnRpdHkiLCJPbmxpbmVOViIsIm1hcmtldFZhbHVlIiwiT25saW5lVkwiLCJjdXJyZW5jeSIsIkN1cnJlbmN5Q29kZSIsInBvc2l0aW9uIiwic2VjdXJpdHlJZCIsIkF2ZXJhZ2VQcmljZSIsImF2ZXJhZ2VDb3N0IiwiQXZlcmFnZVByaWNlUHJvZml0TG9zcyIsInVucmVhbGl6ZWRQbmwiLCJBdmVyYWdlUHJpY2VQcm9maXRMb3NzUGVyY2VudGFnZSIsInVucmVhbGl6ZWRQbmxQY3QiLCJpbmNsdWRlUmF3VHJhbnNhY3Rpb24iLCJyYXdQb3NpdGlvbiIsImdldFJhd1RyYW5zYWN0aW9uIiwiYmFsYW5jZSIsImJhc2VDdXJyZW5jeSIsInRvdGFsVmFsdWUiLCJPbmxpbmVWYWx1ZSIsImNhc2giLCJPbmxpbmVDYXNoIiwiZGV0ZWN0T3RwQ2hhbGxlbmdlIiwicGFnZSIsImNhbmRpZGF0ZXMiLCJzZWxlY3RvciIsImVsIiwiJCIsImdldFBvc3NpYmxlTG9naW5SZXN1bHRzIiwicmVzdWx0cyIsIkxvZ2luUmVzdWx0cyIsIlN1Y2Nlc3MiLCJUd29GYWN0b3JSZXRyaWV2ZXJNaXNzaW5nIiwiZmV0Y2hXaXRoU2Vzc2lvbkhlYWRlcnMiLCJ1cmwiLCJ0b2tlbnMiLCJyZXN1bHQiLCJldmFsdWF0ZSIsImlubmVyVXJsIiwiaW5uZXJUb2tlbnMiLCJyZXNwb25zZSIsImZldGNoIiwiY3JlZGVudGlhbHMiLCJoZWFkZXJzIiwiQWNjZXB0Iiwic2Vzc2lvbiIsImNzZXNzaW9uIiwic3RhdHVzIiwidGV4dCIsIkpTT04iLCJwYXJzZSIsInBvc3RXaXRoU2Vzc2lvbkhlYWRlcnMiLCJib2R5IiwiaW5uZXJCb2R5IiwibWV0aG9kIiwic3RyaW5naWZ5IiwiRXhjZWxsZW5jZVNjcmFwZXIiLCJCYXNlU2NyYXBlcldpdGhCcm93c2VyIiwic2Vzc2lvbktleSIsImJhc2VVcmwiLCJnZXRMb2dpbk9wdGlvbnMiLCJsb2dpblVybCIsImZpZWxkcyIsInZhbHVlIiwidXNlcm5hbWUiLCJwYXNzd29yZCIsInN1Ym1pdEJ1dHRvblNlbGVjdG9yIiwicG9zc2libGVSZXN1bHRzIiwibG9naW4iLCJuYXZpZ2F0ZVRvIiwiZSIsIm1lc3NhZ2UiLCJNYXRoIiwicmFuZG9tIiwibG9naW5SZXNwb25zZSIsImFwaVVybCIsIkxvZ2luIiwiVXNlciIsIlBhc3N3b3JkIiwib2siLCJzdWNjZXNzIiwiZXJyb3JUeXBlIiwiU2NyYXBlckVycm9yVHlwZXMiLCJHZW5lcmFsIiwiZXJyb3JNZXNzYWdlIiwicGFyc2VkIiwiRXJyb3IiLCJlcnJvciIsImNvZGUiLCJDb2RlIiwibXNnIiwiTWVzc2FnZSIsImlzSW52YWxpZENyZWRzIiwiaW5jbHVkZXMiLCJJbnZhbGlkUGFzc3dvcmQiLCJTZXNzaW9uS2V5IiwiaGFzT3RwIiwiZmV0Y2hEYXRhIiwiYWNjb3VudHNSZXNwIiwicmF3QWNjb3VudHMiLCJVc2VyQWNjb3VudHMiLCJVc2VyQWNjb3VudCIsImFjY291bnRzIiwibGVuZ3RoIiwicG9ydGZvbGlvQWNjb3VudHMiLCJlbmNvZGVVUklDb21wb25lbnQiLCJiYWxhbmNlc1Jlc3AiLCJwb3J0Zm9saW9BY2NvdW50IiwicHVzaCIsIl9kZWZhdWx0IiwiZXhwb3J0cyIsImRlZmF1bHQiXSwic291cmNlcyI6WyIuLi8uLi9zcmMvc2NyYXBlcnMvZXhjZWxsZW5jZS50cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyB0eXBlIFBhZ2UgfSBmcm9tICdwdXBwZXRlZXInO1xyXG5pbXBvcnQgeyBnZXREZWJ1ZyB9IGZyb20gJy4uL2hlbHBlcnMvZGVidWcnO1xyXG5pbXBvcnQgeyBnZXRSYXdUcmFuc2FjdGlvbiB9IGZyb20gJy4uL2hlbHBlcnMvdHJhbnNhY3Rpb25zJztcclxuaW1wb3J0IHsgQXNzZXRUeXBlLCB0eXBlIFBvcnRmb2xpb0FjY291bnQsIHR5cGUgUG9zaXRpb24gfSBmcm9tICcuLi9wb3J0Zm9saW8nO1xyXG5pbXBvcnQgeyBCYXNlU2NyYXBlcldpdGhCcm93c2VyLCBMb2dpblJlc3VsdHMsIHR5cGUgUG9zc2libGVMb2dpblJlc3VsdHMgfSBmcm9tICcuL2Jhc2Utc2NyYXBlci13aXRoLWJyb3dzZXInO1xyXG5pbXBvcnQgeyBTY3JhcGVyRXJyb3JUeXBlcyB9IGZyb20gJy4vZXJyb3JzJztcclxuaW1wb3J0IHsgdHlwZSBTY3JhcGVyTG9naW5SZXN1bHQsIHR5cGUgU2NyYXBlck9wdGlvbnMgfSBmcm9tICcuL2ludGVyZmFjZSc7XHJcblxyXG5jb25zdCBkZWJ1ZyA9IGdldERlYnVnKCdleGNlbGxlbmNlJyk7XHJcblxyXG5jb25zdCBCQVNFX1VSTCA9ICdodHRwczovL2V4dHJhZGVwcm8ueG5lcy5jby5pbCc7XHJcbmNvbnN0IEFQSV9CQVNFID0gYCR7QkFTRV9VUkx9L2FwaS92Mi9qc29uMmA7XHJcblxyXG4vLyBUaGUgYGZpZWxkc2AgcXVlcnkgcGFyYW0gdGVsbHMgdGhlIEFQSSB3aGljaCBzZWN1cml0eS1tZXRhZGF0YSBjb2x1bW5zIHRvIGluY2x1ZGVcclxuLy8gaW4gdGhlIGJhbGFuY2VzIHJlc3BvbnNlIChgVmlldy5NZXRhLlNlY3VyaXR5W11gKS4gV2l0aG91dCBpdCwgdGhlIE1ldGEgam9pbiBpc1xyXG4vLyBlbXB0eSBhbmQgcG9zaXRpb25zIGxvc2UgdGhlaXIgbmFtZXMvc3ltYm9scy9hc3NldCB0eXBlLiBNaXJyb3JzIHRoZSBsaXZlIFNQQSBjYWxsLlxyXG5jb25zdCBCQUxBTkNFX0ZJRUxEUyA9ICdFbmdOYW1lLEVuZ1N5bWJvbCxIZWJOYW1lLEhlYlN5bWJvbCxTeW1ib2wsRXhwaXJhdGlvbkRhdGUsSXRlbVR5cGUsU3RvY2tUeXBlLElzRXRmLElzRm9yZWlnbic7XHJcblxyXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cclxuLy8gQVBJIHJlc3BvbnNlIHNoYXBlIGludGVyZmFjZXMgKGJhc2VkIG9uIGxpdmUgY2FwdHVyZSwgMjAyNi0wNi0yNClcclxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXHJcblxyXG5pbnRlcmZhY2UgTG9naW5SZXNwb25zZSB7XHJcbiAgTG9naW4/OiB7XHJcbiAgICBTZXNzaW9uS2V5Pzogc3RyaW5nO1xyXG4gICAgJy1MYXN0TG9naW4nPzogc3RyaW5nO1xyXG4gICAgJy1QYXNzd29yZEV4cGlyeSc/OiBzdHJpbmc7XHJcbiAgICBDYXBhYmlsaXRpZXM/OiB1bmtub3duO1xyXG4gICAgQXR0cmlidXRlcz86IHVua25vd247XHJcbiAgfTtcclxuICAvLyBFcnJvciBzaGFwZXMg4oCUIHRoZSBBUEkgbWF5IHJldHVybiBlcnJvciBpbmZvIGF0IHRoZSB0b3AgbGV2ZWwgb3IgaW4gYSBuZXN0ZWQgb2JqZWN0XHJcbiAgRXJyb3I/OiB7XHJcbiAgICBDb2RlPzogbnVtYmVyIHwgc3RyaW5nO1xyXG4gICAgTWVzc2FnZT86IHN0cmluZztcclxuICB9O1xyXG4gIGVycm9yPzogc3RyaW5nO1xyXG4gIG1lc3NhZ2U/OiBzdHJpbmc7XHJcbn1cclxuXHJcbmludGVyZmFjZSBVc2VyQWNjb3VudCB7XHJcbiAgJy1rZXknOiBzdHJpbmc7XHJcbiAgJy1uYW1lJz86IHN0cmluZztcclxuICAnLXRlbENvZGUnPzogc3RyaW5nO1xyXG4gICctcmVsYXRpb24nPzogc3RyaW5nO1xyXG4gICctbmlja05hbWUnPzogc3RyaW5nO1xyXG4gICctdHlwZSc/OiBzdHJpbmc7XHJcbn1cclxuXHJcbmludGVyZmFjZSBBY2NvdW50c1Jlc3BvbnNlIHtcclxuICBVc2VyQWNjb3VudHM/OiB7XHJcbiAgICBVc2VyQWNjb3VudD86IFVzZXJBY2NvdW50IHwgVXNlckFjY291bnRbXTtcclxuICB9O1xyXG59XHJcblxyXG5pbnRlcmZhY2UgU2VjdXJpdHlNZXRhIHtcclxuICAnLUtleSc6IHN0cmluZyB8IG51bWJlcjtcclxuICBIZWJOYW1lPzogc3RyaW5nIHwgbnVsbDtcclxuICBFbmdOYW1lPzogc3RyaW5nIHwgbnVsbDtcclxuICBIZWJTeW1ib2w/OiBzdHJpbmcgfCBudWxsO1xyXG4gIEVuZ1N5bWJvbD86IHN0cmluZyB8IG51bGw7XHJcbiAgU3ltYm9sPzogc3RyaW5nIHwgbnVsbDtcclxuICBJdGVtVHlwZT86IHN0cmluZyB8IG51bWJlciB8IG51bGw7XHJcbiAgU3RvY2tUeXBlPzogc3RyaW5nIHwgbnVtYmVyIHwgbnVsbDtcclxuICBJc0V0Zj86IGJvb2xlYW4gfCBzdHJpbmcgfCBudW1iZXIgfCBudWxsO1xyXG4gIElzRm9yZWlnbj86IGJvb2xlYW4gfCBzdHJpbmcgfCBudW1iZXIgfCBudWxsO1xyXG59XHJcblxyXG5pbnRlcmZhY2UgQmFsYW5jZVBvc2l0aW9uIHtcclxuICBFcXVpdHlOdW1iZXI/OiBzdHJpbmcgfCBudW1iZXI7XHJcbiAgT25saW5lTlY/OiBudW1iZXI7XHJcbiAgQXZhaWxhYmxlTlY/OiBudW1iZXI7XHJcbiAgTGFzdFJhdGU/OiBudW1iZXI7XHJcbiAgQmFzZVJhdGU/OiBudW1iZXI7XHJcbiAgT25saW5lVkw/OiBudW1iZXI7XHJcbiAgT25saW5lTmlzVkw/OiBudW1iZXI7XHJcbiAgQXZlcmFnZVByaWNlPzogbnVtYmVyO1xyXG4gIFByb2ZpdExvc3M/OiBudW1iZXI7XHJcbiAgQXZlcmFnZVByaWNlUHJvZml0TG9zcz86IG51bWJlcjtcclxuICBBdmVyYWdlUHJpY2VQcm9maXRMb3NzUGVyY2VudGFnZT86IG51bWJlcjtcclxuICBPbmxpbmVQZXJjZW50YWdlPzogbnVtYmVyO1xyXG4gIEN1cnJlbmN5Q29kZT86IHN0cmluZztcclxuICBFeHBpcnlEYXRlPzogc3RyaW5nO1xyXG4gIFZhbHVlRGF0ZT86IHN0cmluZztcclxuICBTdWJBY2NvdW50PzogdW5rbm93bjtcclxuICBTdWJBY2NvdW50TmFtZT86IHN0cmluZztcclxuICBMaWVuTnY/OiBudW1iZXI7XHJcbiAgTG9hbk52PzogbnVtYmVyO1xyXG59XHJcblxyXG5pbnRlcmZhY2UgQWNjb3VudFZpZXcge1xyXG4gIE9ubGluZVZhbHVlPzogbnVtYmVyO1xyXG4gIE1vcm5pbmdWYWx1ZT86IG51bWJlcjtcclxuICBPbmxpbmVDYXNoPzogbnVtYmVyO1xyXG4gIE1vcm5pbmdDYXNoPzogbnVtYmVyO1xyXG4gIEN1cnJlbmN5Q29kZT86IHN0cmluZztcclxuICBQcm9maXRMb3NzPzogbnVtYmVyO1xyXG4gIFByb2ZpdExvc3NQZXJjZW50YWdlPzogbnVtYmVyO1xyXG4gIEJhbGFuY2VDYWNoZURhdGU/OiBzdHJpbmc7XHJcbiAgQWNjb3VudFBvc2l0aW9uPzoge1xyXG4gICAgQmFsYW5jZT86IEJhbGFuY2VQb3NpdGlvbiB8IEJhbGFuY2VQb3NpdGlvbltdO1xyXG4gIH07XHJcbn1cclxuXHJcbmludGVyZmFjZSBCYWxhbmNlc1Jlc3BvbnNlIHtcclxuICBWaWV3Pzoge1xyXG4gICAgQWNjb3VudD86IEFjY291bnRWaWV3O1xyXG4gICAgTWV0YT86IHtcclxuICAgICAgU2VjdXJpdHk/OiBTZWN1cml0eU1ldGEgfCBTZWN1cml0eU1ldGFbXTtcclxuICAgIH07XHJcbiAgfTtcclxufVxyXG5cclxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXHJcbi8vIEFzc2V0IHR5cGUgbWFwcGluZ1xyXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cclxuXHJcbi8qKlxyXG4gKiBNYXAgRXhjZWxsZW5jZSBJdGVtVHlwZS9TdG9ja1R5cGUvSXNFdGYgZmxhZ3MgdG8gQXNzZXRUeXBlLlxyXG4gKlxyXG4gKiBWYWx1ZXMgY29uZmlybWVkIGFnYWluc3QgYSBsaXZlIGJhbGFuY2VzIHJlc3BvbnNlICgyMDI2LTA2LTI0KTogYEl0ZW1UeXBlYCBpcyBhXHJcbiAqIHN0cmluZyBsYWJlbCBzdWNoIGFzIFwiRXF1aXR5XCIgb3IgXCJGdW5kXCI7IGBTdG9ja1R5cGVgIG1heSBiZSBudWxsLCBcIkVxdWl0eVwiLCBvclxyXG4gKiBcIkVURlwiOyBgSXNFdGZgIGlzIGEgYm9vbGVhbi4gV2UgdHJlYXQgYW4gRVRGIG1hcmtlciAoSXNFdGYgdHJ1ZSwgb3IgU3RvY2tUeXBlXHJcbiAqIFwiRVRGXCIpIGFzIEVURiBmaXJzdCwgc2luY2UgYW4gRVRGIGlzIGFsc28gcmVwb3J0ZWQgd2l0aCBJdGVtVHlwZSBcIkVxdWl0eVwiL1wiRnVuZFwiLlxyXG4gKiBOdW1lcmljL3N0cmluZyBmYWxsYmFja3MgYXJlIGtlcHQgZGVmZW5zaXZlbHkgZm9yIGNvZGVzIHdlIG1heSBub3QgaGF2ZSBvYnNlcnZlZC5cclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBtYXBBc3NldFR5cGUobWV0YTogU2VjdXJpdHlNZXRhKTogQXNzZXRUeXBlIHtcclxuICBjb25zdCBpdGVtVHlwZSA9IFN0cmluZyhtZXRhLkl0ZW1UeXBlID8/ICcnKS50b0xvd2VyQ2FzZSgpO1xyXG4gIGNvbnN0IHN0b2NrVHlwZSA9IFN0cmluZyhtZXRhLlN0b2NrVHlwZSA/PyAnJykudG9Mb3dlckNhc2UoKTtcclxuXHJcbiAgY29uc3QgaXNFdGYgPVxyXG4gICAgbWV0YS5Jc0V0ZiA9PT0gdHJ1ZSB8fCBtZXRhLklzRXRmID09PSAxIHx8IG1ldGEuSXNFdGYgPT09ICcxJyB8fCBtZXRhLklzRXRmID09PSAndHJ1ZScgfHwgc3RvY2tUeXBlID09PSAnZXRmJztcclxuICBpZiAoaXNFdGYpIHJldHVybiBBc3NldFR5cGUuRXRmO1xyXG5cclxuICBpZiAoaXRlbVR5cGUgPT09ICdib25kJyB8fCBzdG9ja1R5cGUgPT09ICdib25kJyB8fCBpdGVtVHlwZSA9PT0gJzInKSByZXR1cm4gQXNzZXRUeXBlLkJvbmQ7XHJcbiAgaWYgKGl0ZW1UeXBlID09PSAnZnVuZCcgfHwgc3RvY2tUeXBlID09PSAnZnVuZCcgfHwgaXRlbVR5cGUgPT09ICczJykgcmV0dXJuIEFzc2V0VHlwZS5GdW5kO1xyXG4gIGlmIChpdGVtVHlwZSA9PT0gJ29wdGlvbicgfHwgc3RvY2tUeXBlID09PSAnb3B0aW9uJyB8fCBpdGVtVHlwZSA9PT0gJzQnKSByZXR1cm4gQXNzZXRUeXBlLk9wdGlvbjtcclxuICBpZiAoaXRlbVR5cGUgPT09ICdmdXR1cmUnIHx8IHN0b2NrVHlwZSA9PT0gJ2Z1dHVyZScgfHwgaXRlbVR5cGUgPT09ICc1JykgcmV0dXJuIEFzc2V0VHlwZS5GdXR1cmU7XHJcbiAgaWYgKGl0ZW1UeXBlID09PSAnY2FzaCcgfHwgc3RvY2tUeXBlID09PSAnY2FzaCcpIHJldHVybiBBc3NldFR5cGUuQ2FzaDtcclxuICAvLyBcIkVxdWl0eVwiIGlzIEV4Y2VsbGVuY2UncyBsYWJlbCBmb3IgYSBwbGFpbiBzdG9jazsgXCJcIiAvIFwiMVwiIC8gXCJzdG9ja1wiIGtlcHQgYXMgZmFsbGJhY2tzLlxyXG4gIGlmIChpdGVtVHlwZSA9PT0gJ2VxdWl0eScgfHwgaXRlbVR5cGUgPT09ICdzdG9jaycgfHwgaXRlbVR5cGUgPT09ICcxJyB8fCBpdGVtVHlwZSA9PT0gJycpIHJldHVybiBBc3NldFR5cGUuU3RvY2s7XHJcblxyXG4gIHJldHVybiBBc3NldFR5cGUuT3RoZXI7XHJcbn1cclxuXHJcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxyXG4vLyBQb3J0Zm9saW8gbWFwcGluZyAoZXhwb3J0ZWQgZm9yIHVuaXQgdGVzdGluZylcclxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXHJcblxyXG4vKipcclxuICogTWFwIHRoZSBiYWxhbmNlcyBBUEkgcmVzcG9uc2UgZm9yIGEgc2luZ2xlIGFjY291bnQgaW50byBhIFBvcnRmb2xpb0FjY291bnQuXHJcbiAqXHJcbiAqIEBwYXJhbSBhY2NvdW50TnVtYmVyIC0gVGhlIGFjY291bnQga2V5IChlLmcuIFwiMDAtMDAwMDAwXCIpXHJcbiAqIEBwYXJhbSBiYWxhbmNlc1Jlc3BvbnNlIC0gVGhlIHJhdyBKU09OIGZyb20gR0VUIC9hY2NvdW50L3ZpZXcvYmFsYW5jZXNcclxuICogQHBhcmFtIG9wdGlvbnMgLSBTY3JhcGVyIG9wdGlvbnMgKHVzZWQgdG8gZ2F0ZSByYXdQb3NpdGlvbiB2aWEgaW5jbHVkZVJhd1RyYW5zYWN0aW9uKVxyXG4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIG1hcEJhbGFuY2VzVG9Qb3J0Zm9saW9BY2NvdW50KFxyXG4gIGFjY291bnROdW1iZXI6IHN0cmluZyxcclxuICBiYWxhbmNlc1Jlc3BvbnNlOiBCYWxhbmNlc1Jlc3BvbnNlLFxyXG4gIG9wdGlvbnM/OiBQaWNrPFNjcmFwZXJPcHRpb25zLCAnaW5jbHVkZVJhd1RyYW5zYWN0aW9uJz4sXHJcbik6IFBvcnRmb2xpb0FjY291bnQge1xyXG4gIGNvbnN0IHZpZXcgPSBiYWxhbmNlc1Jlc3BvbnNlLlZpZXc7XHJcbiAgY29uc3QgYWNjb3VudCA9IHZpZXc/LkFjY291bnQ7XHJcbiAgY29uc3QgYXNPZiA9IGFjY291bnQ/LkJhbGFuY2VDYWNoZURhdGU7XHJcblxyXG4gIC8vIEJ1aWxkIGEgbG9va3VwIG1hcDogc2VjdXJpdHkga2V5IChzdHJpbmcpIOKGkiBTZWN1cml0eU1ldGFcclxuICBjb25zdCByYXdNZXRhID0gdmlldz8uTWV0YT8uU2VjdXJpdHk7XHJcbiAgY29uc3QgbWV0YUFycmF5OiBTZWN1cml0eU1ldGFbXSA9IHJhd01ldGEgPT0gbnVsbCA/IFtdIDogQXJyYXkuaXNBcnJheShyYXdNZXRhKSA/IHJhd01ldGEgOiBbcmF3TWV0YV07XHJcbiAgY29uc3QgbWV0YUJ5S2V5ID0gbmV3IE1hcDxzdHJpbmcsIFNlY3VyaXR5TWV0YT4oKTtcclxuICBmb3IgKGNvbnN0IG0gb2YgbWV0YUFycmF5KSB7XHJcbiAgICBjb25zdCBrZXkgPSBTdHJpbmcobVsnLUtleSddID8/ICcnKTtcclxuICAgIGlmIChrZXkpIHtcclxuICAgICAgbWV0YUJ5S2V5LnNldChrZXksIG0pO1xyXG4gICAgfVxyXG4gIH1cclxuXHJcbiAgLy8gTWFwIHBvc2l0aW9uc1xyXG4gIGNvbnN0IHJhd0JhbGFuY2VzID0gYWNjb3VudD8uQWNjb3VudFBvc2l0aW9uPy5CYWxhbmNlO1xyXG4gIGNvbnN0IGJhbGFuY2VzOiBCYWxhbmNlUG9zaXRpb25bXSA9XHJcbiAgICByYXdCYWxhbmNlcyA9PSBudWxsID8gW10gOiBBcnJheS5pc0FycmF5KHJhd0JhbGFuY2VzKSA/IHJhd0JhbGFuY2VzIDogW3Jhd0JhbGFuY2VzXTtcclxuXHJcbiAgY29uc3QgcG9zaXRpb25zOiBQb3NpdGlvbltdID0gYmFsYW5jZXMubWFwKChiYWwpOiBQb3NpdGlvbiA9PiB7XHJcbiAgICBjb25zdCBzZWNLZXlTdHIgPSBTdHJpbmcoYmFsLkVxdWl0eU51bWJlciA/PyAnJyk7XHJcbiAgICBjb25zdCBtZXRhID0gbWV0YUJ5S2V5LmdldChzZWNLZXlTdHIpO1xyXG5cclxuICAgIC8vIFVzZSB8fCAobm90ID8/KSBzbyB0aGF0IG51bGwgdmFsdWVzIGZhbGwgdGhyb3VnaCB0byB0aGUgbmV4dCBjYW5kaWRhdGVcclxuICAgIGNvbnN0IG5hbWUgPSBtZXRhPy5IZWJOYW1lIHx8IG1ldGE/LkVuZ05hbWUgfHwgc2VjS2V5U3RyO1xyXG4gICAgY29uc3QgcmF3U3ltYm9sID0gbWV0YT8uU3ltYm9sIHx8IG1ldGE/LkhlYlN5bWJvbCB8fCBtZXRhPy5FbmdTeW1ib2wgfHwgbnVsbDtcclxuICAgIGNvbnN0IHN5bWJvbCA9IHJhd1N5bWJvbCA/PyB1bmRlZmluZWQ7XHJcbiAgICBjb25zdCBhc3NldFR5cGUgPSBtZXRhID8gbWFwQXNzZXRUeXBlKG1ldGEpIDogQXNzZXRUeXBlLk90aGVyO1xyXG5cclxuICAgIGNvbnN0IG1hcmtldFByaWNlID0gYmFsLkxhc3RSYXRlID8/IGJhbC5CYXNlUmF0ZSA/PyB1bmRlZmluZWQ7XHJcbiAgICBjb25zdCBxdWFudGl0eSA9IGJhbC5PbmxpbmVOViA/PyAwO1xyXG4gICAgY29uc3QgbWFya2V0VmFsdWUgPSBiYWwuT25saW5lVkwgPz8gMDtcclxuICAgIGNvbnN0IGN1cnJlbmN5ID0gYmFsLkN1cnJlbmN5Q29kZSA/PyAnSUxTJztcclxuXHJcbiAgICBjb25zdCBwb3NpdGlvbjogUG9zaXRpb24gPSB7XHJcbiAgICAgIG5hbWUsXHJcbiAgICAgIHNlY3VyaXR5SWQ6IHNlY0tleVN0cixcclxuICAgICAgcXVhbnRpdHksXHJcbiAgICAgIGN1cnJlbmN5LFxyXG4gICAgICBtYXJrZXRWYWx1ZSxcclxuICAgIH07XHJcblxyXG4gICAgaWYgKHN5bWJvbCAhPT0gdW5kZWZpbmVkKSB7XHJcbiAgICAgIHBvc2l0aW9uLnN5bWJvbCA9IHN5bWJvbDtcclxuICAgIH1cclxuICAgIGlmIChhc3NldFR5cGUgIT09IHVuZGVmaW5lZCkge1xyXG4gICAgICBwb3NpdGlvbi5hc3NldFR5cGUgPSBhc3NldFR5cGU7XHJcbiAgICB9XHJcbiAgICBpZiAobWFya2V0UHJpY2UgIT09IHVuZGVmaW5lZCkge1xyXG4gICAgICBwb3NpdGlvbi5tYXJrZXRQcmljZSA9IG1hcmtldFByaWNlO1xyXG4gICAgfVxyXG4gICAgaWYgKGJhbC5BdmVyYWdlUHJpY2UgIT09IHVuZGVmaW5lZCkge1xyXG4gICAgICBwb3NpdGlvbi5hdmVyYWdlQ29zdCA9IGJhbC5BdmVyYWdlUHJpY2U7XHJcbiAgICB9XHJcbiAgICBpZiAoYmFsLkF2ZXJhZ2VQcmljZVByb2ZpdExvc3MgIT09IHVuZGVmaW5lZCkge1xyXG4gICAgICBwb3NpdGlvbi51bnJlYWxpemVkUG5sID0gYmFsLkF2ZXJhZ2VQcmljZVByb2ZpdExvc3M7XHJcbiAgICB9XHJcbiAgICBpZiAoYmFsLkF2ZXJhZ2VQcmljZVByb2ZpdExvc3NQZXJjZW50YWdlICE9PSB1bmRlZmluZWQpIHtcclxuICAgICAgcG9zaXRpb24udW5yZWFsaXplZFBubFBjdCA9IGJhbC5BdmVyYWdlUHJpY2VQcm9maXRMb3NzUGVyY2VudGFnZTtcclxuICAgIH1cclxuICAgIGlmIChhc09mICE9PSB1bmRlZmluZWQpIHtcclxuICAgICAgcG9zaXRpb24uYXNPZiA9IGFzT2Y7XHJcbiAgICB9XHJcblxyXG4gICAgaWYgKG9wdGlvbnM/LmluY2x1ZGVSYXdUcmFuc2FjdGlvbikge1xyXG4gICAgICBwb3NpdGlvbi5yYXdQb3NpdGlvbiA9IGdldFJhd1RyYW5zYWN0aW9uKHsgYmFsYW5jZTogYmFsLCBtZXRhOiBtZXRhID8/IG51bGwgfSk7XHJcbiAgICB9XHJcblxyXG4gICAgcmV0dXJuIHBvc2l0aW9uO1xyXG4gIH0pO1xyXG5cclxuICByZXR1cm4ge1xyXG4gICAgYWNjb3VudE51bWJlcixcclxuICAgIGJhc2VDdXJyZW5jeTogYWNjb3VudD8uQ3VycmVuY3lDb2RlLFxyXG4gICAgdG90YWxWYWx1ZTogYWNjb3VudD8uT25saW5lVmFsdWUsXHJcbiAgICBjYXNoOiBhY2NvdW50Py5PbmxpbmVDYXNoLFxyXG4gICAgcG9zaXRpb25zLFxyXG4gIH07XHJcbn1cclxuXHJcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxyXG4vLyBPVFAgLyAyRkEgZGV0ZWN0aW9uIGhlbHBlciAoZXhwb3J0ZWQgZm9yIHVuaXQgdGVzdGluZylcclxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXHJcblxyXG4vKipcclxuICogRGVmZW5zaXZlIGJlc3QtZWZmb3J0IDJGQS9PVFAgY2hhbGxlbmdlIGRldGVjdG9yLlxyXG4gKlxyXG4gKiBCZWNhdXNlIG5vIGNvbmZpcm1lZCBPVFAgQ1NTIHNlbGVjdG9yIGlzIGF2YWlsYWJsZSBmcm9tIHRoZSBsaXZlIGNhcHR1cmUsIHRoaXNcclxuICogdHJpZXMgYSBmZXcgaGV1cmlzdGljIHNlbGVjdG9ycyBhbmQgYWx3YXlzIHJldHVybnMgZmFsc2Ugd2hlbiB1bmNlcnRhaW4uXHJcbiAqIFRoZSBpbnRlbnQgaXMgdG8gZmFpbCBsb3VkbHkgKFR3b0ZhY3RvclJldHJpZXZlck1pc3NpbmcpIGZvciBhY2NvdW50cyB0aGF0IERPXHJcbiAqIGhhdmUgMkZBIGVuYWJsZWQsIHJhdGhlciB0aGFuIHNpbGVudGx5IGxvb3BpbmcuXHJcbiAqXHJcbiAqIFRPRE86IG9uY2UgYSAyRkEtZW5hYmxlZCBFeGNlbGxlbmNlIGFjY291bnQgaXMgYXZhaWxhYmxlLCBjYXB0dXJlIHRoZSBleGFjdCBPVFBcclxuICogICAgICAgZm9ybSBzZWxlY3RvciBhbmQgcmVwbGFjZSB0aGUgaGV1cmlzdGljcyBoZXJlLlxyXG4gKi9cclxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGRldGVjdE90cENoYWxsZW5nZShwYWdlOiBQYWdlIHwgdW5kZWZpbmVkKTogUHJvbWlzZTxib29sZWFuPiB7XHJcbiAgaWYgKCFwYWdlKSByZXR1cm4gZmFsc2U7XHJcbiAgdHJ5IHtcclxuICAgIC8vIEhldXJpc3RpYyBzZWxlY3RvcnMg4oCUIGFkanVzdCBhZnRlciBsaXZlIDJGQSBjYXB0dXJlXHJcbiAgICBjb25zdCBjYW5kaWRhdGVzID0gW1xyXG4gICAgICAnaW5wdXRbdHlwZT1cInRlbFwiXScsIC8vIHR5cGljYWwgT1RQIGRpZ2l0IGlucHV0XHJcbiAgICAgICdbY2xhc3MqPVwib3RwXCJdJyxcclxuICAgICAgJ1tjbGFzcyo9XCJ0d28tZmFjdG9yXCJdJyxcclxuICAgICAgJ1tjbGFzcyo9XCIyZmFcIl0nLFxyXG4gICAgICAnW2lkKj1cIm90cFwiXScsXHJcbiAgICBdO1xyXG4gICAgZm9yIChjb25zdCBzZWxlY3RvciBvZiBjYW5kaWRhdGVzKSB7XHJcbiAgICAgIGNvbnN0IGVsID0gYXdhaXQgcGFnZS4kKHNlbGVjdG9yKTtcclxuICAgICAgaWYgKGVsKSByZXR1cm4gdHJ1ZTtcclxuICAgIH1cclxuICAgIHJldHVybiBmYWxzZTtcclxuICB9IGNhdGNoIHtcclxuICAgIC8vIElmIHRoZSBwYWdlIGlzIG5hdmlnYXRpbmcgb3IgdGhlIGV2YWx1YXRpb24gY29udGV4dCBpcyBkZXN0cm95ZWQsIGVyciBvbiB0aGUgc2FmZSBzaWRlLlxyXG4gICAgcmV0dXJuIGZhbHNlO1xyXG4gIH1cclxufVxyXG5cclxuZnVuY3Rpb24gZ2V0UG9zc2libGVMb2dpblJlc3VsdHMoKTogUG9zc2libGVMb2dpblJlc3VsdHMge1xyXG4gIGNvbnN0IHJlc3VsdHM6IFBvc3NpYmxlTG9naW5SZXN1bHRzID0ge307XHJcblxyXG4gIC8vIFN1Y2Nlc3M6IGFmdGVyIGxvZ2luIHRoZSBTUEEgbmF2aWdhdGVzIHRvIC9hcHBcclxuICByZXN1bHRzW0xvZ2luUmVzdWx0cy5TdWNjZXNzXSA9IFsvXFwvYXBwL2ldO1xyXG5cclxuICAvLyBEZWZlbnNpdmUgMkZBIGRldGVjdGlvbiDigJQgbm8gY29uZmlybWVkIHNlbGVjdG9yLCBiZXN0LWVmZm9ydCBoZXVyaXN0aWNzXHJcbiAgcmVzdWx0c1tMb2dpblJlc3VsdHMuVHdvRmFjdG9yUmV0cmlldmVyTWlzc2luZ10gPSBbXHJcbiAgICBhc3luYyAob3B0aW9ucz86IHsgcGFnZT86IFBhZ2UgfSkgPT4gZGV0ZWN0T3RwQ2hhbGxlbmdlKG9wdGlvbnM/LnBhZ2UpLFxyXG4gIF07XHJcblxyXG4gIHJldHVybiByZXN1bHRzO1xyXG59XHJcblxyXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cclxuLy8gSW4tcGFnZSBhdXRoZW50aWNhdGVkIGZldGNoIGhlbHBlclxyXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cclxuXHJcbi8qKlxyXG4gKiBBdXRoZW50aWNhdGVkIHJlcXVlc3QgdG9rZW5zIChjb25maXJtZWQgYWdhaW5zdCBhIGxpdmUgc2Vzc2lvbiwgMjAyNi0wNi0yNCk6XHJcbiAqICAgLSBgc2Vzc2lvbmAgIGhlYWRlciA9IHRoZSBgU2Vzc2lvbktleWAgKGEgVVVJRCkgcmV0dXJuZWQgYnkgUE9TVCAvbG9naW4uXHJcbiAqICAgLSBgY3Nlc3Npb25gIGhlYWRlciA9IGEgY2xpZW50LWdlbmVyYXRlZCByYW5kb20gdmFsdWUsIHNlbnQgb24gRVZFUlkgcmVxdWVzdFxyXG4gKiAgICAgKGluY2x1ZGluZyAvbG9naW4gaXRzZWxmKS4gVGhlIHNlcnZlciBiaW5kcyB0aGUgaXNzdWVkIFNlc3Npb25LZXkgdG8gd2hhdGV2ZXJcclxuICogICAgIGNzZXNzaW9uIGFjY29tcGFuaWVkIHRoZSBsb2dpbiwgc28gdGhlIFNBTUUgY3Nlc3Npb24gbXVzdCBiZSByZXVzZWQgdGhyb3VnaG91dC5cclxuICogQXV0aCBpcyBoZWFkZXItYmFzZWQsIG5vdCBjb29raWUtYmFzZWQuXHJcbiAqXHJcbiAqIElNUE9SVEFOVDogTkVWRVIgbG9nIHNlc3Npb24sIGNzZXNzaW9uLCBvciBTZXNzaW9uS2V5IHZhbHVlcy5cclxuICovXHJcbmludGVyZmFjZSBTZXNzaW9uVG9rZW5zIHtcclxuICBzZXNzaW9uOiBzdHJpbmc7XHJcbiAgY3Nlc3Npb246IHN0cmluZztcclxufVxyXG5cclxuLyoqXHJcbiAqIFBlcmZvcm0gYW4gYXV0aGVudGljYXRlZCBHRVQgaW5zaWRlIHRoZSBQdXBwZXRlZXIgcGFnZSBjb250ZXh0LlxyXG4gKi9cclxuYXN5bmMgZnVuY3Rpb24gZmV0Y2hXaXRoU2Vzc2lvbkhlYWRlcnM8VD4ocGFnZTogUGFnZSwgdXJsOiBzdHJpbmcsIHRva2VuczogU2Vzc2lvblRva2Vucyk6IFByb21pc2U8VCB8IG51bGw+IHtcclxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBwYWdlLmV2YWx1YXRlKFxyXG4gICAgYXN5bmMgKGlubmVyVXJsOiBzdHJpbmcsIGlubmVyVG9rZW5zOiBTZXNzaW9uVG9rZW5zKSA9PiB7XHJcbiAgICAgIHRyeSB7XHJcbiAgICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChpbm5lclVybCwge1xyXG4gICAgICAgICAgY3JlZGVudGlhbHM6ICdpbmNsdWRlJyxcclxuICAgICAgICAgIGhlYWRlcnM6IHtcclxuICAgICAgICAgICAgQWNjZXB0OiAnYXBwbGljYXRpb24vanNvbicsXHJcbiAgICAgICAgICAgICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicsXHJcbiAgICAgICAgICAgIHNlc3Npb246IGlubmVyVG9rZW5zLnNlc3Npb24sXHJcbiAgICAgICAgICAgIGNzZXNzaW9uOiBpbm5lclRva2Vucy5jc2Vzc2lvbixcclxuICAgICAgICAgIH0sXHJcbiAgICAgICAgfSk7XHJcblxyXG4gICAgICAgIGlmIChyZXNwb25zZS5zdGF0dXMgPT09IDIwNCkgcmV0dXJuIG51bGw7XHJcbiAgICAgICAgY29uc3QgdGV4dCA9IGF3YWl0IHJlc3BvbnNlLnRleHQoKTtcclxuICAgICAgICByZXR1cm4gSlNPTi5wYXJzZSh0ZXh0KSBhcyB1bmtub3duO1xyXG4gICAgICB9IGNhdGNoIHtcclxuICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgICAgfVxyXG4gICAgfSxcclxuICAgIHVybCxcclxuICAgIHRva2VucyxcclxuICApO1xyXG4gIHJldHVybiByZXN1bHQgYXMgVCB8IG51bGw7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBQZXJmb3JtIGFuIGF1dGhlbnRpY2F0ZWQgUE9TVCBpbnNpZGUgdGhlIFB1cHBldGVlciBwYWdlIGNvbnRleHQuXHJcbiAqL1xyXG5hc3luYyBmdW5jdGlvbiBwb3N0V2l0aFNlc3Npb25IZWFkZXJzPFQ+KFxyXG4gIHBhZ2U6IFBhZ2UsXHJcbiAgdXJsOiBzdHJpbmcsXHJcbiAgYm9keTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sXHJcbiAgdG9rZW5zOiBTZXNzaW9uVG9rZW5zLFxyXG4pOiBQcm9taXNlPFQgfCBudWxsPiB7XHJcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcGFnZS5ldmFsdWF0ZShcclxuICAgIGFzeW5jIChpbm5lclVybDogc3RyaW5nLCBpbm5lckJvZHk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LCBpbm5lclRva2VuczogU2Vzc2lvblRva2VucykgPT4ge1xyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2goaW5uZXJVcmwsIHtcclxuICAgICAgICAgIG1ldGhvZDogJ1BPU1QnLFxyXG4gICAgICAgICAgY3JlZGVudGlhbHM6ICdpbmNsdWRlJyxcclxuICAgICAgICAgIGhlYWRlcnM6IHtcclxuICAgICAgICAgICAgQWNjZXB0OiAnYXBwbGljYXRpb24vanNvbicsXHJcbiAgICAgICAgICAgICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicsXHJcbiAgICAgICAgICAgIHNlc3Npb246IGlubmVyVG9rZW5zLnNlc3Npb24sXHJcbiAgICAgICAgICAgIGNzZXNzaW9uOiBpbm5lclRva2Vucy5jc2Vzc2lvbixcclxuICAgICAgICAgIH0sXHJcbiAgICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeShpbm5lckJvZHkpLFxyXG4gICAgICAgIH0pO1xyXG5cclxuICAgICAgICBpZiAocmVzcG9uc2Uuc3RhdHVzID09PSAyMDQpIHJldHVybiBudWxsO1xyXG4gICAgICAgIGNvbnN0IHRleHQgPSBhd2FpdCByZXNwb25zZS50ZXh0KCk7XHJcbiAgICAgICAgcmV0dXJuIEpTT04ucGFyc2UodGV4dCkgYXMgdW5rbm93bjtcclxuICAgICAgfSBjYXRjaCB7XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICAgIH1cclxuICAgIH0sXHJcbiAgICB1cmwsXHJcbiAgICBib2R5LFxyXG4gICAgdG9rZW5zLFxyXG4gICk7XHJcbiAgcmV0dXJuIHJlc3VsdCBhcyBUIHwgbnVsbDtcclxufVxyXG5cclxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXHJcbi8vIENyZWRlbnRpYWxzIHR5cGVcclxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXHJcblxyXG50eXBlIEV4Y2VsbGVuY2VDcmVkZW50aWFscyA9IHtcclxuICB1c2VybmFtZTogc3RyaW5nO1xyXG4gIHBhc3N3b3JkOiBzdHJpbmc7XHJcbn07XHJcblxyXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cclxuLy8gU2NyYXBlciBjbGFzc1xyXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cclxuXHJcbmNsYXNzIEV4Y2VsbGVuY2VTY3JhcGVyIGV4dGVuZHMgQmFzZVNjcmFwZXJXaXRoQnJvd3NlcjxFeGNlbGxlbmNlQ3JlZGVudGlhbHM+IHtcclxuICAvKiogVGhlIFNlc3Npb25LZXkgKFVVSUQpIGZyb20gdGhlIC9sb2dpbiByZXNwb25zZSwgdXNlZCBhcyB0aGUgYHNlc3Npb25gIGhlYWRlci4gTmV2ZXIgbG9nZ2VkLiAqL1xyXG4gIHByaXZhdGUgc2Vzc2lvbktleSA9ICcnO1xyXG5cclxuICAvKipcclxuICAgKiBDbGllbnQtZ2VuZXJhdGVkIGBjc2Vzc2lvbmAgdmFsdWUuIEdlbmVyYXRlZCBvbmNlIHBlciBzY3JhcGUgYW5kIHJldXNlZCBvbiB0aGVcclxuICAgKiBsb2dpbiByZXF1ZXN0IGFuZCBldmVyeSBhdXRoZW50aWNhdGVkIGNhbGwgKHRoZSBzZXJ2ZXIgYmluZHMgdGhlIFNlc3Npb25LZXkgdG8gaXQpLlxyXG4gICAqIE5ldmVyIGxvZ2dlZC5cclxuICAgKi9cclxuICBwcml2YXRlIGNzZXNzaW9uID0gJyc7XHJcblxyXG4gIHByaXZhdGUgZ2V0IHRva2VucygpOiBTZXNzaW9uVG9rZW5zIHtcclxuICAgIHJldHVybiB7IHNlc3Npb246IHRoaXMuc2Vzc2lvbktleSwgY3Nlc3Npb246IHRoaXMuY3Nlc3Npb24gfTtcclxuICB9XHJcblxyXG4gIGdldCBiYXNlVXJsKCkge1xyXG4gICAgcmV0dXJuIEJBU0VfVVJMO1xyXG4gIH1cclxuXHJcbiAgZ2V0TG9naW5PcHRpb25zKGNyZWRlbnRpYWxzOiBFeGNlbGxlbmNlQ3JlZGVudGlhbHMpIHtcclxuICAgIC8vIFdlIG92ZXJyaWRlIGxvZ2luKCkgdG8gZG8gYSBkaXJlY3QgaW4tcGFnZSBQT1NUIHJhdGhlciB0aGFuIGRyaXZpbmcgdGhlIERPTVxyXG4gICAgLy8gZm9ybSwgYmVjYXVzZSBET00gc2VsZWN0b3JzIGhhdmUgbm90IGJlZW4gY29uZmlybWVkIGZyb20gYSBsaXZlIGNhcHR1cmUuXHJcbiAgICAvLyBnZXRMb2dpbk9wdGlvbnMoKSBpcyBzdGlsbCByZXF1aXJlZCBieSB0aGUgYmFzZSBjbGFzcyBpbnRlcmZhY2UsIHNvIHdlIHJldHVyblxyXG4gICAgLy8gYSBtaW5pbWFsIHN0dWIuIFRoZSBhY3R1YWwgbG9naW4gbG9naWMgaXMgaW4gbG9naW4oKSBiZWxvdy5cclxuICAgIHJldHVybiB7XHJcbiAgICAgIGxvZ2luVXJsOiBgJHtCQVNFX1VSTH0vbG9naW5gLFxyXG4gICAgICBmaWVsZHM6IFtcclxuICAgICAgICAvLyBTdHViIOKAlCBub3QgdXNlZCBiZWNhdXNlIGxvZ2luKCkgb3ZlcnJpZGVzIHRoZSBmb3JtLWRyaXZlIGZsb3dcclxuICAgICAgICB7IHNlbGVjdG9yOiAnW25hbWU9XCJ1c2VybmFtZVwiXScsIHZhbHVlOiBjcmVkZW50aWFscy51c2VybmFtZSB9LFxyXG4gICAgICAgIHsgc2VsZWN0b3I6ICdbbmFtZT1cInBhc3N3b3JkXCJdJywgdmFsdWU6IGNyZWRlbnRpYWxzLnBhc3N3b3JkIH0sXHJcbiAgICAgIF0sXHJcbiAgICAgIHN1Ym1pdEJ1dHRvblNlbGVjdG9yOiBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgLy8gTm8tb3A6IGxvZ2luKCkgaGFuZGxlcyBzdWJtaXNzaW9uIGRpcmVjdGx5XHJcbiAgICAgIH0sXHJcbiAgICAgIHBvc3NpYmxlUmVzdWx0czogZ2V0UG9zc2libGVMb2dpblJlc3VsdHMoKSxcclxuICAgIH07XHJcbiAgfVxyXG5cclxuICAvKipcclxuICAgKiBPdmVycmlkZSBsb2dpbigpIHRvIGF1dGhlbnRpY2F0ZSB2aWEgYSBkaXJlY3QgaW4tcGFnZSBKU09OIFBPU1QuXHJcbiAgICpcclxuICAgKiBSYXRpb25hbGU6IHJhdGhlciB0aGFuIGRyaXZpbmcgdGhlIFNQQSdzIERPTSBmb3JtLCB3ZSBQT1NUIGRpcmVjdGx5IHRvIHRoZVxyXG4gICAqIHN0YWJsZSBKU09OIEFQSSBlbmRwb2ludC4gUmVxdWVzdC9yZXNwb25zZSBzaGFwZXMgY29uZmlybWVkIGFnYWluc3QgYSBsaXZlXHJcbiAgICogc2Vzc2lvbiAoMjAyNi0wNi0yNCkuXHJcbiAgICpcclxuICAgKiBGbG93OlxyXG4gICAqICAxLiBOYXZpZ2F0ZSB0byB0aGUgbG9naW4gcGFnZSB0byBlc3RhYmxpc2ggdGhlIGNvcnJlY3Qgc2FtZS1vcmlnaW4gY29udGV4dC5cclxuICAgKiAgMi4gR2VuZXJhdGUgYSBgY3Nlc3Npb25gIHZhbHVlIGFuZCBQT1NUIC9hcGkvdjIvanNvbjIvbG9naW4gd2l0aCB0aGVcclxuICAgKiAgICAge0xvZ2luOntVc2VyLFBhc3N3b3JkfX0gYm9keSBhbmQgdGhlIGNzZXNzaW9uIGhlYWRlci5cclxuICAgKiAgMy4gUGFyc2UgcmVzcG9uc2U6IGV4dHJhY3QgTG9naW4uU2Vzc2lvbktleSBvbiBzdWNjZXNzLCBkZXRlY3QgZXJyb3JzLlxyXG4gICAqL1xyXG4gIGFzeW5jIGxvZ2luKGNyZWRlbnRpYWxzOiBFeGNlbGxlbmNlQ3JlZGVudGlhbHMpOiBQcm9taXNlPFNjcmFwZXJMb2dpblJlc3VsdD4ge1xyXG4gICAgZGVidWcoJ25hdmlnYXRpbmcgdG8gbG9naW4gcGFnZScpO1xyXG4gICAgLy8gTmF2aWdhdGUgdG8gdGhlIGxvZ2luIHBhZ2UgdG8gZXN0YWJsaXNoIG9yaWdpbiBjb250ZXh0IGZvciBpbi1wYWdlIGZldGNoXHJcbiAgICB0cnkge1xyXG4gICAgICBhd2FpdCB0aGlzLm5hdmlnYXRlVG8oYCR7QkFTRV9VUkx9L2xvZ2luYCwgJ2RvbWNvbnRlbnRsb2FkZWQnKTtcclxuICAgIH0gY2F0Y2ggKGUpIHtcclxuICAgICAgZGVidWcoJ25hdmlnYXRlVG8gbG9naW4gcGFnZSBmYWlsZWQ6ICVzJywgKGUgYXMgRXJyb3IpLm1lc3NhZ2UpO1xyXG4gICAgICAvLyBOb24tZmF0YWw6IGNvbnRpbnVlIOKAlCB0aGUgcGFnZSBtaWdodCBiZSBwYXJ0aWFsbHkgbG9hZGVkLCBhbmQgdGhlIGluLXBhZ2UgUE9TVFxyXG4gICAgICAvLyBtYXkgc3RpbGwgd29yayBpZiB0aGUgb3JpZ2luIGlzIHNldCBjb3JyZWN0bHkuXHJcbiAgICB9XHJcblxyXG4gICAgLy8gR2VuZXJhdGUgdGhlIHBlci1zZXNzaW9uIGNzZXNzaW9uIHRva2VuLiBUaGUgbGl2ZSBTUEEgdXNlcyBhIE1hdGgucmFuZG9tKCkgZmxvYXRcclxuICAgIC8vIHN0cmluZyAoZS5nLiBcIjAuNDM4MS4uLlwiKSwgc28gd2UgbWlycm9yIHRoYXQgZXhhY3QgZm9ybWF0IHRvIGF2b2lkIGFueSBzZXJ2ZXItc2lkZVxyXG4gICAgLy8gc2hhcGUgdmFsaWRhdGlvbi4gSXQgaXMgY2xpZW50LWNob3NlbiBhbmQgb25seSBuZWVkcyB0byBzdGF5IGNvbnNpc3RlbnQgYWNyb3NzIHRoZVxyXG4gICAgLy8gc2Vzc2lvbiAodGhlIHNlcnZlciBiaW5kcyB0aGUgaXNzdWVkIFNlc3Npb25LZXkgdG8gaXQpLlxyXG4gICAgdGhpcy5jc2Vzc2lvbiA9IFN0cmluZyhNYXRoLnJhbmRvbSgpKTtcclxuXHJcbiAgICBkZWJ1ZygncG9zdGluZyBjcmVkZW50aWFscyB0byBsb2dpbiBBUEknKTtcclxuICAgIC8vIE5FVkVSIGxvZyBjcmVkZW50aWFscywgc2Vzc2lvbktleSwgc2Vzc2lvbiwgb3IgY3Nlc3Npb24gdmFsdWVzLlxyXG4gICAgY29uc3QgbG9naW5SZXNwb25zZSA9IGF3YWl0IHRoaXMucGFnZS5ldmFsdWF0ZShcclxuICAgICAgYXN5bmMgKGFwaVVybDogc3RyaW5nLCB1c2VybmFtZTogc3RyaW5nLCBwYXNzd29yZDogc3RyaW5nLCBjc2Vzc2lvbjogc3RyaW5nKSA9PiB7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2goYXBpVXJsLCB7XHJcbiAgICAgICAgICAgIG1ldGhvZDogJ1BPU1QnLFxyXG4gICAgICAgICAgICBjcmVkZW50aWFsczogJ2luY2x1ZGUnLFxyXG4gICAgICAgICAgICBoZWFkZXJzOiB7XHJcbiAgICAgICAgICAgICAgQWNjZXB0OiAnYXBwbGljYXRpb24vanNvbicsXHJcbiAgICAgICAgICAgICAgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyxcclxuICAgICAgICAgICAgICBjc2Vzc2lvbixcclxuICAgICAgICAgICAgfSxcclxuICAgICAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBMb2dpbjogeyBVc2VyOiB1c2VybmFtZSwgUGFzc3dvcmQ6IHBhc3N3b3JkIH0gfSksXHJcbiAgICAgICAgICB9KTtcclxuICAgICAgICAgIGNvbnN0IHRleHQgPSBhd2FpdCByZXNwb25zZS50ZXh0KCk7XHJcbiAgICAgICAgICByZXR1cm4geyBvazogcmVzcG9uc2Uub2ssIHN0YXR1czogcmVzcG9uc2Uuc3RhdHVzLCBib2R5OiB0ZXh0IH07XHJcbiAgICAgICAgfSBjYXRjaCAoZSkge1xyXG4gICAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBzdGF0dXM6IDAsIGJvZHk6IFN0cmluZyhlKSB9O1xyXG4gICAgICAgIH1cclxuICAgICAgfSxcclxuICAgICAgYCR7QVBJX0JBU0V9L2xvZ2luYCxcclxuICAgICAgY3JlZGVudGlhbHMudXNlcm5hbWUsXHJcbiAgICAgIGNyZWRlbnRpYWxzLnBhc3N3b3JkLFxyXG4gICAgICB0aGlzLmNzZXNzaW9uLFxyXG4gICAgKTtcclxuXHJcbiAgICBpZiAoIWxvZ2luUmVzcG9uc2Uub2spIHtcclxuICAgICAgZGVidWcoJ2xvZ2luIEhUVFAgZXJyb3I6IHN0YXR1cz0lZCcsIGxvZ2luUmVzcG9uc2Uuc3RhdHVzKTtcclxuICAgICAgcmV0dXJuIHtcclxuICAgICAgICBzdWNjZXNzOiBmYWxzZSxcclxuICAgICAgICBlcnJvclR5cGU6IFNjcmFwZXJFcnJvclR5cGVzLkdlbmVyYWwsXHJcbiAgICAgICAgZXJyb3JNZXNzYWdlOiBgTG9naW4gcmVxdWVzdCBmYWlsZWQgd2l0aCBIVFRQICR7bG9naW5SZXNwb25zZS5zdGF0dXN9YCxcclxuICAgICAgfTtcclxuICAgIH1cclxuXHJcbiAgICBsZXQgcGFyc2VkOiBMb2dpblJlc3BvbnNlO1xyXG4gICAgdHJ5IHtcclxuICAgICAgcGFyc2VkID0gSlNPTi5wYXJzZShsb2dpblJlc3BvbnNlLmJvZHkpIGFzIExvZ2luUmVzcG9uc2U7XHJcbiAgICB9IGNhdGNoIHtcclxuICAgICAgZGVidWcoJ2ZhaWxlZCB0byBwYXJzZSBsb2dpbiByZXNwb25zZSBKU09OJyk7XHJcbiAgICAgIHJldHVybiB7XHJcbiAgICAgICAgc3VjY2VzczogZmFsc2UsXHJcbiAgICAgICAgZXJyb3JUeXBlOiBTY3JhcGVyRXJyb3JUeXBlcy5HZW5lcmFsLFxyXG4gICAgICAgIGVycm9yTWVzc2FnZTogJ0xvZ2luIHJlc3BvbnNlIHdhcyBub3QgdmFsaWQgSlNPTicsXHJcbiAgICAgIH07XHJcbiAgICB9XHJcblxyXG4gICAgLy8gQ2hlY2sgZm9yIEFQSS1sZXZlbCBlcnJvclxyXG4gICAgaWYgKHBhcnNlZC5FcnJvciB8fCBwYXJzZWQuZXJyb3IpIHtcclxuICAgICAgY29uc3QgY29kZSA9IHBhcnNlZC5FcnJvcj8uQ29kZSA/PyBwYXJzZWQuZXJyb3IgPz8gJ3Vua25vd24nO1xyXG4gICAgICBjb25zdCBtc2cgPSBwYXJzZWQuRXJyb3I/Lk1lc3NhZ2UgPz8gcGFyc2VkLm1lc3NhZ2UgPz8gJyc7XHJcbiAgICAgIGRlYnVnKCdsb2dpbiBBUEkgZXJyb3I6IGNvZGU9JXMnLCBjb2RlKTtcclxuXHJcbiAgICAgIC8vIEhldXJpc3RpYzogdHJlYXQgXCJpbnZhbGlkXCIgLyBcIndyb25nXCIgY3JlZGVudGlhbCBlcnJvcnMgYXMgSW52YWxpZFBhc3N3b3JkXHJcbiAgICAgIGNvbnN0IGlzSW52YWxpZENyZWRzID1cclxuICAgICAgICB0eXBlb2YgbXNnID09PSAnc3RyaW5nJyAmJlxyXG4gICAgICAgIChtc2cudG9Mb3dlckNhc2UoKS5pbmNsdWRlcygnaW52YWxpZCcpIHx8XHJcbiAgICAgICAgICBtc2cudG9Mb3dlckNhc2UoKS5pbmNsdWRlcygnd3JvbmcnKSB8fFxyXG4gICAgICAgICAgbXNnLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoJ9ep15LXldeZJykgfHxcclxuICAgICAgICAgIG1zZy50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKCdpbmNvcnJlY3QnKSk7XHJcblxyXG4gICAgICBpZiAoaXNJbnZhbGlkQ3JlZHMpIHtcclxuICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgc3VjY2VzczogZmFsc2UsXHJcbiAgICAgICAgICBlcnJvclR5cGU6IFNjcmFwZXJFcnJvclR5cGVzLkludmFsaWRQYXNzd29yZCxcclxuICAgICAgICAgIGVycm9yTWVzc2FnZTogYExvZ2luIGZhaWxlZDogJHttc2d9YCxcclxuICAgICAgICB9O1xyXG4gICAgICB9XHJcblxyXG4gICAgICByZXR1cm4ge1xyXG4gICAgICAgIHN1Y2Nlc3M6IGZhbHNlLFxyXG4gICAgICAgIGVycm9yVHlwZTogU2NyYXBlckVycm9yVHlwZXMuR2VuZXJhbCxcclxuICAgICAgICBlcnJvck1lc3NhZ2U6IGBMb2dpbiBBUEkgZXJyb3IgKGNvZGUgJHtjb2RlfSk6ICR7bXNnfWAsXHJcbiAgICAgIH07XHJcbiAgICB9XHJcblxyXG4gICAgY29uc3Qgc2Vzc2lvbktleSA9IHBhcnNlZC5Mb2dpbj8uU2Vzc2lvbktleTtcclxuICAgIGlmICghc2Vzc2lvbktleSkge1xyXG4gICAgICBkZWJ1ZygnbG9naW4gcmVzcG9uc2UgbWlzc2luZyBTZXNzaW9uS2V5Jyk7XHJcbiAgICAgIC8vIENoZWNrIGZvciBPVFAgY2hhbGxlbmdlIGhldXJpc3RpY2FsbHkgYmVmb3JlIGdpdmluZyB1cFxyXG4gICAgICBjb25zdCBoYXNPdHAgPSBhd2FpdCBkZXRlY3RPdHBDaGFsbGVuZ2UodGhpcy5wYWdlKTtcclxuICAgICAgaWYgKGhhc090cCkge1xyXG4gICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICBzdWNjZXNzOiBmYWxzZSxcclxuICAgICAgICAgIGVycm9yVHlwZTogU2NyYXBlckVycm9yVHlwZXMuVHdvRmFjdG9yUmV0cmlldmVyTWlzc2luZyxcclxuICAgICAgICAgIGVycm9yTWVzc2FnZTpcclxuICAgICAgICAgICAgJ0V4Y2VsbGVuY2UgMkZBL09UUCBjaGFsbGVuZ2UgZGV0ZWN0ZWQuIEZ1bGwgT1RQIHN1cHBvcnQgaXMgbm90IHlldCBpbXBsZW1lbnRlZCAnICtcclxuICAgICAgICAgICAgJyhubyAyRkEtZW5hYmxlZCB0ZXN0IGFjY291bnQgd2FzIGF2YWlsYWJsZSBkdXJpbmcgZGV2ZWxvcG1lbnQpLiAnICtcclxuICAgICAgICAgICAgJ0lmIHlvdXIgYWNjb3VudCByZXF1aXJlcyAyRkEsIHBsZWFzZSBvcGVuIGFuIGlzc3VlLicsXHJcbiAgICAgICAgfTtcclxuICAgICAgfVxyXG4gICAgICByZXR1cm4ge1xyXG4gICAgICAgIHN1Y2Nlc3M6IGZhbHNlLFxyXG4gICAgICAgIGVycm9yVHlwZTogU2NyYXBlckVycm9yVHlwZXMuR2VuZXJhbCxcclxuICAgICAgICBlcnJvck1lc3NhZ2U6ICdMb2dpbiBzdWNjZWVkZWQgYnV0IFNlc3Npb25LZXkgd2FzIG5vdCByZXR1cm5lZCcsXHJcbiAgICAgIH07XHJcbiAgICB9XHJcblxyXG4gICAgLy8gU3RvcmUgZm9yIHVzZSBpbiBmZXRjaERhdGEoKS4gTkVWRVIgbG9nIHRoaXMgdmFsdWUuXHJcbiAgICB0aGlzLnNlc3Npb25LZXkgPSBzZXNzaW9uS2V5O1xyXG4gICAgZGVidWcoJ2xvZ2luIHN1Y2Nlc3NmdWwsIFNlc3Npb25LZXkgY2FwdHVyZWQgKG5vdCBsb2dnZWQpJyk7XHJcblxyXG4gICAgLy8gTm8gZnVydGhlciBuYXZpZ2F0aW9uIG5lZWRlZDogYXV0aGVudGljYXRlZCBBUEkgY2FsbHMgYXJlIG1hZGUgZnJvbSB0aGlzXHJcbiAgICAvLyBzYW1lLW9yaWdpbiBwYWdlIHVzaW5nIGV4cGxpY2l0IHNlc3Npb24vY3Nlc3Npb24gaGVhZGVycyAoc2VlIGZldGNoRGF0YSkuXHJcbiAgICByZXR1cm4geyBzdWNjZXNzOiB0cnVlIH07XHJcbiAgfVxyXG5cclxuICBhc3luYyBmZXRjaERhdGEoKSB7XHJcbiAgICBkZWJ1ZygnZmV0Y2hpbmcgYWNjb3VudCBsaXN0Jyk7XHJcblxyXG4gICAgY29uc3QgYWNjb3VudHNSZXNwID0gYXdhaXQgZmV0Y2hXaXRoU2Vzc2lvbkhlYWRlcnM8QWNjb3VudHNSZXNwb25zZT4oXHJcbiAgICAgIHRoaXMucGFnZSxcclxuICAgICAgYCR7QVBJX0JBU0V9L2FjY291bnRzP3RvcD0xMGAsXHJcbiAgICAgIHRoaXMudG9rZW5zLFxyXG4gICAgKTtcclxuXHJcbiAgICBjb25zdCByYXdBY2NvdW50cyA9IGFjY291bnRzUmVzcD8uVXNlckFjY291bnRzPy5Vc2VyQWNjb3VudDtcclxuICAgIGNvbnN0IGFjY291bnRzOiBVc2VyQWNjb3VudFtdID0gcmF3QWNjb3VudHMgPT0gbnVsbCA/IFtdIDogQXJyYXkuaXNBcnJheShyYXdBY2NvdW50cykgPyByYXdBY2NvdW50cyA6IFtyYXdBY2NvdW50c107XHJcblxyXG4gICAgZGVidWcoJ2ZvdW5kICVkIGFjY291bnRzJywgYWNjb3VudHMubGVuZ3RoKTtcclxuXHJcbiAgICBjb25zdCBwb3J0Zm9saW9BY2NvdW50czogUG9ydGZvbGlvQWNjb3VudFtdID0gW107XHJcblxyXG4gICAgZm9yIChjb25zdCBhY2NvdW50IG9mIGFjY291bnRzKSB7XHJcbiAgICAgIGNvbnN0IGFjY291bnROdW1iZXIgPSBhY2NvdW50Wycta2V5J107XHJcbiAgICAgIGlmICghYWNjb3VudE51bWJlcikge1xyXG4gICAgICAgIGRlYnVnKCdza2lwcGluZyBhY2NvdW50IHdpdGggbWlzc2luZyBrZXknKTtcclxuICAgICAgICBjb250aW51ZTtcclxuICAgICAgfVxyXG5cclxuICAgICAgZGVidWcoJ2luaXRpYWxpc2luZyBhY2NvdW50ICVzJywgYWNjb3VudE51bWJlcik7XHJcbiAgICAgIC8vIFBPU1QgL2FjY291bnQvaW5pdCBhY3RpdmF0ZXMgdGhlIGFjY291bnQgZm9yIHRoZSBzZXNzaW9uXHJcbiAgICAgIGF3YWl0IHBvc3RXaXRoU2Vzc2lvbkhlYWRlcnM8dW5rbm93bj4oXHJcbiAgICAgICAgdGhpcy5wYWdlLFxyXG4gICAgICAgIGAke0FQSV9CQVNFfS9hY2NvdW50L2luaXQ/YWNjb3VudD0ke2VuY29kZVVSSUNvbXBvbmVudChhY2NvdW50TnVtYmVyKX1gLFxyXG4gICAgICAgIHt9LFxyXG4gICAgICAgIHRoaXMudG9rZW5zLFxyXG4gICAgICApO1xyXG5cclxuICAgICAgZGVidWcoJ2ZldGNoaW5nIGJhbGFuY2VzIGZvciBhY2NvdW50ICVzJywgYWNjb3VudE51bWJlcik7XHJcbiAgICAgIGNvbnN0IGJhbGFuY2VzUmVzcCA9IGF3YWl0IGZldGNoV2l0aFNlc3Npb25IZWFkZXJzPEJhbGFuY2VzUmVzcG9uc2U+KFxyXG4gICAgICAgIHRoaXMucGFnZSxcclxuICAgICAgICBgJHtBUElfQkFTRX0vYWNjb3VudC92aWV3L2JhbGFuY2VzP2FjY291bnQ9JHtlbmNvZGVVUklDb21wb25lbnQoYWNjb3VudE51bWJlcil9JmZpZWxkcz0ke0JBTEFOQ0VfRklFTERTfSZjdXJyZW5jeT1JTFNgLFxyXG4gICAgICAgIHRoaXMudG9rZW5zLFxyXG4gICAgICApO1xyXG5cclxuICAgICAgaWYgKCFiYWxhbmNlc1Jlc3ApIHtcclxuICAgICAgICBkZWJ1Zygnbm8gYmFsYW5jZXMgcmVzcG9uc2UgZm9yIGFjY291bnQgJXMsIHNraXBwaW5nJywgYWNjb3VudE51bWJlcik7XHJcbiAgICAgICAgY29udGludWU7XHJcbiAgICAgIH1cclxuXHJcbiAgICAgIGNvbnN0IHBvcnRmb2xpb0FjY291bnQgPSBtYXBCYWxhbmNlc1RvUG9ydGZvbGlvQWNjb3VudChhY2NvdW50TnVtYmVyLCBiYWxhbmNlc1Jlc3AsIHRoaXMub3B0aW9ucyk7XHJcbiAgICAgIHBvcnRmb2xpb0FjY291bnRzLnB1c2gocG9ydGZvbGlvQWNjb3VudCk7XHJcbiAgICB9XHJcblxyXG4gICAgZGVidWcoJ2ZldGNoRGF0YSBjb21wbGV0ZSwgJWQgcG9ydGZvbGlvIGFjY291bnRzJywgcG9ydGZvbGlvQWNjb3VudHMubGVuZ3RoKTtcclxuXHJcbiAgICByZXR1cm4ge1xyXG4gICAgICBzdWNjZXNzOiB0cnVlLFxyXG4gICAgICBwb3J0Zm9saW9BY2NvdW50cyxcclxuICAgIH07XHJcbiAgfVxyXG59XHJcblxyXG5leHBvcnQgZGVmYXVsdCBFeGNlbGxlbmNlU2NyYXBlcjtcclxuIl0sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7QUFDQSxJQUFBQSxNQUFBLEdBQUFDLE9BQUE7QUFDQSxJQUFBQyxhQUFBLEdBQUFELE9BQUE7QUFDQSxJQUFBRSxVQUFBLEdBQUFGLE9BQUE7QUFDQSxJQUFBRyx1QkFBQSxHQUFBSCxPQUFBO0FBQ0EsSUFBQUksT0FBQSxHQUFBSixPQUFBO0FBR0EsTUFBTUssS0FBSyxHQUFHLElBQUFDLGVBQVEsRUFBQyxZQUFZLENBQUM7QUFFcEMsTUFBTUMsUUFBUSxHQUFHLCtCQUErQjtBQUNoRCxNQUFNQyxRQUFRLEdBQUcsR0FBR0QsUUFBUSxlQUFlOztBQUUzQztBQUNBO0FBQ0E7QUFDQSxNQUFNRSxjQUFjLEdBQUcsOEZBQThGOztBQUVySDtBQUNBO0FBQ0E7O0FBNEZBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDTyxTQUFTQyxZQUFZQSxDQUFD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