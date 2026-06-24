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
    const initData = await (0, _waiting.waitUntil)(() => (0, _storage.getFromSessionStorage)(this.page, 'init'), 'get init data in session storage', 10000, 1000);
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
      const authModule = await (0, _waiting.waitUntil)(async () => authModuleOrUndefined(await (0, _storage.getFromSessionStorage)(this.page, 'auth-module')), 'get authorization header with valid token in session storage', 10_000, 50);
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfbW9tZW50IiwiX2ludGVyb3BSZXF1aXJlRGVmYXVsdCIsInJlcXVpcmUiLCJfZGVidWciLCJfZWxlbWVudHNJbnRlcmFjdGlvbnMiLCJfZmV0Y2giLCJfbmF2aWdhdGlvbiIsIl9zdG9yYWdlIiwiX3RyYW5zYWN0aW9ucyIsIl93YWl0aW5nIiwiX3RyYW5zYWN0aW9uczIiLCJfYmFzZVNjcmFwZXJXaXRoQnJvd3NlciIsImUiLCJfX2VzTW9kdWxlIiwiZGVmYXVsdCIsImFwaUhlYWRlcnMiLCJPcmlnaW4iLCJSZWZlcmVyIiwiTE9HSU5fVVJMIiwiVFJBTlNBQ1RJT05TX1JFUVVFU1RfRU5EUE9JTlQiLCJGUkFNRVNfUkVRVUVTVF9FTkRQT0lOVCIsIlBFTkRJTkdfVFJBTlNBQ1RJT05TX1JFUVVFU1RfRU5EUE9JTlQiLCJTU09fQVVUSE9SSVpBVElPTl9SRVFVRVNUX0VORFBPSU5UIiwiSW52YWxpZFBhc3N3b3JkTWVzc2FnZSIsIkNoYW5nZVBhc3N3b3JkTWVzc2FnZSIsIkNoYW5nZVBhc3N3b3JkU3VidGl0bGUiLCJDaGFuZ2VQYXNzd29yZFVybCIsImRlYnVnIiwiZ2V0RGVidWciLCJUcm5UeXBlQ29kZSIsImlzQXV0aE1vZHVsZSIsInJlc3VsdCIsIkJvb2xlYW4iLCJhdXRoIiwiY2FsQ29ubmVjdFRva2VuIiwiU3RyaW5nIiwidHJpbSIsImF1dGhNb2R1bGVPclVuZGVmaW5lZCIsInVuZGVmaW5lZCIsImlzUGVuZGluZyIsInRyYW5zYWN0aW9uIiwiZGViQ3JkRGF0ZSIsImlzQ2FyZFRyYW5zYWN0aW9uRGV0YWlscyIsImlzQ2FyZFBlbmRpbmdUcmFuc2FjdGlvbkRldGFpbHMiLCJnZXRMb2dpbkZyYW1lIiwicGFnZSIsImZyYW1lIiwid2FpdFVudGlsIiwiZnJhbWVzIiwiZmluZCIsImYiLCJ1cmwiLCJpbmNsdWRlcyIsIlByb21pc2UiLCJyZXNvbHZlIiwiRXJyb3IiLCJoYXNJbnZhbGlkUGFzc3dvcmRFcnJvciIsImVycm9yRm91bmQiLCJlbGVtZW50UHJlc2VudE9uUGFnZSIsImVycm9yTWVzc2FnZSIsInBhZ2VFdmFsIiwiaXRlbSIsImlubmVyVGV4dCIsImhhc0NoYW5nZVBhc3N3b3JkRm9ybSIsImNoYW5nZVBhc3N3b3JkRnJhbWUiLCJzdWJ0aXRsZVRleHQiLCJlcnJUZXh0IiwibWVzc2FnZSIsImdldFBvc3NpYmxlTG9naW5SZXN1bHRzIiwidXJscyIsIkxvZ2luUmVzdWx0cyIsIlN1Y2Nlc3MiLCJJbnZhbGlkUGFzc3dvcmQiLCJvcHRpb25zIiwiQ2hhbmdlUGFzc3dvcmQiLCJjcmVhdGVMb2dpbkZpZWxkcyIsImNyZWRlbnRpYWxzIiwic2VsZWN0b3IiLCJ2YWx1ZSIsInVzZXJuYW1lIiwicGFzc3dvcmQiLCJjb252ZXJ0UGFyc2VkRGF0YVRvVHJhbnNhY3Rpb25zIiwiZGF0YSIsInBlbmRpbmdEYXRhIiwicGVuZGluZ1RyYW5zYWN0aW9ucyIsImNhcmRzTGlzdCIsImZsYXRNYXAiLCJjYXJkIiwiYXV0aERldGFsaXNMaXN0IiwiYmFua0FjY291bnRzIiwibW9udGhEYXRhIiwicmVndWxhckRlYml0RGF5cyIsImFjY291bnRzIiwiZGViaXREYXRlcyIsImltbWVkaWF0ZURlYml0RGF5cyIsImltbWlkaWF0ZURlYml0cyIsImRlYml0RGF5cyIsImNvbXBsZXRlZFRyYW5zYWN0aW9ucyIsImRlYml0RGF0ZSIsInRyYW5zYWN0aW9ucyIsImFsbCIsIm1hcCIsIm51bU9mUGF5bWVudHMiLCJudW1iZXJPZlBheW1lbnRzIiwiaW5zdGFsbG1lbnRzIiwibnVtYmVyIiwiY3VyUGF5bWVudE51bSIsInRvdGFsIiwiZGF0ZSIsIm1vbWVudCIsInRyblB1cmNoYXNlRGF0ZSIsImNoYXJnZWRBbW91bnQiLCJ0cm5BbXQiLCJhbXRCZWZvcmVDb252QW5kSW5kZXgiLCJvcmlnaW5hbEFtb3VudCIsInRyblR5cGVDb2RlIiwiY3JlZGl0IiwiaWRlbnRpZmllciIsInRybkludElkIiwidHlwZSIsInJlZ3VsYXIiLCJzdGFuZGluZ09yZGVyIiwiVHJhbnNhY3Rpb25UeXBlcyIsIk5vcm1hbCIsIkluc3RhbGxtZW50cyIsInN0YXR1cyIsIlRyYW5zYWN0aW9uU3RhdHVzZXMiLCJQZW5kaW5nIiwiQ29tcGxldGVkIiwiYWRkIiwidG9JU09TdHJpbmciLCJwcm9jZXNzZWREYXRlIiwiRGF0ZSIsIm9yaWdpbmFsQ3VycmVuY3kiLCJ0cm5DdXJyZW5jeVN5bWJvbCIsImNoYXJnZWRDdXJyZW5jeSIsImRlYkNyZEN1cnJlbmN5U3ltYm9sIiwiZGVzY3JpcHRpb24iLCJtZXJjaGFudE5hbWUiLCJtZW1vIiwidHJhbnNUeXBlQ29tbWVudERldGFpbHMiLCJ0b1N0cmluZyIsImNhdGVnb3J5IiwiYnJhbmNoQ29kZURlc2MiLCJpbmNsdWRlUmF3VHJhbnNhY3Rpb24iLCJyYXdUcmFuc2FjdGlvbiIsImdldFJhd1RyYW5zYWN0aW9uIiwiVmlzYUNhbFNjcmFwZXIiLCJCYXNlU2NyYXBlcldpdGhCcm93c2VyIiwiYXV0aG9yaXphdGlvbiIsIm9wZW5Mb2dpblBvcHVwIiwid2FpdFVudGlsRWxlbWVudEZvdW5kIiwiY2xpY2tCdXR0b24iLCJnZXRDYXJkcyIsImluaXREYXRhIiwiZ2V0RnJvbVNlc3Npb25TdG9yYWdlIiwiY2FyZHMiLCJjYXJkVW5pcXVlSWQiLCJsYXN0NERpZ2l0cyIsImdldEF1dGhvcml6YXRpb25IZWFkZXIiLCJhdXRoTW9kdWxlIiwiZ2V0WFNpdGVJZCIsImdldExvZ2luT3B0aW9ucyIsImF1dGhSZXF1ZXN0UHJvbWlzZSIsIndhaXRGb3JSZXF1ZXN0IiwidGltZW91dCIsImNhdGNoIiwibG9naW5VcmwiLCJmaWVsZHMiLCJzdWJtaXRCdXR0b25TZWxlY3RvciIsInBvc3NpYmxlUmVzdWx0cyIsImNoZWNrUmVhZGluZXNzIiwicHJlQWN0aW9uIiwicG9zdEFjdGlvbiIsIndhaXRGb3JOYXZpZ2F0aW9uIiwiY3VycmVudFVybCIsImdldEN1cnJlbnRVcmwiLCJlbmRzV2l0aCIsInJlcXVlc3QiLCJoZWFkZXJzIiwicmVxdWlyZXNDaGFuZ2VQYXNzd29yZCIsInVzZXJBZ2VudCIsImZldGNoRGF0YSIsImRlZmF1bHRTdGFydE1vbWVudCIsInN1YnRyYWN0Iiwic3RhcnREYXRlIiwidG9EYXRlIiwic3RhcnRNb21lbnQiLCJtYXgiLCJmb3JtYXQiLCJ4U2l0ZUlkIiwiQXV0aG9yaXphdGlvbiIsImZ1dHVyZU1vbnRoc1RvU2NyYXBlIiwiZmV0Y2hQb3N0IiwiY2FyZHNGb3JGcmFtZURhdGEiLCJmaW5hbE1vbnRoVG9GZXRjaE1vbWVudCIsIm1vbnRocyIsImRpZmYiLCJhbGxNb250aHNEYXRhIiwiYmFua0lzc3VlZENhcmRzIiwiY2FyZExldmVsRnJhbWVzIiwiY2FyZFVuaXF1ZUlEQXJyYXkiLCJpIiwibW9udGgiLCJjbG9uZSIsInllYXIiLCJzdGF0dXNDb2RlIiwidGl0bGUiLCJwdXNoIiwidHhucyIsIm91dHB1dERhdGEiLCJlbmFibGVUcmFuc2FjdGlvbnNGaWx0ZXJCeURhdGUiLCJmaWx0ZXJPbGRUcmFuc2FjdGlvbnMiLCJjb21iaW5lSW5zdGFsbG1lbnRzIiwiYmFsYW5jZSIsIm5leHRUb3RhbERlYml0IiwiYWNjb3VudE51bWJlciIsIkpTT04iLCJzdHJpbmdpZnkiLCJzdWNjZXNzIiwiX2RlZmF1bHQiLCJleHBvcnRzIl0sInNvdXJjZXMiOlsiLi4vLi4vc3JjL3NjcmFwZXJzL3Zpc2EtY2FsLnRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCBtb21lbnQgZnJvbSAnbW9tZW50JztcclxuaW1wb3J0IHsgdHlwZSBIVFRQUmVxdWVzdCwgdHlwZSBGcmFtZSwgdHlwZSBQYWdlIH0gZnJvbSAncHVwcGV0ZWVyJztcclxuaW1wb3J0IHsgZ2V0RGVidWcgfSBmcm9tICcuLi9oZWxwZXJzL2RlYnVnJztcclxuaW1wb3J0IHsgY2xpY2tCdXR0b24sIGVsZW1lbnRQcmVzZW50T25QYWdlLCBwYWdlRXZhbCwgd2FpdFVudGlsRWxlbWVudEZvdW5kIH0gZnJvbSAnLi4vaGVscGVycy9lbGVtZW50cy1pbnRlcmFjdGlvbnMnO1xyXG5pbXBvcnQgeyBmZXRjaFBvc3QgfSBmcm9tICcuLi9oZWxwZXJzL2ZldGNoJztcclxuaW1wb3J0IHsgZ2V0Q3VycmVudFVybCwgd2FpdEZvck5hdmlnYXRpb24gfSBmcm9tICcuLi9oZWxwZXJzL25hdmlnYXRpb24nO1xyXG5pbXBvcnQgeyBnZXRGcm9tU2Vzc2lvblN0b3JhZ2UgfSBmcm9tICcuLi9oZWxwZXJzL3N0b3JhZ2UnO1xyXG5pbXBvcnQgeyBmaWx0ZXJPbGRUcmFuc2FjdGlvbnMsIGdldFJhd1RyYW5zYWN0aW9uIH0gZnJvbSAnLi4vaGVscGVycy90cmFuc2FjdGlvbnMnO1xyXG5pbXBvcnQgeyB3YWl0VW50aWwgfSBmcm9tICcuLi9oZWxwZXJzL3dhaXRpbmcnO1xyXG5pbXBvcnQgeyBUcmFuc2FjdGlvblN0YXR1c2VzLCBUcmFuc2FjdGlvblR5cGVzLCB0eXBlIFRyYW5zYWN0aW9uLCB0eXBlIFRyYW5zYWN0aW9uc0FjY291bnQgfSBmcm9tICcuLi90cmFuc2FjdGlvbnMnO1xyXG5pbXBvcnQgeyBCYXNlU2NyYXBlcldpdGhCcm93c2VyLCBMb2dpblJlc3VsdHMsIHR5cGUgTG9naW5PcHRpb25zIH0gZnJvbSAnLi9iYXNlLXNjcmFwZXItd2l0aC1icm93c2VyJztcclxuaW1wb3J0IHsgdHlwZSBTY3JhcGVyU2NyYXBpbmdSZXN1bHQsIHR5cGUgU2NyYXBlck9wdGlvbnMgfSBmcm9tICcuL2ludGVyZmFjZSc7XHJcblxyXG5jb25zdCBhcGlIZWFkZXJzID0ge1xyXG4gICdVc2VyLUFnZW50JzpcclxuICAgICdNb3ppbGxhLzUuMCAoTWFjaW50b3NoOyBJbnRlbCBNYWMgT1MgWCAxMF8xNV83KSBBcHBsZVdlYktpdC81MzcuMzYgKEtIVE1MLCBsaWtlIEdlY2tvKSBDaHJvbWUvMTQyLjAuMC4wIFNhZmFyaS81MzcuMzYnLFxyXG4gIE9yaWdpbjogJ2h0dHBzOi8vZGlnaXRhbC13ZWIuY2FsLW9ubGluZS5jby5pbCcsXHJcbiAgUmVmZXJlcjogJ2h0dHBzOi8vZGlnaXRhbC13ZWIuY2FsLW9ubGluZS5jby5pbCcsXHJcbiAgJ0FjY2VwdC1MYW5ndWFnZSc6ICdoZS1JTCxoZTtxPTAuOSxlbi1VUztxPTAuOCxlbjtxPTAuNycsXHJcbiAgJ1NlYy1GZXRjaC1TaXRlJzogJ3NhbWUtc2l0ZScsXHJcbiAgJ1NlYy1GZXRjaC1Nb2RlJzogJ2NvcnMnLFxyXG4gICdTZWMtRmV0Y2gtRGVzdCc6ICdlbXB0eScsXHJcbn07XHJcbmNvbnN0IExPR0lOX1VSTCA9ICdodHRwczovL3d3dy5jYWwtb25saW5lLmNvLmlsLyc7XHJcbmNvbnN0IFRSQU5TQUNUSU9OU19SRVFVRVNUX0VORFBPSU5UID1cclxuICAnaHR0cHM6Ly9hcGkuY2FsLW9ubGluZS5jby5pbC9UcmFuc2FjdGlvbnMvYXBpL3RyYW5zYWN0aW9uc0RldGFpbHMvZ2V0Q2FyZFRyYW5zYWN0aW9uc0RldGFpbHMnO1xyXG5jb25zdCBGUkFNRVNfUkVRVUVTVF9FTkRQT0lOVCA9ICdodHRwczovL2FwaS5jYWwtb25saW5lLmNvLmlsL0ZyYW1lcy9hcGkvRnJhbWVzL0dldEZyYW1lU3RhdHVzJztcclxuY29uc3QgUEVORElOR19UUkFOU0FDVElPTlNfUkVRVUVTVF9FTkRQT0lOVCA9XHJcbiAgJ2h0dHBzOi8vYXBpLmNhbC1vbmxpbmUuY28uaWwvVHJhbnNhY3Rpb25zL2FwaS9hcHByb3ZhbHMvZ2V0Q2xlYXJhbmNlUmVxdWVzdHMnO1xyXG5jb25zdCBTU09fQVVUSE9SSVpBVElPTl9SRVFVRVNUX0VORFBPSU5UID0gJ2h0dHBzOi8vY29ubmVjdC5jYWwtb25saW5lLmNvLmlsL2NvbC1yZXN0L2NhbGNvbm5lY3QvYXV0aGVudGljYXRpb24vU1NPJztcclxuXHJcbmNvbnN0IEludmFsaWRQYXNzd29yZE1lc3NhZ2UgPSAn16nXnSDXlNee16nXqtee16kg15DXlSDXlNeh15nXodee15Qg16nXlNeV15bXoNeVINep15LXldeZ15nXnSc7XHJcbmNvbnN0IENoYW5nZVBhc3N3b3JkTWVzc2FnZSA9ICfXnNeU15fXnNeZ16Mg16HXmdeh157XlCc7XHJcbmNvbnN0IENoYW5nZVBhc3N3b3JkU3VidGl0bGUgPSAn15TXkteZ16Ig15TXltee158g15zXodeZ16HXnteUINeX15PXqdeUJztcclxuY29uc3QgQ2hhbmdlUGFzc3dvcmRVcmwgPSAnL2NoYW5nZS1wYXNzd29yZCc7XHJcblxyXG5jb25zdCBkZWJ1ZyA9IGdldERlYnVnKCd2aXNhLWNhbCcpO1xyXG5cclxuZW51bSBUcm5UeXBlQ29kZSB7XHJcbiAgcmVndWxhciA9ICc1JyxcclxuICBjcmVkaXQgPSAnNicsXHJcbiAgaW5zdGFsbG1lbnRzID0gJzgnLFxyXG4gIHN0YW5kaW5nT3JkZXIgPSAnOScsXHJcbn1cclxuXHJcbmludGVyZmFjZSBTY3JhcGVkVHJhbnNhY3Rpb24ge1xyXG4gIGFtdEJlZm9yZUNvbnZBbmRJbmRleDogbnVtYmVyO1xyXG4gIGJyYW5jaENvZGVEZXNjOiBzdHJpbmc7XHJcbiAgY2FzaEFjY01hbmFnZXJOYW1lOiBudWxsO1xyXG4gIGNhc2hBY2NvdW50TWFuYWdlcjogbnVsbDtcclxuICBjYXNoQWNjb3VudFRybkFtdDogbnVtYmVyO1xyXG4gIGNoYXJnZUV4dGVybmFsVG9DYXJkQ29tbWVudDogc3RyaW5nO1xyXG4gIGNvbW1lbnRzOiBbXTtcclxuICBjdXJQYXltZW50TnVtOiBudW1iZXI7XHJcbiAgZGViQ3JkQ3VycmVuY3lTeW1ib2w6IEN1cnJlbmN5U3ltYm9sO1xyXG4gIGRlYkNyZERhdGU6IHN0cmluZztcclxuICBkZWJpdFNwcmVhZEluZDogYm9vbGVhbjtcclxuICBkaXNjb3VudEFtb3VudDogdW5rbm93bjtcclxuICBkaXNjb3VudFJlYXNvbjogdW5rbm93bjtcclxuICBpbW1lZGlhdGVDb21tZW50czogW107XHJcbiAgaXNJbW1lZGlhdGVDb21tZW50SW5kOiBib29sZWFuO1xyXG4gIGlzSW1tZWRpYXRlSEhLSW5kOiBib29sZWFuO1xyXG4gIGlzTWFyZ2FyaXRhOiBib29sZWFuO1xyXG4gIGlzU3ByZWFkUGF5bWVuc3RBYnJvYWQ6IGJvb2xlYW47XHJcbiAgbGlua2VkQ29tbWVudHM6IFtdO1xyXG4gIG1lcmNoYW50QWRkcmVzczogc3RyaW5nO1xyXG4gIG1lcmNoYW50TmFtZTogc3RyaW5nO1xyXG4gIG1lcmNoYW50UGhvbmVObzogc3RyaW5nO1xyXG4gIG51bU9mUGF5bWVudHM6IG51bWJlcjtcclxuICBvbkdvaW5nVHJhbnNhY3Rpb25zQ29tbWVudDogc3RyaW5nO1xyXG4gIHJlZnVuZEluZDogYm9vbGVhbjtcclxuICByb3VuZGluZ0Ftb3VudDogdW5rbm93bjtcclxuICByb3VuZGluZ1JlYXNvbjogdW5rbm93bjtcclxuICB0b2tlbkluZDogMDtcclxuICB0b2tlbk51bWJlclBhcnQ0OiAnJztcclxuICB0cmFuc0NhcmRQcmVzZW50SW5kOiBib29sZWFuO1xyXG4gIHRyYW5zVHlwZUNvbW1lbnREZXRhaWxzOiBbXTtcclxuICB0cm5BbXQ6IG51bWJlcjtcclxuICB0cm5DdXJyZW5jeVN5bWJvbDogQ3VycmVuY3lTeW1ib2w7XHJcbiAgdHJuRXhhY1dheTogbnVtYmVyO1xyXG4gIHRybkludElkOiBzdHJpbmc7XHJcbiAgdHJuTnVtYXJldG9yOiBudW1iZXI7XHJcbiAgdHJuUHVyY2hhc2VEYXRlOiBzdHJpbmc7XHJcbiAgdHJuVHlwZTogc3RyaW5nO1xyXG4gIHRyblR5cGVDb2RlOiBUcm5UeXBlQ29kZTtcclxuICB3YWxsZXRQcm92aWRlckNvZGU6IDA7XHJcbiAgd2FsbGV0UHJvdmlkZXJEZXNjOiAnJztcclxuICBlYXJseVBheW1lbnRJbmQ6IGJvb2xlYW47XHJcbn1cclxuaW50ZXJmYWNlIFNjcmFwZWRQZW5kaW5nVHJhbnNhY3Rpb24ge1xyXG4gIG1lcmNoYW50SUQ6IHN0cmluZztcclxuICBtZXJjaGFudE5hbWU6IHN0cmluZztcclxuICB0cm5QdXJjaGFzZURhdGU6IHN0cmluZztcclxuICB3YWxsZXRUcmFuSW5kOiBudW1iZXI7XHJcbiAgdHJhbnNhY3Rpb25zT3JpZ2luOiBudW1iZXI7XHJcbiAgdHJuQW10OiBudW1iZXI7XHJcbiAgdHBhQXBwcm92YWxBbW91bnQ6IHVua25vd247XHJcbiAgdHJuQ3VycmVuY3lTeW1ib2w6IEN1cnJlbmN5U3ltYm9sO1xyXG4gIHRyblR5cGVDb2RlOiBUcm5UeXBlQ29kZTtcclxuICB0cm5UeXBlOiBzdHJpbmc7XHJcbiAgYnJhbmNoQ29kZURlc2M6IHN0cmluZztcclxuICB0cmFuc0NhcmRQcmVzZW50SW5kOiBib29sZWFuO1xyXG4gIGo1SW5kaWNhdG9yOiBzdHJpbmc7XHJcbiAgbnVtYmVyT2ZQYXltZW50czogbnVtYmVyO1xyXG4gIGZpcnN0UGF5bWVudEFtb3VudDogbnVtYmVyO1xyXG4gIHRyYW5zVHlwZUNvbW1lbnREZXRhaWxzOiBbXTtcclxufVxyXG5pbnRlcmZhY2UgSW5pdFJlc3BvbnNlIHtcclxuICByZXN1bHQ6IHtcclxuICAgIGNhcmRzOiB7XHJcbiAgICAgIGNhcmRVbmlxdWVJZDogc3RyaW5nO1xyXG4gICAgICBsYXN0NERpZ2l0czogc3RyaW5nO1xyXG4gICAgICBba2V5OiBzdHJpbmddOiB1bmtub3duO1xyXG4gICAgfVtdO1xyXG4gIH07XHJcbn1cclxudHlwZSBDdXJyZW5jeVN5bWJvbCA9IHN0cmluZztcclxuaW50ZXJmYWNlIENhcmRUcmFuc2FjdGlvbkRldGFpbHNFcnJvciB7XHJcbiAgdGl0bGU6IHN0cmluZztcclxuICBzdGF0dXNDb2RlOiBudW1iZXI7XHJcbn1cclxuaW50ZXJmYWNlIENhcmRUcmFuc2FjdGlvbkRldGFpbHMgZXh0ZW5kcyBDYXJkVHJhbnNhY3Rpb25EZXRhaWxzRXJyb3Ige1xyXG4gIHJlc3VsdDoge1xyXG4gICAgYmFua0FjY291bnRzOiB7XHJcbiAgICAgIGJhbmtBY2NvdW50TnVtOiBzdHJpbmc7XHJcbiAgICAgIGJhbmtOYW1lOiBzdHJpbmc7XHJcbiAgICAgIGNob2ljZUV4dGVybmFsVHJhbnNhY3Rpb25zOiBhbnk7XHJcbiAgICAgIGN1cnJlbnRCYW5rQWNjb3VudEluZDogYm9vbGVhbjtcclxuICAgICAgZGViaXREYXRlczoge1xyXG4gICAgICAgIGJhc2tldEFtb3VudENvbW1lbnQ6IHVua25vd247XHJcbiAgICAgICAgY2hvaWNlSEhLRGViaXQ6IG51bWJlcjtcclxuICAgICAgICBkYXRlOiBzdHJpbmc7XHJcbiAgICAgICAgZGViaXRSZWFzb246IHVua25vd247XHJcbiAgICAgICAgZml4RGViaXRBbW91bnQ6IG51bWJlcjtcclxuICAgICAgICBmcm9tUHVyY2hhc2VEYXRlOiBzdHJpbmc7XHJcbiAgICAgICAgaXNDaG9pY2VSZXBhaW1lbnQ6IGJvb2xlYW47XHJcbiAgICAgICAgdG9QdXJjaGFzZURhdGU6IHN0cmluZztcclxuICAgICAgICB0b3RhbEJhc2tldEFtb3VudDogbnVtYmVyO1xyXG4gICAgICAgIHRvdGFsRGViaXRzOiB7XHJcbiAgICAgICAgICBjdXJyZW5jeVN5bWJvbDogQ3VycmVuY3lTeW1ib2w7XHJcbiAgICAgICAgICBhbW91bnQ6IG51bWJlcjtcclxuICAgICAgICB9W107XHJcbiAgICAgICAgdHJhbnNhY3Rpb25zOiBTY3JhcGVkVHJhbnNhY3Rpb25bXTtcclxuICAgICAgfVtdO1xyXG4gICAgICBpbW1pZGlhdGVEZWJpdHM6IHsgdG90YWxEZWJpdHM6IFtdOyBkZWJpdERheXM6IFtdIH07XHJcbiAgICB9W107XHJcbiAgICBibG9ja2VkQ2FyZEluZDogYm9vbGVhbjtcclxuICB9O1xyXG4gIHN0YXR1c0NvZGU6IDE7XHJcbiAgc3RhdHVzRGVzY3JpcHRpb246IHN0cmluZztcclxuICBzdGF0dXNUaXRsZTogc3RyaW5nO1xyXG59XHJcbmludGVyZmFjZSBDYXJkUGVuZGluZ1RyYW5zYWN0aW9uRGV0YWlscyBleHRlbmRzIENhcmRUcmFuc2FjdGlvbkRldGFpbHNFcnJvciB7XHJcbiAgcmVzdWx0OiB7XHJcbiAgICBjYXJkc0xpc3Q6IHtcclxuICAgICAgY2FyZFVuaXF1ZUlEOiBzdHJpbmc7XHJcbiAgICAgIGF1dGhEZXRhbGlzTGlzdDogU2NyYXBlZFBlbmRpbmdUcmFuc2FjdGlvbltdO1xyXG4gICAgfVtdO1xyXG4gIH07XHJcbiAgc3RhdHVzQ29kZTogMTtcclxuICBzdGF0dXNEZXNjcmlwdGlvbjogc3RyaW5nO1xyXG4gIHN0YXR1c1RpdGxlOiBzdHJpbmc7XHJcbn1cclxuXHJcbmludGVyZmFjZSBDYXJkTGV2ZWxGcmFtZSB7XHJcbiAgY2FyZFVuaXF1ZUlkOiBzdHJpbmc7XHJcbiAgbmV4dFRvdGFsRGViaXQ/OiBudW1iZXI7XHJcbn1cclxuXHJcbmludGVyZmFjZSBGcmFtZXNSZXNwb25zZSB7XHJcbiAgcmVzdWx0Pzoge1xyXG4gICAgYmFua0lzc3VlZENhcmRzPzoge1xyXG4gICAgICBjYXJkTGV2ZWxGcmFtZXM/OiBDYXJkTGV2ZWxGcmFtZVtdO1xyXG4gICAgfTtcclxuICB9O1xyXG59XHJcblxyXG5pbnRlcmZhY2UgQXV0aE1vZHVsZSB7XHJcbiAgYXV0aDoge1xyXG4gICAgY2FsQ29ubmVjdFRva2VuOiBzdHJpbmcgfCBudWxsO1xyXG4gIH07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGlzQXV0aE1vZHVsZShyZXN1bHQ6IGFueSk6IHJlc3VsdCBpcyBBdXRoTW9kdWxlIHtcclxuICByZXR1cm4gQm9vbGVhbihyZXN1bHQ/LmF1dGg/LmNhbENvbm5lY3RUb2tlbiAmJiBTdHJpbmcocmVzdWx0LmF1dGguY2FsQ29ubmVjdFRva2VuKS50cmltKCkpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBhdXRoTW9kdWxlT3JVbmRlZmluZWQocmVzdWx0OiBhbnkpOiBBdXRoTW9kdWxlIHwgdW5kZWZpbmVkIHtcclxuICByZXR1cm4gaXNBdXRoTW9kdWxlKHJlc3VsdCkgPyByZXN1bHQgOiB1bmRlZmluZWQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGlzUGVuZGluZyhcclxuICB0cmFuc2FjdGlvbjogU2NyYXBlZFRyYW5zYWN0aW9uIHwgU2NyYXBlZFBlbmRpbmdUcmFuc2FjdGlvbixcclxuKTogdHJhbnNhY3Rpb24gaXMgU2NyYXBlZFBlbmRpbmdUcmFuc2FjdGlvbiB7XHJcbiAgcmV0dXJuICh0cmFuc2FjdGlvbiBhcyBTY3JhcGVkVHJhbnNhY3Rpb24pLmRlYkNyZERhdGUgPT09IHVuZGVmaW5lZDsgLy8gYW4gYXJiaXRyYXJ5IGZpZWxkIHRoYXQgb25seSBhcHBlYXJzIGluIGEgY29tcGxldGVkIHRyYW5zYWN0aW9uXHJcbn1cclxuXHJcbmZ1bmN0aW9uIGlzQ2FyZFRyYW5zYWN0aW9uRGV0YWlscyhcclxuICByZXN1bHQ6IENhcmRUcmFuc2FjdGlvbkRldGFpbHMgfCBDYXJkVHJhbnNhY3Rpb25EZXRhaWxzRXJyb3IsXHJcbik6IHJlc3VsdCBpcyBDYXJkVHJhbnNhY3Rpb25EZXRhaWxzIHtcclxuICByZXR1cm4gKHJlc3VsdCBhcyBDYXJkVHJhbnNhY3Rpb25EZXRhaWxzKS5yZXN1bHQgIT09IHVuZGVmaW5lZDtcclxufVxyXG5cclxuZnVuY3Rpb24gaXNDYXJkUGVuZGluZ1RyYW5zYWN0aW9uRGV0YWlscyhcclxuICByZXN1bHQ6IENhcmRQZW5kaW5nVHJhbnNhY3Rpb25EZXRhaWxzIHwgQ2FyZFRyYW5zYWN0aW9uRGV0YWlsc0Vycm9yLFxyXG4pOiByZXN1bHQgaXMgQ2FyZFBlbmRpbmdUcmFuc2FjdGlvbkRldGFpbHMge1xyXG4gIHJldHVybiAocmVzdWx0IGFzIENhcmRQZW5kaW5nVHJhbnNhY3Rpb25EZXRhaWxzKS5yZXN1bHQgIT09IHVuZGVmaW5lZDtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gZ2V0TG9naW5GcmFtZShwYWdlOiBQYWdlKSB7XHJcbiAgbGV0IGZyYW1lOiBGcmFtZSB8IG51bGwgPSBudWxsO1xyXG4gIGRlYnVnKCd3YWl0IHVudGlsIGxvZ2luIGZyYW1lIGZvdW5kJyk7XHJcbiAgYXdhaXQgd2FpdFVudGlsKFxyXG4gICAgKCkgPT4ge1xyXG4gICAgICBmcmFtZSA9IHBhZ2UuZnJhbWVzKCkuZmluZChmID0+IGYudXJsKCkuaW5jbHVkZXMoJ2Nvbm5lY3QnKSkgfHwgbnVsbDtcclxuICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSghIWZyYW1lKTtcclxuICAgIH0sXHJcbiAgICAnd2FpdCBmb3IgaWZyYW1lIHdpdGggbG9naW4gZm9ybScsXHJcbiAgICAxMDAwMCxcclxuICAgIDEwMDAsXHJcbiAgKTtcclxuXHJcbiAgaWYgKCFmcmFtZSkge1xyXG4gICAgZGVidWcoJ2ZhaWxlZCB0byBmaW5kIGxvZ2luIGZyYW1lIGZvciAxMCBzZWNvbmRzJyk7XHJcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ2ZhaWxlZCB0byBleHRyYWN0IGxvZ2luIGlmcmFtZScpO1xyXG4gIH1cclxuXHJcbiAgcmV0dXJuIGZyYW1lO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBoYXNJbnZhbGlkUGFzc3dvcmRFcnJvcihwYWdlOiBQYWdlKSB7XHJcbiAgY29uc3QgZnJhbWUgPSBhd2FpdCBnZXRMb2dpbkZyYW1lKHBhZ2UpO1xyXG4gIGNvbnN0IGVycm9yRm91bmQgPSBhd2FpdCBlbGVtZW50UHJlc2VudE9uUGFnZShmcmFtZSwgJ2Rpdi5nZW5lcmFsLWVycm9yID4gZGl2Jyk7XHJcbiAgY29uc3QgZXJyb3JNZXNzYWdlID0gZXJyb3JGb3VuZFxyXG4gICAgPyBhd2FpdCBwYWdlRXZhbChmcmFtZSwgJ2Rpdi5nZW5lcmFsLWVycm9yID4gZGl2JywgJycsIGl0ZW0gPT4ge1xyXG4gICAgICAgIHJldHVybiAoaXRlbSBhcyBIVE1MRGl2RWxlbWVudCkuaW5uZXJUZXh0O1xyXG4gICAgICB9KVxyXG4gICAgOiAnJztcclxuICByZXR1cm4gZXJyb3JNZXNzYWdlID09PSBJbnZhbGlkUGFzc3dvcmRNZXNzYWdlO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBoYXNDaGFuZ2VQYXNzd29yZEZvcm0ocGFnZTogUGFnZSkge1xyXG4gIC8vIENoZWNrIGlmIGFueSBmcmFtZSBuYXZpZ2F0ZWQgdG8gdGhlIGNoYW5nZS1wYXNzd29yZCByb3V0ZVxyXG4gIGNvbnN0IGNoYW5nZVBhc3N3b3JkRnJhbWUgPSBwYWdlLmZyYW1lcygpLmZpbmQoZiA9PiB7XHJcbiAgICBjb25zdCB1cmwgPSBmLnVybCgpO1xyXG4gICAgcmV0dXJuIHVybC5pbmNsdWRlcygnY29ubmVjdC5jYWwtb25saW5lLmNvLmlsJykgJiYgdXJsLmluY2x1ZGVzKENoYW5nZVBhc3N3b3JkVXJsKTtcclxuICB9KTtcclxuICBpZiAoY2hhbmdlUGFzc3dvcmRGcmFtZSkge1xyXG4gICAgcmV0dXJuIHRydWU7XHJcbiAgfVxyXG5cclxuICB0cnkge1xyXG4gICAgY29uc3QgZnJhbWUgPSBhd2FpdCBnZXRMb2dpbkZyYW1lKHBhZ2UpO1xyXG5cclxuICAgIC8vIENoZWNrIGZvciB0aGUgY2hhbmdlLXBhc3N3b3JkIEFuZ3VsYXIgY29tcG9uZW50XHJcbiAgICBpZiAoYXdhaXQgZWxlbWVudFByZXNlbnRPblBhZ2UoZnJhbWUsICdjaGFuZ2UtcGFzc3dvcmQnKSkge1xyXG4gICAgICByZXR1cm4gdHJ1ZTtcclxuICAgIH1cclxuXHJcbiAgICAvLyBDaGVjayBmb3IgdGhlIGNoYW5nZSBwYXNzd29yZCB0aXRsZSBlbGVtZW50XHJcbiAgICBpZiAoYXdhaXQgZWxlbWVudFByZXNlbnRPblBhZ2UoZnJhbWUsICcuY2hhbmdlLXBhc3N3b3JkLXRpdGxlJykpIHtcclxuICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICB9XHJcblxyXG4gICAgLy8gQ2hlY2sgZm9yIHRoZSBjaGFuZ2UgcGFzc3dvcmQgc3VidGl0bGUgdGV4dFxyXG4gICAgaWYgKGF3YWl0IGVsZW1lbnRQcmVzZW50T25QYWdlKGZyYW1lLCAnLmNoYW5nZS1wYXNzd29yZC1zdWJ0aXRsZScpKSB7XHJcbiAgICAgIGNvbnN0IHN1YnRpdGxlVGV4dCA9IGF3YWl0IHBhZ2VFdmFsKGZyYW1lLCAnLmNoYW5nZS1wYXNzd29yZC1zdWJ0aXRsZScsICcnLCBpdGVtID0+IHtcclxuICAgICAgICByZXR1cm4gKGl0ZW0gYXMgSFRNTEVsZW1lbnQpLmlubmVyVGV4dC50cmltKCk7XHJcbiAgICAgIH0pO1xyXG4gICAgICBpZiAoc3VidGl0bGVUZXh0LmluY2x1ZGVzKENoYW5nZVBhc3N3b3JkU3VidGl0bGUpKSB7XHJcbiAgICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICAvLyBMZWdhY3k6IGNoZWNrIGZvciB0aGUgb2xkIC5lcnItZGVzYyBiYXNlZCBjaGFuZ2UgcGFzc3dvcmQgbWVzc2FnZVxyXG4gICAgY29uc3QgZXJyb3JGb3VuZCA9IGF3YWl0IGVsZW1lbnRQcmVzZW50T25QYWdlKGZyYW1lLCAnLmVyci1kZXNjJyk7XHJcbiAgICBpZiAoZXJyb3JGb3VuZCkge1xyXG4gICAgICBjb25zdCBlcnJUZXh0ID0gYXdhaXQgcGFnZUV2YWwoZnJhbWUsICcuZXJyLWRlc2MnLCAnJywgaXRlbSA9PiB7XHJcbiAgICAgICAgcmV0dXJuIChpdGVtIGFzIEhUTUxFbGVtZW50KS5pbm5lclRleHQudHJpbSgpO1xyXG4gICAgICB9KTtcclxuICAgICAgcmV0dXJuIGVyclRleHQuaW5jbHVkZXMoQ2hhbmdlUGFzc3dvcmRNZXNzYWdlKTtcclxuICAgIH1cclxuICB9IGNhdGNoIChlKSB7XHJcbiAgICBkZWJ1ZygnZmFpbGVkIHRvIGNoZWNrIGNoYW5nZSBwYXNzd29yZCBmb3JtIGluIGxvZ2luIGZyYW1lOiAlcycsIChlIGFzIEVycm9yKS5tZXNzYWdlKTtcclxuICB9XHJcbiAgcmV0dXJuIGZhbHNlO1xyXG59XHJcblxyXG5mdW5jdGlvbiBnZXRQb3NzaWJsZUxvZ2luUmVzdWx0cygpIHtcclxuICBkZWJ1ZygncmV0dXJuIHBvc3NpYmxlIGxvZ2luIHJlc3VsdHMnKTtcclxuICBjb25zdCB1cmxzOiBMb2dpbk9wdGlvbnNbJ3Bvc3NpYmxlUmVzdWx0cyddID0ge1xyXG4gICAgW0xvZ2luUmVzdWx0cy5TdWNjZXNzXTogWy9kYXNoYm9hcmQvaV0sXHJcbiAgICBbTG9naW5SZXN1bHRzLkludmFsaWRQYXNzd29yZF06IFtcclxuICAgICAgYXN5bmMgKG9wdGlvbnM/OiB7IHBhZ2U/OiBQYWdlIH0pID0+IHtcclxuICAgICAgICBjb25zdCBwYWdlID0gb3B0aW9ucz8ucGFnZTtcclxuICAgICAgICBpZiAoIXBhZ2UpIHtcclxuICAgICAgICAgIHJldHVybiBmYWxzZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIGhhc0ludmFsaWRQYXNzd29yZEVycm9yKHBhZ2UpO1xyXG4gICAgICB9LFxyXG4gICAgXSxcclxuICAgIC8vIFtMb2dpblJlc3VsdHMuQWNjb3VudEJsb2NrZWRdOiBbXSwgLy8gVE9ETyBhZGQgd2hlbiByZWFjaGluZyB0aGlzIHNjZW5hcmlvXHJcbiAgICBbTG9naW5SZXN1bHRzLkNoYW5nZVBhc3N3b3JkXTogW1xyXG4gICAgICBhc3luYyAob3B0aW9ucz86IHsgcGFnZT86IFBhZ2UgfSkgPT4ge1xyXG4gICAgICAgIGNvbnN0IHBhZ2UgPSBvcHRpb25zPy5wYWdlO1xyXG4gICAgICAgIGlmICghcGFnZSkge1xyXG4gICAgICAgICAgcmV0dXJuIGZhbHNlO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4gaGFzQ2hhbmdlUGFzc3dvcmRGb3JtKHBhZ2UpO1xyXG4gICAgICB9LFxyXG4gICAgXSxcclxuICB9O1xyXG4gIHJldHVybiB1cmxzO1xyXG59XHJcblxyXG5mdW5jdGlvbiBjcmVhdGVMb2dpbkZpZWxkcyhjcmVkZW50aWFsczogU2NyYXBlclNwZWNpZmljQ3JlZGVudGlhbHMpIHtcclxuICBkZWJ1ZygnY3JlYXRlIGxvZ2luIGZpZWxkcyBmb3IgdXNlcm5hbWUgYW5kIHBhc3N3b3JkJyk7XHJcbiAgcmV0dXJuIFtcclxuICAgIHsgc2VsZWN0b3I6ICdbZm9ybWNvbnRyb2xuYW1lPVwidXNlck5hbWVcIl0nLCB2YWx1ZTogY3JlZGVudGlhbHMudXNlcm5hbWUgfSxcclxuICAgIHsgc2VsZWN0b3I6ICdbZm9ybWNvbnRyb2xuYW1lPVwicGFzc3dvcmRcIl0nLCB2YWx1ZTogY3JlZGVudGlhbHMucGFzc3dvcmQgfSxcclxuICBdO1xyXG59XHJcblxyXG5mdW5jdGlvbiBjb252ZXJ0UGFyc2VkRGF0YVRvVHJhbnNhY3Rpb25zKFxyXG4gIGRhdGE6IENhcmRUcmFuc2FjdGlvbkRldGFpbHNbXSxcclxuICBwZW5kaW5nRGF0YT86IENhcmRQZW5kaW5nVHJhbnNhY3Rpb25EZXRhaWxzIHwgbnVsbCxcclxuICBvcHRpb25zPzogU2NyYXBlck9wdGlvbnMsXHJcbik6IFRyYW5zYWN0aW9uW10ge1xyXG4gIGNvbnN0IHBlbmRpbmdUcmFuc2FjdGlvbnMgPSBwZW5kaW5nRGF0YT8ucmVzdWx0XHJcbiAgICA/IHBlbmRpbmdEYXRhLnJlc3VsdC5jYXJkc0xpc3QuZmxhdE1hcChjYXJkID0+IGNhcmQuYXV0aERldGFsaXNMaXN0KVxyXG4gICAgOiBbXTtcclxuXHJcbiAgY29uc3QgYmFua0FjY291bnRzID0gZGF0YS5mbGF0TWFwKG1vbnRoRGF0YSA9PiBtb250aERhdGEucmVzdWx0LmJhbmtBY2NvdW50cyk7XHJcbiAgY29uc3QgcmVndWxhckRlYml0RGF5cyA9IGJhbmtBY2NvdW50cy5mbGF0TWFwKGFjY291bnRzID0+IGFjY291bnRzLmRlYml0RGF0ZXMpO1xyXG4gIGNvbnN0IGltbWVkaWF0ZURlYml0RGF5cyA9IGJhbmtBY2NvdW50cy5mbGF0TWFwKGFjY291bnRzID0+IGFjY291bnRzLmltbWlkaWF0ZURlYml0cy5kZWJpdERheXMpO1xyXG4gIGNvbnN0IGNvbXBsZXRlZFRyYW5zYWN0aW9ucyA9IFsuLi5yZWd1bGFyRGViaXREYXlzLCAuLi5pbW1lZGlhdGVEZWJpdERheXNdLmZsYXRNYXAoXHJcbiAgICBkZWJpdERhdGUgPT4gZGViaXREYXRlLnRyYW5zYWN0aW9ucyxcclxuICApO1xyXG5cclxuICBjb25zdCBhbGw6IChTY3JhcGVkVHJhbnNhY3Rpb24gfCBTY3JhcGVkUGVuZGluZ1RyYW5zYWN0aW9uKVtdID0gWy4uLnBlbmRpbmdUcmFuc2FjdGlvbnMsIC4uLmNvbXBsZXRlZFRyYW5zYWN0aW9uc107XHJcblxyXG4gIHJldHVybiBhbGwubWFwKHRyYW5zYWN0aW9uID0+IHtcclxuICAgIGNvbnN0IG51bU9mUGF5bWVudHMgPSBpc1BlbmRpbmcodHJhbnNhY3Rpb24pID8gdHJhbnNhY3Rpb24ubnVtYmVyT2ZQYXltZW50cyA6IHRyYW5zYWN0aW9uLm51bU9mUGF5bWVudHM7XHJcbiAgICBjb25zdCBpbnN0YWxsbWVudHMgPSBudW1PZlBheW1lbnRzXHJcbiAgICAgID8ge1xyXG4gICAgICAgICAgbnVtYmVyOiBpc1BlbmRpbmcodHJhbnNhY3Rpb24pID8gMSA6IHRyYW5zYWN0aW9uLmN1clBheW1lbnROdW0sXHJcbiAgICAgICAgICB0b3RhbDogbnVtT2ZQYXltZW50cyxcclxuICAgICAgICB9XHJcbiAgICAgIDogdW5kZWZpbmVkO1xyXG5cclxuICAgIGNvbnN0IGRhdGUgPSBtb21lbnQodHJhbnNhY3Rpb24udHJuUHVyY2hhc2VEYXRlKTtcclxuXHJcbiAgICBjb25zdCBjaGFyZ2VkQW1vdW50ID0gKGlzUGVuZGluZyh0cmFuc2FjdGlvbikgPyB0cmFuc2FjdGlvbi50cm5BbXQgOiB0cmFuc2FjdGlvbi5hbXRCZWZvcmVDb252QW5kSW5kZXgpICogLTE7XHJcbiAgICBjb25zdCBvcmlnaW5hbEFtb3VudCA9IHRyYW5zYWN0aW9uLnRybkFtdCAqICh0cmFuc2FjdGlvbi50cm5UeXBlQ29kZSA9PT0gVHJuVHlwZUNvZGUuY3JlZGl0ID8gMSA6IC0xKTtcclxuXHJcbiAgICBjb25zdCByZXN1bHQ6IFRyYW5zYWN0aW9uID0ge1xyXG4gICAgICBpZGVudGlmaWVyOiAhaXNQZW5kaW5nKHRyYW5zYWN0aW9uKSA/IHRyYW5zYWN0aW9uLnRybkludElkIDogdW5kZWZpbmVkLFxyXG4gICAgICB0eXBlOiBbVHJuVHlwZUNvZGUucmVndWxhciwgVHJuVHlwZUNvZGUuc3RhbmRpbmdPcmRlcl0uaW5jbHVkZXModHJhbnNhY3Rpb24udHJuVHlwZUNvZGUpXHJcbiAgICAgICAgPyBUcmFuc2FjdGlvblR5cGVzLk5vcm1hbFxyXG4gICAgICAgIDogVHJhbnNhY3Rpb25UeXBlcy5JbnN0YWxsbWVudHMsXHJcbiAgICAgIHN0YXR1czogaXNQZW5kaW5nKHRyYW5zYWN0aW9uKSA/IFRyYW5zYWN0aW9uU3RhdHVzZXMuUGVuZGluZyA6IFRyYW5zYWN0aW9uU3RhdHVzZXMuQ29tcGxldGVkLFxyXG4gICAgICBkYXRlOiBpbnN0YWxsbWVudHMgPyBkYXRlLmFkZChpbnN0YWxsbWVudHMubnVtYmVyIC0gMSwgJ21vbnRoJykudG9JU09TdHJpbmcoKSA6IGRhdGUudG9JU09TdHJpbmcoKSxcclxuICAgICAgcHJvY2Vzc2VkRGF0ZTogaXNQZW5kaW5nKHRyYW5zYWN0aW9uKSA/IGRhdGUudG9JU09TdHJpbmcoKSA6IG5ldyBEYXRlKHRyYW5zYWN0aW9uLmRlYkNyZERhdGUpLnRvSVNPU3RyaW5nKCksXHJcbiAgICAgIG9yaWdpbmFsQW1vdW50LFxyXG4gICAgICBvcmlnaW5hbEN1cnJlbmN5OiB0cmFuc2FjdGlvbi50cm5DdXJyZW5jeVN5bWJvbCxcclxuICAgICAgY2hhcmdlZEFtb3VudCxcclxuICAgICAgY2hhcmdlZEN1cnJlbmN5OiAhaXNQZW5kaW5nKHRyYW5zYWN0aW9uKSA/IHRyYW5zYWN0aW9uLmRlYkNyZEN1cnJlbmN5U3ltYm9sIDogdW5kZWZpbmVkLFxyXG4gICAgICBkZXNjcmlwdGlvbjogdHJhbnNhY3Rpb24ubWVyY2hhbnROYW1lLFxyXG4gICAgICBtZW1vOiB0cmFuc2FjdGlvbi50cmFuc1R5cGVDb21tZW50RGV0YWlscy50b1N0cmluZygpLFxyXG4gICAgICBjYXRlZ29yeTogdHJhbnNhY3Rpb24uYnJhbmNoQ29kZURlc2MsXHJcbiAgICB9O1xyXG5cclxuICAgIGlmIChpbnN0YWxsbWVudHMpIHtcclxuICAgICAgcmVzdWx0Lmluc3RhbGxtZW50cyA9IGluc3RhbGxtZW50cztcclxuICAgIH1cclxuXHJcbiAgICBpZiAob3B0aW9ucz8uaW5jbHVkZVJhd1RyYW5zYWN0aW9uKSB7XHJcbiAgICAgIHJlc3VsdC5yYXdUcmFuc2FjdGlvbiA9IGdldFJhd1RyYW5zYWN0aW9uKHRyYW5zYWN0aW9uKTtcclxuICAgIH1cclxuXHJcbiAgICByZXR1cm4gcmVzdWx0O1xyXG4gIH0pO1xyXG59XHJcblxyXG50eXBlIFNjcmFwZXJTcGVjaWZpY0NyZWRlbnRpYWxzID0geyB1c2VybmFtZTogc3RyaW5nOyBwYXNzd29yZDogc3RyaW5nIH07XHJcblxyXG5jbGFzcyBWaXNhQ2FsU2NyYXBlciBleHRlbmRzIEJhc2VTY3JhcGVyV2l0aEJyb3dzZXI8U2NyYXBlclNwZWNpZmljQ3JlZGVudGlhbHM+IHtcclxuICBwcml2YXRlIGF1dGhvcml6YXRpb246IHN0cmluZyB8IHVuZGVmaW5lZCA9IHVuZGVmaW5lZDtcclxuXHJcbiAgcHJpdmF0ZSBhdXRoUmVxdWVzdFByb21pc2U6IFByb21pc2U8SFRUUFJlcXVlc3QgfCB1bmRlZmluZWQ+IHwgdW5kZWZpbmVkO1xyXG5cclxuICBvcGVuTG9naW5Qb3B1cCA9IGFzeW5jICgpID0+IHtcclxuICAgIGRlYnVnKCdvcGVuIGxvZ2luIHBvcHVwLCB3YWl0IHVudGlsIGxvZ2luIGJ1dHRvbiBhdmFpbGFibGUnKTtcclxuICAgIGF3YWl0IHdhaXRVbnRpbEVsZW1lbnRGb3VuZCh0aGlzLnBhZ2UsICcjY2NMb2dpbkRlc2t0b3BCdG4nLCB0cnVlKTtcclxuICAgIGRlYnVnKCdjbGljayBvbiB0aGUgbG9naW4gYnV0dG9uJyk7XHJcbiAgICBhd2FpdCBjbGlja0J1dHRvbih0aGlzLnBhZ2UsICcjY2NMb2dpbkRlc2t0b3BCdG4nKTtcclxuICAgIGRlYnVnKCdnZXQgdGhlIGZyYW1lIHRoYXQgaG9sZHMgdGhlIGxvZ2luJyk7XHJcbiAgICBjb25zdCBmcmFtZSA9IGF3YWl0IGdldExvZ2luRnJhbWUodGhpcy5wYWdlKTtcclxuICAgIGRlYnVnKCd3YWl0IHVudGlsIHRoZSBwYXNzd29yZCBsb2dpbiB0YWIgaGVhZGVyIGlzIGF2YWlsYWJsZScpO1xyXG4gICAgYXdhaXQgd2FpdFVudGlsRWxlbWVudEZvdW5kKGZyYW1lLCAnI3JlZ3VsYXItbG9naW4nKTtcclxuICAgIGRlYnVnKCduYXZpZ2F0ZSB0byB0aGUgcGFzc3dvcmQgbG9naW4gdGFiJyk7XHJcbiAgICBhd2FpdCBjbGlja0J1dHRvbihmcmFtZSwgJyNyZWd1bGFyLWxvZ2luJyk7XHJcbiAgICBkZWJ1Zygnd2FpdCB1bnRpbCB0aGUgcGFzc3dvcmQgbG9naW4gdGFiIGlzIGFjdGl2ZScpO1xyXG4gICAgYXdhaXQgd2FpdFVudGlsRWxlbWVudEZvdW5kKGZyYW1lLCAncmVndWxhci1sb2dpbicpO1xyXG5cclxuICAgIHJldHVybiBmcmFtZTtcclxuICB9O1xyXG5cclxuICBhc3luYyBnZXRDYXJkcygpIHtcclxuICAgIGNvbnN0IGluaXREYXRhID0gYXdhaXQgd2FpdFVudGlsKFxyXG4gICAgICAoKSA9PiBnZXRGcm9tU2Vzc2lvblN0b3JhZ2U8SW5pdFJlc3BvbnNlPih0aGlzLnBhZ2UsICdpbml0JyksXHJcbiAgICAgICdnZXQgaW5pdCBkYXRhIGluIHNlc3Npb24gc3RvcmFnZScsXHJcbiAgICAgIDEwMDAwLFxyXG4gICAgICAxMDAwLFxyXG4gICAgKTtcclxuICAgIGlmICghaW5pdERhdGEpIHtcclxuICAgICAgdGhyb3cgbmV3IEVycm9yKCdjb3VsZCBub3QgZmluZCBcImluaXRcIiBkYXRhIGluIHNlc3Npb24gc3RvcmFnZScpO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGluaXREYXRhPy5yZXN1bHQuY2FyZHMubWFwKCh7IGNhcmRVbmlxdWVJZCwgbGFzdDREaWdpdHMgfSkgPT4gKHsgY2FyZFVuaXF1ZUlkLCBsYXN0NERpZ2l0cyB9KSk7XHJcbiAgfVxyXG5cclxuICBhc3luYyBnZXRBdXRob3JpemF0aW9uSGVhZGVyKCkge1xyXG4gICAgaWYgKCF0aGlzLmF1dGhvcml6YXRpb24pIHtcclxuICAgICAgZGVidWcoJ2ZldGNoaW5nIGF1dGhvcml6YXRpb24gaGVhZGVyJyk7XHJcbiAgICAgIGNvbnN0IGF1dGhNb2R1bGUgPSBhd2FpdCB3YWl0VW50aWwoXHJcbiAgICAgICAgYXN5bmMgKCkgPT4gYXV0aE1vZHVsZU9yVW5kZWZpbmVkKGF3YWl0IGdldEZyb21TZXNzaW9uU3RvcmFnZTxBdXRoTW9kdWxlPih0aGlzLnBhZ2UsICdhdXRoLW1vZHVsZScpKSxcclxuICAgICAgICAnZ2V0IGF1dGhvcml6YXRpb24gaGVhZGVyIHdpdGggdmFsaWQgdG9rZW4gaW4gc2Vzc2lvbiBzdG9yYWdlJyxcclxuICAgICAgICAxMF8wMDAsXHJcbiAgICAgICAgNTAsXHJcbiAgICAgICk7XHJcbiAgICAgIHJldHVybiBgQ0FMQXV0aFNjaGVtZSAke2F1dGhNb2R1bGUuYXV0aC5jYWxDb25uZWN0VG9rZW59YDtcclxuICAgIH1cclxuICAgIHJldHVybiB0aGlzLmF1dGhvcml6YXRpb247XHJcbiAgfVxyXG5cclxuICBhc3luYyBnZXRYU2l0ZUlkKCkge1xyXG4gICAgLypcclxuICAgICAgSSBkb24ndCBrbm93IGlmIHRoZSBjb25zdGFudCBiZWxvdyB3aWxsIGNoYW5nZSBpbiB0aGUgZmVhdHVyZS5cclxuICAgICAgSWYgc28sIHVzZSB0aGUgbmV4dCBjb2RlOlxyXG5cclxuICAgICAgcmV0dXJuIHRoaXMucGFnZS5ldmFsdWF0ZSgoKSA9PiBuZXcgVXQoKS54U2l0ZUlkKTtcclxuXHJcbiAgICAgIFRvIGdldCB0aGUgY2xhc3NuYW1lIHNlYXJjaCBmb3IgJ3hTaXRlSWQnIGluIHRoZSBwYWdlIHNvdXJjZVxyXG4gICAgICBjbGFzcyBVdCB7XHJcbiAgICAgICAgY29uc3RydWN0b3IoX2UsIG9uLCB5bikge1xyXG4gICAgICAgICAgICB0aGlzLnN0b3JlID0gX2UsXHJcbiAgICAgICAgICAgIHRoaXMuY29uZmlnID0gb24sXHJcbiAgICAgICAgICAgIHRoaXMuZXZlbnRCdXNTZXJ2aWNlID0geW4sXHJcbiAgICAgICAgICAgIHRoaXMueFNpdGVJZCA9IFwiMDkwMzE5ODctMjczRS0yMzExLTkwNkMtOEFGODVCMTdDOEQ5XCIsXHJcbiAgICAqL1xyXG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgnMDkwMzE5ODctMjczRS0yMzExLTkwNkMtOEFGODVCMTdDOEQ5Jyk7XHJcbiAgfVxyXG5cclxuICBnZXRMb2dpbk9wdGlvbnMoY3JlZGVudGlhbHM6IFNjcmFwZXJTcGVjaWZpY0NyZWRlbnRpYWxzKTogTG9naW5PcHRpb25zIHtcclxuICAgIHRoaXMuYXV0aFJlcXVlc3RQcm9taXNlID0gdGhpcy5wYWdlXHJcbiAgICAgIC53YWl0Rm9yUmVxdWVzdChTU09fQVVUSE9SSVpBVElPTl9SRVFVRVNUX0VORFBPSU5ULCB7IHRpbWVvdXQ6IDEwXzAwMCB9KVxyXG4gICAgICAuY2F0Y2goZSA9PiB7XHJcbiAgICAgICAgZGVidWcoJ2Vycm9yIHdoaWxlIHdhaXRpbmcgZm9yIHRoZSB0b2tlbiByZXF1ZXN0JywgZSk7XHJcbiAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgICAgfSk7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICBsb2dpblVybDogYCR7TE9HSU5fVVJMfWAsXHJcbiAgICAgIGZpZWxkczogY3JlYXRlTG9naW5GaWVsZHMoY3JlZGVudGlhbHMpLFxyXG4gICAgICBzdWJtaXRCdXR0b25TZWxlY3RvcjogJ2J1dHRvblt0eXBlPVwic3VibWl0XCJdJyxcclxuICAgICAgcG9zc2libGVSZXN1bHRzOiBnZXRQb3NzaWJsZUxvZ2luUmVzdWx0cygpLFxyXG4gICAgICBjaGVja1JlYWRpbmVzczogYXN5bmMgKCkgPT4gd2FpdFVudGlsRWxlbWVudEZvdW5kKHRoaXMucGFnZSwgJyNjY0xvZ2luRGVza3RvcEJ0bicpLFxyXG4gICAgICBwcmVBY3Rpb246IHRoaXMub3BlbkxvZ2luUG9wdXAsXHJcbiAgICAgIHBvc3RBY3Rpb246IGFzeW5jICgpID0+IHtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgYXdhaXQgd2FpdEZvck5hdmlnYXRpb24odGhpcy5wYWdlKTtcclxuICAgICAgICAgIGNvbnN0IGN1cnJlbnRVcmwgPSBhd2FpdCBnZXRDdXJyZW50VXJsKHRoaXMucGFnZSk7XHJcbiAgICAgICAgICBpZiAoY3VycmVudFVybC5lbmRzV2l0aCgnc2l0ZS10dXRvcmlhbCcpKSB7XHJcbiAgICAgICAgICAgIGF3YWl0IGNsaWNrQnV0dG9uKHRoaXMucGFnZSwgJ2J1dHRvbi5idG4tY2xvc2UnKTtcclxuICAgICAgICAgIH1cclxuICAgICAgICAgIGNvbnN0IHJlcXVlc3QgPSBhd2FpdCB0aGlzLmF1dGhSZXF1ZXN0UHJvbWlzZTtcclxuICAgICAgICAgIHRoaXMuYXV0aG9yaXphdGlvbiA9IFN0cmluZyhyZXF1ZXN0Py5oZWFkZXJzKCkuYXV0aG9yaXphdGlvbiB8fCAnJykudHJpbSgpO1xyXG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcclxuICAgICAgICAgIGNvbnN0IGN1cnJlbnRVcmwgPSBhd2FpdCBnZXRDdXJyZW50VXJsKHRoaXMucGFnZSk7XHJcbiAgICAgICAgICBpZiAoY3VycmVudFVybC5lbmRzV2l0aCgnZGFzaGJvYXJkJykpIHJldHVybjtcclxuICAgICAgICAgIGNvbnN0IHJlcXVpcmVzQ2hhbmdlUGFzc3dvcmQgPSBhd2FpdCBoYXNDaGFuZ2VQYXNzd29yZEZvcm0odGhpcy5wYWdlKTtcclxuICAgICAgICAgIGlmIChyZXF1aXJlc0NoYW5nZVBhc3N3b3JkKSByZXR1cm47XHJcbiAgICAgICAgICB0aHJvdyBlO1xyXG4gICAgICAgIH1cclxuICAgICAgfSxcclxuICAgICAgdXNlckFnZW50OiBhcGlIZWFkZXJzWydVc2VyLUFnZW50J10sXHJcbiAgICB9O1xyXG4gIH1cclxuXHJcbiAgYXN5bmMgZmV0Y2hEYXRhKCk6IFByb21pc2U8U2NyYXBlclNjcmFwaW5nUmVzdWx0PiB7XHJcbiAgICBjb25zdCBkZWZhdWx0U3RhcnRNb21lbnQgPSBtb21lbnQoKS5zdWJ0cmFjdCgxLCAneWVhcnMnKS5zdWJ0cmFjdCg2LCAnbW9udGhzJykuYWRkKDEsICdkYXknKTtcclxuICAgIGNvbnN0IHN0YXJ0RGF0ZSA9IHRoaXMub3B0aW9ucy5zdGFydERhdGUgfHwgZGVmYXVsdFN0YXJ0TW9tZW50LnRvRGF0ZSgpO1xyXG4gICAgY29uc3Qgc3RhcnRNb21lbnQgPSBtb21lbnQubWF4KGRlZmF1bHRTdGFydE1vbWVudCwgbW9tZW50KHN0YXJ0RGF0ZSkpO1xyXG4gICAgZGVidWcoYGZldGNoIHRyYW5zYWN0aW9ucyBzdGFydGluZyAke3N0YXJ0TW9tZW50LmZvcm1hdCgpfWApO1xyXG5cclxuICAgIGNvbnN0IFtjYXJkcywgeFNpdGVJZCwgQXV0aG9yaXphdGlvbl0gPSBhd2FpdCBQcm9taXNlLmFsbChbXHJcbiAgICAgIHRoaXMuZ2V0Q2FyZHMoKSxcclxuICAgICAgdGhpcy5nZXRYU2l0ZUlkKCksXHJcbiAgICAgIHRoaXMuZ2V0QXV0aG9yaXphdGlvbkhlYWRlcigpLFxyXG4gICAgXSk7XHJcblxyXG4gICAgY29uc3QgZnV0dXJlTW9udGhzVG9TY3JhcGUgPSB0aGlzLm9wdGlvbnMuZnV0dXJlTW9udGhzVG9TY3JhcGUgPz8gMTtcclxuXHJcbiAgICBkZWJ1ZygnZmV0Y2ggZnJhbWVzIChtaXNnYXJvdCkgb2YgY2FyZHMnKTtcclxuICAgIGNvbnN0IGZyYW1lcyA9IGF3YWl0IGZldGNoUG9zdDxGcmFtZXNSZXNwb25zZT4oXHJcbiAgICAgIEZSQU1FU19SRVFVRVNUX0VORFBPSU5ULFxyXG4gICAgICB7IGNhcmRzRm9yRnJhbWVEYXRhOiBjYXJkcy5tYXAoKHsgY2FyZFVuaXF1ZUlkIH0pID0+ICh7IGNhcmRVbmlxdWVJZCB9KSkgfSxcclxuICAgICAge1xyXG4gICAgICAgIEF1dGhvcml6YXRpb24sXHJcbiAgICAgICAgJ1gtU2l0ZS1JZCc6IHhTaXRlSWQsXHJcbiAgICAgICAgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyxcclxuICAgICAgICAuLi5hcGlIZWFkZXJzLFxyXG4gICAgICB9LFxyXG4gICAgKTtcclxuXHJcbiAgICBjb25zdCBhY2NvdW50cyA9IGF3YWl0IFByb21pc2UuYWxsKFxyXG4gICAgICBjYXJkcy5tYXAoYXN5bmMgY2FyZCA9PiB7XHJcbiAgICAgICAgY29uc3QgZmluYWxNb250aFRvRmV0Y2hNb21lbnQgPSBtb21lbnQoKS5hZGQoZnV0dXJlTW9udGhzVG9TY3JhcGUsICdtb250aCcpO1xyXG4gICAgICAgIGNvbnN0IG1vbnRocyA9IGZpbmFsTW9udGhUb0ZldGNoTW9tZW50LmRpZmYoc3RhcnRNb21lbnQsICdtb250aHMnKTtcclxuICAgICAgICBjb25zdCBhbGxNb250aHNEYXRhOiBDYXJkVHJhbnNhY3Rpb25EZXRhaWxzW10gPSBbXTtcclxuICAgICAgICBjb25zdCBmcmFtZSA9IGZyYW1lcy5yZXN1bHQ/LmJhbmtJc3N1ZWRDYXJkcz8uY2FyZExldmVsRnJhbWVzPy5maW5kKFxyXG4gICAgICAgICAgKGY6IENhcmRMZXZlbEZyYW1lKSA9PiBmLmNhcmRVbmlxdWVJZCA9PT0gY2FyZC5jYXJkVW5pcXVlSWQsXHJcbiAgICAgICAgKTtcclxuXHJcbiAgICAgICAgZGVidWcoYGZldGNoIHBlbmRpbmcgdHJhbnNhY3Rpb25zIGZvciBjYXJkICR7Y2FyZC5jYXJkVW5pcXVlSWR9YCk7XHJcbiAgICAgICAgbGV0IHBlbmRpbmdEYXRhID0gYXdhaXQgZmV0Y2hQb3N0KFxyXG4gICAgICAgICAgUEVORElOR19UUkFOU0FDVElPTlNfUkVRVUVTVF9FTkRQT0lOVCxcclxuICAgICAgICAgIHsgY2FyZFVuaXF1ZUlEQXJyYXk6IFtjYXJkLmNhcmRVbmlxdWVJZF0gfSxcclxuICAgICAgICAgIHtcclxuICAgICAgICAgICAgQXV0aG9yaXphdGlvbixcclxuICAgICAgICAgICAgJ1gtU2l0ZS1JZCc6IHhTaXRlSWQsXHJcbiAgICAgICAgICAgICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicsXHJcbiAgICAgICAgICAgIC4uLmFwaUhlYWRlcnMsXHJcbiAgICAgICAgICB9LFxyXG4gICAgICAgICk7XHJcblxyXG4gICAgICAgIGRlYnVnKGBmZXRjaCBjb21wbGV0ZWQgdHJhbnNhY3Rpb25zIGZvciBjYXJkICR7Y2FyZC5jYXJkVW5pcXVlSWR9YCk7XHJcbiAgICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPD0gbW9udGhzOyBpKyspIHtcclxuICAgICAgICAgIGNvbnN0IG1vbnRoID0gZmluYWxNb250aFRvRmV0Y2hNb21lbnQuY2xvbmUoKS5zdWJ0cmFjdChpLCAnbW9udGhzJyk7XHJcbiAgICAgICAgICBjb25zdCBtb250aERhdGEgPSBhd2FpdCBmZXRjaFBvc3QoXHJcbiAgICAgICAgICAgIFRSQU5TQUNUSU9OU19SRVFVRVNUX0VORFBPSU5ULFxyXG4gICAgICAgICAgICB7IGNhcmRVbmlxdWVJZDogY2FyZC5jYXJkVW5pcXVlSWQsIG1vbnRoOiBtb250aC5mb3JtYXQoJ00nKSwgeWVhcjogbW9udGguZm9ybWF0KCdZWVlZJykgfSxcclxuICAgICAgICAgICAge1xyXG4gICAgICAgICAgICAgIEF1dGhvcml6YXRpb24sXHJcbiAgICAgICAgICAgICAgJ1gtU2l0ZS1JZCc6IHhTaXRlSWQsXHJcbiAgICAgICAgICAgICAgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyxcclxuICAgICAgICAgICAgICAuLi5hcGlIZWFkZXJzLFxyXG4gICAgICAgICAgICB9LFxyXG4gICAgICAgICAgKTtcclxuXHJcbiAgICAgICAgICBpZiAobW9udGhEYXRhPy5zdGF0dXNDb2RlICE9PSAxKVxyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXHJcbiAgICAgICAgICAgICAgYGZhaWxlZCB0byBmZXRjaCB0cmFuc2FjdGlvbnMgZm9yIGNhcmQgJHtjYXJkLmxhc3Q0RGlnaXRzfS4gTWVzc2FnZTogJHttb250aERhdGE/LnRpdGxlIHx8ICcnfWAsXHJcbiAgICAgICAgICAgICk7XHJcblxyXG4gICAgICAgICAgaWYgKCFpc0NhcmRUcmFuc2FjdGlvbkRldGFpbHMobW9udGhEYXRhKSkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ21vbnRoRGF0YSBpcyBub3Qgb2YgdHlwZSBDYXJkVHJhbnNhY3Rpb25EZXRhaWxzJyk7XHJcbiAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgYWxsTW9udGhzRGF0YS5wdXNoKG1vbnRoRGF0YSk7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICBpZiAocGVuZGluZ0RhdGE/LnN0YXR1c0NvZGUgIT09IDEgJiYgcGVuZGluZ0RhdGE/LnN0YXR1c0NvZGUgIT09IDk2KSB7XHJcbiAgICAgICAgICBkZWJ1ZyhcclxuICAgICAgICAgICAgYGZhaWxlZCB0byBmZXRjaCBwZW5kaW5nIHRyYW5zYWN0aW9ucyBmb3IgY2FyZCAke2NhcmQubGFzdDREaWdpdHN9LiBNZXNzYWdlOiAke3BlbmRpbmdEYXRhPy50aXRsZSB8fCAnJ31gLFxyXG4gICAgICAgICAgKTtcclxuICAgICAgICAgIHBlbmRpbmdEYXRhID0gbnVsbDtcclxuICAgICAgICB9IGVsc2UgaWYgKCFpc0NhcmRQZW5kaW5nVHJhbnNhY3Rpb25EZXRhaWxzKHBlbmRpbmdEYXRhKSkge1xyXG4gICAgICAgICAgZGVidWcoJ3BlbmRpbmdEYXRhIGlzIG5vdCBvZiB0eXBlIENhcmRUcmFuc2FjdGlvbkRldGFpbHMnKTtcclxuICAgICAgICAgIHBlbmRpbmdEYXRhID0gbnVsbDtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGNvbnN0IHRyYW5zYWN0aW9ucyA9IGNvbnZlcnRQYXJzZWREYXRhVG9UcmFuc2FjdGlvbnMoYWxsTW9udGhzRGF0YSwgcGVuZGluZ0RhdGEsIHRoaXMub3B0aW9ucyk7XHJcblxyXG4gICAgICAgIGRlYnVnKCdmaWx0ZXIgb3V0IG9sZCB0cmFuc2FjdGlvbnMnKTtcclxuICAgICAgICBjb25zdCB0eG5zID1cclxuICAgICAgICAgICh0aGlzLm9wdGlvbnMub3V0cHV0RGF0YT8uZW5hYmxlVHJhbnNhY3Rpb25zRmlsdGVyQnlEYXRlID8/IHRydWUpXHJcbiAgICAgICAgICAgID8gZmlsdGVyT2xkVHJhbnNhY3Rpb25zKHRyYW5zYWN0aW9ucywgbW9tZW50KHN0YXJ0RGF0ZSksIHRoaXMub3B0aW9ucy5jb21iaW5lSW5zdGFsbG1lbnRzIHx8IGZhbHNlKVxyXG4gICAgICAgICAgICA6IHRyYW5zYWN0aW9ucztcclxuXHJcbiAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgIHR4bnMsXHJcbiAgICAgICAgICBiYWxhbmNlOiBmcmFtZT8ubmV4dFRvdGFsRGViaXQgIT0gbnVsbCA/IC1mcmFtZS5uZXh0VG90YWxEZWJpdCA6IHVuZGVmaW5lZCxcclxuICAgICAgICAgIGFjY291bnROdW1iZXI6IGNhcmQubGFzdDREaWdpdHMsXHJcbiAgICAgICAgfSBhcyBUcmFuc2FjdGlvbnNBY2NvdW50O1xyXG4gICAgICB9KSxcclxuICAgICk7XHJcblxyXG4gICAgZGVidWcoJ3JldHVybiB0aGUgc2NyYXBlZCBhY2NvdW50cycpO1xyXG5cclxuICAgIGRlYnVnKEpTT04uc3RyaW5naWZ5KGFjY291bnRzLCBudWxsLCAyKSk7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICBzdWNjZXNzOiB0cnVlLFxyXG4gICAgICBhY2NvdW50cyxcclxuICAgIH07XHJcbiAgfVxyXG59XHJcblxyXG5leHBvcnQgZGVmYXVsdCBWaXNhQ2FsU2NyYXBlcjtcclxuIl0sIm1hcHBpbmdzIjoiOzs7Ozs7QUFBQSxJQUFBQSxPQUFBLEdBQUFDLHNCQUFBLENBQUFDLE9BQUE7QUFFQSxJQUFBQyxNQUFBLEdBQUFELE9BQUE7QUFDQSxJQUFBRSxxQkFBQSxHQUFBRixPQUFBO0FBQ0EsSUFBQUcsTUFBQSxHQUFBSCxPQUFBO0FBQ0EsSUFBQUksV0FBQSxHQUFBSixPQUFBO0FBQ0EsSUFBQUssUUFBQSxHQUFBTCxPQUFBO0FBQ0EsSUFBQU0sYUFBQSxHQUFBTixPQUFBO0FBQ0EsSUFBQU8sUUFBQSxHQUFBUCxPQUFBO0FBQ0EsSUFBQVEsY0FBQSxHQUFBUixPQUFBO0FBQ0EsSUFBQVMsdUJBQUEsR0FBQVQsT0FBQTtBQUFzRyxTQUFBRCx1QkFBQVcsQ0FBQSxXQUFBQSxDQUFBLElBQUFBLENBQUEsQ0FBQUMsVUFBQSxHQUFBRCxDQUFBLEtBQUFFLE9BQUEsRUFBQUYsQ0FBQTtBQUd0RyxNQUFNRyxVQUFVLEdBQUc7RUFDakIsWUFBWSxFQUNWLHVIQUF1SDtFQUN6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