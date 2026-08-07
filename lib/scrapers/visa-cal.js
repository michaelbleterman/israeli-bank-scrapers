"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;
var _moment = _interopRequireDefault(require("moment"));
var _debug = require("../helpers/debug");
var _elementsInteractions = require("../helpers/elements-interactions");
var _fetch = require("../helpers/fetch");
var _navigation = require("../helpers/navigation");
var _storage = require("../helpers/storage");
var _transactions = require("../helpers/transactions");
var _waiting = require("../helpers/waiting");
var _transactions2 = require("../transactions");
var _baseScraperWithBrowser = require("./base-scraper-with-browser");
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
const apiHeaders = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
  Origin: 'https://digital-web.cal-online.co.il',
  Referer: 'https://digital-web.cal-online.co.il',
  'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
  'Sec-Fetch-Site': 'same-site',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Dest': 'empty'
};
const LOGIN_URL = 'https://www.cal-online.co.il/';
const TRANSACTIONS_REQUEST_ENDPOINT = 'https://api.cal-online.co.il/Transactions/api/transactionsDetails/getCardTransactionsDetails';
const FRAMES_REQUEST_ENDPOINT = 'https://api.cal-online.co.il/Frames/api/Frames/GetFrameStatus';
const PENDING_TRANSACTIONS_REQUEST_ENDPOINT = 'https://api.cal-online.co.il/Transactions/api/approvals/getClearanceRequests';
const SSO_AUTHORIZATION_REQUEST_ENDPOINT = 'https://connect.cal-online.co.il/col-rest/calconnect/authentication/SSO';
const InvalidPasswordMessage = 'שם המשתמש או הסיסמה שהוזנו שגויים';
const ChangePasswordMessage = 'להחליף סיסמה';
const ChangePasswordSubtitle = 'הגיע הזמן לסיסמה חדשה';
const ChangePasswordUrl = '/change-password';
const debug = (0, _debug.getDebug)('visa-cal');

/**
 * Budget for waiting on data the Cal SPA writes to sessionStorage after login
 * ("init", "auth-module"). Both waits depend on the same page hydration, so they
 * share a single budget. Note this must stay well below any outer/hard timeout of
 * the caller, so a slow Cal surfaces as a typed TIMEOUT error rather than an
 * opaque abort. Do not set this to 0 expecting "no timeout" - waitUntil rejects
 * immediately in that case.
 */
const SESSION_DATA_TIMEOUT_MS = 60_000;
var TrnTypeCode = /*#__PURE__*/function (TrnTypeCode) {
  TrnTypeCode["regular"] = "5";
  TrnTypeCode["credit"] = "6";
  TrnTypeCode["installments"] = "8";
  TrnTypeCode["standingOrder"] = "9";
  return TrnTypeCode;
}(TrnTypeCode || {});
function isAuthModule(result) {
  return Boolean(result?.auth?.calConnectToken && String(result.auth.calConnectToken).trim());
}
function authModuleOrUndefined(result) {
  return isAuthModule(result) ? result : undefined;
}
function isPending(transaction) {
  return transaction.debCrdDate === undefined; // an arbitrary field that only appears in a completed transaction
}
function isCardTransactionDetails(result) {
  return result.result !== undefined;
}
function isCardPendingTransactionDetails(result) {
  return result.result !== undefined;
}
async function getLoginFrame(page) {
  let frame = null;
  debug('wait until login frame found');
  await (0, _waiting.waitUntil)(() => {
    frame = page.frames().find(f => f.url().includes('connect')) || null;
    return Promise.resolve(!!frame);
  }, 'wait for iframe with login form', 10000, 1000);
  if (!frame) {
    debug('failed to find login frame for 10 seconds');
    throw new Error('failed to extract login iframe');
  }
  return frame;
}
async function hasInvalidPasswordError(page) {
  const frame = await getLoginFrame(page);
  const errorFound = await (0, _elementsInteractions.elementPresentOnPage)(frame, 'div.general-error > div');
  const errorMessage = errorFound ? await (0, _elementsInteractions.pageEval)(frame, 'div.general-error > div', '', item => {
    return item.innerText;
  }) : '';
  return errorMessage === InvalidPasswordMessage;
}
async function hasChangePasswordForm(page) {
  // Check if any frame navigated to the change-password route
  const changePasswordFrame = page.frames().find(f => {
    const url = f.url();
    return url.includes('connect.cal-online.co.il') && url.includes(ChangePasswordUrl);
  });
  if (changePasswordFrame) {
    return true;
  }
  try {
    const frame = await getLoginFrame(page);

    // Check for the change-password Angular component
    if (await (0, _elementsInteractions.elementPresentOnPage)(frame, 'change-password')) {
      return true;
    }

    // Check for the change password title element
    if (await (0, _elementsInteractions.elementPresentOnPage)(frame, '.change-password-title')) {
      return true;
    }

    // Check for the change password subtitle text
    if (await (0, _elementsInteractions.elementPresentOnPage)(frame, '.change-password-subtitle')) {
      const subtitleText = await (0, _elementsInteractions.pageEval)(frame, '.change-password-subtitle', '', item => {
        return item.innerText.trim();
      });
      if (subtitleText.includes(ChangePasswordSubtitle)) {
        return true;
      }
    }

    // Legacy: check for the old .err-desc based change password message
    const errorFound = await (0, _elementsInteractions.elementPresentOnPage)(frame, '.err-desc');
    if (errorFound) {
      const errText = await (0, _elementsInteractions.pageEval)(frame, '.err-desc', '', item => {
        return item.innerText.trim();
      });
      return errText.includes(ChangePasswordMessage);
    }
  } catch (e) {
    debug('failed to check change password form in login frame: %s', e.message);
  }
  return false;
}
function getPossibleLoginResults() {
  debug('return possible login results');
  const urls = {
    [_baseScraperWithBrowser.LoginResults.Success]: [/dashboard/i],
    [_baseScraperWithBrowser.LoginResults.InvalidPassword]: [async options => {
      const page = options?.page;
      if (!page) {
        return false;
      }
      return hasInvalidPasswordError(page);
    }],
    // [LoginResults.AccountBlocked]: [], // TODO add when reaching this scenario
    [_baseScraperWithBrowser.LoginResults.ChangePassword]: [async options => {
      const page = options?.page;
      if (!page) {
        return false;
      }
      return hasChangePasswordForm(page);
    }]
  };
  return urls;
}
function createLoginFields(credentials) {
  debug('create login fields for username and password');
  return [{
    selector: '[formcontrolname="userName"]',
    value: credentials.username
  }, {
    selector: '[formcontrolname="password"]',
    value: credentials.password
  }];
}
function convertParsedDataToTransactions(data, pendingData, options) {
  const pendingTransactions = pendingData?.result ? pendingData.result.cardsList.flatMap(card => card.authDetalisList) : [];
  const bankAccounts = data.flatMap(monthData => monthData.result.bankAccounts);
  const regularDebitDays = bankAccounts.flatMap(accounts => accounts.debitDates);
  const immediateDebitDays = bankAccounts.flatMap(accounts => accounts.immidiateDebits.debitDays);
  const completedTransactions = [...regularDebitDays, ...immediateDebitDays].flatMap(debitDate => debitDate.transactions);
  const all = [...pendingTransactions, ...completedTransactions];
  return all.map(transaction => {
    const numOfPayments = isPending(transaction) ? transaction.numberOfPayments : transaction.numOfPayments;
    const installments = numOfPayments ? {
      number: isPending(transaction) ? 1 : transaction.curPaymentNum,
      total: numOfPayments
    } : undefined;
    const date = (0, _moment.default)(transaction.trnPurchaseDate);
    const chargedAmount = (isPending(transaction) ? transaction.trnAmt : transaction.amtBeforeConvAndIndex) * -1;
    const originalAmount = transaction.trnAmt * (transaction.trnTypeCode === TrnTypeCode.credit ? 1 : -1);
    const result = {
      identifier: !isPending(transaction) ? transaction.trnIntId : undefined,
      type: [TrnTypeCode.regular, TrnTypeCode.standingOrder].includes(transaction.trnTypeCode) ? _transactions2.TransactionTypes.Normal : _transactions2.TransactionTypes.Installments,
      status: isPending(transaction) ? _transactions2.TransactionStatuses.Pending : _transactions2.TransactionStatuses.Completed,
      date: installments ? date.add(installments.number - 1, 'month').toISOString() : date.toISOString(),
      processedDate: isPending(transaction) ? date.toISOString() : new Date(transaction.debCrdDate).toISOString(),
      originalAmount,
      originalCurrency: transaction.trnCurrencySymbol,
      chargedAmount,
      chargedCurrency: !isPending(transaction) ? transaction.debCrdCurrencySymbol : undefined,
      description: transaction.merchantName,
      memo: transaction.transTypeCommentDetails.toString(),
      category: transaction.branchCodeDesc
    };
    if (installments) {
      result.installments = installments;
    }
    if (options?.includeRawTransaction) {
      result.rawTransaction = (0, _transactions.getRawTransaction)(transaction);
    }
    return result;
  });
}
class VisaCalScraper extends _baseScraperWithBrowser.BaseScraperWithBrowser {
  authorization = undefined;
  openLoginPopup = async () => {
    debug('open login popup, wait until login button available');
    await (0, _elementsInteractions.waitUntilElementFound)(this.page, '#ccLoginDesktopBtn', true);
    debug('click on the login button');
    await (0, _elementsInteractions.clickButton)(this.page, '#ccLoginDesktopBtn');
    debug('get the frame that holds the login');
    const frame = await getLoginFrame(this.page);
    debug('wait until the password login tab header is available');
    await (0, _elementsInteractions.waitUntilElementFound)(frame, '#regular-login');
    debug('navigate to the password login tab');
    await (0, _elementsInteractions.clickButton)(frame, '#regular-login');
    debug('wait until the password login tab is active');
    await (0, _elementsInteractions.waitUntilElementFound)(frame, 'regular-login');
    return frame;
  };
  async getCards() {
    const initData = await (0, _waiting.waitUntil)(() => (0, _storage.getFromSessionStorage)(this.page, 'init'), 'get init data in session storage', SESSION_DATA_TIMEOUT_MS, 250);
    if (!initData) {
      throw new Error('could not find "init" data in session storage');
    }
    return initData?.result.cards.map(({
      cardUniqueId,
      last4Digits
    }) => ({
      cardUniqueId,
      last4Digits
    }));
  }
  async getAuthorizationHeader() {
    if (!this.authorization) {
      debug('fetching authorization header');
      const authModule = await (0, _waiting.waitUntil)(async () => authModuleOrUndefined(await (0, _storage.getFromSessionStorage)(this.page, 'auth-module')), 'get authorization header with valid token in session storage', SESSION_DATA_TIMEOUT_MS, 50);
      return `CALAuthScheme ${authModule.auth.calConnectToken}`;
    }
    return this.authorization;
  }
  async getXSiteId() {
    /*
      I don't know if the constant below will change in the feature.
      If so, use the next code:
       return this.page.evaluate(() => new Ut().xSiteId);
       To get the classname search for 'xSiteId' in the page source
      class Ut {
        constructor(_e, on, yn) {
            this.store = _e,
            this.config = on,
            this.eventBusService = yn,
            this.xSiteId = "09031987-273E-2311-906C-8AF85B17C8D9",
    */
    return Promise.resolve('09031987-273E-2311-906C-8AF85B17C8D9');
  }
  getLoginOptions(credentials) {
    this.authRequestPromise = this.page.waitForRequest(SSO_AUTHORIZATION_REQUEST_ENDPOINT, {
      timeout: 10_000
    }).catch(e => {
      debug('error while waiting for the token request', e);
      return undefined;
    });
    return {
      loginUrl: `${LOGIN_URL}`,
      fields: createLoginFields(credentials),
      submitButtonSelector: 'button[type="submit"]',
      possibleResults: getPossibleLoginResults(),
      checkReadiness: async () => (0, _elementsInteractions.waitUntilElementFound)(this.page, '#ccLoginDesktopBtn'),
      preAction: this.openLoginPopup,
      postAction: async () => {
        try {
          await (0, _navigation.waitForNavigation)(this.page);
          const currentUrl = await (0, _navigation.getCurrentUrl)(this.page);
          if (currentUrl.endsWith('site-tutorial')) {
            await (0, _elementsInteractions.clickButton)(this.page, 'button.btn-close');
          }
          const request = await this.authRequestPromise;
          this.authorization = String(request?.headers().authorization || '').trim();
        } catch (e) {
          const currentUrl = await (0, _navigation.getCurrentUrl)(this.page);
          if (currentUrl.endsWith('dashboard')) return;
          const requiresChangePassword = await hasChangePasswordForm(this.page);
          if (requiresChangePassword) return;
          throw e;
        }
      },
      userAgent: apiHeaders['User-Agent']
    };
  }
  async fetchData() {
    const defaultStartMoment = (0, _moment.default)().subtract(1, 'years').subtract(6, 'months').add(1, 'day');
    const startDate = this.options.startDate || defaultStartMoment.toDate();
    const startMoment = _moment.default.max(defaultStartMoment, (0, _moment.default)(startDate));
    debug(`fetch transactions starting ${startMoment.format()}`);
    const [cards, xSiteId, Authorization] = await Promise.all([this.getCards(), this.getXSiteId(), this.getAuthorizationHeader()]);
    const futureMonthsToScrape = this.options.futureMonthsToScrape ?? 1;
    debug('fetch frames (misgarot) of cards');
    const frames = await (0, _fetch.fetchPost)(FRAMES_REQUEST_ENDPOINT, {
      cardsForFrameData: cards.map(({
        cardUniqueId
      }) => ({
        cardUniqueId
      }))
    }, {
      Authorization,
      'X-Site-Id': xSiteId,
      'Content-Type': 'application/json',
      ...apiHeaders
    });
    const accounts = await Promise.all(cards.map(async card => {
      const finalMonthToFetchMoment = (0, _moment.default)().add(futureMonthsToScrape, 'month');
      const months = finalMonthToFetchMoment.diff(startMoment, 'months');
      const allMonthsData = [];
      const frame = frames.result?.bankIssuedCards?.cardLevelFrames?.find(f => f.cardUniqueId === card.cardUniqueId);
      debug(`fetch pending transactions for card ${card.cardUniqueId}`);
      let pendingData = await (0, _fetch.fetchPost)(PENDING_TRANSACTIONS_REQUEST_ENDPOINT, {
        cardUniqueIDArray: [card.cardUniqueId]
      }, {
        Authorization,
        'X-Site-Id': xSiteId,
        'Content-Type': 'application/json',
        ...apiHeaders
      });
      debug(`fetch completed transactions for card ${card.cardUniqueId}`);
      for (let i = 0; i <= months; i++) {
        const month = finalMonthToFetchMoment.clone().subtract(i, 'months');
        const monthData = await (0, _fetch.fetchPost)(TRANSACTIONS_REQUEST_ENDPOINT, {
          cardUniqueId: card.cardUniqueId,
          month: month.format('M'),
          year: month.format('YYYY')
        }, {
          Authorization,
          'X-Site-Id': xSiteId,
          'Content-Type': 'application/json',
          ...apiHeaders
        });
        if (monthData?.statusCode !== 1) throw new Error(`failed to fetch transactions for card ${card.last4Digits}. Message: ${monthData?.title || ''}`);
        if (!isCardTransactionDetails(monthData)) {
          throw new Error('monthData is not of type CardTransactionDetails');
        }
        allMonthsData.push(monthData);
      }
      if (pendingData?.statusCode !== 1 && pendingData?.statusCode !== 96) {
        debug(`failed to fetch pending transactions for card ${card.last4Digits}. Message: ${pendingData?.title || ''}`);
        pendingData = null;
      } else if (!isCardPendingTransactionDetails(pendingData)) {
        debug('pendingData is not of type CardTransactionDetails');
        pendingData = null;
      }
      const transactions = convertParsedDataToTransactions(allMonthsData, pendingData, this.options);
      debug('filter out old transactions');
      const txns = this.options.outputData?.enableTransactionsFilterByDate ?? true ? (0, _transactions.filterOldTransactions)(transactions, (0, _moment.default)(startDate), this.options.combineInstallments || false) : transactions;
      return {
        txns,
        balance: frame?.nextTotalDebit != null ? -frame.nextTotalDebit : undefined,
        accountNumber: card.last4Digits
      };
    }));
    debug('return the scraped accounts');
    debug(JSON.stringify(accounts, null, 2));
    return {
      success: true,
      accounts
    };
  }
}
var _default = exports.default = VisaCalScraper;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfbW9tZW50IiwiX2ludGVyb3BSZXF1aXJlRGVmYXVsdCIsInJlcXVpcmUiLCJfZGVidWciLCJfZWxlbWVudHNJbnRlcmFjdGlvbnMiLCJfZmV0Y2giLCJfbmF2aWdhdGlvbiIsIl9zdG9yYWdlIiwiX3RyYW5zYWN0aW9ucyIsIl93YWl0aW5nIiwiX3RyYW5zYWN0aW9uczIiLCJfYmFzZVNjcmFwZXJXaXRoQnJvd3NlciIsImUiLCJfX2VzTW9kdWxlIiwiZGVmYXVsdCIsImFwaUhlYWRlcnMiLCJPcmlnaW4iLCJSZWZlcmVyIiwiTE9HSU5fVVJMIiwiVFJBTlNBQ1RJT05TX1JFUVVFU1RfRU5EUE9JTlQiLCJGUkFNRVNfUkVRVUVTVF9FTkRQT0lOVCIsIlBFTkRJTkdfVFJBTlNBQ1RJT05TX1JFUVVFU1RfRU5EUE9JTlQiLCJTU09fQVVUSE9SSVpBVElPTl9SRVFVRVNUX0VORFBPSU5UIiwiSW52YWxpZFBhc3N3b3JkTWVzc2FnZSIsIkNoYW5nZVBhc3N3b3JkTWVzc2FnZSIsIkNoYW5nZVBhc3N3b3JkU3VidGl0bGUiLCJDaGFuZ2VQYXNzd29yZFVybCIsImRlYnVnIiwiZ2V0RGVidWciLCJTRVNTSU9OX0RBVEFfVElNRU9VVF9NUyIsIlRyblR5cGVDb2RlIiwiaXNBdXRoTW9kdWxlIiwicmVzdWx0IiwiQm9vbGVhbiIsImF1dGgiLCJjYWxDb25uZWN0VG9rZW4iLCJTdHJpbmciLCJ0cmltIiwiYXV0aE1vZHVsZU9yVW5kZWZpbmVkIiwidW5kZWZpbmVkIiwiaXNQZW5kaW5nIiwidHJhbnNhY3Rpb24iLCJkZWJDcmREYXRlIiwiaXNDYXJkVHJhbnNhY3Rpb25EZXRhaWxzIiwiaXNDYXJkUGVuZGluZ1RyYW5zYWN0aW9uRGV0YWlscyIsImdldExvZ2luRnJhbWUiLCJwYWdlIiwiZnJhbWUiLCJ3YWl0VW50aWwiLCJmcmFtZXMiLCJmaW5kIiwiZiIsInVybCIsImluY2x1ZGVzIiwiUHJvbWlzZSIsInJlc29sdmUiLCJFcnJvciIsImhhc0ludmFsaWRQYXNzd29yZEVycm9yIiwiZXJyb3JGb3VuZCIsImVsZW1lbnRQcmVzZW50T25QYWdlIiwiZXJyb3JNZXNzYWdlIiwicGFnZUV2YWwiLCJpdGVtIiwiaW5uZXJUZXh0IiwiaGFzQ2hhbmdlUGFzc3dvcmRGb3JtIiwiY2hhbmdlUGFzc3dvcmRGcmFtZSIsInN1YnRpdGxlVGV4dCIsImVyclRleHQiLCJtZXNzYWdlIiwiZ2V0UG9zc2libGVMb2dpblJlc3VsdHMiLCJ1cmxzIiwiTG9naW5SZXN1bHRzIiwiU3VjY2VzcyIsIkludmFsaWRQYXNzd29yZCIsIm9wdGlvbnMiLCJDaGFuZ2VQYXNzd29yZCIsImNyZWF0ZUxvZ2luRmllbGRzIiwiY3JlZGVudGlhbHMiLCJzZWxlY3RvciIsInZhbHVlIiwidXNlcm5hbWUiLCJwYXNzd29yZCIsImNvbnZlcnRQYXJzZWREYXRhVG9UcmFuc2FjdGlvbnMiLCJkYXRhIiwicGVuZGluZ0RhdGEiLCJwZW5kaW5nVHJhbnNhY3Rpb25zIiwiY2FyZHNMaXN0IiwiZmxhdE1hcCIsImNhcmQiLCJhdXRoRGV0YWxpc0xpc3QiLCJiYW5rQWNjb3VudHMiLCJtb250aERhdGEiLCJyZWd1bGFyRGViaXREYXlzIiwiYWNjb3VudHMiLCJkZWJpdERhdGVzIiwiaW1tZWRpYXRlRGViaXREYXlzIiwiaW1taWRpYXRlRGViaXRzIiwiZGViaXREYXlzIiwiY29tcGxldGVkVHJhbnNhY3Rpb25zIiwiZGViaXREYXRlIiwidHJhbnNhY3Rpb25zIiwiYWxsIiwibWFwIiwibnVtT2ZQYXltZW50cyIsIm51bWJlck9mUGF5bWVudHMiLCJpbnN0YWxsbWVudHMiLCJudW1iZXIiLCJjdXJQYXltZW50TnVtIiwidG90YWwiLCJkYXRlIiwibW9tZW50IiwidHJuUHVyY2hhc2VEYXRlIiwiY2hhcmdlZEFtb3VudCIsInRybkFtdCIsImFtdEJlZm9yZUNvbnZBbmRJbmRleCIsIm9yaWdpbmFsQW1vdW50IiwidHJuVHlwZUNvZGUiLCJjcmVkaXQiLCJpZGVudGlmaWVyIiwidHJuSW50SWQiLCJ0eXBlIiwicmVndWxhciIsInN0YW5kaW5nT3JkZXIiLCJUcmFuc2FjdGlvblR5cGVzIiwiTm9ybWFsIiwiSW5zdGFsbG1lbnRzIiwic3RhdHVzIiwiVHJhbnNhY3Rpb25TdGF0dXNlcyIsIlBlbmRpbmciLCJDb21wbGV0ZWQiLCJhZGQiLCJ0b0lTT1N0cmluZyIsInByb2Nlc3NlZERhdGUiLCJEYXRlIiwib3JpZ2luYWxDdXJyZW5jeSIsInRybkN1cnJlbmN5U3ltYm9sIiwiY2hhcmdlZEN1cnJlbmN5IiwiZGViQ3JkQ3VycmVuY3lTeW1ib2wiLCJkZXNjcmlwdGlvbiIsIm1lcmNoYW50TmFtZSIsIm1lbW8iLCJ0cmFuc1R5cGVDb21tZW50RGV0YWlscyIsInRvU3RyaW5nIiwiY2F0ZWdvcnkiLCJicmFuY2hDb2RlRGVzYyIsImluY2x1ZGVSYXdUcmFuc2FjdGlvbiIsInJhd1RyYW5zYWN0aW9uIiwiZ2V0UmF3VHJhbnNhY3Rpb24iLCJWaXNhQ2FsU2NyYXBlciIsIkJhc2VTY3JhcGVyV2l0aEJyb3dzZXIiLCJhdXRob3JpemF0aW9uIiwib3BlbkxvZ2luUG9wdXAiLCJ3YWl0VW50aWxFbGVtZW50Rm91bmQiLCJjbGlja0J1dHRvbiIsImdldENhcmRzIiwiaW5pdERhdGEiLCJnZXRGcm9tU2Vzc2lvblN0b3JhZ2UiLCJjYXJkcyIsImNhcmRVbmlxdWVJZCIsImxhc3Q0RGlnaXRzIiwiZ2V0QXV0aG9yaXphdGlvbkhlYWRlciIsImF1dGhNb2R1bGUiLCJnZXRYU2l0ZUlkIiwiZ2V0TG9naW5PcHRpb25zIiwiYXV0aFJlcXVlc3RQcm9taXNlIiwid2FpdEZvclJlcXVlc3QiLCJ0aW1lb3V0IiwiY2F0Y2giLCJsb2dpblVybCIsImZpZWxkcyIsInN1Ym1pdEJ1dHRvblNlbGVjdG9yIiwicG9zc2libGVSZXN1bHRzIiwiY2hlY2tSZWFkaW5lc3MiLCJwcmVBY3Rpb24iLCJwb3N0QWN0aW9uIiwid2FpdEZvck5hdmlnYXRpb24iLCJjdXJyZW50VXJsIiwiZ2V0Q3VycmVudFVybCIsImVuZHNXaXRoIiwicmVxdWVzdCIsImhlYWRlcnMiLCJyZXF1aXJlc0NoYW5nZVBhc3N3b3JkIiwidXNlckFnZW50IiwiZmV0Y2hEYXRhIiwiZGVmYXVsdFN0YXJ0TW9tZW50Iiwic3VidHJhY3QiLCJzdGFydERhdGUiLCJ0b0RhdGUiLCJzdGFydE1vbWVudCIsIm1heCIsImZvcm1hdCIsInhTaXRlSWQiLCJBdXRob3JpemF0aW9uIiwiZnV0dXJlTW9udGhzVG9TY3JhcGUiLCJmZXRjaFBvc3QiLCJjYXJkc0ZvckZyYW1lRGF0YSIsImZpbmFsTW9udGhUb0ZldGNoTW9tZW50IiwibW9udGhzIiwiZGlmZiIsImFsbE1vbnRoc0RhdGEiLCJiYW5rSXNzdWVkQ2FyZHMiLCJjYXJkTGV2ZWxGcmFtZXMiLCJjYXJkVW5pcXVlSURBcnJheSIsImkiLCJtb250aCIsImNsb25lIiwieWVhciIsInN0YXR1c0NvZGUiLCJ0aXRsZSIsInB1c2giLCJ0eG5zIiwib3V0cHV0RGF0YSIsImVuYWJsZVRyYW5zYWN0aW9uc0ZpbHRlckJ5RGF0ZSIsImZpbHRlck9sZFRyYW5zYWN0aW9ucyIsImNvbWJpbmVJbnN0YWxsbWVudHMiLCJiYWxhbmNlIiwibmV4dFRvdGFsRGViaXQiLCJhY2NvdW50TnVtYmVyIiwiSlNPTiIsInN0cmluZ2lmeSIsInN1Y2Nlc3MiLCJfZGVmYXVsdCIsImV4cG9ydHMiXSwic291cmNlcyI6WyIuLi8uLi9zcmMvc2NyYXBlcnMvdmlzYS1jYWwudHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IG1vbWVudCBmcm9tICdtb21lbnQnO1xuaW1wb3J0IHsgdHlwZSBIVFRQUmVxdWVzdCwgdHlwZSBGcmFtZSwgdHlwZSBQYWdlIH0gZnJvbSAncHVwcGV0ZWVyJztcbmltcG9ydCB7IGdldERlYnVnIH0gZnJvbSAnLi4vaGVscGVycy9kZWJ1Zyc7XG5pbXBvcnQgeyBjbGlja0J1dHRvbiwgZWxlbWVudFByZXNlbnRPblBhZ2UsIHBhZ2VFdmFsLCB3YWl0VW50aWxFbGVtZW50Rm91bmQgfSBmcm9tICcuLi9oZWxwZXJzL2VsZW1lbnRzLWludGVyYWN0aW9ucyc7XG5pbXBvcnQgeyBmZXRjaFBvc3QgfSBmcm9tICcuLi9oZWxwZXJzL2ZldGNoJztcbmltcG9ydCB7IGdldEN1cnJlbnRVcmwsIHdhaXRGb3JOYXZpZ2F0aW9uIH0gZnJvbSAnLi4vaGVscGVycy9uYXZpZ2F0aW9uJztcbmltcG9ydCB7IGdldEZyb21TZXNzaW9uU3RvcmFnZSB9IGZyb20gJy4uL2hlbHBlcnMvc3RvcmFnZSc7XG5pbXBvcnQgeyBmaWx0ZXJPbGRUcmFuc2FjdGlvbnMsIGdldFJhd1RyYW5zYWN0aW9uIH0gZnJvbSAnLi4vaGVscGVycy90cmFuc2FjdGlvbnMnO1xuaW1wb3J0IHsgd2FpdFVudGlsIH0gZnJvbSAnLi4vaGVscGVycy93YWl0aW5nJztcbmltcG9ydCB7IFRyYW5zYWN0aW9uU3RhdHVzZXMsIFRyYW5zYWN0aW9uVHlwZXMsIHR5cGUgVHJhbnNhY3Rpb24sIHR5cGUgVHJhbnNhY3Rpb25zQWNjb3VudCB9IGZyb20gJy4uL3RyYW5zYWN0aW9ucyc7XG5pbXBvcnQgeyBCYXNlU2NyYXBlcldpdGhCcm93c2VyLCBMb2dpblJlc3VsdHMsIHR5cGUgTG9naW5PcHRpb25zIH0gZnJvbSAnLi9iYXNlLXNjcmFwZXItd2l0aC1icm93c2VyJztcbmltcG9ydCB7IHR5cGUgU2NyYXBlclNjcmFwaW5nUmVzdWx0LCB0eXBlIFNjcmFwZXJPcHRpb25zIH0gZnJvbSAnLi9pbnRlcmZhY2UnO1xuXG5jb25zdCBhcGlIZWFkZXJzID0ge1xuICAnVXNlci1BZ2VudCc6XG4gICAgJ01vemlsbGEvNS4wIChNYWNpbnRvc2g7IEludGVsIE1hYyBPUyBYIDEwXzE1XzcpIEFwcGxlV2ViS2l0LzUzNy4zNiAoS0hUTUwsIGxpa2UgR2Vja28pIENocm9tZS8xNDIuMC4wLjAgU2FmYXJpLzUzNy4zNicsXG4gIE9yaWdpbjogJ2h0dHBzOi8vZGlnaXRhbC13ZWIuY2FsLW9ubGluZS5jby5pbCcsXG4gIFJlZmVyZXI6ICdodHRwczovL2RpZ2l0YWwtd2ViLmNhbC1vbmxpbmUuY28uaWwnLFxuICAnQWNjZXB0LUxhbmd1YWdlJzogJ2hlLUlMLGhlO3E9MC45LGVuLVVTO3E9MC44LGVuO3E9MC43JyxcbiAgJ1NlYy1GZXRjaC1TaXRlJzogJ3NhbWUtc2l0ZScsXG4gICdTZWMtRmV0Y2gtTW9kZSc6ICdjb3JzJyxcbiAgJ1NlYy1GZXRjaC1EZXN0JzogJ2VtcHR5Jyxcbn07XG5jb25zdCBMT0dJTl9VUkwgPSAnaHR0cHM6Ly93d3cuY2FsLW9ubGluZS5jby5pbC8nO1xuY29uc3QgVFJBTlNBQ1RJT05TX1JFUVVFU1RfRU5EUE9JTlQgPVxuICAnaHR0cHM6Ly9hcGkuY2FsLW9ubGluZS5jby5pbC9UcmFuc2FjdGlvbnMvYXBpL3RyYW5zYWN0aW9uc0RldGFpbHMvZ2V0Q2FyZFRyYW5zYWN0aW9uc0RldGFpbHMnO1xuY29uc3QgRlJBTUVTX1JFUVVFU1RfRU5EUE9JTlQgPSAnaHR0cHM6Ly9hcGkuY2FsLW9ubGluZS5jby5pbC9GcmFtZXMvYXBpL0ZyYW1lcy9HZXRGcmFtZVN0YXR1cyc7XG5jb25zdCBQRU5ESU5HX1RSQU5TQUNUSU9OU19SRVFVRVNUX0VORFBPSU5UID1cbiAgJ2h0dHBzOi8vYXBpLmNhbC1vbmxpbmUuY28uaWwvVHJhbnNhY3Rpb25zL2FwaS9hcHByb3ZhbHMvZ2V0Q2xlYXJhbmNlUmVxdWVzdHMnO1xuY29uc3QgU1NPX0FVVEhPUklaQVRJT05fUkVRVUVTVF9FTkRQT0lOVCA9ICdodHRwczovL2Nvbm5lY3QuY2FsLW9ubGluZS5jby5pbC9jb2wtcmVzdC9jYWxjb25uZWN0L2F1dGhlbnRpY2F0aW9uL1NTTyc7XG5cbmNvbnN0IEludmFsaWRQYXNzd29yZE1lc3NhZ2UgPSAn16nXnSDXlNee16nXqtee16kg15DXlSDXlNeh15nXodee15Qg16nXlNeV15bXoNeVINep15LXldeZ15nXnSc7XG5jb25zdCBDaGFuZ2VQYXNzd29yZE1lc3NhZ2UgPSAn15zXlNeX15zXmdejINeh15nXodee15QnO1xuY29uc3QgQ2hhbmdlUGFzc3dvcmRTdWJ0aXRsZSA9ICfXlNeS15nXoiDXlNeW157XnyDXnNeh15nXodee15Qg15fXk9ep15QnO1xuY29uc3QgQ2hhbmdlUGFzc3dvcmRVcmwgPSAnL2NoYW5nZS1wYXNzd29yZCc7XG5cbmNvbnN0IGRlYnVnID0gZ2V0RGVidWcoJ3Zpc2EtY2FsJyk7XG5cbi8qKlxuICogQnVkZ2V0IGZvciB3YWl0aW5nIG9uIGRhdGEgdGhlIENhbCBTUEEgd3JpdGVzIHRvIHNlc3Npb25TdG9yYWdlIGFmdGVyIGxvZ2luXG4gKiAoXCJpbml0XCIsIFwiYXV0aC1tb2R1bGVcIikuIEJvdGggd2FpdHMgZGVwZW5kIG9uIHRoZSBzYW1lIHBhZ2UgaHlkcmF0aW9uLCBzbyB0aGV5XG4gKiBzaGFyZSBhIHNpbmdsZSBidWRnZXQuIE5vdGUgdGhpcyBtdXN0IHN0YXkgd2VsbCBiZWxvdyBhbnkgb3V0ZXIvaGFyZCB0aW1lb3V0IG9mXG4gKiB0aGUgY2FsbGVyLCBzbyBhIHNsb3cgQ2FsIHN1cmZhY2VzIGFzIGEgdHlwZWQgVElNRU9VVCBlcnJvciByYXRoZXIgdGhhbiBhblxuICogb3BhcXVlIGFib3J0LiBEbyBub3Qgc2V0IHRoaXMgdG8gMCBleHBlY3RpbmcgXCJubyB0aW1lb3V0XCIgLSB3YWl0VW50aWwgcmVqZWN0c1xuICogaW1tZWRpYXRlbHkgaW4gdGhhdCBjYXNlLlxuICovXG5jb25zdCBTRVNTSU9OX0RBVEFfVElNRU9VVF9NUyA9IDYwXzAwMDtcblxuZW51bSBUcm5UeXBlQ29kZSB7XG4gIHJlZ3VsYXIgPSAnNScsXG4gIGNyZWRpdCA9ICc2JyxcbiAgaW5zdGFsbG1lbnRzID0gJzgnLFxuICBzdGFuZGluZ09yZGVyID0gJzknLFxufVxuXG5pbnRlcmZhY2UgU2NyYXBlZFRyYW5zYWN0aW9uIHtcbiAgYW10QmVmb3JlQ29udkFuZEluZGV4OiBudW1iZXI7XG4gIGJyYW5jaENvZGVEZXNjOiBzdHJpbmc7XG4gIGNhc2hBY2NNYW5hZ2VyTmFtZTogbnVsbDtcbiAgY2FzaEFjY291bnRNYW5hZ2VyOiBudWxsO1xuICBjYXNoQWNjb3VudFRybkFtdDogbnVtYmVyO1xuICBjaGFyZ2VFeHRlcm5hbFRvQ2FyZENvbW1lbnQ6IHN0cmluZztcbiAgY29tbWVudHM6IFtdO1xuICBjdXJQYXltZW50TnVtOiBudW1iZXI7XG4gIGRlYkNyZEN1cnJlbmN5U3ltYm9sOiBDdXJyZW5jeVN5bWJvbDtcbiAgZGViQ3JkRGF0ZTogc3RyaW5nO1xuICBkZWJpdFNwcmVhZEluZDogYm9vbGVhbjtcbiAgZGlzY291bnRBbW91bnQ6IHVua25vd247XG4gIGRpc2NvdW50UmVhc29uOiB1bmtub3duO1xuICBpbW1lZGlhdGVDb21tZW50czogW107XG4gIGlzSW1tZWRpYXRlQ29tbWVudEluZDogYm9vbGVhbjtcbiAgaXNJbW1lZGlhdGVISEtJbmQ6IGJvb2xlYW47XG4gIGlzTWFyZ2FyaXRhOiBib29sZWFuO1xuICBpc1NwcmVhZFBheW1lbnN0QWJyb2FkOiBib29sZWFuO1xuICBsaW5rZWRDb21tZW50czogW107XG4gIG1lcmNoYW50QWRkcmVzczogc3RyaW5nO1xuICBtZXJjaGFudE5hbWU6IHN0cmluZztcbiAgbWVyY2hhbnRQaG9uZU5vOiBzdHJpbmc7XG4gIG51bU9mUGF5bWVudHM6IG51bWJlcjtcbiAgb25Hb2luZ1RyYW5zYWN0aW9uc0NvbW1lbnQ6IHN0cmluZztcbiAgcmVmdW5kSW5kOiBib29sZWFuO1xuICByb3VuZGluZ0Ftb3VudDogdW5rbm93bjtcbiAgcm91bmRpbmdSZWFzb246IHVua25vd247XG4gIHRva2VuSW5kOiAwO1xuICB0b2tlbk51bWJlclBhcnQ0OiAnJztcbiAgdHJhbnNDYXJkUHJlc2VudEluZDogYm9vbGVhbjtcbiAgdHJhbnNUeXBlQ29tbWVudERldGFpbHM6IFtdO1xuICB0cm5BbXQ6IG51bWJlcjtcbiAgdHJuQ3VycmVuY3lTeW1ib2w6IEN1cnJlbmN5U3ltYm9sO1xuICB0cm5FeGFjV2F5OiBudW1iZXI7XG4gIHRybkludElkOiBzdHJpbmc7XG4gIHRybk51bWFyZXRvcjogbnVtYmVyO1xuICB0cm5QdXJjaGFzZURhdGU6IHN0cmluZztcbiAgdHJuVHlwZTogc3RyaW5nO1xuICB0cm5UeXBlQ29kZTogVHJuVHlwZUNvZGU7XG4gIHdhbGxldFByb3ZpZGVyQ29kZTogMDtcbiAgd2FsbGV0UHJvdmlkZXJEZXNjOiAnJztcbiAgZWFybHlQYXltZW50SW5kOiBib29sZWFuO1xufVxuaW50ZXJmYWNlIFNjcmFwZWRQZW5kaW5nVHJhbnNhY3Rpb24ge1xuICBtZXJjaGFudElEOiBzdHJpbmc7XG4gIG1lcmNoYW50TmFtZTogc3RyaW5nO1xuICB0cm5QdXJjaGFzZURhdGU6IHN0cmluZztcbiAgd2FsbGV0VHJhbkluZDogbnVtYmVyO1xuICB0cmFuc2FjdGlvbnNPcmlnaW46IG51bWJlcjtcbiAgdHJuQW10OiBudW1iZXI7XG4gIHRwYUFwcHJvdmFsQW1vdW50OiB1bmtub3duO1xuICB0cm5DdXJyZW5jeVN5bWJvbDogQ3VycmVuY3lTeW1ib2w7XG4gIHRyblR5cGVDb2RlOiBUcm5UeXBlQ29kZTtcbiAgdHJuVHlwZTogc3RyaW5nO1xuICBicmFuY2hDb2RlRGVzYzogc3RyaW5nO1xuICB0cmFuc0NhcmRQcmVzZW50SW5kOiBib29sZWFuO1xuICBqNUluZGljYXRvcjogc3RyaW5nO1xuICBudW1iZXJPZlBheW1lbnRzOiBudW1iZXI7XG4gIGZpcnN0UGF5bWVudEFtb3VudDogbnVtYmVyO1xuICB0cmFuc1R5cGVDb21tZW50RGV0YWlsczogW107XG59XG5pbnRlcmZhY2UgSW5pdFJlc3BvbnNlIHtcbiAgcmVzdWx0OiB7XG4gICAgY2FyZHM6IHtcbiAgICAgIGNhcmRVbmlxdWVJZDogc3RyaW5nO1xuICAgICAgbGFzdDREaWdpdHM6IHN0cmluZztcbiAgICAgIFtrZXk6IHN0cmluZ106IHVua25vd247XG4gICAgfVtdO1xuICB9O1xufVxudHlwZSBDdXJyZW5jeVN5bWJvbCA9IHN0cmluZztcbmludGVyZmFjZSBDYXJkVHJhbnNhY3Rpb25EZXRhaWxzRXJyb3Ige1xuICB0aXRsZTogc3RyaW5nO1xuICBzdGF0dXNDb2RlOiBudW1iZXI7XG59XG5pbnRlcmZhY2UgQ2FyZFRyYW5zYWN0aW9uRGV0YWlscyBleHRlbmRzIENhcmRUcmFuc2FjdGlvbkRldGFpbHNFcnJvciB7XG4gIHJlc3VsdDoge1xuICAgIGJhbmtBY2NvdW50czoge1xuICAgICAgYmFua0FjY291bnROdW06IHN0cmluZztcbiAgICAgIGJhbmtOYW1lOiBzdHJpbmc7XG4gICAgICBjaG9pY2VFeHRlcm5hbFRyYW5zYWN0aW9uczogYW55O1xuICAgICAgY3VycmVudEJhbmtBY2NvdW50SW5kOiBib29sZWFuO1xuICAgICAgZGViaXREYXRlczoge1xuICAgICAgICBiYXNrZXRBbW91bnRDb21tZW50OiB1bmtub3duO1xuICAgICAgICBjaG9pY2VISEtEZWJpdDogbnVtYmVyO1xuICAgICAgICBkYXRlOiBzdHJpbmc7XG4gICAgICAgIGRlYml0UmVhc29uOiB1bmtub3duO1xuICAgICAgICBmaXhEZWJpdEFtb3VudDogbnVtYmVyO1xuICAgICAgICBmcm9tUHVyY2hhc2VEYXRlOiBzdHJpbmc7XG4gICAgICAgIGlzQ2hvaWNlUmVwYWltZW50OiBib29sZWFuO1xuICAgICAgICB0b1B1cmNoYXNlRGF0ZTogc3RyaW5nO1xuICAgICAgICB0b3RhbEJhc2tldEFtb3VudDogbnVtYmVyO1xuICAgICAgICB0b3RhbERlYml0czoge1xuICAgICAgICAgIGN1cnJlbmN5U3ltYm9sOiBDdXJyZW5jeVN5bWJvbDtcbiAgICAgICAgICBhbW91bnQ6IG51bWJlcjtcbiAgICAgICAgfVtdO1xuICAgICAgICB0cmFuc2FjdGlvbnM6IFNjcmFwZWRUcmFuc2FjdGlvbltdO1xuICAgICAgfVtdO1xuICAgICAgaW1taWRpYXRlRGViaXRzOiB7IHRvdGFsRGViaXRzOiBbXTsgZGViaXREYXlzOiBbXSB9O1xuICAgIH1bXTtcbiAgICBibG9ja2VkQ2FyZEluZDogYm9vbGVhbjtcbiAgfTtcbiAgc3RhdHVzQ29kZTogMTtcbiAgc3RhdHVzRGVzY3JpcHRpb246IHN0cmluZztcbiAgc3RhdHVzVGl0bGU6IHN0cmluZztcbn1cbmludGVyZmFjZSBDYXJkUGVuZGluZ1RyYW5zYWN0aW9uRGV0YWlscyBleHRlbmRzIENhcmRUcmFuc2FjdGlvbkRldGFpbHNFcnJvciB7XG4gIHJlc3VsdDoge1xuICAgIGNhcmRzTGlzdDoge1xuICAgICAgY2FyZFVuaXF1ZUlEOiBzdHJpbmc7XG4gICAgICBhdXRoRGV0YWxpc0xpc3Q6IFNjcmFwZWRQZW5kaW5nVHJhbnNhY3Rpb25bXTtcbiAgICB9W107XG4gIH07XG4gIHN0YXR1c0NvZGU6IDE7XG4gIHN0YXR1c0Rlc2NyaXB0aW9uOiBzdHJpbmc7XG4gIHN0YXR1c1RpdGxlOiBzdHJpbmc7XG59XG5cbmludGVyZmFjZSBDYXJkTGV2ZWxGcmFtZSB7XG4gIGNhcmRVbmlxdWVJZDogc3RyaW5nO1xuICBuZXh0VG90YWxEZWJpdD86IG51bWJlcjtcbn1cblxuaW50ZXJmYWNlIEZyYW1lc1Jlc3BvbnNlIHtcbiAgcmVzdWx0Pzoge1xuICAgIGJhbmtJc3N1ZWRDYXJkcz86IHtcbiAgICAgIGNhcmRMZXZlbEZyYW1lcz86IENhcmRMZXZlbEZyYW1lW107XG4gICAgfTtcbiAgfTtcbn1cblxuaW50ZXJmYWNlIEF1dGhNb2R1bGUge1xuICBhdXRoOiB7XG4gICAgY2FsQ29ubmVjdFRva2VuOiBzdHJpbmcgfCBudWxsO1xuICB9O1xufVxuXG5mdW5jdGlvbiBpc0F1dGhNb2R1bGUocmVzdWx0OiBhbnkpOiByZXN1bHQgaXMgQXV0aE1vZHVsZSB7XG4gIHJldHVybiBCb29sZWFuKHJlc3VsdD8uYXV0aD8uY2FsQ29ubmVjdFRva2VuICYmIFN0cmluZyhyZXN1bHQuYXV0aC5jYWxDb25uZWN0VG9rZW4pLnRyaW0oKSk7XG59XG5cbmZ1bmN0aW9uIGF1dGhNb2R1bGVPclVuZGVmaW5lZChyZXN1bHQ6IGFueSk6IEF1dGhNb2R1bGUgfCB1bmRlZmluZWQge1xuICByZXR1cm4gaXNBdXRoTW9kdWxlKHJlc3VsdCkgPyByZXN1bHQgOiB1bmRlZmluZWQ7XG59XG5cbmZ1bmN0aW9uIGlzUGVuZGluZyhcbiAgdHJhbnNhY3Rpb246IFNjcmFwZWRUcmFuc2FjdGlvbiB8IFNjcmFwZWRQZW5kaW5nVHJhbnNhY3Rpb24sXG4pOiB0cmFuc2FjdGlvbiBpcyBTY3JhcGVkUGVuZGluZ1RyYW5zYWN0aW9uIHtcbiAgcmV0dXJuICh0cmFuc2FjdGlvbiBhcyBTY3JhcGVkVHJhbnNhY3Rpb24pLmRlYkNyZERhdGUgPT09IHVuZGVmaW5lZDsgLy8gYW4gYXJiaXRyYXJ5IGZpZWxkIHRoYXQgb25seSBhcHBlYXJzIGluIGEgY29tcGxldGVkIHRyYW5zYWN0aW9uXG59XG5cbmZ1bmN0aW9uIGlzQ2FyZFRyYW5zYWN0aW9uRGV0YWlscyhcbiAgcmVzdWx0OiBDYXJkVHJhbnNhY3Rpb25EZXRhaWxzIHwgQ2FyZFRyYW5zYWN0aW9uRGV0YWlsc0Vycm9yLFxuKTogcmVzdWx0IGlzIENhcmRUcmFuc2FjdGlvbkRldGFpbHMge1xuICByZXR1cm4gKHJlc3VsdCBhcyBDYXJkVHJhbnNhY3Rpb25EZXRhaWxzKS5yZXN1bHQgIT09IHVuZGVmaW5lZDtcbn1cblxuZnVuY3Rpb24gaXNDYXJkUGVuZGluZ1RyYW5zYWN0aW9uRGV0YWlscyhcbiAgcmVzdWx0OiBDYXJkUGVuZGluZ1RyYW5zYWN0aW9uRGV0YWlscyB8IENhcmRUcmFuc2FjdGlvbkRldGFpbHNFcnJvcixcbik6IHJlc3VsdCBpcyBDYXJkUGVuZGluZ1RyYW5zYWN0aW9uRGV0YWlscyB7XG4gIHJldHVybiAocmVzdWx0IGFzIENhcmRQZW5kaW5nVHJhbnNhY3Rpb25EZXRhaWxzKS5yZXN1bHQgIT09IHVuZGVmaW5lZDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZ2V0TG9naW5GcmFtZShwYWdlOiBQYWdlKSB7XG4gIGxldCBmcmFtZTogRnJhbWUgfCBudWxsID0gbnVsbDtcbiAgZGVidWcoJ3dhaXQgdW50aWwgbG9naW4gZnJhbWUgZm91bmQnKTtcbiAgYXdhaXQgd2FpdFVudGlsKFxuICAgICgpID0+IHtcbiAgICAgIGZyYW1lID0gcGFnZS5mcmFtZXMoKS5maW5kKGYgPT4gZi51cmwoKS5pbmNsdWRlcygnY29ubmVjdCcpKSB8fCBudWxsO1xuICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSghIWZyYW1lKTtcbiAgICB9LFxuICAgICd3YWl0IGZvciBpZnJhbWUgd2l0aCBsb2dpbiBmb3JtJyxcbiAgICAxMDAwMCxcbiAgICAxMDAwLFxuICApO1xuXG4gIGlmICghZnJhbWUpIHtcbiAgICBkZWJ1ZygnZmFpbGVkIHRvIGZpbmQgbG9naW4gZnJhbWUgZm9yIDEwIHNlY29uZHMnKTtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ2ZhaWxlZCB0byBleHRyYWN0IGxvZ2luIGlmcmFtZScpO1xuICB9XG5cbiAgcmV0dXJuIGZyYW1lO1xufVxuXG5hc3luYyBmdW5jdGlvbiBoYXNJbnZhbGlkUGFzc3dvcmRFcnJvcihwYWdlOiBQYWdlKSB7XG4gIGNvbnN0IGZyYW1lID0gYXdhaXQgZ2V0TG9naW5GcmFtZShwYWdlKTtcbiAgY29uc3QgZXJyb3JGb3VuZCA9IGF3YWl0IGVsZW1lbnRQcmVzZW50T25QYWdlKGZyYW1lLCAnZGl2LmdlbmVyYWwtZXJyb3IgPiBkaXYnKTtcbiAgY29uc3QgZXJyb3JNZXNzYWdlID0gZXJyb3JGb3VuZFxuICAgID8gYXdhaXQgcGFnZUV2YWwoZnJhbWUsICdkaXYuZ2VuZXJhbC1lcnJvciA+IGRpdicsICcnLCBpdGVtID0+IHtcbiAgICAgICAgcmV0dXJuIChpdGVtIGFzIEhUTUxEaXZFbGVtZW50KS5pbm5lclRleHQ7XG4gICAgICB9KVxuICAgIDogJyc7XG4gIHJldHVybiBlcnJvck1lc3NhZ2UgPT09IEludmFsaWRQYXNzd29yZE1lc3NhZ2U7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGhhc0NoYW5nZVBhc3N3b3JkRm9ybShwYWdlOiBQYWdlKSB7XG4gIC8vIENoZWNrIGlmIGFueSBmcmFtZSBuYXZpZ2F0ZWQgdG8gdGhlIGNoYW5nZS1wYXNzd29yZCByb3V0ZVxuICBjb25zdCBjaGFuZ2VQYXNzd29yZEZyYW1lID0gcGFnZS5mcmFtZXMoKS5maW5kKGYgPT4ge1xuICAgIGNvbnN0IHVybCA9IGYudXJsKCk7XG4gICAgcmV0dXJuIHVybC5pbmNsdWRlcygnY29ubmVjdC5jYWwtb25saW5lLmNvLmlsJykgJiYgdXJsLmluY2x1ZGVzKENoYW5nZVBhc3N3b3JkVXJsKTtcbiAgfSk7XG4gIGlmIChjaGFuZ2VQYXNzd29yZEZyYW1lKSB7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cblxuICB0cnkge1xuICAgIGNvbnN0IGZyYW1lID0gYXdhaXQgZ2V0TG9naW5GcmFtZShwYWdlKTtcblxuICAgIC8vIENoZWNrIGZvciB0aGUgY2hhbmdlLXBhc3N3b3JkIEFuZ3VsYXIgY29tcG9uZW50XG4gICAgaWYgKGF3YWl0IGVsZW1lbnRQcmVzZW50T25QYWdlKGZyYW1lLCAnY2hhbmdlLXBhc3N3b3JkJykpIHtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8vIENoZWNrIGZvciB0aGUgY2hhbmdlIHBhc3N3b3JkIHRpdGxlIGVsZW1lbnRcbiAgICBpZiAoYXdhaXQgZWxlbWVudFByZXNlbnRPblBhZ2UoZnJhbWUsICcuY2hhbmdlLXBhc3N3b3JkLXRpdGxlJykpIHtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8vIENoZWNrIGZvciB0aGUgY2hhbmdlIHBhc3N3b3JkIHN1YnRpdGxlIHRleHRcbiAgICBpZiAoYXdhaXQgZWxlbWVudFByZXNlbnRPblBhZ2UoZnJhbWUsICcuY2hhbmdlLXBhc3N3b3JkLXN1YnRpdGxlJykpIHtcbiAgICAgIGNvbnN0IHN1YnRpdGxlVGV4dCA9IGF3YWl0IHBhZ2VFdmFsKGZyYW1lLCAnLmNoYW5nZS1wYXNzd29yZC1zdWJ0aXRsZScsICcnLCBpdGVtID0+IHtcbiAgICAgICAgcmV0dXJuIChpdGVtIGFzIEhUTUxFbGVtZW50KS5pbm5lclRleHQudHJpbSgpO1xuICAgICAgfSk7XG4gICAgICBpZiAoc3VidGl0bGVUZXh0LmluY2x1ZGVzKENoYW5nZVBhc3N3b3JkU3VidGl0bGUpKSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIExlZ2FjeTogY2hlY2sgZm9yIHRoZSBvbGQgLmVyci1kZXNjIGJhc2VkIGNoYW5nZSBwYXNzd29yZCBtZXNzYWdlXG4gICAgY29uc3QgZXJyb3JGb3VuZCA9IGF3YWl0IGVsZW1lbnRQcmVzZW50T25QYWdlKGZyYW1lLCAnLmVyci1kZXNjJyk7XG4gICAgaWYgKGVycm9yRm91bmQpIHtcbiAgICAgIGNvbnN0IGVyclRleHQgPSBhd2FpdCBwYWdlRXZhbChmcmFtZSwgJy5lcnItZGVzYycsICcnLCBpdGVtID0+IHtcbiAgICAgICAgcmV0dXJuIChpdGVtIGFzIEhUTUxFbGVtZW50KS5pbm5lclRleHQudHJpbSgpO1xuICAgICAgfSk7XG4gICAgICByZXR1cm4gZXJyVGV4dC5pbmNsdWRlcyhDaGFuZ2VQYXNzd29yZE1lc3NhZ2UpO1xuICAgIH1cbiAgfSBjYXRjaCAoZSkge1xuICAgIGRlYnVnKCdmYWlsZWQgdG8gY2hlY2sgY2hhbmdlIHBhc3N3b3JkIGZvcm0gaW4gbG9naW4gZnJhbWU6ICVzJywgKGUgYXMgRXJyb3IpLm1lc3NhZ2UpO1xuICB9XG4gIHJldHVybiBmYWxzZTtcbn1cblxuZnVuY3Rpb24gZ2V0UG9zc2libGVMb2dpblJlc3VsdHMoKSB7XG4gIGRlYnVnKCdyZXR1cm4gcG9zc2libGUgbG9naW4gcmVzdWx0cycpO1xuICBjb25zdCB1cmxzOiBMb2dpbk9wdGlvbnNbJ3Bvc3NpYmxlUmVzdWx0cyddID0ge1xuICAgIFtMb2dpblJlc3VsdHMuU3VjY2Vzc106IFsvZGFzaGJvYXJkL2ldLFxuICAgIFtMb2dpblJlc3VsdHMuSW52YWxpZFBhc3N3b3JkXTogW1xuICAgICAgYXN5bmMgKG9wdGlvbnM/OiB7IHBhZ2U/OiBQYWdlIH0pID0+IHtcbiAgICAgICAgY29uc3QgcGFnZSA9IG9wdGlvbnM/LnBhZ2U7XG4gICAgICAgIGlmICghcGFnZSkge1xuICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gaGFzSW52YWxpZFBhc3N3b3JkRXJyb3IocGFnZSk7XG4gICAgICB9LFxuICAgIF0sXG4gICAgLy8gW0xvZ2luUmVzdWx0cy5BY2NvdW50QmxvY2tlZF06IFtdLCAvLyBUT0RPIGFkZCB3aGVuIHJlYWNoaW5nIHRoaXMgc2NlbmFyaW9cbiAgICBbTG9naW5SZXN1bHRzLkNoYW5nZVBhc3N3b3JkXTogW1xuICAgICAgYXN5bmMgKG9wdGlvbnM/OiB7IHBhZ2U/OiBQYWdlIH0pID0+IHtcbiAgICAgICAgY29uc3QgcGFnZSA9IG9wdGlvbnM/LnBhZ2U7XG4gICAgICAgIGlmICghcGFnZSkge1xuICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gaGFzQ2hhbmdlUGFzc3dvcmRGb3JtKHBhZ2UpO1xuICAgICAgfSxcbiAgICBdLFxuICB9O1xuICByZXR1cm4gdXJscztcbn1cblxuZnVuY3Rpb24gY3JlYXRlTG9naW5GaWVsZHMoY3JlZGVudGlhbHM6IFNjcmFwZXJTcGVjaWZpY0NyZWRlbnRpYWxzKSB7XG4gIGRlYnVnKCdjcmVhdGUgbG9naW4gZmllbGRzIGZvciB1c2VybmFtZSBhbmQgcGFzc3dvcmQnKTtcbiAgcmV0dXJuIFtcbiAgICB7IHNlbGVjdG9yOiAnW2Zvcm1jb250cm9sbmFtZT1cInVzZXJOYW1lXCJdJywgdmFsdWU6IGNyZWRlbnRpYWxzLnVzZXJuYW1lIH0sXG4gICAgeyBzZWxlY3RvcjogJ1tmb3JtY29udHJvbG5hbWU9XCJwYXNzd29yZFwiXScsIHZhbHVlOiBjcmVkZW50aWFscy5wYXNzd29yZCB9LFxuICBdO1xufVxuXG5mdW5jdGlvbiBjb252ZXJ0UGFyc2VkRGF0YVRvVHJhbnNhY3Rpb25zKFxuICBkYXRhOiBDYXJkVHJhbnNhY3Rpb25EZXRhaWxzW10sXG4gIHBlbmRpbmdEYXRhPzogQ2FyZFBlbmRpbmdUcmFuc2FjdGlvbkRldGFpbHMgfCBudWxsLFxuICBvcHRpb25zPzogU2NyYXBlck9wdGlvbnMsXG4pOiBUcmFuc2FjdGlvbltdIHtcbiAgY29uc3QgcGVuZGluZ1RyYW5zYWN0aW9ucyA9IHBlbmRpbmdEYXRhPy5yZXN1bHRcbiAgICA/IHBlbmRpbmdEYXRhLnJlc3VsdC5jYXJkc0xpc3QuZmxhdE1hcChjYXJkID0+IGNhcmQuYXV0aERldGFsaXNMaXN0KVxuICAgIDogW107XG5cbiAgY29uc3QgYmFua0FjY291bnRzID0gZGF0YS5mbGF0TWFwKG1vbnRoRGF0YSA9PiBtb250aERhdGEucmVzdWx0LmJhbmtBY2NvdW50cyk7XG4gIGNvbnN0IHJlZ3VsYXJEZWJpdERheXMgPSBiYW5rQWNjb3VudHMuZmxhdE1hcChhY2NvdW50cyA9PiBhY2NvdW50cy5kZWJpdERhdGVzKTtcbiAgY29uc3QgaW1tZWRpYXRlRGViaXREYXlzID0gYmFua0FjY291bnRzLmZsYXRNYXAoYWNjb3VudHMgPT4gYWNjb3VudHMuaW1taWRpYXRlRGViaXRzLmRlYml0RGF5cyk7XG4gIGNvbnN0IGNvbXBsZXRlZFRyYW5zYWN0aW9ucyA9IFsuLi5yZWd1bGFyRGViaXREYXlzLCAuLi5pbW1lZGlhdGVEZWJpdERheXNdLmZsYXRNYXAoXG4gICAgZGViaXREYXRlID0+IGRlYml0RGF0ZS50cmFuc2FjdGlvbnMsXG4gICk7XG5cbiAgY29uc3QgYWxsOiAoU2NyYXBlZFRyYW5zYWN0aW9uIHwgU2NyYXBlZFBlbmRpbmdUcmFuc2FjdGlvbilbXSA9IFsuLi5wZW5kaW5nVHJhbnNhY3Rpb25zLCAuLi5jb21wbGV0ZWRUcmFuc2FjdGlvbnNdO1xuXG4gIHJldHVybiBhbGwubWFwKHRyYW5zYWN0aW9uID0+IHtcbiAgICBjb25zdCBudW1PZlBheW1lbnRzID0gaXNQZW5kaW5nKHRyYW5zYWN0aW9uKSA/IHRyYW5zYWN0aW9uLm51bWJlck9mUGF5bWVudHMgOiB0cmFuc2FjdGlvbi5udW1PZlBheW1lbnRzO1xuICAgIGNvbnN0IGluc3RhbGxtZW50cyA9IG51bU9mUGF5bWVudHNcbiAgICAgID8ge1xuICAgICAgICAgIG51bWJlcjogaXNQZW5kaW5nKHRyYW5zYWN0aW9uKSA/IDEgOiB0cmFuc2FjdGlvbi5jdXJQYXltZW50TnVtLFxuICAgICAgICAgIHRvdGFsOiBudW1PZlBheW1lbnRzLFxuICAgICAgICB9XG4gICAgICA6IHVuZGVmaW5lZDtcblxuICAgIGNvbnN0IGRhdGUgPSBtb21lbnQodHJhbnNhY3Rpb24udHJuUHVyY2hhc2VEYXRlKTtcblxuICAgIGNvbnN0IGNoYXJnZWRBbW91bnQgPSAoaXNQZW5kaW5nKHRyYW5zYWN0aW9uKSA/IHRyYW5zYWN0aW9uLnRybkFtdCA6IHRyYW5zYWN0aW9uLmFtdEJlZm9yZUNvbnZBbmRJbmRleCkgKiAtMTtcbiAgICBjb25zdCBvcmlnaW5hbEFtb3VudCA9IHRyYW5zYWN0aW9uLnRybkFtdCAqICh0cmFuc2FjdGlvbi50cm5UeXBlQ29kZSA9PT0gVHJuVHlwZUNvZGUuY3JlZGl0ID8gMSA6IC0xKTtcblxuICAgIGNvbnN0IHJlc3VsdDogVHJhbnNhY3Rpb24gPSB7XG4gICAgICBpZGVudGlmaWVyOiAhaXNQZW5kaW5nKHRyYW5zYWN0aW9uKSA/IHRyYW5zYWN0aW9uLnRybkludElkIDogdW5kZWZpbmVkLFxuICAgICAgdHlwZTogW1RyblR5cGVDb2RlLnJlZ3VsYXIsIFRyblR5cGVDb2RlLnN0YW5kaW5nT3JkZXJdLmluY2x1ZGVzKHRyYW5zYWN0aW9uLnRyblR5cGVDb2RlKVxuICAgICAgICA/IFRyYW5zYWN0aW9uVHlwZXMuTm9ybWFsXG4gICAgICAgIDogVHJhbnNhY3Rpb25UeXBlcy5JbnN0YWxsbWVudHMsXG4gICAgICBzdGF0dXM6IGlzUGVuZGluZyh0cmFuc2FjdGlvbikgPyBUcmFuc2FjdGlvblN0YXR1c2VzLlBlbmRpbmcgOiBUcmFuc2FjdGlvblN0YXR1c2VzLkNvbXBsZXRlZCxcbiAgICAgIGRhdGU6IGluc3RhbGxtZW50cyA/IGRhdGUuYWRkKGluc3RhbGxtZW50cy5udW1iZXIgLSAxLCAnbW9udGgnKS50b0lTT1N0cmluZygpIDogZGF0ZS50b0lTT1N0cmluZygpLFxuICAgICAgcHJvY2Vzc2VkRGF0ZTogaXNQZW5kaW5nKHRyYW5zYWN0aW9uKSA/IGRhdGUudG9JU09TdHJpbmcoKSA6IG5ldyBEYXRlKHRyYW5zYWN0aW9uLmRlYkNyZERhdGUpLnRvSVNPU3RyaW5nKCksXG4gICAgICBvcmlnaW5hbEFtb3VudCxcbiAgICAgIG9yaWdpbmFsQ3VycmVuY3k6IHRyYW5zYWN0aW9uLnRybkN1cnJlbmN5U3ltYm9sLFxuICAgICAgY2hhcmdlZEFtb3VudCxcbiAgICAgIGNoYXJnZWRDdXJyZW5jeTogIWlzUGVuZGluZyh0cmFuc2FjdGlvbikgPyB0cmFuc2FjdGlvbi5kZWJDcmRDdXJyZW5jeVN5bWJvbCA6IHVuZGVmaW5lZCxcbiAgICAgIGRlc2NyaXB0aW9uOiB0cmFuc2FjdGlvbi5tZXJjaGFudE5hbWUsXG4gICAgICBtZW1vOiB0cmFuc2FjdGlvbi50cmFuc1R5cGVDb21tZW50RGV0YWlscy50b1N0cmluZygpLFxuICAgICAgY2F0ZWdvcnk6IHRyYW5zYWN0aW9uLmJyYW5jaENvZGVEZXNjLFxuICAgIH07XG5cbiAgICBpZiAoaW5zdGFsbG1lbnRzKSB7XG4gICAgICByZXN1bHQuaW5zdGFsbG1lbnRzID0gaW5zdGFsbG1lbnRzO1xuICAgIH1cblxuICAgIGlmIChvcHRpb25zPy5pbmNsdWRlUmF3VHJhbnNhY3Rpb24pIHtcbiAgICAgIHJlc3VsdC5yYXdUcmFuc2FjdGlvbiA9IGdldFJhd1RyYW5zYWN0aW9uKHRyYW5zYWN0aW9uKTtcbiAgICB9XG5cbiAgICByZXR1cm4gcmVzdWx0O1xuICB9KTtcbn1cblxudHlwZSBTY3JhcGVyU3BlY2lmaWNDcmVkZW50aWFscyA9IHsgdXNlcm5hbWU6IHN0cmluZzsgcGFzc3dvcmQ6IHN0cmluZyB9O1xuXG5jbGFzcyBWaXNhQ2FsU2NyYXBlciBleHRlbmRzIEJhc2VTY3JhcGVyV2l0aEJyb3dzZXI8U2NyYXBlclNwZWNpZmljQ3JlZGVudGlhbHM+IHtcbiAgcHJpdmF0ZSBhdXRob3JpemF0aW9uOiBzdHJpbmcgfCB1bmRlZmluZWQgPSB1bmRlZmluZWQ7XG5cbiAgcHJpdmF0ZSBhdXRoUmVxdWVzdFByb21pc2U6IFByb21pc2U8SFRUUFJlcXVlc3QgfCB1bmRlZmluZWQ+IHwgdW5kZWZpbmVkO1xuXG4gIG9wZW5Mb2dpblBvcHVwID0gYXN5bmMgKCkgPT4ge1xuICAgIGRlYnVnKCdvcGVuIGxvZ2luIHBvcHVwLCB3YWl0IHVudGlsIGxvZ2luIGJ1dHRvbiBhdmFpbGFibGUnKTtcbiAgICBhd2FpdCB3YWl0VW50aWxFbGVtZW50Rm91bmQodGhpcy5wYWdlLCAnI2NjTG9naW5EZXNrdG9wQnRuJywgdHJ1ZSk7XG4gICAgZGVidWcoJ2NsaWNrIG9uIHRoZSBsb2dpbiBidXR0b24nKTtcbiAgICBhd2FpdCBjbGlja0J1dHRvbih0aGlzLnBhZ2UsICcjY2NMb2dpbkRlc2t0b3BCdG4nKTtcbiAgICBkZWJ1ZygnZ2V0IHRoZSBmcmFtZSB0aGF0IGhvbGRzIHRoZSBsb2dpbicpO1xuICAgIGNvbnN0IGZyYW1lID0gYXdhaXQgZ2V0TG9naW5GcmFtZSh0aGlzLnBhZ2UpO1xuICAgIGRlYnVnKCd3YWl0IHVudGlsIHRoZSBwYXNzd29yZCBsb2dpbiB0YWIgaGVhZGVyIGlzIGF2YWlsYWJsZScpO1xuICAgIGF3YWl0IHdhaXRVbnRpbEVsZW1lbnRGb3VuZChmcmFtZSwgJyNyZWd1bGFyLWxvZ2luJyk7XG4gICAgZGVidWcoJ25hdmlnYXRlIHRvIHRoZSBwYXNzd29yZCBsb2dpbiB0YWInKTtcbiAgICBhd2FpdCBjbGlja0J1dHRvbihmcmFtZSwgJyNyZWd1bGFyLWxvZ2luJyk7XG4gICAgZGVidWcoJ3dhaXQgdW50aWwgdGhlIHBhc3N3b3JkIGxvZ2luIHRhYiBpcyBhY3RpdmUnKTtcbiAgICBhd2FpdCB3YWl0VW50aWxFbGVtZW50Rm91bmQoZnJhbWUsICdyZWd1bGFyLWxvZ2luJyk7XG5cbiAgICByZXR1cm4gZnJhbWU7XG4gIH07XG5cbiAgYXN5bmMgZ2V0Q2FyZHMoKSB7XG4gICAgY29uc3QgaW5pdERhdGEgPSBhd2FpdCB3YWl0VW50aWwoXG4gICAgICAoKSA9PiBnZXRGcm9tU2Vzc2lvblN0b3JhZ2U8SW5pdFJlc3BvbnNlPih0aGlzLnBhZ2UsICdpbml0JyksXG4gICAgICAnZ2V0IGluaXQgZGF0YSBpbiBzZXNzaW9uIHN0b3JhZ2UnLFxuICAgICAgU0VTU0lPTl9EQVRBX1RJTUVPVVRfTVMsXG4gICAgICAyNTAsXG4gICAgKTtcbiAgICBpZiAoIWluaXREYXRhKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ2NvdWxkIG5vdCBmaW5kIFwiaW5pdFwiIGRhdGEgaW4gc2Vzc2lvbiBzdG9yYWdlJyk7XG4gICAgfVxuICAgIHJldHVybiBpbml0RGF0YT8ucmVzdWx0LmNhcmRzLm1hcCgoeyBjYXJkVW5pcXVlSWQsIGxhc3Q0RGlnaXRzIH0pID0+ICh7IGNhcmRVbmlxdWVJZCwgbGFzdDREaWdpdHMgfSkpO1xuICB9XG5cbiAgYXN5bmMgZ2V0QXV0aG9yaXphdGlvbkhlYWRlcigpIHtcbiAgICBpZiAoIXRoaXMuYXV0aG9yaXphdGlvbikge1xuICAgICAgZGVidWcoJ2ZldGNoaW5nIGF1dGhvcml6YXRpb24gaGVhZGVyJyk7XG4gICAgICBjb25zdCBhdXRoTW9kdWxlID0gYXdhaXQgd2FpdFVudGlsKFxuICAgICAgICBhc3luYyAoKSA9PiBhdXRoTW9kdWxlT3JVbmRlZmluZWQoYXdhaXQgZ2V0RnJvbVNlc3Npb25TdG9yYWdlPEF1dGhNb2R1bGU+KHRoaXMucGFnZSwgJ2F1dGgtbW9kdWxlJykpLFxuICAgICAgICAnZ2V0IGF1dGhvcml6YXRpb24gaGVhZGVyIHdpdGggdmFsaWQgdG9rZW4gaW4gc2Vzc2lvbiBzdG9yYWdlJyxcbiAgICAgICAgU0VTU0lPTl9EQVRBX1RJTUVPVVRfTVMsXG4gICAgICAgIDUwLFxuICAgICAgKTtcbiAgICAgIHJldHVybiBgQ0FMQXV0aFNjaGVtZSAke2F1dGhNb2R1bGUuYXV0aC5jYWxDb25uZWN0VG9rZW59YDtcbiAgICB9XG4gICAgcmV0dXJuIHRoaXMuYXV0aG9yaXphdGlvbjtcbiAgfVxuXG4gIGFzeW5jIGdldFhTaXRlSWQoKSB7XG4gICAgLypcbiAgICAgIEkgZG9uJ3Qga25vdyBpZiB0aGUgY29uc3RhbnQgYmVsb3cgd2lsbCBjaGFuZ2UgaW4gdGhlIGZlYXR1cmUuXG4gICAgICBJZiBzbywgdXNlIHRoZSBuZXh0IGNvZGU6XG5cbiAgICAgIHJldHVybiB0aGlzLnBhZ2UuZXZhbHVhdGUoKCkgPT4gbmV3IFV0KCkueFNpdGVJZCk7XG5cbiAgICAgIFRvIGdldCB0aGUgY2xhc3NuYW1lIHNlYXJjaCBmb3IgJ3hTaXRlSWQnIGluIHRoZSBwYWdlIHNvdXJjZVxuICAgICAgY2xhc3MgVXQge1xuICAgICAgICBjb25zdHJ1Y3RvcihfZSwgb24sIHluKSB7XG4gICAgICAgICAgICB0aGlzLnN0b3JlID0gX2UsXG4gICAgICAgICAgICB0aGlzLmNvbmZpZyA9IG9uLFxuICAgICAgICAgICAgdGhpcy5ldmVudEJ1c1NlcnZpY2UgPSB5bixcbiAgICAgICAgICAgIHRoaXMueFNpdGVJZCA9IFwiMDkwMzE5ODctMjczRS0yMzExLTkwNkMtOEFGODVCMTdDOEQ5XCIsXG4gICAgKi9cbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCcwOTAzMTk4Ny0yNzNFLTIzMTEtOTA2Qy04QUY4NUIxN0M4RDknKTtcbiAgfVxuXG4gIGdldExvZ2luT3B0aW9ucyhjcmVkZW50aWFsczogU2NyYXBlclNwZWNpZmljQ3JlZGVudGlhbHMpOiBMb2dpbk9wdGlvbnMge1xuICAgIHRoaXMuYXV0aFJlcXVlc3RQcm9taXNlID0gdGhpcy5wYWdlXG4gICAgICAud2FpdEZvclJlcXVlc3QoU1NPX0FVVEhPUklaQVRJT05fUkVRVUVTVF9FTkRQT0lOVCwgeyB0aW1lb3V0OiAxMF8wMDAgfSlcbiAgICAgIC5jYXRjaChlID0+IHtcbiAgICAgICAgZGVidWcoJ2Vycm9yIHdoaWxlIHdhaXRpbmcgZm9yIHRoZSB0b2tlbiByZXF1ZXN0JywgZSk7XG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICB9KTtcbiAgICByZXR1cm4ge1xuICAgICAgbG9naW5Vcmw6IGAke0xPR0lOX1VSTH1gLFxuICAgICAgZmllbGRzOiBjcmVhdGVMb2dpbkZpZWxkcyhjcmVkZW50aWFscyksXG4gICAgICBzdWJtaXRCdXR0b25TZWxlY3RvcjogJ2J1dHRvblt0eXBlPVwic3VibWl0XCJdJyxcbiAgICAgIHBvc3NpYmxlUmVzdWx0czogZ2V0UG9zc2libGVMb2dpblJlc3VsdHMoKSxcbiAgICAgIGNoZWNrUmVhZGluZXNzOiBhc3luYyAoKSA9PiB3YWl0VW50aWxFbGVtZW50Rm91bmQodGhpcy5wYWdlLCAnI2NjTG9naW5EZXNrdG9wQnRuJyksXG4gICAgICBwcmVBY3Rpb246IHRoaXMub3BlbkxvZ2luUG9wdXAsXG4gICAgICBwb3N0QWN0aW9uOiBhc3luYyAoKSA9PiB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgYXdhaXQgd2FpdEZvck5hdmlnYXRpb24odGhpcy5wYWdlKTtcbiAgICAgICAgICBjb25zdCBjdXJyZW50VXJsID0gYXdhaXQgZ2V0Q3VycmVudFVybCh0aGlzLnBhZ2UpO1xuICAgICAgICAgIGlmIChjdXJyZW50VXJsLmVuZHNXaXRoKCdzaXRlLXR1dG9yaWFsJykpIHtcbiAgICAgICAgICAgIGF3YWl0IGNsaWNrQnV0dG9uKHRoaXMucGFnZSwgJ2J1dHRvbi5idG4tY2xvc2UnKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgY29uc3QgcmVxdWVzdCA9IGF3YWl0IHRoaXMuYXV0aFJlcXVlc3RQcm9taXNlO1xuICAgICAgICAgIHRoaXMuYXV0aG9yaXphdGlvbiA9IFN0cmluZyhyZXF1ZXN0Py5oZWFkZXJzKCkuYXV0aG9yaXphdGlvbiB8fCAnJykudHJpbSgpO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgY29uc3QgY3VycmVudFVybCA9IGF3YWl0IGdldEN1cnJlbnRVcmwodGhpcy5wYWdlKTtcbiAgICAgICAgICBpZiAoY3VycmVudFVybC5lbmRzV2l0aCgnZGFzaGJvYXJkJykpIHJldHVybjtcbiAgICAgICAgICBjb25zdCByZXF1aXJlc0NoYW5nZVBhc3N3b3JkID0gYXdhaXQgaGFzQ2hhbmdlUGFzc3dvcmRGb3JtKHRoaXMucGFnZSk7XG4gICAgICAgICAgaWYgKHJlcXVpcmVzQ2hhbmdlUGFzc3dvcmQpIHJldHVybjtcbiAgICAgICAgICB0aHJvdyBlO1xuICAgICAgICB9XG4gICAgICB9LFxuICAgICAgdXNlckFnZW50OiBhcGlIZWFkZXJzWydVc2VyLUFnZW50J10sXG4gICAgfTtcbiAgfVxuXG4gIGFzeW5jIGZldGNoRGF0YSgpOiBQcm9taXNlPFNjcmFwZXJTY3JhcGluZ1Jlc3VsdD4ge1xuICAgIGNvbnN0IGRlZmF1bHRTdGFydE1vbWVudCA9IG1vbWVudCgpLnN1YnRyYWN0KDEsICd5ZWFycycpLnN1YnRyYWN0KDYsICdtb250aHMnKS5hZGQoMSwgJ2RheScpO1xuICAgIGNvbnN0IHN0YXJ0RGF0ZSA9IHRoaXMub3B0aW9ucy5zdGFydERhdGUgfHwgZGVmYXVsdFN0YXJ0TW9tZW50LnRvRGF0ZSgpO1xuICAgIGNvbnN0IHN0YXJ0TW9tZW50ID0gbW9tZW50Lm1heChkZWZhdWx0U3RhcnRNb21lbnQsIG1vbWVudChzdGFydERhdGUpKTtcbiAgICBkZWJ1ZyhgZmV0Y2ggdHJhbnNhY3Rpb25zIHN0YXJ0aW5nICR7c3RhcnRNb21lbnQuZm9ybWF0KCl9YCk7XG5cbiAgICBjb25zdCBbY2FyZHMsIHhTaXRlSWQsIEF1dGhvcml6YXRpb25dID0gYXdhaXQgUHJvbWlzZS5hbGwoW1xuICAgICAgdGhpcy5nZXRDYXJkcygpLFxuICAgICAgdGhpcy5nZXRYU2l0ZUlkKCksXG4gICAgICB0aGlzLmdldEF1dGhvcml6YXRpb25IZWFkZXIoKSxcbiAgICBdKTtcblxuICAgIGNvbnN0IGZ1dHVyZU1vbnRoc1RvU2NyYXBlID0gdGhpcy5vcHRpb25zLmZ1dHVyZU1vbnRoc1RvU2NyYXBlID8/IDE7XG5cbiAgICBkZWJ1ZygnZmV0Y2ggZnJhbWVzIChtaXNnYXJvdCkgb2YgY2FyZHMnKTtcbiAgICBjb25zdCBmcmFtZXMgPSBhd2FpdCBmZXRjaFBvc3Q8RnJhbWVzUmVzcG9uc2U+KFxuICAgICAgRlJBTUVTX1JFUVVFU1RfRU5EUE9JTlQsXG4gICAgICB7IGNhcmRzRm9yRnJhbWVEYXRhOiBjYXJkcy5tYXAoKHsgY2FyZFVuaXF1ZUlkIH0pID0+ICh7IGNhcmRVbmlxdWVJZCB9KSkgfSxcbiAgICAgIHtcbiAgICAgICAgQXV0aG9yaXphdGlvbixcbiAgICAgICAgJ1gtU2l0ZS1JZCc6IHhTaXRlSWQsXG4gICAgICAgICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicsXG4gICAgICAgIC4uLmFwaUhlYWRlcnMsXG4gICAgICB9LFxuICAgICk7XG5cbiAgICBjb25zdCBhY2NvdW50cyA9IGF3YWl0IFByb21pc2UuYWxsKFxuICAgICAgY2FyZHMubWFwKGFzeW5jIGNhcmQgPT4ge1xuICAgICAgICBjb25zdCBmaW5hbE1vbnRoVG9GZXRjaE1vbWVudCA9IG1vbWVudCgpLmFkZChmdXR1cmVNb250aHNUb1NjcmFwZSwgJ21vbnRoJyk7XG4gICAgICAgIGNvbnN0IG1vbnRocyA9IGZpbmFsTW9udGhUb0ZldGNoTW9tZW50LmRpZmYoc3RhcnRNb21lbnQsICdtb250aHMnKTtcbiAgICAgICAgY29uc3QgYWxsTW9udGhzRGF0YTogQ2FyZFRyYW5zYWN0aW9uRGV0YWlsc1tdID0gW107XG4gICAgICAgIGNvbnN0IGZyYW1lID0gZnJhbWVzLnJlc3VsdD8uYmFua0lzc3VlZENhcmRzPy5jYXJkTGV2ZWxGcmFtZXM/LmZpbmQoXG4gICAgICAgICAgKGY6IENhcmRMZXZlbEZyYW1lKSA9PiBmLmNhcmRVbmlxdWVJZCA9PT0gY2FyZC5jYXJkVW5pcXVlSWQsXG4gICAgICAgICk7XG5cbiAgICAgICAgZGVidWcoYGZldGNoIHBlbmRpbmcgdHJhbnNhY3Rpb25zIGZvciBjYXJkICR7Y2FyZC5jYXJkVW5pcXVlSWR9YCk7XG4gICAgICAgIGxldCBwZW5kaW5nRGF0YSA9IGF3YWl0IGZldGNoUG9zdChcbiAgICAgICAgICBQRU5ESU5HX1RSQU5TQUNUSU9OU19SRVFVRVNUX0VORFBPSU5ULFxuICAgICAgICAgIHsgY2FyZFVuaXF1ZUlEQXJyYXk6IFtjYXJkLmNhcmRVbmlxdWVJZF0gfSxcbiAgICAgICAgICB7XG4gICAgICAgICAgICBBdXRob3JpemF0aW9uLFxuICAgICAgICAgICAgJ1gtU2l0ZS1JZCc6IHhTaXRlSWQsXG4gICAgICAgICAgICAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nLFxuICAgICAgICAgICAgLi4uYXBpSGVhZGVycyxcbiAgICAgICAgICB9LFxuICAgICAgICApO1xuXG4gICAgICAgIGRlYnVnKGBmZXRjaCBjb21wbGV0ZWQgdHJhbnNhY3Rpb25zIGZvciBjYXJkICR7Y2FyZC5jYXJkVW5pcXVlSWR9YCk7XG4gICAgICAgIGZvciAobGV0IGkgPSAwOyBpIDw9IG1vbnRoczsgaSsrKSB7XG4gICAgICAgICAgY29uc3QgbW9udGggPSBmaW5hbE1vbnRoVG9GZXRjaE1vbWVudC5jbG9uZSgpLnN1YnRyYWN0KGksICdtb250aHMnKTtcbiAgICAgICAgICBjb25zdCBtb250aERhdGEgPSBhd2FpdCBmZXRjaFBvc3QoXG4gICAgICAgICAgICBUUkFOU0FDVElPTlNfUkVRVUVTVF9FTkRQT0lOVCxcbiAgICAgICAgICAgIHsgY2FyZFVuaXF1ZUlkOiBjYXJkLmNhcmRVbmlxdWVJZCwgbW9udGg6IG1vbnRoLmZvcm1hdCgnTScpLCB5ZWFyOiBtb250aC5mb3JtYXQoJ1lZWVknKSB9LFxuICAgICAgICAgICAge1xuICAgICAgICAgICAgICBBdXRob3JpemF0aW9uLFxuICAgICAgICAgICAgICAnWC1TaXRlLUlkJzogeFNpdGVJZCxcbiAgICAgICAgICAgICAgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyxcbiAgICAgICAgICAgICAgLi4uYXBpSGVhZGVycyxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgKTtcblxuICAgICAgICAgIGlmIChtb250aERhdGE/LnN0YXR1c0NvZGUgIT09IDEpXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICAgIGBmYWlsZWQgdG8gZmV0Y2ggdHJhbnNhY3Rpb25zIGZvciBjYXJkICR7Y2FyZC5sYXN0NERpZ2l0c30uIE1lc3NhZ2U6ICR7bW9udGhEYXRhPy50aXRsZSB8fCAnJ31gLFxuICAgICAgICAgICAgKTtcblxuICAgICAgICAgIGlmICghaXNDYXJkVHJhbnNhY3Rpb25EZXRhaWxzKG1vbnRoRGF0YSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignbW9udGhEYXRhIGlzIG5vdCBvZiB0eXBlIENhcmRUcmFuc2FjdGlvbkRldGFpbHMnKTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBhbGxNb250aHNEYXRhLnB1c2gobW9udGhEYXRhKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChwZW5kaW5nRGF0YT8uc3RhdHVzQ29kZSAhPT0gMSAmJiBwZW5kaW5nRGF0YT8uc3RhdHVzQ29kZSAhPT0gOTYpIHtcbiAgICAgICAgICBkZWJ1ZyhcbiAgICAgICAgICAgIGBmYWlsZWQgdG8gZmV0Y2ggcGVuZGluZyB0cmFuc2FjdGlvbnMgZm9yIGNhcmQgJHtjYXJkLmxhc3Q0RGlnaXRzfS4gTWVzc2FnZTogJHtwZW5kaW5nRGF0YT8udGl0bGUgfHwgJyd9YCxcbiAgICAgICAgICApO1xuICAgICAgICAgIHBlbmRpbmdEYXRhID0gbnVsbDtcbiAgICAgICAgfSBlbHNlIGlmICghaXNDYXJkUGVuZGluZ1RyYW5zYWN0aW9uRGV0YWlscyhwZW5kaW5nRGF0YSkpIHtcbiAgICAgICAgICBkZWJ1ZygncGVuZGluZ0RhdGEgaXMgbm90IG9mIHR5cGUgQ2FyZFRyYW5zYWN0aW9uRGV0YWlscycpO1xuICAgICAgICAgIHBlbmRpbmdEYXRhID0gbnVsbDtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHRyYW5zYWN0aW9ucyA9IGNvbnZlcnRQYXJzZWREYXRhVG9UcmFuc2FjdGlvbnMoYWxsTW9udGhzRGF0YSwgcGVuZGluZ0RhdGEsIHRoaXMub3B0aW9ucyk7XG5cbiAgICAgICAgZGVidWcoJ2ZpbHRlciBvdXQgb2xkIHRyYW5zYWN0aW9ucycpO1xuICAgICAgICBjb25zdCB0eG5zID1cbiAgICAgICAgICAodGhpcy5vcHRpb25zLm91dHB1dERhdGE/LmVuYWJsZVRyYW5zYWN0aW9uc0ZpbHRlckJ5RGF0ZSA/PyB0cnVlKVxuICAgICAgICAgICAgPyBmaWx0ZXJPbGRUcmFuc2FjdGlvbnModHJhbnNhY3Rpb25zLCBtb21lbnQoc3RhcnREYXRlKSwgdGhpcy5vcHRpb25zLmNvbWJpbmVJbnN0YWxsbWVudHMgfHwgZmFsc2UpXG4gICAgICAgICAgICA6IHRyYW5zYWN0aW9ucztcblxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIHR4bnMsXG4gICAgICAgICAgYmFsYW5jZTogZnJhbWU/Lm5leHRUb3RhbERlYml0ICE9IG51bGwgPyAtZnJhbWUubmV4dFRvdGFsRGViaXQgOiB1bmRlZmluZWQsXG4gICAgICAgICAgYWNjb3VudE51bWJlcjogY2FyZC5sYXN0NERpZ2l0cyxcbiAgICAgICAgfSBhcyBUcmFuc2FjdGlvbnNBY2NvdW50O1xuICAgICAgfSksXG4gICAgKTtcblxuICAgIGRlYnVnKCdyZXR1cm4gdGhlIHNjcmFwZWQgYWNjb3VudHMnKTtcblxuICAgIGRlYnVnKEpTT04uc3RyaW5naWZ5KGFjY291bnRzLCBudWxsLCAyKSk7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN1Y2Nlc3M6IHRydWUsXG4gICAgICBhY2NvdW50cyxcbiAgICB9O1xuICB9XG59XG5cbmV4cG9ydCBkZWZhdWx0IFZpc2FDYWxTY3JhcGVyO1xuIl0sIm1hcHBpbmdzIjoiOzs7Ozs7QUFBQSxJQUFBQSxPQUFBLEdBQUFDLHNCQUFBLENBQUFDLE9BQUE7QUFFQSxJQUFBQyxNQUFBLEdBQUFELE9BQUE7QUFDQSxJQUFBRSxxQkFBQSxHQUFBRixPQUFBO0FBQ0EsSUFBQUcsTUFBQSxHQUFBSCxPQUFBO0FBQ0EsSUFBQUksV0FBQSxHQUFBSixPQUFBO0FBQ0EsSUFBQUssUUFB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