"use strict";

var _definitions = require("../definitions");
var _portfolio = require("../portfolio");
var _testsUtils = require("../tests/tests-utils");
var _baseScraperWithBrowser = require("./base-scraper-with-browser");
var _excellence = _interopRequireWildcard(require("./excellence"));
function _interopRequireWildcard(e, t) { if ("function" == typeof WeakMap) var r = new WeakMap(), n = new WeakMap(); return (_interopRequireWildcard = function (e, t) { if (!t && e && e.__esModule) return e; var o, i, f = { __proto__: null, default: e }; if (null === e || "object" != typeof e && "function" != typeof e) return f; if (o = t ? n : r) { if (o.has(e)) return o.get(e); o.set(e, f); } for (const t in e) "default" !== t && {}.hasOwnProperty.call(e, t) && ((i = (o = Object.defineProperty) && Object.getOwnPropertyDescriptor(e, t)) && (i.get || i.set) ? o(f, t, i) : f[t] = e[t]); return f; })(e, t); }
const COMPANY_ID = 'excellence';
const testsConfig = (0, _testsUtils.getTestsConfig)();

// ---------------------------------------------------------------------------
// Minimal mock balances response (matches the §7.4 live-capture shape)
// ---------------------------------------------------------------------------
const MOCK_BALANCES_RESPONSE = {
  View: {
    Account: {
      OnlineValue: 150000.5,
      OnlineCash: 5000.25,
      CurrencyCode: 'ILS',
      BalanceCacheDate: '2026-06-24T10:00:00Z',
      AccountPosition: {
        Balance: [{
          EquityNumber: 1234,
          OnlineNV: 100,
          LastRate: 50.5,
          OnlineVL: 5050,
          OnlineNisVL: 5050,
          AveragePrice: 48.0,
          AveragePriceProfitLoss: 250,
          AveragePriceProfitLossPercentage: 5.21,
          CurrencyCode: 'ILS'
        }, {
          EquityNumber: 5678,
          OnlineNV: 10,
          BaseRate: 120.0,
          // no LastRate — should fall back to BaseRate
          OnlineVL: 1200,
          OnlineNisVL: 4200,
          AveragePrice: 115.0,
          AveragePriceProfitLoss: 50,
          AveragePriceProfitLossPercentage: 4.35,
          CurrencyCode: 'USD'
        }]
      }
    },
    Meta: {
      Security: [{
        '-Key': 1234,
        HebName: 'מניית בדיקה',
        EngName: 'Test Stock',
        Symbol: 'TST',
        HebSymbol: 'בדיקה',
        ItemType: '1',
        // stock
        IsEtf: false
      }, {
        '-Key': 5678,
        HebName: null,
        EngName: 'US Bond Fund',
        Symbol: null,
        EngSymbol: 'UBND',
        ItemType: '2',
        // bond
        IsEtf: false
      }]
    }
  }
};

// ---------------------------------------------------------------------------
// Registration / SCRAPERS metadata
// ---------------------------------------------------------------------------
describe('Excellence scraper', () => {
  beforeAll(() => {
    (0, _testsUtils.extendAsyncTimeout)();
  });
  test('should expose login fields in scrapers constant', () => {
    expect(_definitions.SCRAPERS[_definitions.CompanyTypes.excellence]).toBeDefined();
    expect(_definitions.SCRAPERS[_definitions.CompanyTypes.excellence].name).toBe('Excellence');
    expect(_definitions.SCRAPERS[_definitions.CompanyTypes.excellence].loginFields).toContain('username');
    expect(_definitions.SCRAPERS[_definitions.CompanyTypes.excellence].loginFields).toContain('password');
  });

  // ---------------------------------------------------------------------------
  // mapBalancesToPortfolioAccount unit tests
  // ---------------------------------------------------------------------------
  describe('mapBalancesToPortfolioAccount', () => {
    test('maps account-level totals correctly', () => {
      const result = (0, _excellence.mapBalancesToPortfolioAccount)('00-000000', MOCK_BALANCES_RESPONSE);
      expect(result.accountNumber).toBe('00-000000');
      expect(result.totalValue).toBe(150000.5);
      expect(result.cash).toBe(5000.25);
      expect(result.baseCurrency).toBe('ILS');
    });
    test('maps positions correctly using Meta join on EquityNumber / -Key', () => {
      const result = (0, _excellence.mapBalancesToPortfolioAccount)('00-000000', MOCK_BALANCES_RESPONSE);
      expect(result.positions).toHaveLength(2);
      const first = result.positions[0];
      expect(first.securityId).toBe('1234');
      expect(first.name).toBe('מניית בדיקה'); // HebName takes priority
      expect(first.symbol).toBe('TST');
      expect(first.quantity).toBe(100);
      expect(first.marketPrice).toBe(50.5); // from LastRate
      expect(first.marketValue).toBe(5050);
      expect(first.currency).toBe('ILS');
      expect(first.averageCost).toBe(48.0);
      expect(first.unrealizedPnl).toBe(250);
      expect(first.unrealizedPnlPct).toBe(5.21);
      expect(first.asOf).toBe('2026-06-24T10:00:00Z');
      expect(first.assetType).toBe(_portfolio.AssetType.Stock);
    });
    test('falls back to BaseRate when LastRate is absent', () => {
      const result = (0, _excellence.mapBalancesToPortfolioAccount)('00-000000', MOCK_BALANCES_RESPONSE);
      const second = result.positions[1];
      expect(second.securityId).toBe('5678');
      expect(second.marketPrice).toBe(120.0); // from BaseRate
      expect(second.currency).toBe('USD');
      expect(second.assetType).toBe(_portfolio.AssetType.Bond);
    });
    test('falls back to EngName when HebName is absent/null', () => {
      const result = (0, _excellence.mapBalancesToPortfolioAccount)('00-000000', MOCK_BALANCES_RESPONSE);
      const second = result.positions[1];
      expect(second.name).toBe('US Bond Fund');
      expect(second.symbol).toBe('UBND'); // EngSymbol fallback
    });
    test('omits rawPosition by default (includeRawTransaction not set)', () => {
      const result = (0, _excellence.mapBalancesToPortfolioAccount)('00-000000', MOCK_BALANCES_RESPONSE);
      expect(result.positions[0].rawPosition).toBeUndefined();
    });
    test('includes rawPosition when includeRawTransaction is true', () => {
      const result = (0, _excellence.mapBalancesToPortfolioAccount)('00-000000', MOCK_BALANCES_RESPONSE, {
        includeRawTransaction: true
      });
      expect(result.positions[0].rawPosition).toBeDefined();
      expect(result.positions[0].rawPosition).not.toBeNull();
    });
    test('handles single Balance object (non-array) gracefully', () => {
      const singleBalance = {
        ...MOCK_BALANCES_RESPONSE,
        View: {
          ...MOCK_BALANCES_RESPONSE.View,
          Account: {
            ...MOCK_BALANCES_RESPONSE.View.Account,
            AccountPosition: {
              Balance: MOCK_BALANCES_RESPONSE.View.Account.AccountPosition.Balance[0]
            }
          },
          Meta: {
            Security: MOCK_BALANCES_RESPONSE.View.Meta.Security[0]
          }
        }
      };
      const result = (0, _excellence.mapBalancesToPortfolioAccount)('00-000000', singleBalance);
      expect(result.positions).toHaveLength(1);
      expect(result.positions[0].securityId).toBe('1234');
    });
    test('handles empty/missing balances gracefully', () => {
      const empty = {
        View: {
          Account: {
            CurrencyCode: 'ILS'
          },
          Meta: {
            Security: []
          }
        }
      };
      const result = (0, _excellence.mapBalancesToPortfolioAccount)('00-000000', empty);
      expect(result.positions).toHaveLength(0);
      expect(result.accountNumber).toBe('00-000000');
    });
    test('falls back to securityId as name when Meta is missing for that key', () => {
      const noMeta = {
        ...MOCK_BALANCES_RESPONSE,
        View: {
          ...MOCK_BALANCES_RESPONSE.View,
          Meta: {
            Security: []
          } // no meta at all
        }
      };
      const result = (0, _excellence.mapBalancesToPortfolioAccount)('00-000000', noMeta);
      expect(result.positions[0].name).toBe('1234');
    });
  });

  // ---------------------------------------------------------------------------
  // mapAssetType unit tests
  // ---------------------------------------------------------------------------
  describe('mapAssetType', () => {
    test('returns Etf when IsEtf is true', () => {
      expect((0, _excellence.mapAssetType)({
        '-Key': '1',
        IsEtf: true
      })).toBe(_portfolio.AssetType.Etf);
      expect((0, _excellence.mapAssetType)({
        '-Key': '1',
        IsEtf: 1
      })).toBe(_portfolio.AssetType.Etf);
      expect((0, _excellence.mapAssetType)({
        '-Key': '1',
        IsEtf: '1'
      })).toBe(_portfolio.AssetType.Etf);
    });
    test('returns Bond for ItemType "2" or "bond"', () => {
      expect((0, _excellence.mapAssetType)({
        '-Key': '1',
        ItemType: '2'
      })).toBe(_portfolio.AssetType.Bond);
      expect((0, _excellence.mapAssetType)({
        '-Key': '1',
        ItemType: 'bond'
      })).toBe(_portfolio.AssetType.Bond);
    });
    test('returns Stock for ItemType "1" or "stock"', () => {
      expect((0, _excellence.mapAssetType)({
        '-Key': '1',
        ItemType: '1'
      })).toBe(_portfolio.AssetType.Stock);
      expect((0, _excellence.mapAssetType)({
        '-Key': '1',
        ItemType: 'stock'
      })).toBe(_portfolio.AssetType.Stock);
    });

    // Values confirmed against the live 2026-06-24 balances response.
    test('returns Stock for the live "Equity" ItemType label', () => {
      expect((0, _excellence.mapAssetType)({
        '-Key': '1',
        ItemType: 'Equity',
        StockType: 'Equity',
        IsEtf: false
      })).toBe(_portfolio.AssetType.Stock);
    });
    test('returns Fund for the live "Fund" ItemType label', () => {
      expect((0, _excellence.mapAssetType)({
        '-Key': '1',
        ItemType: 'Fund',
        StockType: null,
        IsEtf: false
      })).toBe(_portfolio.AssetType.Fund);
    });
    test('returns Etf when StockType is "ETF" even if ItemType is Equity/Fund', () => {
      expect((0, _excellence.mapAssetType)({
        '-Key': '1',
        ItemType: 'Equity',
        StockType: 'ETF',
        IsEtf: null
      })).toBe(_portfolio.AssetType.Etf);
      expect((0, _excellence.mapAssetType)({
        '-Key': '1',
        ItemType: 'Fund',
        StockType: null,
        IsEtf: true
      })).toBe(_portfolio.AssetType.Etf);
    });
    test('returns Other for unknown ItemType', () => {
      expect((0, _excellence.mapAssetType)({
        '-Key': '1',
        ItemType: '99'
      })).toBe(_portfolio.AssetType.Other);
    });
  });

  // ---------------------------------------------------------------------------
  // detectOtpChallenge unit tests
  // ---------------------------------------------------------------------------
  describe('detectOtpChallenge', () => {
    test('returns false when page is undefined', async () => {
      await expect((0, _excellence.detectOtpChallenge)(undefined)).resolves.toBe(false);
    });
    test('returns true when an OTP input is found', async () => {
      const mockPage = {
        $: jest.fn().mockImplementation(selector => {
          if (selector === 'input[type="tel"]') return Promise.resolve({});
          return Promise.resolve(null);
        })
      };
      await expect((0, _excellence.detectOtpChallenge)(mockPage)).resolves.toBe(true);
    });
    test('returns false when no OTP elements are found', async () => {
      const mockPage = {
        $: jest.fn().mockResolvedValue(null)
      };
      await expect((0, _excellence.detectOtpChallenge)(mockPage)).resolves.toBe(false);
    });
    test('returns false when page.$ throws', async () => {
      const mockPage = {
        $: jest.fn().mockRejectedValue(new Error('context destroyed'))
      };
      await expect((0, _excellence.detectOtpChallenge)(mockPage)).resolves.toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // getLoginOptions — possibleResults sanity check (no browser required)
  // ---------------------------------------------------------------------------
  describe('getLoginOptions possibleResults', () => {
    function buildScraper() {
      return new _excellence.default({
        companyId: _definitions.CompanyTypes.excellence,
        startDate: new Date()
      });
    }
    test('Success result matches /app URL pattern', () => {
      const loginOptions = buildScraper().getLoginOptions({
        username: 'u',
        password: 'p'
      });
      const successConditions = loginOptions.possibleResults[_baseScraperWithBrowser.LoginResults.Success];
      expect(Array.isArray(successConditions)).toBe(true);
      const pattern = successConditions[0];
      expect(pattern).toBeInstanceOf(RegExp);
      expect(pattern.test('https://extradepro.xnes.co.il/app')).toBe(true);
      expect(pattern.test('https://extradepro.xnes.co.il/login')).toBe(false);
    });
    test('TwoFactorRetrieverMissing has a function detector', () => {
      const loginOptions = buildScraper().getLoginOptions({
        username: 'u',
        password: 'p'
      });
      const tfConditions = loginOptions.possibleResults[_baseScraperWithBrowser.LoginResults.TwoFactorRetrieverMissing];
      expect(Array.isArray(tfConditions)).toBe(true);
      expect(typeof tfConditions[0]).toBe('function');
    });
  });

  // ---------------------------------------------------------------------------
  // Real-API gated test (requires testsConfig.credentials.excellence)
  // ---------------------------------------------------------------------------
  (0, _testsUtils.maybeTestCompanyAPI)(COMPANY_ID)('should scrape portfolio accounts', async () => {
    const options = {
      ...testsConfig.options,
      companyId: COMPANY_ID
    };
    const scraper = new _excellence.default(options);
    const result = await scraper.scrape(testsConfig.credentials.excellence);
    expect(result).toBeDefined();
    const error = `${result.errorType ?? ''} ${result.errorMessage ?? ''}`.trim();
    expect(error).toBe('');
    expect(result.success).toBe(true);
    expect(Array.isArray(result.portfolioAccounts)).toBe(true);
  });
});
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfZGVmaW5pdGlvbnMiLCJyZXF1aXJlIiwiX3BvcnRmb2xpbyIsIl90ZXN0c1V0aWxzIiwiX2Jhc2VTY3JhcGVyV2l0aEJyb3dzZXIiLCJfZXhjZWxsZW5jZSIsIl9pbnRlcm9wUmVxdWlyZVdpbGRjYXJkIiwiZSIsInQiLCJXZWFrTWFwIiwiciIsIm4iLCJfX2VzTW9kdWxlIiwibyIsImkiLCJmIiwiX19wcm90b19fIiwiZGVmYXVsdCIsImhhcyIsImdldCIsInNldCIsImhhc093blByb3BlcnR5IiwiY2FsbCIsIk9iamVjdCIsImRlZmluZVByb3BlcnR5IiwiZ2V0T3duUHJvcGVydHlEZXNjcmlwdG9yIiwiQ09NUEFOWV9JRCIsInRlc3RzQ29uZmlnIiwiZ2V0VGVzdHNDb25maWciLCJNT0NLX0JBTEFOQ0VTX1JFU1BPTlNFIiwiVmlldyIsIkFjY291bnQiLCJPbmxpbmVWYWx1ZSIsIk9ubGluZUNhc2giLCJDdXJyZW5jeUNvZGUiLCJCYWxhbmNlQ2FjaGVEYXRlIiwiQWNjb3VudFBvc2l0aW9uIiwiQmFsYW5jZSIsIkVxdWl0eU51bWJlciIsIk9ubGluZU5WIiwiTGFzdFJhdGUiLCJPbmxpbmVWTCIsIk9ubGluZU5pc1ZMIiwiQXZlcmFnZVByaWNlIiwiQXZlcmFnZVByaWNlUHJvZml0TG9zcyIsIkF2ZXJhZ2VQcmljZVByb2ZpdExvc3NQZXJjZW50YWdlIiwiQmFzZVJhdGUiLCJNZXRhIiwiU2VjdXJpdHkiLCJIZWJOYW1lIiwiRW5nTmFtZSIsIlN5bWJvbCIsIkhlYlN5bWJvbCIsIkl0ZW1UeXBlIiwiSXNFdGYiLCJFbmdTeW1ib2wiLCJkZXNjcmliZSIsImJlZm9yZUFsbCIsImV4dGVuZEFzeW5jVGltZW91dCIsInRlc3QiLCJleHBlY3QiLCJTQ1JBUEVSUyIsIkNvbXBhbnlUeXBlcyIsImV4Y2VsbGVuY2UiLCJ0b0JlRGVmaW5lZCIsIm5hbWUiLCJ0b0JlIiwibG9naW5GaWVsZHMiLCJ0b0NvbnRhaW4iLCJyZXN1bHQiLCJtYXBCYWxhbmNlc1RvUG9ydGZvbGlvQWNjb3VudCIsImFjY291bnROdW1iZXIiLCJ0b3RhbFZhbHVlIiwiY2FzaCIsImJhc2VDdXJyZW5jeSIsInBvc2l0aW9ucyIsInRvSGF2ZUxlbmd0aCIsImZpcnN0Iiwic2VjdXJpdHlJZCIsInN5bWJvbCIsInF1YW50aXR5IiwibWFya2V0UHJpY2UiLCJtYXJrZXRWYWx1ZSIsImN1cnJlbmN5IiwiYXZlcmFnZUNvc3QiLCJ1bnJlYWxpemVkUG5sIiwidW5yZWFsaXplZFBubFBjdCIsImFzT2YiLCJhc3NldFR5cGUiLCJBc3NldFR5cGUiLCJTdG9jayIsInNlY29uZCIsIkJvbmQiLCJyYXdQb3NpdGlvbiIsInRvQmVVbmRlZmluZWQiLCJpbmNsdWRlUmF3VHJhbnNhY3Rpb24iLCJub3QiLCJ0b0JlTnVsbCIsInNpbmdsZUJhbGFuY2UiLCJlbXB0eSIsIm5vTWV0YSIsIm1hcEFzc2V0VHlwZSIsIkV0ZiIsIlN0b2NrVHlwZSIsIkZ1bmQiLCJPdGhlciIsImRldGVjdE90cENoYWxsZW5nZSIsInVuZGVmaW5lZCIsInJlc29sdmVzIiwibW9ja1BhZ2UiLCIkIiwiamVzdCIsImZuIiwibW9ja0ltcGxlbWVudGF0aW9uIiwic2VsZWN0b3IiLCJQcm9taXNlIiwicmVzb2x2ZSIsIm1vY2tSZXNvbHZlZFZhbHVlIiwibW9ja1JlamVjdGVkVmFsdWUiLCJFcnJvciIsImJ1aWxkU2NyYXBlciIsIkV4Y2VsbGVuY2VTY3JhcGVyIiwiY29tcGFueUlkIiwic3RhcnREYXRlIiwiRGF0ZSIsImxvZ2luT3B0aW9ucyIsImdldExvZ2luT3B0aW9ucyIsInVzZXJuYW1lIiwicGFzc3dvcmQiLCJzdWNjZXNzQ29uZGl0aW9ucyIsInBvc3NpYmxlUmVzdWx0cyIsIkxvZ2luUmVzdWx0cyIsIlN1Y2Nlc3MiLCJBcnJheSIsImlzQXJyYXkiLCJwYXR0ZXJuIiwidG9CZUluc3RhbmNlT2YiLCJSZWdFeHAiLCJ0ZkNvbmRpdGlvbnMiLCJUd29GYWN0b3JSZXRyaWV2ZXJNaXNzaW5nIiwibWF5YmVUZXN0Q29tcGFueUFQSSIsIm9wdGlvbnMiLCJzY3JhcGVyIiwic2NyYXBlIiwiY3JlZGVudGlhbHMiLCJlcnJvciIsImVycm9yVHlwZSIsImVycm9yTWVzc2FnZSIsInRyaW0iLCJzdWNjZXNzIiwicG9ydGZvbGlvQWNjb3VudHMiXSwic291cmNlcyI6WyIuLi8uLi9zcmMvc2NyYXBlcnMvZXhjZWxsZW5jZS50ZXN0LnRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IHR5cGUgUGFnZSB9IGZyb20gJ3B1cHBldGVlcic7XHJcbmltcG9ydCB7IENvbXBhbnlUeXBlcywgU0NSQVBFUlMgfSBmcm9tICcuLi9kZWZpbml0aW9ucyc7XHJcbmltcG9ydCB7IEFzc2V0VHlwZSB9IGZyb20gJy4uL3BvcnRmb2xpbyc7XHJcbmltcG9ydCB7IGV4dGVuZEFzeW5jVGltZW91dCwgZ2V0VGVzdHNDb25maWcsIG1heWJlVGVzdENvbXBhbnlBUEkgfSBmcm9tICcuLi90ZXN0cy90ZXN0cy11dGlscyc7XHJcbmltcG9ydCB7IExvZ2luUmVzdWx0cyB9IGZyb20gJy4vYmFzZS1zY3JhcGVyLXdpdGgtYnJvd3Nlcic7XHJcbmltcG9ydCBFeGNlbGxlbmNlU2NyYXBlciwgeyBkZXRlY3RPdHBDaGFsbGVuZ2UsIG1hcEFzc2V0VHlwZSwgbWFwQmFsYW5jZXNUb1BvcnRmb2xpb0FjY291bnQgfSBmcm9tICcuL2V4Y2VsbGVuY2UnO1xyXG5pbXBvcnQgeyB0eXBlIFNjcmFwZXJPcHRpb25zIH0gZnJvbSAnLi9pbnRlcmZhY2UnO1xyXG5cclxuY29uc3QgQ09NUEFOWV9JRCA9ICdleGNlbGxlbmNlJztcclxuY29uc3QgdGVzdHNDb25maWcgPSBnZXRUZXN0c0NvbmZpZygpO1xyXG5cclxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXHJcbi8vIE1pbmltYWwgbW9jayBiYWxhbmNlcyByZXNwb25zZSAobWF0Y2hlcyB0aGUgwqc3LjQgbGl2ZS1jYXB0dXJlIHNoYXBlKVxyXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cclxuY29uc3QgTU9DS19CQUxBTkNFU19SRVNQT05TRSA9IHtcclxuICBWaWV3OiB7XHJcbiAgICBBY2NvdW50OiB7XHJcbiAgICAgIE9ubGluZVZhbHVlOiAxNTAwMDAuNSxcclxuICAgICAgT25saW5lQ2FzaDogNTAwMC4yNSxcclxuICAgICAgQ3VycmVuY3lDb2RlOiAnSUxTJyxcclxuICAgICAgQmFsYW5jZUNhY2hlRGF0ZTogJzIwMjYtMDYtMjRUMTA6MDA6MDBaJyxcclxuICAgICAgQWNjb3VudFBvc2l0aW9uOiB7XHJcbiAgICAgICAgQmFsYW5jZTogW1xyXG4gICAgICAgICAge1xyXG4gICAgICAgICAgICBFcXVpdHlOdW1iZXI6IDEyMzQsXHJcbiAgICAgICAgICAgIE9ubGluZU5WOiAxMDAsXHJcbiAgICAgICAgICAgIExhc3RSYXRlOiA1MC41LFxyXG4gICAgICAgICAgICBPbmxpbmVWTDogNTA1MCxcclxuICAgICAgICAgICAgT25saW5lTmlzVkw6IDUwNTAsXHJcbiAgICAgICAgICAgIEF2ZXJhZ2VQcmljZTogNDguMCxcclxuICAgICAgICAgICAgQXZlcmFnZVByaWNlUHJvZml0TG9zczogMjUwLFxyXG4gICAgICAgICAgICBBdmVyYWdlUHJpY2VQcm9maXRMb3NzUGVyY2VudGFnZTogNS4yMSxcclxuICAgICAgICAgICAgQ3VycmVuY3lDb2RlOiAnSUxTJyxcclxuICAgICAgICAgIH0sXHJcbiAgICAgICAgICB7XHJcbiAgICAgICAgICAgIEVxdWl0eU51bWJlcjogNTY3OCxcclxuICAgICAgICAgICAgT25saW5lTlY6IDEwLFxyXG4gICAgICAgICAgICBCYXNlUmF0ZTogMTIwLjAsIC8vIG5vIExhc3RSYXRlIOKAlCBzaG91bGQgZmFsbCBiYWNrIHRvIEJhc2VSYXRlXHJcbiAgICAgICAgICAgIE9ubGluZVZMOiAxMjAwLFxyXG4gICAgICAgICAgICBPbmxpbmVOaXNWTDogNDIwMCxcclxuICAgICAgICAgICAgQXZlcmFnZVByaWNlOiAxMTUuMCxcclxuICAgICAgICAgICAgQXZlcmFnZVByaWNlUHJvZml0TG9zczogNTAsXHJcbiAgICAgICAgICAgIEF2ZXJhZ2VQcmljZVByb2ZpdExvc3NQZXJjZW50YWdlOiA0LjM1LFxyXG4gICAgICAgICAgICBDdXJyZW5jeUNvZGU6ICdVU0QnLFxyXG4gICAgICAgICAgfSxcclxuICAgICAgICBdLFxyXG4gICAgICB9LFxyXG4gICAgfSxcclxuICAgIE1ldGE6IHtcclxuICAgICAgU2VjdXJpdHk6IFtcclxuICAgICAgICB7XHJcbiAgICAgICAgICAnLUtleSc6IDEyMzQsXHJcbiAgICAgICAgICBIZWJOYW1lOiAn157XoNeZ15nXqiDXkdeT15nXp9eUJyxcclxuICAgICAgICAgIEVuZ05hbWU6ICdUZXN0IFN0b2NrJyxcclxuICAgICAgICAgIFN5bWJvbDogJ1RTVCcsXHJcbiAgICAgICAgICBIZWJTeW1ib2w6ICfXkdeT15nXp9eUJyxcclxuICAgICAgICAgIEl0ZW1UeXBlOiAnMScsIC8vIHN0b2NrXHJcbiAgICAgICAgICBJc0V0ZjogZmFsc2UsXHJcbiAgICAgICAgfSxcclxuICAgICAgICB7XHJcbiAgICAgICAgICAnLUtleSc6IDU2NzgsXHJcbiAgICAgICAgICBIZWJOYW1lOiBudWxsLFxyXG4gICAgICAgICAgRW5nTmFtZTogJ1VTIEJvbmQgRnVuZCcsXHJcbiAgICAgICAgICBTeW1ib2w6IG51bGwsXHJcbiAgICAgICAgICBFbmdTeW1ib2w6ICdVQk5EJyxcclxuICAgICAgICAgIEl0ZW1UeXBlOiAnMicsIC8vIGJvbmRcclxuICAgICAgICAgIElzRXRmOiBmYWxzZSxcclxuICAgICAgICB9LFxyXG4gICAgICBdLFxyXG4gICAgfSxcclxuICB9LFxyXG59O1xyXG5cclxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXHJcbi8vIFJlZ2lzdHJhdGlvbiAvIFNDUkFQRVJTIG1ldGFkYXRhXHJcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxyXG5kZXNjcmliZSgnRXhjZWxsZW5jZSBzY3JhcGVyJywgKCkgPT4ge1xyXG4gIGJlZm9yZUFsbCgoKSA9PiB7XHJcbiAgICBleHRlbmRBc3luY1RpbWVvdXQoKTtcclxuICB9KTtcclxuXHJcbiAgdGVzdCgnc2hvdWxkIGV4cG9zZSBsb2dpbiBmaWVsZHMgaW4gc2NyYXBlcnMgY29uc3RhbnQnLCAoKSA9PiB7XHJcbiAgICBleHBlY3QoU0NSQVBFUlNbQ29tcGFueVR5cGVzLmV4Y2VsbGVuY2VdKS50b0JlRGVmaW5lZCgpO1xyXG4gICAgZXhwZWN0KFNDUkFQRVJTW0NvbXBhbnlUeXBlcy5leGNlbGxlbmNlXS5uYW1lKS50b0JlKCdFeGNlbGxlbmNlJyk7XHJcbiAgICBleHBlY3QoU0NSQVBFUlNbQ29tcGFueVR5cGVzLmV4Y2VsbGVuY2VdLmxvZ2luRmllbGRzKS50b0NvbnRhaW4oJ3VzZXJuYW1lJyk7XHJcbiAgICBleHBlY3QoU0NSQVBFUlNbQ29tcGFueVR5cGVzLmV4Y2VsbGVuY2VdLmxvZ2luRmllbGRzKS50b0NvbnRhaW4oJ3Bhc3N3b3JkJyk7XHJcbiAgfSk7XHJcblxyXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxyXG4gIC8vIG1hcEJhbGFuY2VzVG9Qb3J0Zm9saW9BY2NvdW50IHVuaXQgdGVzdHNcclxuICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cclxuICBkZXNjcmliZSgnbWFwQmFsYW5jZXNUb1BvcnRmb2xpb0FjY291bnQnLCAoKSA9PiB7XHJcbiAgICB0ZXN0KCdtYXBzIGFjY291bnQtbGV2ZWwgdG90YWxzIGNvcnJlY3RseScsICgpID0+IHtcclxuICAgICAgY29uc3QgcmVzdWx0ID0gbWFwQmFsYW5jZXNUb1BvcnRmb2xpb0FjY291bnQoJzAwLTAwMDAwMCcsIE1PQ0tfQkFMQU5DRVNfUkVTUE9OU0UpO1xyXG5cclxuICAgICAgZXhwZWN0KHJlc3VsdC5hY2NvdW50TnVtYmVyKS50b0JlKCcwMC0wMDAwMDAnKTtcclxuICAgICAgZXhwZWN0KHJlc3VsdC50b3RhbFZhbHVlKS50b0JlKDE1MDAwMC41KTtcclxuICAgICAgZXhwZWN0KHJlc3VsdC5jYXNoKS50b0JlKDUwMDAuMjUpO1xyXG4gICAgICBleHBlY3QocmVzdWx0LmJhc2VDdXJyZW5jeSkudG9CZSgnSUxTJyk7XHJcbiAgICB9KTtcclxuXHJcbiAgICB0ZXN0KCdtYXBzIHBvc2l0aW9ucyBjb3JyZWN0bHkgdXNpbmcgTWV0YSBqb2luIG9uIEVxdWl0eU51bWJlciAvIC1LZXknLCAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IHJlc3VsdCA9IG1hcEJhbGFuY2VzVG9Qb3J0Zm9saW9BY2NvdW50KCcwMC0wMDAwMDAnLCBNT0NLX0JBTEFOQ0VTX1JFU1BPTlNFKTtcclxuXHJcbiAgICAgIGV4cGVjdChyZXN1bHQucG9zaXRpb25zKS50b0hhdmVMZW5ndGgoMik7XHJcblxyXG4gICAgICBjb25zdCBmaXJzdCA9IHJlc3VsdC5wb3NpdGlvbnNbMF07XHJcbiAgICAgIGV4cGVjdChmaXJzdC5zZWN1cml0eUlkKS50b0JlKCcxMjM0Jyk7XHJcbiAgICAgIGV4cGVjdChmaXJzdC5uYW1lKS50b0JlKCfXnteg15nXmdeqINeR15PXmden15QnKTsgLy8gSGViTmFtZSB0YWtlcyBwcmlvcml0eVxyXG4gICAgICBleHBlY3QoZmlyc3Quc3ltYm9sKS50b0JlKCdUU1QnKTtcclxuICAgICAgZXhwZWN0KGZpcnN0LnF1YW50aXR5KS50b0JlKDEwMCk7XHJcbiAgICAgIGV4cGVjdChmaXJzdC5tYXJrZXRQcmljZSkudG9CZSg1MC41KTsgLy8gZnJvbSBMYXN0UmF0ZVxyXG4gICAgICBleHBlY3QoZmlyc3QubWFya2V0VmFsdWUpLnRvQmUoNTA1MCk7XHJcbiAgICAgIGV4cGVjdChmaXJzdC5jdXJyZW5jeSkudG9CZSgnSUxTJyk7XHJcbiAgICAgIGV4cGVjdChmaXJzdC5hdmVyYWdlQ29zdCkudG9CZSg0OC4wKTtcclxuICAgICAgZXhwZWN0KGZpcnN0LnVucmVhbGl6ZWRQbmwpLnRvQmUoMjUwKTtcclxuICAgICAgZXhwZWN0KGZpcnN0LnVucmVhbGl6ZWRQbmxQY3QpLnRvQmUoNS4yMSk7XHJcbiAgICAgIGV4cGVjdChmaXJzdC5hc09mKS50b0JlKCcyMDI2LTA2LTI0VDEwOjAwOjAwWicpO1xyXG4gICAgICBleHBlY3QoZmlyc3QuYXNzZXRUeXBlKS50b0JlKEFzc2V0VHlwZS5TdG9jayk7XHJcbiAgICB9KTtcclxuXHJcbiAgICB0ZXN0KCdmYWxscyBiYWNrIHRvIEJhc2VSYXRlIHdoZW4gTGFzdFJhdGUgaXMgYWJzZW50JywgKCkgPT4ge1xyXG4gICAgICBjb25zdCByZXN1bHQgPSBtYXBCYWxhbmNlc1RvUG9ydGZvbGlvQWNjb3VudCgnMDAtMDAwMDAwJywgTU9DS19CQUxBTkNFU19SRVNQT05TRSk7XHJcbiAgICAgIGNvbnN0IHNlY29uZCA9IHJlc3VsdC5wb3NpdGlvbnNbMV07XHJcblxyXG4gICAgICBleHBlY3Qoc2Vjb25kLnNlY3VyaXR5SWQpLnRvQmUoJzU2NzgnKTtcclxuICAgICAgZXhwZWN0KHNlY29uZC5tYXJrZXRQcmljZSkudG9CZSgxMjAuMCk7IC8vIGZyb20gQmFzZVJhdGVcclxuICAgICAgZXhwZWN0KHNlY29uZC5jdXJyZW5jeSkudG9CZSgnVVNEJyk7XHJcbiAgICAgIGV4cGVjdChzZWNvbmQuYXNzZXRUeXBlKS50b0JlKEFzc2V0VHlwZS5Cb25kKTtcclxuICAgIH0pO1xyXG5cclxuICAgIHRlc3QoJ2ZhbGxzIGJhY2sgdG8gRW5nTmFtZSB3aGVuIEhlYk5hbWUgaXMgYWJzZW50L251bGwnLCAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IHJlc3VsdCA9IG1hcEJhbGFuY2VzVG9Qb3J0Zm9saW9BY2NvdW50KCcwMC0wMDAwMDAnLCBNT0NLX0JBTEFOQ0VTX1JFU1BPTlNFKTtcclxuICAgICAgY29uc3Qgc2Vjb25kID0gcmVzdWx0LnBvc2l0aW9uc1sxXTtcclxuXHJcbiAgICAgIGV4cGVjdChzZWNvbmQubmFtZSkudG9CZSgnVVMgQm9uZCBGdW5kJyk7XHJcbiAgICAgIGV4cGVjdChzZWNvbmQuc3ltYm9sKS50b0JlKCdVQk5EJyk7IC8vIEVuZ1N5bWJvbCBmYWxsYmFja1xyXG4gICAgfSk7XHJcblxyXG4gICAgdGVzdCgnb21pdHMgcmF3UG9zaXRpb24gYnkgZGVmYXVsdCAoaW5jbHVkZVJhd1RyYW5zYWN0aW9uIG5vdCBzZXQpJywgKCkgPT4ge1xyXG4gICAgICBjb25zdCByZXN1bHQgPSBtYXBCYWxhbmNlc1RvUG9ydGZvbGlvQWNjb3VudCgnMDAtMDAwMDAwJywgTU9DS19CQUxBTkNFU19SRVNQT05TRSk7XHJcbiAgICAgIGV4cGVjdChyZXN1bHQucG9zaXRpb25zWzBdLnJhd1Bvc2l0aW9uKS50b0JlVW5kZWZpbmVkKCk7XHJcbiAgICB9KTtcclxuXHJcbiAgICB0ZXN0KCdpbmNsdWRlcyByYXdQb3NpdGlvbiB3aGVuIGluY2x1ZGVSYXdUcmFuc2FjdGlvbiBpcyB0cnVlJywgKCkgPT4ge1xyXG4gICAgICBjb25zdCByZXN1bHQgPSBtYXBCYWxhbmNlc1RvUG9ydGZvbGlvQWNjb3VudCgnMDAtMDAwMDAwJywgTU9DS19CQUxBTkNFU19SRVNQT05TRSwge1xyXG4gICAgICAgIGluY2x1ZGVSYXdUcmFuc2FjdGlvbjogdHJ1ZSxcclxuICAgICAgfSk7XHJcbiAgICAgIGV4cGVjdChyZXN1bHQucG9zaXRpb25zWzBdLnJhd1Bvc2l0aW9uKS50b0JlRGVmaW5lZCgpO1xyXG4gICAgICBleHBlY3QocmVzdWx0LnBvc2l0aW9uc1swXS5yYXdQb3NpdGlvbikubm90LnRvQmVOdWxsKCk7XHJcbiAgICB9KTtcclxuXHJcbiAgICB0ZXN0KCdoYW5kbGVzIHNpbmdsZSBCYWxhbmNlIG9iamVjdCAobm9uLWFycmF5KSBncmFjZWZ1bGx5JywgKCkgPT4ge1xyXG4gICAgICBjb25zdCBzaW5nbGVCYWxhbmNlID0ge1xyXG4gICAgICAgIC4uLk1PQ0tfQkFMQU5DRVNfUkVTUE9OU0UsXHJcbiAgICAgICAgVmlldzoge1xyXG4gICAgICAgICAgLi4uTU9DS19CQUxBTkNFU19SRVNQT05TRS5WaWV3LFxyXG4gICAgICAgICAgQWNjb3VudDoge1xyXG4gICAgICAgICAgICAuLi5NT0NLX0JBTEFOQ0VTX1JFU1BPTlNFLlZpZXcuQWNjb3VudCxcclxuICAgICAgICAgICAgQWNjb3VudFBvc2l0aW9uOiB7XHJcbiAgICAgICAgICAgICAgQmFsYW5jZTogTU9DS19CQUxBTkNFU19SRVNQT05TRS5WaWV3LkFjY291bnQuQWNjb3VudFBvc2l0aW9uLkJhbGFuY2VbMF0sXHJcbiAgICAgICAgICAgIH0sXHJcbiAgICAgICAgICB9LFxyXG4gICAgICAgICAgTWV0YToge1xyXG4gICAgICAgICAgICBTZWN1cml0eTogTU9DS19CQUxBTkNFU19SRVNQT05TRS5WaWV3Lk1ldGEuU2VjdXJpdHlbMF0sXHJcbiAgICAgICAgICB9LFxyXG4gICAgICAgIH0sXHJcbiAgICAgIH07XHJcblxyXG4gICAgICBjb25zdCByZXN1bHQgPSBtYXBCYWxhbmNlc1RvUG9ydGZvbGlvQWNjb3VudCgnMDAtMDAwMDAwJywgc2luZ2xlQmFsYW5jZSk7XHJcbiAgICAgIGV4cGVjdChyZXN1bHQucG9zaXRpb25zKS50b0hhdmVMZW5ndGgoMSk7XHJcbiAgICAgIGV4cGVjdChyZXN1bHQucG9zaXRpb25zWzBdLnNlY3VyaXR5SWQpLnRvQmUoJzEyMzQnKTtcclxuICAgIH0pO1xyXG5cclxuICAgIHRlc3QoJ2hhbmRsZXMgZW1wdHkvbWlzc2luZyBiYWxhbmNlcyBncmFjZWZ1bGx5JywgKCkgPT4ge1xyXG4gICAgICBjb25zdCBlbXB0eSA9IHsgVmlldzogeyBBY2NvdW50OiB7IEN1cnJlbmN5Q29kZTogJ0lMUycgfSwgTWV0YTogeyBTZWN1cml0eTogW10gfSB9IH07XHJcbiAgICAgIGNvbnN0IHJlc3VsdCA9IG1hcEJhbGFuY2VzVG9Qb3J0Zm9saW9BY2NvdW50KCcwMC0wMDAwMDAnLCBlbXB0eSk7XHJcbiAgICAgIGV4cGVjdChyZXN1bHQucG9zaXRpb25zKS50b0hhdmVMZW5ndGgoMCk7XHJcbiAgICAgIGV4cGVjdChyZXN1bHQuYWNjb3VudE51bWJlcikudG9CZSgnMDAtMDAwMDAwJyk7XHJcbiAgICB9KTtcclxuXHJcbiAgICB0ZXN0KCdmYWxscyBiYWNrIHRvIHNlY3VyaXR5SWQgYXMgbmFtZSB3aGVuIE1ldGEgaXMgbWlzc2luZyBmb3IgdGhhdCBrZXknLCAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IG5vTWV0YSA9IHtcclxuICAgICAgICAuLi5NT0NLX0JBTEFOQ0VTX1JFU1BPTlNFLFxyXG4gICAgICAgIFZpZXc6IHtcclxuICAgICAgICAgIC4uLk1PQ0tfQkFMQU5DRVNfUkVTUE9OU0UuVmlldyxcclxuICAgICAgICAgIE1ldGE6IHsgU2VjdXJpdHk6IFtdIH0sIC8vIG5vIG1ldGEgYXQgYWxsXHJcbiAgICAgICAgfSxcclxuICAgICAgfTtcclxuICAgICAgY29uc3QgcmVzdWx0ID0gbWFwQmFsYW5jZXNUb1BvcnRmb2xpb0FjY291bnQoJzAwLTAwMDAwMCcsIG5vTWV0YSk7XHJcbiAgICAgIGV4cGVjdChyZXN1bHQucG9zaXRpb25zWzBdLm5hbWUpLnRvQmUoJzEyMzQnKTtcclxuICAgIH0pO1xyXG4gIH0pO1xyXG5cclxuICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cclxuICAvLyBtYXBBc3NldFR5cGUgdW5pdCB0ZXN0c1xyXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxyXG4gIGRlc2NyaWJlKCdtYXBBc3NldFR5cGUnLCAoKSA9PiB7XHJcbiAgICB0ZXN0KCdyZXR1cm5zIEV0ZiB3aGVuIElzRXRmIGlzIHRydWUnLCAoKSA9PiB7XHJcbiAgICAgIGV4cGVjdChtYXBBc3NldFR5cGUoeyAnLUtleSc6ICcxJywgSXNFdGY6IHRydWUgfSkpLnRvQmUoQXNzZXRUeXBlLkV0Zik7XHJcbiAgICAgIGV4cGVjdChtYXBBc3NldFR5cGUoeyAnLUtleSc6ICcxJywgSXNFdGY6IDEgfSkpLnRvQmUoQXNzZXRUeXBlLkV0Zik7XHJcbiAgICAgIGV4cGVjdChtYXBBc3NldFR5cGUoeyAnLUtleSc6ICcxJywgSXNFdGY6ICcxJyB9KSkudG9CZShBc3NldFR5cGUuRXRmKTtcclxuICAgIH0pO1xyXG5cclxuICAgIHRlc3QoJ3JldHVybnMgQm9uZCBmb3IgSXRlbVR5cGUgXCIyXCIgb3IgXCJib25kXCInLCAoKSA9PiB7XHJcbiAgICAgIGV4cGVjdChtYXBBc3NldFR5cGUoeyAnLUtleSc6ICcxJywgSXRlbVR5cGU6ICcyJyB9KSkudG9CZShBc3NldFR5cGUuQm9uZCk7XHJcbiAgICAgIGV4cGVjdChtYXBBc3NldFR5cGUoeyAnLUtleSc6ICcxJywgSXRlbVR5cGU6ICdib25kJyB9KSkudG9CZShBc3NldFR5cGUuQm9uZCk7XHJcbiAgICB9KTtcclxuXHJcbiAgICB0ZXN0KCdyZXR1cm5zIFN0b2NrIGZvciBJdGVtVHlwZSBcIjFcIiBvciBcInN0b2NrXCInLCAoKSA9PiB7XHJcbiAgICAgIGV4cGVjdChtYXBBc3NldFR5cGUoeyAnLUtleSc6ICcxJywgSXRlbVR5cGU6ICcxJyB9KSkudG9CZShBc3NldFR5cGUuU3RvY2spO1xyXG4gICAgICBleHBlY3QobWFwQXNzZXRUeXBlKHsgJy1LZXknOiAnMScsIEl0ZW1UeXBlOiAnc3RvY2snIH0pKS50b0JlKEFzc2V0VHlwZS5TdG9jayk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyBWYWx1ZXMgY29uZmlybWVkIGFnYWluc3QgdGhlIGxpdmUgMjAyNi0wNi0yNCBiYWxhbmNlcyByZXNwb25zZS5cclxuICAgIHRlc3QoJ3JldHVybnMgU3RvY2sgZm9yIHRoZSBsaXZlIFwiRXF1aXR5XCIgSXRlbVR5cGUgbGFiZWwnLCAoKSA9PiB7XHJcbiAgICAgIGV4cGVjdChtYXBBc3NldFR5cGUoeyAnLUtleSc6ICcxJywgSXRlbVR5cGU6ICdFcXVpdHknLCBTdG9ja1R5cGU6ICdFcXVpdHknLCBJc0V0ZjogZmFsc2UgfSkpLnRvQmUoXHJcbiAgICAgICAgQXNzZXRUeXBlLlN0b2NrLFxyXG4gICAgICApO1xyXG4gICAgfSk7XHJcblxyXG4gICAgdGVzdCgncmV0dXJucyBGdW5kIGZvciB0aGUgbGl2ZSBcIkZ1bmRcIiBJdGVtVHlwZSBsYWJlbCcsICgpID0+IHtcclxuICAgICAgZXhwZWN0KG1hcEFzc2V0VHlwZSh7ICctS2V5JzogJzEnLCBJdGVtVHlwZTogJ0Z1bmQnLCBTdG9ja1R5cGU6IG51bGwsIElzRXRmOiBmYWxzZSB9KSkudG9CZShBc3NldFR5cGUuRnVuZCk7XHJcbiAgICB9KTtcclxuXHJcbiAgICB0ZXN0KCdyZXR1cm5zIEV0ZiB3aGVuIFN0b2NrVHlwZSBpcyBcIkVURlwiIGV2ZW4gaWYgSXRlbVR5cGUgaXMgRXF1aXR5L0Z1bmQnLCAoKSA9PiB7XHJcbiAgICAgIGV4cGVjdChtYXBBc3NldFR5cGUoeyAnLUtleSc6ICcxJywgSXRlbVR5cGU6ICdFcXVpdHknLCBTdG9ja1R5cGU6ICdFVEYnLCBJc0V0ZjogbnVsbCB9KSkudG9CZShBc3NldFR5cGUuRXRmKTtcclxuICAgICAgZXhwZWN0KG1hcEFzc2V0VHlwZSh7ICctS2V5JzogJzEnLCBJdGVtVHlwZTogJ0Z1bmQnLCBTdG9ja1R5cGU6IG51bGwsIElzRXRmOiB0cnVlIH0pKS50b0JlKEFzc2V0VHlwZS5FdGYpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgdGVzdCgncmV0dXJucyBPdGhlciBmb3IgdW5rbm93biBJdGVtVHlwZScsICgpID0+IHtcclxuICAgICAgZXhwZWN0KG1hcEFzc2V0VHlwZSh7ICctS2V5JzogJzEnLCBJdGVtVHlwZTogJzk5JyB9KSkudG9CZShBc3NldFR5cGUuT3RoZXIpO1xyXG4gICAgfSk7XHJcbiAgfSk7XHJcblxyXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxyXG4gIC8vIGRldGVjdE90cENoYWxsZW5nZSB1bml0IHRlc3RzXHJcbiAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXHJcbiAgZGVzY3JpYmUoJ2RldGVjdE90cENoYWxsZW5nZScsICgpID0+IHtcclxuICAgIHRlc3QoJ3JldHVybnMgZmFsc2Ugd2hlbiBwYWdlIGlzIHVuZGVmaW5lZCcsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQgZXhwZWN0KGRldGVjdE90cENoYWxsZW5nZSh1bmRlZmluZWQpKS5yZXNvbHZlcy50b0JlKGZhbHNlKTtcclxuICAgIH0pO1xyXG5cclxuICAgIHRlc3QoJ3JldHVybnMgdHJ1ZSB3aGVuIGFuIE9UUCBpbnB1dCBpcyBmb3VuZCcsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgbW9ja1BhZ2U6IFBpY2s8UGFnZSwgJyQnPiA9IHtcclxuICAgICAgICAkOiBqZXN0LmZuKCkubW9ja0ltcGxlbWVudGF0aW9uKChzZWxlY3Rvcjogc3RyaW5nKSA9PiB7XHJcbiAgICAgICAgICBpZiAoc2VsZWN0b3IgPT09ICdpbnB1dFt0eXBlPVwidGVsXCJdJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7fSk7XHJcbiAgICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKG51bGwpO1xyXG4gICAgICAgIH0pLFxyXG4gICAgICB9O1xyXG4gICAgICBhd2FpdCBleHBlY3QoZGV0ZWN0T3RwQ2hhbGxlbmdlKG1vY2tQYWdlIGFzIHVua25vd24gYXMgUGFnZSkpLnJlc29sdmVzLnRvQmUodHJ1ZSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICB0ZXN0KCdyZXR1cm5zIGZhbHNlIHdoZW4gbm8gT1RQIGVsZW1lbnRzIGFyZSBmb3VuZCcsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgbW9ja1BhZ2U6IFBpY2s8UGFnZSwgJyQnPiA9IHtcclxuICAgICAgICAkOiBqZXN0LmZuKCkubW9ja1Jlc29sdmVkVmFsdWUobnVsbCksXHJcbiAgICAgIH07XHJcbiAgICAgIGF3YWl0IGV4cGVjdChkZXRlY3RPdHBDaGFsbGVuZ2UobW9ja1BhZ2UgYXMgdW5rbm93biBhcyBQYWdlKSkucmVzb2x2ZXMudG9CZShmYWxzZSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICB0ZXN0KCdyZXR1cm5zIGZhbHNlIHdoZW4gcGFnZS4kIHRocm93cycsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgbW9ja1BhZ2U6IFBpY2s8UGFnZSwgJyQnPiA9IHtcclxuICAgICAgICAkOiBqZXN0LmZuKCkubW9ja1JlamVjdGVkVmFsdWUobmV3IEVycm9yKCdjb250ZXh0IGRlc3Ryb3llZCcpKSxcclxuICAgICAgfTtcclxuICAgICAgYXdhaXQgZXhwZWN0KGRldGVjdE90cENoYWxsZW5nZShtb2NrUGFnZSBhcyB1bmtub3duIGFzIFBhZ2UpKS5yZXNvbHZlcy50b0JlKGZhbHNlKTtcclxuICAgIH0pO1xyXG4gIH0pO1xyXG5cclxuICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cclxuICAvLyBnZXRMb2dpbk9wdGlvbnMg4oCUIHBvc3NpYmxlUmVzdWx0cyBzYW5pdHkgY2hlY2sgKG5vIGJyb3dzZXIgcmVxdWlyZWQpXHJcbiAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXHJcbiAgZGVzY3JpYmUoJ2dldExvZ2luT3B0aW9ucyBwb3NzaWJsZVJlc3VsdHMnLCAoKSA9PiB7XHJcbiAgICBmdW5jdGlvbiBidWlsZFNjcmFwZXIoKSB7XHJcbiAgICAgIHJldHVybiBuZXcgRXhjZWxsZW5jZVNjcmFwZXIoe1xyXG4gICAgICAgIGNvbXBhbnlJZDogQ29tcGFueVR5cGVzLmV4Y2VsbGVuY2UsXHJcbiAgICAgICAgc3RhcnREYXRlOiBuZXcgRGF0ZSgpLFxyXG4gICAgICB9IGFzIHVua25vd24gYXMgU2NyYXBlck9wdGlvbnMpO1xyXG4gICAgfVxyXG5cclxuICAgIHRlc3QoJ1N1Y2Nlc3MgcmVzdWx0IG1hdGNoZXMgL2FwcCBVUkwgcGF0dGVybicsICgpID0+IHtcclxuICAgICAgY29uc3QgbG9naW5PcHRpb25zID0gYnVpbGRTY3JhcGVyKCkuZ2V0TG9naW5PcHRpb25zKHsgdXNlcm5hbWU6ICd1JywgcGFzc3dvcmQ6ICdwJyB9KTtcclxuICAgICAgY29uc3Qgc3VjY2Vzc0NvbmRpdGlvbnMgPSBsb2dpbk9wdGlvbnMucG9zc2libGVSZXN1bHRzW0xvZ2luUmVzdWx0cy5TdWNjZXNzXTtcclxuICAgICAgZXhwZWN0KEFycmF5LmlzQXJyYXkoc3VjY2Vzc0NvbmRpdGlvbnMpKS50b0JlKHRydWUpO1xyXG5cclxuICAgICAgY29uc3QgcGF0dGVybiA9IHN1Y2Nlc3NDb25kaXRpb25zIVswXSBhcyBSZWdFeHA7XHJcbiAgICAgIGV4cGVjdChwYXR0ZXJuKS50b0JlSW5zdGFuY2VPZihSZWdFeHApO1xyXG4gICAgICBleHBlY3QocGF0dGVybi50ZXN0KCdodHRwczovL2V4dHJhZGVwcm8ueG5lcy5jby5pbC9hcHAnKSkudG9CZSh0cnVlKTtcclxuICAgICAgZXhwZWN0KHBhdHRlcm4udGVzdCgnaHR0cHM6Ly9leHRyYWRlcHJvLnhuZXMuY28uaWwvbG9naW4nKSkudG9CZShmYWxzZSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICB0ZXN0KCdUd29GYWN0b3JSZXRyaWV2ZXJNaXNzaW5nIGhhcyBhIGZ1bmN0aW9uIGRldGVjdG9yJywgKCkgPT4ge1xyXG4gICAgICBjb25zdCBsb2dpbk9wdGlvbnMgPSBidWlsZFNjcmFwZXIoKS5nZXRMb2dpbk9wdGlvbnMoeyB1c2VybmFtZTogJ3UnLCBwYXNzd29yZDogJ3AnIH0pO1xyXG4gICAgICBjb25zdCB0ZkNvbmRpdGlvbnMgPSBsb2dpbk9wdGlvbnMucG9zc2libGVSZXN1bHRzW0xvZ2luUmVzdWx0cy5Ud29GYWN0b3JSZXRyaWV2ZXJNaXNzaW5nXTtcclxuICAgICAgZXhwZWN0KEFycmF5LmlzQXJyYXkodGZDb25kaXRpb25zKSkudG9CZSh0cnVlKTtcclxuICAgICAgZXhwZWN0KHR5cGVvZiB0ZkNvbmRpdGlvbnMhWzBdKS50b0JlKCdmdW5jdGlvbicpO1xyXG4gICAgfSk7XHJcbiAgfSk7XHJcblxyXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxyXG4gIC8vIFJlYWwtQVBJIGdhdGVkIHRlc3QgKHJlcXVpcmVzIHRlc3RzQ29uZmlnLmNyZWRlbnRpYWxzLmV4Y2VsbGVuY2UpXHJcbiAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXHJcbiAgbWF5YmVUZXN0Q29tcGFueUFQSShDT01QQU5ZX0lEKSgnc2hvdWxkIHNjcmFwZSBwb3J0Zm9saW8gYWNjb3VudHMnLCBhc3luYyAoKSA9PiB7XHJcbiAgICBjb25zdCBvcHRpb25zID0ge1xyXG4gICAgICAuLi50ZXN0c0NvbmZpZy5vcHRpb25zLFxyXG4gICAgICBjb21wYW55SWQ6IENPTVBBTllfSUQsXHJcbiAgICB9O1xyXG5cclxuICAgIGNvbnN0IHNjcmFwZXIgPSBuZXcgRXhjZWxsZW5jZVNjcmFwZXIob3B0aW9ucyk7XHJcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBzY3JhcGVyLnNjcmFwZSh0ZXN0c0NvbmZpZy5jcmVkZW50aWFscy5leGNlbGxlbmNlKTtcclxuXHJcbiAgICBleHBlY3QocmVzdWx0KS50b0JlRGVmaW5lZCgpO1xyXG4gICAgY29uc3QgZXJyb3IgPSBgJHtyZXN1bHQuZXJyb3JUeXBlID8/ICcnfSAke3Jlc3VsdC5lcnJvck1lc3NhZ2UgPz8gJyd9YC50cmltKCk7XHJcbiAgICBleHBlY3QoZXJyb3IpLnRvQmUoJycpO1xyXG4gICAgZXhwZWN0KHJlc3VsdC5zdWNjZXNzKS50b0JlKHRydWUpO1xyXG4gICAgZXhwZWN0KEFycmF5LmlzQXJyYXkocmVzdWx0LnBvcnRmb2xpb0FjY291bnRzKSkudG9CZSh0cnVlKTtcclxuICB9KTtcclxufSk7XHJcbiJdLCJtYXBwaW5ncyI6Ijs7QUFDQSxJQUFBQSxZQUFBLEdBQUFDLE9BQUE7QUFDQSxJQUFBQyxVQUFBLEdBQUFELE9BQUE7QUFDQSxJQUFBRSxXQUFBLEdBQUFGLE9BQUE7QUFDQSxJQUFBRyx1QkFBQSxHQUFBSCxPQUFBO0FBQ0EsSUFBQUksV0FBQSxHQUFBQyx1QkFBQSxDQUFBTCxPQUFBO0FBQWtILFNBQUFLLHdCQUFBQyxDQUFBLEVBQUFDLENBQUEsNkJBQUFDLE9BQUEsTUFBQUMsQ0FBQSxPQUFBRCxPQUFBLElBQUFFLENBQUEsT0FBQUYsT0FBQSxZQUFBSCx1QkFBQSxZQUFBQSxDQUFBQyxDQUFBLEVBQUFDLENBQUEsU0FBQUEsQ0FBQSxJQUFBRCxDQUFBLElBQUFBLENBQUEsQ0FBQUssVUFBQSxTQUFBTCxDQUFBLE1BQUFNLENBQUEsRUFBQUMsQ0FBQSxFQUFBQyxDQUFBLEtBQUFDLFNBQUEsUUFBQUMsT0FBQSxFQUFBVixDQUFBLGlCQUFBQSxDQUFBLHVCQUFBQSxDQUFBLHlCQUFBQSxDQUFBLFNBQUFRLENBQUEsTUFBQUYsQ0FBQSxHQUFBTCxDQUFBLEdBQUFHLENBQUEsR0FBQUQsQ0FBQSxRQUFBRyxDQUFBLENBQUFLLEdBQUEsQ0FBQVgsQ0FBQSxVQUFBTSxDQUFB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