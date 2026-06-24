"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;
var _moment = _interopRequireDefault(require("moment"));
var _crypto = require("crypto");
var _debug = require("../helpers/debug");
var _fetch = require("../helpers/fetch");
var _navigation = require("../helpers/navigation");
var _waiting = require("../helpers/waiting");
var _transactions = require("../transactions");
var _baseScraperWithBrowser = require("./base-scraper-with-browser");
var _errors = require("./errors");
var _transactions2 = require("../helpers/transactions");
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
const debug = (0, _debug.getDebug)('hapoalim');
const DATE_FORMAT = 'YYYYMMDD';

// eslint-disable-next-line @typescript-eslint/no-namespace

function convertTransactions(txns, options) {
  return txns.map(txn => {
    const isOutbound = txn.eventActivityTypeCode === 2;
    let memo = '';
    if (txn.beneficiaryDetailsData) {
      const {
        partyHeadline,
        partyName,
        messageHeadline,
        messageDetail
      } = txn.beneficiaryDetailsData;
      const memoLines = [];
      if (partyHeadline) {
        memoLines.push(partyHeadline);
      }
      if (partyName) {
        memoLines.push(`${partyName}.`);
      }
      if (messageHeadline) {
        memoLines.push(messageHeadline);
      }
      if (messageDetail) {
        memoLines.push(`${messageDetail}.`);
      }
      if (memoLines.length) {
        memo = memoLines.join(' ');
      }
    }
    const result = {
      type: _transactions.TransactionTypes.Normal,
      identifier: txn.referenceNumber,
      date: (0, _moment.default)(txn.eventDate, DATE_FORMAT).toISOString(),
      processedDate: (0, _moment.default)(txn.valueDate, DATE_FORMAT).toISOString(),
      originalAmount: isOutbound ? -txn.eventAmount : txn.eventAmount,
      originalCurrency: 'ILS',
      chargedAmount: isOutbound ? -txn.eventAmount : txn.eventAmount,
      description: txn.activityDescription || '',
      status: txn.serialNumber === 0 ? _transactions.TransactionStatuses.Pending : _transactions.TransactionStatuses.Completed,
      memo
    };
    if (options?.includeRawTransaction) {
      result.rawTransaction = (0, _transactions2.getRawTransaction)(txn);
    }
    return result;
  });
}
async function getRestContext(page) {
  await (0, _waiting.waitUntil)(() => {
    return page.evaluate(() => !!window.bnhpApp);
  }, 'waiting for app data load');
  const result = await page.evaluate(() => {
    return window.bnhpApp.restContext;
  });
  return result.slice(1);
}
async function fetchPoalimXSRFWithinPage(page, url, pageUuid) {
  const cookies = await page.cookies();
  const XSRFCookie = cookies.find(cookie => cookie.name === 'XSRF-TOKEN');
  const headers = {};
  if (XSRFCookie != null) {
    headers['X-XSRF-TOKEN'] = XSRFCookie.value;
  }
  headers.pageUuid = pageUuid;
  headers.uuid = (0, _crypto.randomUUID)();
  headers['Content-Type'] = 'application/json;charset=UTF-8';
  return (0, _fetch.fetchPostWithinPage)(page, url, [], headers);
}
async function getExtraScrap(txnsResult, baseUrl, page, accountNumber) {
  const promises = txnsResult.transactions.map(async transaction => {
    const {
      pfmDetails,
      serialNumber
    } = transaction;
    if (serialNumber !== 0) {
      const url = `${baseUrl}${pfmDetails}&accountId=${accountNumber}&lang=he`;
      const extraTransactionDetails = (await (0, _fetch.fetchGetWithinPage)(page, url)) || [];
      if (extraTransactionDetails && extraTransactionDetails.length) {
        const {
          transactionNumber
        } = extraTransactionDetails[0];
        if (transactionNumber) {
          return {
            ...transaction,
            referenceNumber: transactionNumber,
            additionalInformation: extraTransactionDetails
          };
        }
      }
    }
    return transaction;
  });
  const res = await Promise.all(promises);
  return {
    transactions: res
  };
}
async function getAccountTransactions(baseUrl, apiSiteUrl, page, accountNumber, startDate, endDate, additionalTransactionInformation = false, options) {
  const txnsUrl = `${apiSiteUrl}/current-account/transactions?accountId=${accountNumber}&numItemsPerPage=1000&retrievalEndDate=${endDate}&retrievalStartDate=${startDate}&sortCode=1`;
  const txnsResult = await fetchPoalimXSRFWithinPage(page, txnsUrl, '/current-account/transactions');
  const finalResult = additionalTransactionInformation && txnsResult?.transactions.length ? await getExtraScrap(txnsResult, baseUrl, page, accountNumber) : txnsResult;
  return convertTransactions(finalResult?.transactions ?? [], options);
}
async function getAccountBalance(apiSiteUrl, page, accountNumber) {
  const balanceAndCreditLimitUrl = `${apiSiteUrl}/current-account/composite/balanceAndCreditLimit?accountId=${accountNumber}&view=details&lang=he`;
  const balanceAndCreditLimit = await (0, _fetch.fetchGetWithinPage)(page, balanceAndCreditLimitUrl);
  return balanceAndCreditLimit?.currentBalance;
}
async function fetchAccountData(page, baseUrl, options) {
  const restContext = await getRestContext(page);
  const apiSiteUrl = `${baseUrl}/${restContext}`;
  const accountDataUrl = `${baseUrl}/ServerServices/general/accounts`;
  debug('fetching accounts data');
  const accountsInfo = (await (0, _fetch.fetchGetWithinPage)(page, accountDataUrl)) || [];
  const openAccountsInfo = accountsInfo.filter(account => account.accountClosingReasonCode === 0);
  debug('got %d open accounts from %d total accounts, fetching txns and balance', openAccountsInfo.length, accountsInfo.length);
  const defaultStartMoment = (0, _moment.default)().subtract(1, 'years').add(1, 'day');
  const startDate = options.startDate || defaultStartMoment.toDate();
  const startMoment = _moment.default.max(defaultStartMoment, (0, _moment.default)(startDate));
  const {
    additionalTransactionInformation
  } = options;
  const startDateStr = startMoment.format(DATE_FORMAT);
  const endDateStr = (0, _moment.default)().format(DATE_FORMAT);
  const accounts = [];
  for (const account of openAccountsInfo) {
    debug('getting information for account %s', account.accountNumber);
    const accountNumber = `${account.bankNumber}-${account.branchNumber}-${account.accountNumber}`;
    const balance = await getAccountBalance(apiSiteUrl, page, accountNumber);
    const txns = await getAccountTransactions(baseUrl, apiSiteUrl, page, accountNumber, startDateStr, endDateStr, additionalTransactionInformation, options);
    accounts.push({
      accountNumber,
      balance,
      txns
    });
  }
  const accountData = {
    success: true,
    accounts
  };
  debug('fetching ended');
  return accountData;
}
const OTP_FORM_SELECTOR = 'form.auth-otp-login';
const OTP_SUBMIT_SELECTOR = '.btn-red_1';
const OTP_ERROR_SELECTOR = '.errors-rb .error-message, .auth-otp-login .error';
function getPossibleLoginResults(baseUrl) {
  const urls = {};
  urls[_baseScraperWithBrowser.LoginResults.Success] = [`${baseUrl}/portalserver/HomePage`, `${baseUrl}/ng-portals-bt/rb/he/homepage`, `${baseUrl}/ng-portals/rb/he/homepage`];
  urls[_baseScraperWithBrowser.LoginResults.InvalidPassword] = [`${baseUrl}/AUTHENTICATE/LOGON?flow=AUTHENTICATE&state=LOGON&errorcode=1.6&callme=false`];
  urls[_baseScraperWithBrowser.LoginResults.ChangePassword] = [`${baseUrl}/MCP/START?flow=MCP&state=START&expiredDate=null`, /\/ABOUTTOEXPIRE\/START/i];
  urls[_baseScraperWithBrowser.LoginResults.TwoFactorRetrieverMissing] = [async options => {
    if (!options?.page) return false;
    return !!(await options.page.$(OTP_FORM_SELECTOR));
  }];
  return urls;
}
function createLoginFields(credentials) {
  return [{
    selector: '#userCode',
    value: credentials.userCode
  }, {
    selector: '#password',
    value: credentials.password
  }];
}
class HapoalimScraper extends _baseScraperWithBrowser.BaseScraperWithBrowser {
  get baseUrl() {
    return 'https://login.bankhapoalim.co.il';
  }
  getLoginOptions(credentials) {
    return {
      loginUrl: `${this.baseUrl}/cgi-bin/poalwwwc?reqName=getLogonPage`,
      fields: createLoginFields(credentials),
      submitButtonSelector: '.login-btn',
      postAction: async () => {
        const initialUrl = await (0, _navigation.getCurrentUrl)(this.page, true);
        await (0, _waiting.waitUntil)(async () => {
          try {
            const currentUrl = await (0, _navigation.getCurrentUrl)(this.page, true);
            if (currentUrl !== initialUrl) return true;
            return !!(await this.page.$(OTP_FORM_SELECTOR));
          } catch {
            // Navigation destroyed the execution context — page is redirecting, which is progress
            return true;
          }
        }, 'waiting for redirect or OTP form', 20000, 1000);
      },
      possibleResults: getPossibleLoginResults(this.baseUrl)
    };
  }
  async login(credentials) {
    const result = await super.login(credentials);
    if (result.success || result.errorType !== _errors.ScraperErrorTypes.TwoFactorRetrieverMissing) {
      return result;
    }

    // 2FA page detected — need OTP
    if (!credentials.otpCodeRetriever) {
      debug('2FA required but no otpCodeRetriever provided');
      return {
        success: false,
        errorType: _errors.ScraperErrorTypes.TwoFactorRetrieverMissing,
        errorMessage: 'OTP code retriever is required for Hapoalim 2FA'
      };
    }
    const MAX_OTP_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_OTP_ATTEMPTS; attempt++) {
      debug(`2FA page detected, requesting OTP from caller (attempt ${attempt}/${MAX_OTP_ATTEMPTS})`);
      const otpCode = await credentials.otpCodeRetriever({
        attempt
      });
      debug('entering OTP code');
      const otpInputs = await this.page.$$(`${OTP_FORM_SELECTOR} input[type="text"]`);
      debug('found %d OTP digit inputs', otpInputs.length);
      for (let i = 0; i < otpInputs.length; i++) {
        await otpInputs[i].click();
        await otpInputs[i].evaluate(el => {
          el.value = '';
        });
        if (i < otpCode.length) {
          await otpInputs[i].type(otpCode[i], {
            delay: 50
          });
        }
        await (0, _waiting.sleep)(100);
      }
      debug('submitting OTP');
      // Use page.click() for proper mouse events — clickButton uses synthetic el.click()
      // which Angular ignores.
      await this.page.click(OTP_SUBMIT_SELECTOR);
      try {
        await (0, _waiting.waitUntil)(async () => {
          const otpForm = await this.page.$(OTP_FORM_SELECTOR);
          const errorEl = await this.page.$(OTP_ERROR_SELECTOR);
          const url = await (0, _navigation.getCurrentUrl)(this.page, true);
          debug('OTP poll: form=%s, error=%s, url=%s', !!otpForm, !!errorEl, url);
          if (!otpForm) return 'success';
          if (errorEl) return 'error';
          return false;
        }, 'waiting for OTP result', 20000, 1000);
      } catch {
        // Timeout: error selector didn't match but form is still showing — treat as wrong OTP
        debug('OTP waitUntil timed out — treating as wrong OTP');
      }
      if (!(await this.page.$(OTP_FORM_SELECTOR))) {
        // OTP form closed — wait for the bank to navigate to homepage
        const successPatterns = ['/portalserver/HomePage', '/ng-portals-bt/rb/he/homepage', '/ng-portals/rb/he/homepage'];
        try {
          await (0, _waiting.waitUntil)(async () => {
            const url = await (0, _navigation.getCurrentUrl)(this.page, true);
            debug('post-OTP navigation poll: url=%s', url);
            return successPatterns.some(p => url.includes(p));
          }, 'waiting for post-OTP navigation', 10000, 1000);
          debug('OTP verification succeeded');
          return {
            success: true
          };
        } catch {
          const current = await (0, _navigation.getCurrentUrl)(this.page, true);
          debug('OTP verification failed, current url: %s', current);
          return {
            success: false,
            errorType: _errors.ScraperErrorTypes.General,
            errorMessage: 'OTP verification failed'
          };
        }
      }
      debug(`OTP attempt ${attempt} failed — inline error detected`);
      if (attempt === MAX_OTP_ATTEMPTS) {
        return {
          success: false,
          errorType: _errors.ScraperErrorTypes.General,
          errorMessage: `OTP verification failed after ${MAX_OTP_ATTEMPTS} attempts`
        };
      }
    }
    return {
      success: false,
      errorType: _errors.ScraperErrorTypes.General,
      errorMessage: 'OTP verification failed'
    };
  }
  async fetchData() {
    return fetchAccountData(this.page, this.baseUrl, this.options);
  }
}
var _default = exports.default = HapoalimScraper;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfbW9tZW50IiwiX2ludGVyb3BSZXF1aXJlRGVmYXVsdCIsInJlcXVpcmUiLCJfY3J5cHRvIiwiX2RlYnVnIiwiX2ZldGNoIiwiX25hdmlnYXRpb24iLCJfd2FpdGluZyIsIl90cmFuc2FjdGlvbnMiLCJfYmFzZVNjcmFwZXJXaXRoQnJvd3NlciIsIl9lcnJvcnMiLCJfdHJhbnNhY3Rpb25zMiIsImUiLCJfX2VzTW9kdWxlIiwiZGVmYXVsdCIsImRlYnVnIiwiZ2V0RGVidWciLCJEQVRFX0ZPUk1BVCIsImNvbnZlcnRUcmFuc2FjdGlvbnMiLCJ0eG5zIiwib3B0aW9ucyIsIm1hcCIsInR4biIsImlzT3V0Ym91bmQiLCJldmVudEFjdGl2aXR5VHlwZUNvZGUiLCJtZW1vIiwiYmVuZWZpY2lhcnlEZXRhaWxzRGF0YSIsInBhcnR5SGVhZGxpbmUiLCJwYXJ0eU5hbWUiLCJtZXNzYWdlSGVhZGxpbmUiLCJtZXNzYWdlRGV0YWlsIiwibWVtb0xpbmVzIiwicHVzaCIsImxlbmd0aCIsImpvaW4iLCJyZXN1bHQiLCJ0eXBlIiwiVHJhbnNhY3Rpb25UeXBlcyIsIk5vcm1hbCIsImlkZW50aWZpZXIiLCJyZWZlcmVuY2VOdW1iZXIiLCJkYXRlIiwibW9tZW50IiwiZXZlbnREYXRlIiwidG9JU09TdHJpbmciLCJwcm9jZXNzZWREYXRlIiwidmFsdWVEYXRlIiwib3JpZ2luYWxBbW91bnQiLCJldmVudEFtb3VudCIsIm9yaWdpbmFsQ3VycmVuY3kiLCJjaGFyZ2VkQW1vdW50IiwiZGVzY3JpcHRpb24iLCJhY3Rpdml0eURlc2NyaXB0aW9uIiwic3RhdHVzIiwic2VyaWFsTnVtYmVyIiwiVHJhbnNhY3Rpb25TdGF0dXNlcyIsIlBlbmRpbmciLCJDb21wbGV0ZWQiLCJpbmNsdWRlUmF3VHJhbnNhY3Rpb24iLCJyYXdUcmFuc2FjdGlvbiIsImdldFJhd1RyYW5zYWN0aW9uIiwiZ2V0UmVzdENvbnRleHQiLCJwYWdlIiwid2FpdFVudGlsIiwiZXZhbHVhdGUiLCJ3aW5kb3ciLCJibmhwQXBwIiwicmVzdENvbnRleHQiLCJzbGljZSIsImZldGNoUG9hbGltWFNSRldpdGhpblBhZ2UiLCJ1cmwiLCJwYWdlVXVpZCIsImNvb2tpZXMiLCJYU1JGQ29va2llIiwiZmluZCIsImNvb2tpZSIsIm5hbWUiLCJoZWFkZXJzIiwidmFsdWUiLCJ1dWlkIiwicmFuZG9tVVVJRCIsImZldGNoUG9zdFdpdGhpblBhZ2UiLCJnZXRFeHRyYVNjcmFwIiwidHhuc1Jlc3VsdCIsImJhc2VVcmwiLCJhY2NvdW50TnVtYmVyIiwicHJvbWlzZXMiLCJ0cmFuc2FjdGlvbnMiLCJ0cmFuc2FjdGlvbiIsInBmbURldGFpbHMiLCJleHRyYVRyYW5zYWN0aW9uRGV0YWlscyIsImZldGNoR2V0V2l0aGluUGFnZSIsInRyYW5zYWN0aW9uTnVtYmVyIiwiYWRkaXRpb25hbEluZm9ybWF0aW9uIiwicmVzIiwiUHJvbWlzZSIsImFsbCIsImdldEFjY291bnRUcmFuc2FjdGlvbnMiLCJhcGlTaXRlVXJsIiwic3RhcnREYXRlIiwiZW5kRGF0ZSIsImFkZGl0aW9uYWxUcmFuc2FjdGlvbkluZm9ybWF0aW9uIiwidHhuc1VybCIsImZpbmFsUmVzdWx0IiwiZ2V0QWNjb3VudEJhbGFuY2UiLCJiYWxhbmNlQW5kQ3JlZGl0TGltaXRVcmwiLCJiYWxhbmNlQW5kQ3JlZGl0TGltaXQiLCJjdXJyZW50QmFsYW5jZSIsImZldGNoQWNjb3VudERhdGEiLCJhY2NvdW50RGF0YVVybCIsImFjY291bnRzSW5mbyIsIm9wZW5BY2NvdW50c0luZm8iLCJmaWx0ZXIiLCJhY2NvdW50IiwiYWNjb3VudENsb3NpbmdSZWFzb25Db2RlIiwiZGVmYXVsdFN0YXJ0TW9tZW50Iiwic3VidHJhY3QiLCJhZGQiLCJ0b0RhdGUiLCJzdGFydE1vbWVudCIsIm1heCIsInN0YXJ0RGF0ZVN0ciIsImZvcm1hdCIsImVuZERhdGVTdHIiLCJhY2NvdW50cyIsImJhbmtOdW1iZXIiLCJicmFuY2hOdW1iZXIiLCJiYWxhbmNlIiwiYWNjb3VudERhdGEiLCJzdWNjZXNzIiwiT1RQX0ZPUk1fU0VMRUNUT1IiLCJPVFBfU1VCTUlUX1NFTEVDVE9SIiwiT1RQX0VSUk9SX1NFTEVDVE9SIiwiZ2V0UG9zc2libGVMb2dpblJlc3VsdHMiLCJ1cmxzIiwiTG9naW5SZXN1bHRzIiwiU3VjY2VzcyIsIkludmFsaWRQYXNzd29yZCIsIkNoYW5nZVBhc3N3b3JkIiwiVHdvRmFjdG9yUmV0cmlldmVyTWlzc2luZyIsIiQiLCJjcmVhdGVMb2dpbkZpZWxkcyIsImNyZWRlbnRpYWxzIiwic2VsZWN0b3IiLCJ1c2VyQ29kZSIsInBhc3N3b3JkIiwiSGFwb2FsaW1TY3JhcGVyIiwiQmFzZVNjcmFwZXJXaXRoQnJvd3NlciIsImdldExvZ2luT3B0aW9ucyIsImxvZ2luVXJsIiwiZmllbGRzIiwic3VibWl0QnV0dG9uU2VsZWN0b3IiLCJwb3N0QWN0aW9uIiwiaW5pdGlhbFVybCIsImdldEN1cnJlbnRVcmwiLCJjdXJyZW50VXJsIiwicG9zc2libGVSZXN1bHRzIiwibG9naW4iLCJlcnJvclR5cGUiLCJTY3JhcGVyRXJyb3JUeXBlcyIsIm90cENvZGVSZXRyaWV2ZXIiLCJlcnJvck1lc3NhZ2UiLCJNQVhfT1RQX0FUVEVNUFRTIiwiYXR0ZW1wdCIsIm90cENvZGUiLCJvdHBJbnB1dHMiLCIkJCIsImkiLCJjbGljayIsImVsIiwiZGVsYXkiLCJzbGVlcCIsIm90cEZvcm0iLCJlcnJvckVsIiwic3VjY2Vzc1BhdHRlcm5zIiwic29tZSIsInAiLCJpbmNsdWRlcyIsImN1cnJlbnQiLCJHZW5lcmFsIiwiZmV0Y2hEYXRhIiwiX2RlZmF1bHQiLCJleHBvcnRzIl0sInNvdXJjZXMiOlsiLi4vLi4vc3JjL3NjcmFwZXJzL2hhcG9hbGltLnRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCBtb21lbnQgZnJvbSAnbW9tZW50JztcclxuaW1wb3J0IHsgdHlwZSBQYWdlIH0gZnJvbSAncHVwcGV0ZWVyJztcclxuaW1wb3J0IHsgcmFuZG9tVVVJRCB9IGZyb20gJ2NyeXB0byc7XHJcbmltcG9ydCB7IGdldERlYnVnIH0gZnJvbSAnLi4vaGVscGVycy9kZWJ1Zyc7XHJcbmltcG9ydCB7IGZldGNoR2V0V2l0aGluUGFnZSwgZmV0Y2hQb3N0V2l0aGluUGFnZSB9IGZyb20gJy4uL2hlbHBlcnMvZmV0Y2gnO1xyXG5pbXBvcnQgeyBnZXRDdXJyZW50VXJsIH0gZnJvbSAnLi4vaGVscGVycy9uYXZpZ2F0aW9uJztcclxuaW1wb3J0IHsgc2xlZXAsIHdhaXRVbnRpbCB9IGZyb20gJy4uL2hlbHBlcnMvd2FpdGluZyc7XHJcbmltcG9ydCB7IHR5cGUgVHJhbnNhY3Rpb24sIFRyYW5zYWN0aW9uU3RhdHVzZXMsIFRyYW5zYWN0aW9uVHlwZXMsIHR5cGUgVHJhbnNhY3Rpb25zQWNjb3VudCB9IGZyb20gJy4uL3RyYW5zYWN0aW9ucyc7XHJcbmltcG9ydCB7IEJhc2VTY3JhcGVyV2l0aEJyb3dzZXIsIExvZ2luUmVzdWx0cywgdHlwZSBQb3NzaWJsZUxvZ2luUmVzdWx0cyB9IGZyb20gJy4vYmFzZS1zY3JhcGVyLXdpdGgtYnJvd3Nlcic7XHJcbmltcG9ydCB7IFNjcmFwZXJFcnJvclR5cGVzIH0gZnJvbSAnLi9lcnJvcnMnO1xyXG5pbXBvcnQgeyB0eXBlIFNjcmFwZXJMb2dpblJlc3VsdCwgdHlwZSBTY3JhcGVyT3B0aW9ucyB9IGZyb20gJy4vaW50ZXJmYWNlJztcclxuaW1wb3J0IHsgZ2V0UmF3VHJhbnNhY3Rpb24gfSBmcm9tICcuLi9oZWxwZXJzL3RyYW5zYWN0aW9ucyc7XHJcblxyXG5jb25zdCBkZWJ1ZyA9IGdldERlYnVnKCdoYXBvYWxpbScpO1xyXG5cclxuY29uc3QgREFURV9GT1JNQVQgPSAnWVlZWU1NREQnO1xyXG5cclxuLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIEB0eXBlc2NyaXB0LWVzbGludC9uby1uYW1lc3BhY2VcclxuZGVjbGFyZSBuYW1lc3BhY2Ugd2luZG93IHtcclxuICBjb25zdCBibmhwQXBwOiBhbnk7XHJcbn1cclxuXHJcbmludGVyZmFjZSBTY3JhcGVkVHJhbnNhY3Rpb24ge1xyXG4gIHNlcmlhbE51bWJlcj86IG51bWJlcjtcclxuICBhY3Rpdml0eURlc2NyaXB0aW9uPzogc3RyaW5nO1xyXG4gIGV2ZW50QW1vdW50OiBudW1iZXI7XHJcbiAgdmFsdWVEYXRlPzogc3RyaW5nO1xyXG4gIGV2ZW50RGF0ZT86IHN0cmluZztcclxuICByZWZlcmVuY2VOdW1iZXI/OiBudW1iZXI7XHJcbiAgU2NyYXBlZFRyYW5zYWN0aW9uPzogc3RyaW5nO1xyXG4gIGV2ZW50QWN0aXZpdHlUeXBlQ29kZTogbnVtYmVyO1xyXG4gIGN1cnJlbnRCYWxhbmNlOiBudW1iZXI7XHJcbiAgcGZtRGV0YWlsczogc3RyaW5nO1xyXG4gIGJlbmVmaWNpYXJ5RGV0YWlsc0RhdGE/OiB7XHJcbiAgICBwYXJ0eUhlYWRsaW5lPzogc3RyaW5nO1xyXG4gICAgcGFydHlOYW1lPzogc3RyaW5nO1xyXG4gICAgbWVzc2FnZUhlYWRsaW5lPzogc3RyaW5nO1xyXG4gICAgbWVzc2FnZURldGFpbD86IHN0cmluZztcclxuICB9O1xyXG4gIGFkZGl0aW9uYWxJbmZvcm1hdGlvbj86IHVua25vd247XHJcbn1cclxuXHJcbmludGVyZmFjZSBTY3JhcGVkUGZtVHJhbnNhY3Rpb24ge1xyXG4gIHRyYW5zYWN0aW9uTnVtYmVyOiBudW1iZXI7XHJcbn1cclxuXHJcbnR5cGUgRmV0Y2hlZEFjY291bnREYXRhID0ge1xyXG4gIGJhbmtOdW1iZXI6IHN0cmluZztcclxuICBhY2NvdW50TnVtYmVyOiBzdHJpbmc7XHJcbiAgYnJhbmNoTnVtYmVyOiBzdHJpbmc7XHJcbiAgYWNjb3VudENsb3NpbmdSZWFzb25Db2RlOiBudW1iZXI7XHJcbn1bXTtcclxuXHJcbnR5cGUgRmV0Y2hlZEFjY291bnRUcmFuc2FjdGlvbnNEYXRhID0ge1xyXG4gIHRyYW5zYWN0aW9uczogU2NyYXBlZFRyYW5zYWN0aW9uW107XHJcbn07XHJcblxyXG50eXBlIEJhbGFuY2VBbmRDcmVkaXRMaW1pdCA9IHtcclxuICBjcmVkaXRMaW1pdEFtb3VudDogbnVtYmVyO1xyXG4gIGNyZWRpdExpbWl0RGVzY3JpcHRpb246IHN0cmluZztcclxuICBjcmVkaXRMaW1pdFV0aWxpemF0aW9uQW1vdW50OiBudW1iZXI7XHJcbiAgY3JlZGl0TGltaXRVdGlsaXphdGlvbkV4aXN0YW5jZUNvZGU6IG51bWJlcjtcclxuICBjcmVkaXRMaW1pdFV0aWxpemF0aW9uUGVyY2VudDogbnVtYmVyO1xyXG4gIGN1cnJlbnRBY2NvdW50TGltaXRzQW1vdW50OiBudW1iZXI7XHJcbiAgY3VycmVudEJhbGFuY2U6IG51bWJlcjtcclxuICB3aXRoZHJhd2FsQmFsYW5jZTogbnVtYmVyO1xyXG59O1xyXG5cclxuZnVuY3Rpb24gY29udmVydFRyYW5zYWN0aW9ucyh0eG5zOiBTY3JhcGVkVHJhbnNhY3Rpb25bXSwgb3B0aW9ucz86IFNjcmFwZXJPcHRpb25zKTogVHJhbnNhY3Rpb25bXSB7XHJcbiAgcmV0dXJuIHR4bnMubWFwKHR4biA9PiB7XHJcbiAgICBjb25zdCBpc091dGJvdW5kID0gdHhuLmV2ZW50QWN0aXZpdHlUeXBlQ29kZSA9PT0gMjtcclxuXHJcbiAgICBsZXQgbWVtbyA9ICcnO1xyXG4gICAgaWYgKHR4bi5iZW5lZmljaWFyeURldGFpbHNEYXRhKSB7XHJcbiAgICAgIGNvbnN0IHsgcGFydHlIZWFkbGluZSwgcGFydHlOYW1lLCBtZXNzYWdlSGVhZGxpbmUsIG1lc3NhZ2VEZXRhaWwgfSA9IHR4bi5iZW5lZmljaWFyeURldGFpbHNEYXRhO1xyXG4gICAgICBjb25zdCBtZW1vTGluZXM6IHN0cmluZ1tdID0gW107XHJcbiAgICAgIGlmIChwYXJ0eUhlYWRsaW5lKSB7XHJcbiAgICAgICAgbWVtb0xpbmVzLnB1c2gocGFydHlIZWFkbGluZSk7XHJcbiAgICAgIH1cclxuXHJcbiAgICAgIGlmIChwYXJ0eU5hbWUpIHtcclxuICAgICAgICBtZW1vTGluZXMucHVzaChgJHtwYXJ0eU5hbWV9LmApO1xyXG4gICAgICB9XHJcblxyXG4gICAgICBpZiAobWVzc2FnZUhlYWRsaW5lKSB7XHJcbiAgICAgICAgbWVtb0xpbmVzLnB1c2gobWVzc2FnZUhlYWRsaW5lKTtcclxuICAgICAgfVxyXG5cclxuICAgICAgaWYgKG1lc3NhZ2VEZXRhaWwpIHtcclxuICAgICAgICBtZW1vTGluZXMucHVzaChgJHttZXNzYWdlRGV0YWlsfS5gKTtcclxuICAgICAgfVxyXG5cclxuICAgICAgaWYgKG1lbW9MaW5lcy5sZW5ndGgpIHtcclxuICAgICAgICBtZW1vID0gbWVtb0xpbmVzLmpvaW4oJyAnKTtcclxuICAgICAgfVxyXG4gICAgfVxyXG5cclxuICAgIGNvbnN0IHJlc3VsdDogVHJhbnNhY3Rpb24gPSB7XHJcbiAgICAgIHR5cGU6IFRyYW5zYWN0aW9uVHlwZXMuTm9ybWFsLFxyXG4gICAgICBpZGVudGlmaWVyOiB0eG4ucmVmZXJlbmNlTnVtYmVyLFxyXG4gICAgICBkYXRlOiBtb21lbnQodHhuLmV2ZW50RGF0ZSwgREFURV9GT1JNQVQpLnRvSVNPU3RyaW5nKCksXHJcbiAgICAgIHByb2Nlc3NlZERhdGU6IG1vbWVudCh0eG4udmFsdWVEYXRlLCBEQVRFX0ZPUk1BVCkudG9JU09TdHJpbmcoKSxcclxuICAgICAgb3JpZ2luYWxBbW91bnQ6IGlzT3V0Ym91bmQgPyAtdHhuLmV2ZW50QW1vdW50IDogdHhuLmV2ZW50QW1vdW50LFxyXG4gICAgICBvcmlnaW5hbEN1cnJlbmN5OiAnSUxTJyxcclxuICAgICAgY2hhcmdlZEFtb3VudDogaXNPdXRib3VuZCA/IC10eG4uZXZlbnRBbW91bnQgOiB0eG4uZXZlbnRBbW91bnQsXHJcbiAgICAgIGRlc2NyaXB0aW9uOiB0eG4uYWN0aXZpdHlEZXNjcmlwdGlvbiB8fCAnJyxcclxuICAgICAgc3RhdHVzOiB0eG4uc2VyaWFsTnVtYmVyID09PSAwID8gVHJhbnNhY3Rpb25TdGF0dXNlcy5QZW5kaW5nIDogVHJhbnNhY3Rpb25TdGF0dXNlcy5Db21wbGV0ZWQsXHJcbiAgICAgIG1lbW8sXHJcbiAgICB9O1xyXG5cclxuICAgIGlmIChvcHRpb25zPy5pbmNsdWRlUmF3VHJhbnNhY3Rpb24pIHtcclxuICAgICAgcmVzdWx0LnJhd1RyYW5zYWN0aW9uID0gZ2V0UmF3VHJhbnNhY3Rpb24odHhuKTtcclxuICAgIH1cclxuXHJcbiAgICByZXR1cm4gcmVzdWx0O1xyXG4gIH0pO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBnZXRSZXN0Q29udGV4dChwYWdlOiBQYWdlKSB7XHJcbiAgYXdhaXQgd2FpdFVudGlsKCgpID0+IHtcclxuICAgIHJldHVybiBwYWdlLmV2YWx1YXRlKCgpID0+ICEhd2luZG93LmJuaHBBcHApO1xyXG4gIH0sICd3YWl0aW5nIGZvciBhcHAgZGF0YSBsb2FkJyk7XHJcblxyXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHBhZ2UuZXZhbHVhdGUoKCkgPT4ge1xyXG4gICAgcmV0dXJuIHdpbmRvdy5ibmhwQXBwLnJlc3RDb250ZXh0O1xyXG4gIH0pO1xyXG5cclxuICByZXR1cm4gcmVzdWx0LnNsaWNlKDEpO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBmZXRjaFBvYWxpbVhTUkZXaXRoaW5QYWdlKFxyXG4gIHBhZ2U6IFBhZ2UsXHJcbiAgdXJsOiBzdHJpbmcsXHJcbiAgcGFnZVV1aWQ6IHN0cmluZyxcclxuKTogUHJvbWlzZTxGZXRjaGVkQWNjb3VudFRyYW5zYWN0aW9uc0RhdGEgfCBudWxsPiB7XHJcbiAgY29uc3QgY29va2llcyA9IGF3YWl0IHBhZ2UuY29va2llcygpO1xyXG4gIGNvbnN0IFhTUkZDb29raWUgPSBjb29raWVzLmZpbmQoY29va2llID0+IGNvb2tpZS5uYW1lID09PSAnWFNSRi1UT0tFTicpO1xyXG4gIGNvbnN0IGhlYWRlcnM6IFJlY29yZDxzdHJpbmcsIGFueT4gPSB7fTtcclxuICBpZiAoWFNSRkNvb2tpZSAhPSBudWxsKSB7XHJcbiAgICBoZWFkZXJzWydYLVhTUkYtVE9LRU4nXSA9IFhTUkZDb29raWUudmFsdWU7XHJcbiAgfVxyXG4gIGhlYWRlcnMucGFnZVV1aWQgPSBwYWdlVXVpZDtcclxuICBoZWFkZXJzLnV1aWQgPSByYW5kb21VVUlEKCk7XHJcbiAgaGVhZGVyc1snQ29udGVudC1UeXBlJ10gPSAnYXBwbGljYXRpb24vanNvbjtjaGFyc2V0PVVURi04JztcclxuICByZXR1cm4gZmV0Y2hQb3N0V2l0aGluUGFnZTxGZXRjaGVkQWNjb3VudFRyYW5zYWN0aW9uc0RhdGE+KHBhZ2UsIHVybCwgW10sIGhlYWRlcnMpO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBnZXRFeHRyYVNjcmFwKFxyXG4gIHR4bnNSZXN1bHQ6IEZldGNoZWRBY2NvdW50VHJhbnNhY3Rpb25zRGF0YSxcclxuICBiYXNlVXJsOiBzdHJpbmcsXHJcbiAgcGFnZTogUGFnZSxcclxuICBhY2NvdW50TnVtYmVyOiBzdHJpbmcsXHJcbik6IFByb21pc2U8RmV0Y2hlZEFjY291bnRUcmFuc2FjdGlvbnNEYXRhPiB7XHJcbiAgY29uc3QgcHJvbWlzZXMgPSB0eG5zUmVzdWx0LnRyYW5zYWN0aW9ucy5tYXAoYXN5bmMgKHRyYW5zYWN0aW9uOiBTY3JhcGVkVHJhbnNhY3Rpb24pOiBQcm9taXNlPFNjcmFwZWRUcmFuc2FjdGlvbj4gPT4ge1xyXG4gICAgY29uc3QgeyBwZm1EZXRhaWxzLCBzZXJpYWxOdW1iZXIgfSA9IHRyYW5zYWN0aW9uO1xyXG4gICAgaWYgKHNlcmlhbE51bWJlciAhPT0gMCkge1xyXG4gICAgICBjb25zdCB1cmwgPSBgJHtiYXNlVXJsfSR7cGZtRGV0YWlsc30mYWNjb3VudElkPSR7YWNjb3VudE51bWJlcn0mbGFuZz1oZWA7XHJcbiAgICAgIGNvbnN0IGV4dHJhVHJhbnNhY3Rpb25EZXRhaWxzID0gKGF3YWl0IGZldGNoR2V0V2l0aGluUGFnZTxTY3JhcGVkUGZtVHJhbnNhY3Rpb25bXT4ocGFnZSwgdXJsKSkgfHwgW107XHJcbiAgICAgIGlmIChleHRyYVRyYW5zYWN0aW9uRGV0YWlscyAmJiBleHRyYVRyYW5zYWN0aW9uRGV0YWlscy5sZW5ndGgpIHtcclxuICAgICAgICBjb25zdCB7IHRyYW5zYWN0aW9uTnVtYmVyIH0gPSBleHRyYVRyYW5zYWN0aW9uRGV0YWlsc1swXTtcclxuICAgICAgICBpZiAodHJhbnNhY3Rpb25OdW1iZXIpIHtcclxuICAgICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgIC4uLnRyYW5zYWN0aW9uLFxyXG4gICAgICAgICAgICByZWZlcmVuY2VOdW1iZXI6IHRyYW5zYWN0aW9uTnVtYmVyLFxyXG4gICAgICAgICAgICBhZGRpdGlvbmFsSW5mb3JtYXRpb246IGV4dHJhVHJhbnNhY3Rpb25EZXRhaWxzLFxyXG4gICAgICAgICAgfTtcclxuICAgICAgICB9XHJcbiAgICAgIH1cclxuICAgIH1cclxuICAgIHJldHVybiB0cmFuc2FjdGlvbjtcclxuICB9KTtcclxuICBjb25zdCByZXMgPSBhd2FpdCBQcm9taXNlLmFsbChwcm9taXNlcyk7XHJcbiAgcmV0dXJuIHsgdHJhbnNhY3Rpb25zOiByZXMgfTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gZ2V0QWNjb3VudFRyYW5zYWN0aW9ucyhcclxuICBiYXNlVXJsOiBzdHJpbmcsXHJcbiAgYXBpU2l0ZVVybDogc3RyaW5nLFxyXG4gIHBhZ2U6IFBhZ2UsXHJcbiAgYWNjb3VudE51bWJlcjogc3RyaW5nLFxyXG4gIHN0YXJ0RGF0ZTogc3RyaW5nLFxyXG4gIGVuZERhdGU6IHN0cmluZyxcclxuICBhZGRpdGlvbmFsVHJhbnNhY3Rpb25JbmZvcm1hdGlvbiA9IGZhbHNlLFxyXG4gIG9wdGlvbnM/OiBTY3JhcGVyT3B0aW9ucyxcclxuKSB7XHJcbiAgY29uc3QgdHhuc1VybCA9IGAke2FwaVNpdGVVcmx9L2N1cnJlbnQtYWNjb3VudC90cmFuc2FjdGlvbnM/YWNjb3VudElkPSR7YWNjb3VudE51bWJlcn0mbnVtSXRlbXNQZXJQYWdlPTEwMDAmcmV0cmlldmFsRW5kRGF0ZT0ke2VuZERhdGV9JnJldHJpZXZhbFN0YXJ0RGF0ZT0ke3N0YXJ0RGF0ZX0mc29ydENvZGU9MWA7XHJcbiAgY29uc3QgdHhuc1Jlc3VsdCA9IGF3YWl0IGZldGNoUG9hbGltWFNSRldpdGhpblBhZ2UocGFnZSwgdHhuc1VybCwgJy9jdXJyZW50LWFjY291bnQvdHJhbnNhY3Rpb25zJyk7XHJcblxyXG4gIGNvbnN0IGZpbmFsUmVzdWx0ID1cclxuICAgIGFkZGl0aW9uYWxUcmFuc2FjdGlvbkluZm9ybWF0aW9uICYmIHR4bnNSZXN1bHQ/LnRyYW5zYWN0aW9ucy5sZW5ndGhcclxuICAgICAgPyBhd2FpdCBnZXRFeHRyYVNjcmFwKHR4bnNSZXN1bHQsIGJhc2VVcmwsIHBhZ2UsIGFjY291bnROdW1iZXIpXHJcbiAgICAgIDogdHhuc1Jlc3VsdDtcclxuXHJcbiAgcmV0dXJuIGNvbnZlcnRUcmFuc2FjdGlvbnMoZmluYWxSZXN1bHQ/LnRyYW5zYWN0aW9ucyA/PyBbXSwgb3B0aW9ucyk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGdldEFjY291bnRCYWxhbmNlKGFwaVNpdGVVcmw6IHN0cmluZywgcGFnZTogUGFnZSwgYWNjb3VudE51bWJlcjogc3RyaW5nKSB7XHJcbiAgY29uc3QgYmFsYW5jZUFuZENyZWRpdExpbWl0VXJsID0gYCR7YXBpU2l0ZVVybH0vY3VycmVudC1hY2NvdW50L2NvbXBvc2l0ZS9iYWxhbmNlQW5kQ3JlZGl0TGltaXQ/YWNjb3VudElkPSR7YWNjb3VudE51bWJlcn0mdmlldz1kZXRhaWxzJmxhbmc9aGVgO1xyXG4gIGNvbnN0IGJhbGFuY2VBbmRDcmVkaXRMaW1pdCA9IGF3YWl0IGZldGNoR2V0V2l0aGluUGFnZTxCYWxhbmNlQW5kQ3JlZGl0TGltaXQ+KHBhZ2UsIGJhbGFuY2VBbmRDcmVkaXRMaW1pdFVybCk7XHJcblxyXG4gIHJldHVybiBiYWxhbmNlQW5kQ3JlZGl0TGltaXQ/LmN1cnJlbnRCYWxhbmNlO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBmZXRjaEFjY291bnREYXRhKHBhZ2U6IFBhZ2UsIGJhc2VVcmw6IHN0cmluZywgb3B0aW9uczogU2NyYXBlck9wdGlvbnMpIHtcclxuICBjb25zdCByZXN0Q29udGV4dCA9IGF3YWl0IGdldFJlc3RDb250ZXh0KHBhZ2UpO1xyXG4gIGNvbnN0IGFwaVNpdGVVcmwgPSBgJHtiYXNlVXJsfS8ke3Jlc3RDb250ZXh0fWA7XHJcbiAgY29uc3QgYWNjb3VudERhdGFVcmwgPSBgJHtiYXNlVXJsfS9TZXJ2ZXJTZXJ2aWNlcy9nZW5lcmFsL2FjY291bnRzYDtcclxuXHJcbiAgZGVidWcoJ2ZldGNoaW5nIGFjY291bnRzIGRhdGEnKTtcclxuICBjb25zdCBhY2NvdW50c0luZm8gPSAoYXdhaXQgZmV0Y2hHZXRXaXRoaW5QYWdlPEZldGNoZWRBY2NvdW50RGF0YT4ocGFnZSwgYWNjb3VudERhdGFVcmwpKSB8fCBbXTtcclxuICBjb25zdCBvcGVuQWNjb3VudHNJbmZvID0gYWNjb3VudHNJbmZvLmZpbHRlcihhY2NvdW50ID0+IGFjY291bnQuYWNjb3VudENsb3NpbmdSZWFzb25Db2RlID09PSAwKTtcclxuICBkZWJ1ZyhcclxuICAgICdnb3QgJWQgb3BlbiBhY2NvdW50cyBmcm9tICVkIHRvdGFsIGFjY291bnRzLCBmZXRjaGluZyB0eG5zIGFuZCBiYWxhbmNlJyxcclxuICAgIG9wZW5BY2NvdW50c0luZm8ubGVuZ3RoLFxyXG4gICAgYWNjb3VudHNJbmZvLmxlbmd0aCxcclxuICApO1xyXG5cclxuICBjb25zdCBkZWZhdWx0U3RhcnRNb21lbnQgPSBtb21lbnQoKS5zdWJ0cmFjdCgxLCAneWVhcnMnKS5hZGQoMSwgJ2RheScpO1xyXG4gIGNvbnN0IHN0YXJ0RGF0ZSA9IG9wdGlvbnMuc3RhcnREYXRlIHx8IGRlZmF1bHRTdGFydE1vbWVudC50b0RhdGUoKTtcclxuICBjb25zdCBzdGFydE1vbWVudCA9IG1vbWVudC5tYXgoZGVmYXVsdFN0YXJ0TW9tZW50LCBtb21lbnQoc3RhcnREYXRlKSk7XHJcbiAgY29uc3QgeyBhZGRpdGlvbmFsVHJhbnNhY3Rpb25JbmZvcm1hdGlvbiB9ID0gb3B0aW9ucztcclxuXHJcbiAgY29uc3Qgc3RhcnREYXRlU3RyID0gc3RhcnRNb21lbnQuZm9ybWF0KERBVEVfRk9STUFUKTtcclxuICBjb25zdCBlbmREYXRlU3RyID0gbW9tZW50KCkuZm9ybWF0KERBVEVfRk9STUFUKTtcclxuXHJcbiAgY29uc3QgYWNjb3VudHM6IFRyYW5zYWN0aW9uc0FjY291bnRbXSA9IFtdO1xyXG5cclxuICBmb3IgKGNvbnN0IGFjY291bnQgb2Ygb3BlbkFjY291bnRzSW5mbykge1xyXG4gICAgZGVidWcoJ2dldHRpbmcgaW5mb3JtYXRpb24gZm9yIGFjY291bnQgJXMnLCBhY2NvdW50LmFjY291bnROdW1iZXIpO1xyXG4gICAgY29uc3QgYWNjb3VudE51bWJlciA9IGAke2FjY291bnQuYmFua051bWJlcn0tJHthY2NvdW50LmJyYW5jaE51bWJlcn0tJHthY2NvdW50LmFjY291bnROdW1iZXJ9YDtcclxuXHJcbiAgICBjb25zdCBiYWxhbmNlID0gYXdhaXQgZ2V0QWNjb3VudEJhbGFuY2UoYXBpU2l0ZVVybCwgcGFnZSwgYWNjb3VudE51bWJlcik7XHJcbiAgICBjb25zdCB0eG5zID0gYXdhaXQgZ2V0QWNjb3VudFRyYW5zYWN0aW9ucyhcclxuICAgICAgYmFzZVVybCxcclxuICAgICAgYXBpU2l0ZVVybCxcclxuICAgICAgcGFnZSxcclxuICAgICAgYWNjb3VudE51bWJlcixcclxuICAgICAgc3RhcnREYXRlU3RyLFxyXG4gICAgICBlbmREYXRlU3RyLFxyXG4gICAgICBhZGRpdGlvbmFsVHJhbnNhY3Rpb25JbmZvcm1hdGlvbixcclxuICAgICAgb3B0aW9ucyxcclxuICAgICk7XHJcblxyXG4gICAgYWNjb3VudHMucHVzaCh7XHJcbiAgICAgIGFjY291bnROdW1iZXIsXHJcbiAgICAgIGJhbGFuY2UsXHJcbiAgICAgIHR4bnMsXHJcbiAgICB9KTtcclxuICB9XHJcblxyXG4gIGNvbnN0IGFjY291bnREYXRhID0ge1xyXG4gICAgc3VjY2VzczogdHJ1ZSxcclxuICAgIGFjY291bnRzLFxyXG4gIH07XHJcbiAgZGVidWcoJ2ZldGNoaW5nIGVuZGVkJyk7XHJcbiAgcmV0dXJuIGFjY291bnREYXRhO1xyXG59XHJcblxyXG5jb25zdCBPVFBfRk9STV9TRUxFQ1RPUiA9ICdmb3JtLmF1dGgtb3RwLWxvZ2luJztcclxuY29uc3QgT1RQX1NVQk1JVF9TRUxFQ1RPUiA9ICcuYnRuLXJlZF8xJztcclxuY29uc3QgT1RQX0VSUk9SX1NFTEVDVE9SID0gJy5lcnJvcnMtcmIgLmVycm9yLW1lc3NhZ2UsIC5hdXRoLW90cC1sb2dpbiAuZXJyb3InO1xyXG5cclxuZnVuY3Rpb24gZ2V0UG9zc2libGVMb2dpblJlc3VsdHMoYmFzZVVybDogc3RyaW5nKSB7XHJcbiAgY29uc3QgdXJsczogUG9zc2libGVMb2dpblJlc3VsdHMgPSB7fTtcclxuICB1cmxzW0xvZ2luUmVzdWx0cy5TdWNjZXNzXSA9IFtcclxuICAgIGAke2Jhc2VVcmx9L3BvcnRhbHNlcnZlci9Ib21lUGFnZWAsXHJcbiAgICBgJHtiYXNlVXJsfS9uZy1wb3J0YWxzLWJ0L3JiL2hlL2hvbWVwYWdlYCxcclxuICAgIGAke2Jhc2VVcmx9L25nLXBvcnRhbHMvcmIvaGUvaG9tZXBhZ2VgLFxyXG4gIF07XHJcbiAgdXJsc1tMb2dpblJlc3VsdHMuSW52YWxpZFBhc3N3b3JkXSA9IFtcclxuICAgIGAke2Jhc2VVcmx9L0FVVEhFTlRJQ0FURS9MT0dPTj9mbG93PUFVVEhFTlRJQ0FURSZzdGF0ZT1MT0dPTiZlcnJvcmNvZGU9MS42JmNhbGxtZT1mYWxzZWAsXHJcbiAgXTtcclxuICB1cmxzW0xvZ2luUmVzdWx0cy5DaGFuZ2VQYXNzd29yZF0gPSBbXHJcbiAgICBgJHtiYXNlVXJsfS9NQ1AvU1RBUlQ/Zmxvdz1NQ1Amc3RhdGU9U1RBUlQmZXhwaXJlZERhdGU9bnVsbGAsXHJcbiAgICAvXFwvQUJPVVRUT0VYUElSRVxcL1NUQVJUL2ksXHJcbiAgXTtcclxuICB1cmxzW0xvZ2luUmVzdWx0cy5Ud29GYWN0b3JSZXRyaWV2ZXJNaXNzaW5nXSA9IFtcclxuICAgIGFzeW5jIChvcHRpb25zPzogeyBwYWdlPzogUGFnZSB9KSA9PiB7XHJcbiAgICAgIGlmICghb3B0aW9ucz8ucGFnZSkgcmV0dXJuIGZhbHNlO1xyXG4gICAgICByZXR1cm4gISEoYXdhaXQgb3B0aW9ucy5wYWdlLiQoT1RQX0ZPUk1fU0VMRUNUT1IpKTtcclxuICAgIH0sXHJcbiAgXTtcclxuICByZXR1cm4gdXJscztcclxufVxyXG5cclxuZnVuY3Rpb24gY3JlYXRlTG9naW5GaWVsZHMoY3JlZGVudGlhbHM6IFNjcmFwZXJTcGVjaWZpY0NyZWRlbnRpYWxzKSB7XHJcbiAgcmV0dXJuIFtcclxuICAgIHsgc2VsZWN0b3I6ICcjdXNlckNvZGUnLCB2YWx1ZTogY3JlZGVudGlhbHMudXNlckNvZGUgfSxcclxuICAgIHsgc2VsZWN0b3I6ICcjcGFzc3dvcmQnLCB2YWx1ZTogY3JlZGVudGlhbHMucGFzc3dvcmQgfSxcclxuICBdO1xyXG59XHJcblxyXG50eXBlIFNjcmFwZXJTcGVjaWZpY0NyZWRlbnRpYWxzID0ge1xyXG4gIHVzZXJDb2RlOiBzdHJpbmc7XHJcbiAgcGFzc3dvcmQ6IHN0cmluZztcclxuICBvdHBDb2RlUmV0cmlldmVyPzogKG9wdGlvbnM/OiB7IGF0dGVtcHQ6IG51bWJlciB9KSA9PiBQcm9taXNlPHN0cmluZz47XHJcbn07XHJcblxyXG5jbGFzcyBIYXBvYWxpbVNjcmFwZXIgZXh0ZW5kcyBCYXNlU2NyYXBlcldpdGhCcm93c2VyPFNjcmFwZXJTcGVjaWZpY0NyZWRlbnRpYWxzPiB7XHJcbiAgZ2V0IGJhc2VVcmwoKSB7XHJcbiAgICByZXR1cm4gJ2h0dHBzOi8vbG9naW4uYmFua2hhcG9hbGltLmNvLmlsJztcclxuICB9XHJcblxyXG4gIGdldExvZ2luT3B0aW9ucyhjcmVkZW50aWFsczogU2NyYXBlclNwZWNpZmljQ3JlZGVudGlhbHMpIHtcclxuICAgIHJldHVybiB7XHJcbiAgICAgIGxvZ2luVXJsOiBgJHt0aGlzLmJhc2VVcmx9L2NnaS1iaW4vcG9hbHd3d2M/cmVxTmFtZT1nZXRMb2dvblBhZ2VgLFxyXG4gICAgICBmaWVsZHM6IGNyZWF0ZUxvZ2luRmllbGRzKGNyZWRlbnRpYWxzKSxcclxuICAgICAgc3VibWl0QnV0dG9uU2VsZWN0b3I6ICcubG9naW4tYnRuJyxcclxuICAgICAgcG9zdEFjdGlvbjogYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IGluaXRpYWxVcmwgPSBhd2FpdCBnZXRDdXJyZW50VXJsKHRoaXMucGFnZSwgdHJ1ZSk7XHJcbiAgICAgICAgYXdhaXQgd2FpdFVudGlsKFxyXG4gICAgICAgICAgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICAgIGNvbnN0IGN1cnJlbnRVcmwgPSBhd2FpdCBnZXRDdXJyZW50VXJsKHRoaXMucGFnZSwgdHJ1ZSk7XHJcbiAgICAgICAgICAgICAgaWYgKGN1cnJlbnRVcmwgIT09IGluaXRpYWxVcmwpIHJldHVybiB0cnVlO1xyXG4gICAgICAgICAgICAgIHJldHVybiAhIShhd2FpdCB0aGlzLnBhZ2UuJChPVFBfRk9STV9TRUxFQ1RPUikpO1xyXG4gICAgICAgICAgICB9IGNhdGNoIHtcclxuICAgICAgICAgICAgICAvLyBOYXZpZ2F0aW9uIGRlc3Ryb3llZCB0aGUgZXhlY3V0aW9uIGNvbnRleHQg4oCUIHBhZ2UgaXMgcmVkaXJlY3RpbmcsIHdoaWNoIGlzIHByb2dyZXNzXHJcbiAgICAgICAgICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgIH0sXHJcbiAgICAgICAgICAnd2FpdGluZyBmb3IgcmVkaXJlY3Qgb3IgT1RQIGZvcm0nLFxyXG4gICAgICAgICAgMjAwMDAsXHJcbiAgICAgICAgICAxMDAwLFxyXG4gICAgICAgICk7XHJcbiAgICAgIH0sXHJcbiAgICAgIHBvc3NpYmxlUmVzdWx0czogZ2V0UG9zc2libGVMb2dpblJlc3VsdHModGhpcy5iYXNlVXJsKSxcclxuICAgIH07XHJcbiAgfVxyXG5cclxuICBhc3luYyBsb2dpbihjcmVkZW50aWFsczogU2NyYXBlclNwZWNpZmljQ3JlZGVudGlhbHMpOiBQcm9taXNlPFNjcmFwZXJMb2dpblJlc3VsdD4ge1xyXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgc3VwZXIubG9naW4oY3JlZGVudGlhbHMpO1xyXG5cclxuICAgIGlmIChyZXN1bHQuc3VjY2VzcyB8fCByZXN1bHQuZXJyb3JUeXBlICE9PSBTY3JhcGVyRXJyb3JUeXBlcy5Ud29GYWN0b3JSZXRyaWV2ZXJNaXNzaW5nKSB7XHJcbiAgICAgIHJldHVybiByZXN1bHQ7XHJcbiAgICB9XHJcblxyXG4gICAgLy8gMkZBIHBhZ2UgZGV0ZWN0ZWQg4oCUIG5lZWQgT1RQXHJcbiAgICBpZiAoIWNyZWRlbnRpYWxzLm90cENvZGVSZXRyaWV2ZXIpIHtcclxuICAgICAgZGVidWcoJzJGQSByZXF1aXJlZCBidXQgbm8gb3RwQ29kZVJldHJpZXZlciBwcm92aWRlZCcpO1xyXG4gICAgICByZXR1cm4ge1xyXG4gICAgICAgIHN1Y2Nlc3M6IGZhbHNlLFxyXG4gICAgICAgIGVycm9yVHlwZTogU2NyYXBlckVycm9yVHlwZXMuVHdvRmFjdG9yUmV0cmlldmVyTWlzc2luZyxcclxuICAgICAgICBlcnJvck1lc3NhZ2U6ICdPVFAgY29kZSByZXRyaWV2ZXIgaXMgcmVxdWlyZWQgZm9yIEhhcG9hbGltIDJGQScsXHJcbiAgICAgIH07XHJcbiAgICB9XHJcblxyXG4gICAgY29uc3QgTUFYX09UUF9BVFRFTVBUUyA9IDM7XHJcbiAgICBmb3IgKGxldCBhdHRlbXB0ID0gMTsgYXR0ZW1wdCA8PSBNQVhfT1RQX0FUVEVNUFRTOyBhdHRlbXB0KyspIHtcclxuICAgICAgZGVidWcoYDJGQSBwYWdlIGRldGVjdGVkLCByZXF1ZXN0aW5nIE9UUCBmcm9tIGNhbGxlciAoYXR0ZW1wdCAke2F0dGVtcHR9LyR7TUFYX09UUF9BVFRFTVBUU30pYCk7XHJcbiAgICAgIGNvbnN0IG90cENvZGUgPSBhd2FpdCBjcmVkZW50aWFscy5vdHBDb2RlUmV0cmlldmVyKHsgYXR0ZW1wdCB9KTtcclxuXHJcbiAgICAgIGRlYnVnKCdlbnRlcmluZyBPVFAgY29kZScpO1xyXG4gICAgICBjb25zdCBvdHBJbnB1dHMgPSBhd2FpdCB0aGlzLnBhZ2UuJCQoYCR7T1RQX0ZPUk1fU0VMRUNUT1J9IGlucHV0W3R5cGU9XCJ0ZXh0XCJdYCk7XHJcbiAgICAgIGRlYnVnKCdmb3VuZCAlZCBPVFAgZGlnaXQgaW5wdXRzJywgb3RwSW5wdXRzLmxlbmd0aCk7XHJcblxyXG4gICAgICBmb3IgKGxldCBpID0gMDsgaSA8IG90cElucHV0cy5sZW5ndGg7IGkrKykge1xyXG4gICAgICAgIGF3YWl0IG90cElucHV0c1tpXS5jbGljaygpO1xyXG4gICAgICAgIGF3YWl0IG90cElucHV0c1tpXS5ldmFsdWF0ZShlbCA9PiB7XHJcbiAgICAgICAgICBlbC52YWx1ZSA9ICcnO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIGlmIChpIDwgb3RwQ29kZS5sZW5ndGgpIHtcclxuICAgICAgICAgIGF3YWl0IG90cElucHV0c1tpXS50eXBlKG90cENvZGVbaV0sIHsgZGVsYXk6IDUwIH0pO1xyXG4gICAgICAgIH1cclxuICAgICAgICBhd2FpdCBzbGVlcCgxMDApO1xyXG4gICAgICB9XHJcblxyXG4gICAgICBkZWJ1Zygnc3VibWl0dGluZyBPVFAnKTtcclxuICAgICAgLy8gVXNlIHBhZ2UuY2xpY2soKSBmb3IgcHJvcGVyIG1vdXNlIGV2ZW50cyDigJQgY2xpY2tCdXR0b24gdXNlcyBzeW50aGV0aWMgZWwuY2xpY2soKVxyXG4gICAgICAvLyB3aGljaCBBbmd1bGFyIGlnbm9yZXMuXHJcbiAgICAgIGF3YWl0IHRoaXMucGFnZS5jbGljayhPVFBfU1VCTUlUX1NFTEVDVE9SKTtcclxuXHJcbiAgICAgIHRyeSB7XHJcbiAgICAgICAgYXdhaXQgd2FpdFVudGlsKFxyXG4gICAgICAgICAgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgICAgICBjb25zdCBvdHBGb3JtID0gYXdhaXQgdGhpcy5wYWdlLiQoT1RQX0ZPUk1fU0VMRUNUT1IpO1xyXG4gICAgICAgICAgICBjb25zdCBlcnJvckVsID0gYXdhaXQgdGhpcy5wYWdlLiQoT1RQX0VSUk9SX1NFTEVDVE9SKTtcclxuICAgICAgICAgICAgY29uc3QgdXJsID0gYXdhaXQgZ2V0Q3VycmVudFVybCh0aGlzLnBhZ2UsIHRydWUpO1xyXG4gICAgICAgICAgICBkZWJ1ZygnT1RQIHBvbGw6IGZvcm09JXMsIGVycm9yPSVzLCB1cmw9JXMnLCAhIW90cEZvcm0sICEhZXJyb3JFbCwgdXJsKTtcclxuICAgICAgICAgICAgaWYgKCFvdHBGb3JtKSByZXR1cm4gJ3N1Y2Nlc3MnO1xyXG4gICAgICAgICAgICBpZiAoZXJyb3JFbCkgcmV0dXJuICdlcnJvcic7XHJcbiAgICAgICAgICAgIHJldHVybiBmYWxzZTtcclxuICAgICAgICAgIH0sXHJcbiAgICAgICAgICAnd2FpdGluZyBmb3IgT1RQIHJlc3VsdCcsXHJcbiAgICAgICAgICAyMDAwMCxcclxuICAgICAgICAgIDEwMDAsXHJcbiAgICAgICAgKTtcclxuICAgICAgfSBjYXRjaCB7XHJcbiAgICAgICAgLy8gVGltZW91dDogZXJyb3Igc2VsZWN0b3IgZGlkbid0IG1hdGNoIGJ1dCBmb3JtIGlzIHN0aWxsIHNob3dpbmcg4oCUIHRyZWF0IGFzIHdyb25nIE9UUFxyXG4gICAgICAgIGRlYnVnKCdPVFAgd2FpdFVudGlsIHRpbWVkIG91dCDigJQgdHJlYXRpbmcgYXMgd3JvbmcgT1RQJyk7XHJcbiAgICAgIH1cclxuXHJcbiAgICAgIGlmICghKGF3YWl0IHRoaXMucGFnZS4kKE9UUF9GT1JNX1NFTEVDVE9SKSkpIHtcclxuICAgICAgICAvLyBPVFAgZm9ybSBjbG9zZWQg4oCUIHdhaXQgZm9yIHRoZSBiYW5rIHRvIG5hdmlnYXRlIHRvIGhvbWVwYWdlXHJcbiAgICAgICAgY29uc3Qgc3VjY2Vzc1BhdHRlcm5zID0gW1xyXG4gICAgICAgICAgJy9wb3J0YWxzZXJ2ZXIvSG9tZVBhZ2UnLFxyXG4gICAgICAgICAgJy9uZy1wb3J0YWxzLWJ0L3JiL2hlL2hvbWVwYWdlJyxcclxuICAgICAgICAgICcvbmctcG9ydGFscy9yYi9oZS9ob21lcGFnZScsXHJcbiAgICAgICAgXTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgYXdhaXQgd2FpdFVudGlsKFxyXG4gICAgICAgICAgICBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgICAgICAgY29uc3QgdXJsID0gYXdhaXQgZ2V0Q3VycmVudFVybCh0aGlzLnBhZ2UsIHRydWUpO1xyXG4gICAgICAgICAgICAgIGRlYnVnKCdwb3N0LU9UUCBuYXZpZ2F0aW9uIHBvbGw6IHVybD0lcycsIHVybCk7XHJcbiAgICAgICAgICAgICAgcmV0dXJuIHN1Y2Nlc3NQYXR0ZXJucy5zb21lKHAgPT4gdXJsLmluY2x1ZGVzKHApKTtcclxuICAgICAgICAgICAgfSxcclxuICAgICAgICAgICAgJ3dhaXRpbmcgZm9yIHBvc3QtT1RQIG5hdmlnYXRpb24nLFxyXG4gICAgICAgICAgICAxMDAwMCxcclxuICAgICAgICAgICAgMTAwMCxcclxuICAgICAgICAgICk7XHJcbiAgICAgICAgICBkZWJ1ZygnT1RQIHZlcmlmaWNhdGlvbiBzdWNjZWVkZWQnKTtcclxuICAgICAgICAgIHJldHVybiB7IHN1Y2Nlc3M6IHRydWUgfTtcclxuICAgICAgICB9IGNhdGNoIHtcclxuICAgICAgICAgIGNvbnN0IGN1cnJlbnQgPSBhd2FpdCBnZXRDdXJyZW50VXJsKHRoaXMucGFnZSwgdHJ1ZSk7XHJcbiAgICAgICAgICBkZWJ1ZygnT1RQIHZlcmlmaWNhdGlvbiBmYWlsZWQsIGN1cnJlbnQgdXJsOiAlcycsIGN1cnJlbnQpO1xyXG4gICAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgc3VjY2VzczogZmFsc2UsXHJcbiAgICAgICAgICAgIGVycm9yVHlwZTogU2NyYXBlckVycm9yVHlwZXMuR2VuZXJhbCxcclxuICAgICAgICAgICAgZXJyb3JNZXNzYWdlOiAnT1RQIHZlcmlmaWNhdGlvbiBmYWlsZWQnLFxyXG4gICAgICAgICAgfTtcclxuICAgICAgICB9XHJcbiAgICAgIH1cclxuXHJcbiAgICAgIGRlYnVnKGBPVFAgYXR0ZW1wdCAke2F0dGVtcHR9IGZhaWxlZCDigJQgaW5saW5lIGVycm9yIGRldGVjdGVkYCk7XHJcbiAgICAgIGlmIChhdHRlbXB0ID09PSBNQVhfT1RQX0FUVEVNUFRTKSB7XHJcbiAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgIHN1Y2Nlc3M6IGZhbHNlLFxyXG4gICAgICAgICAgZXJyb3JUeXBlOiBTY3JhcGVyRXJyb3JUeXBlcy5HZW5lcmFsLFxyXG4gICAgICAgICAgZXJyb3JNZXNzYWdlOiBgT1RQIHZlcmlmaWNhdGlvbiBmYWlsZWQgYWZ0ZXIgJHtNQVhfT1RQX0FUVEVNUFRTfSBhdHRlbXB0c2AsXHJcbiAgICAgICAgfTtcclxuICAgICAgfVxyXG4gICAgfVxyXG5cclxuICAgIHJldHVybiB7XHJcbiAgICAgIHN1Y2Nlc3M6IGZhbHNlLFxyXG4gICAgICBlcnJvclR5cGU6IFNjcmFwZXJFcnJvclR5cGVzLkdlbmVyYWwsXHJcbiAgICAgIGVycm9yTWVzc2FnZTogJ09UUCB2ZXJpZmljYXRpb24gZmFpbGVkJyxcclxuICAgIH07XHJcbiAgfVxyXG5cclxuICBhc3luYyBmZXRjaERhdGEoKSB7XHJcbiAgICByZXR1cm4gZmV0Y2hBY2NvdW50RGF0YSh0aGlzLnBhZ2UsIHRoaXMuYmFzZVVybCwgdGhpcy5vcHRpb25zKTtcclxuICB9XHJcbn1cclxuXHJcbmV4cG9ydCBkZWZhdWx0IEhhcG9hbGltU2NyYXBlcjtcclxuIl0sIm1hcHBpbmdzIjoiOzs7Ozs7QUFBQSxJQUFBQSxPQUFBLEdBQUFDLHNCQUFBLENBQUFDLE9BQUE7QUFFQSxJQUFBQyxPQUFBLEdBQUFELE9BQUE7QUFDQSxJQUFBRSxNQUFBLEdBQUFGLE9BQUE7QUFDQSxJQUFBRyxNQUFBLEdBQUFILE9BQUE7QUFDQSxJQUFBSSxXQUFBLEdBQUFKLE9BQUE7QUFDQSxJQUFBSyxRQUFBLEdBQUFMLE9BQUE7QUFDQSxJQUFBTSxhQUFBLEdBQUFOLE9BQUE7QUFDQSxJQUFBTyx1QkFBQSxHQUFBUCxPQUFBO0FBQ0EsSUFBQVEsT0FBQSxHQUFBUixPQUFBO0FBRUEsSUFBQVMsY0FBQSxHQUFBVCxPQUFBO0FBQTRELFNBQUFELHVCQUFBVyxDQUFBLFdBQUFBLENBQUEsSUFBQUEsQ0FBQSxDQUFBQyxVQUFBLEdBQUFELENBQUEsS0FBQUUsT0FBQSxFQUFBRixDQUFBO0FBRTVELE1BQU1HLEtBQUssR0FBRyxJQUFBQyxlQUFRLEVBQUMsVUFBVSxDQUFDO0FBRWxDLE1BQU1DLFdBQVcsR0FBRyxVQUFVOztBQUU5Qjs7QUFtREEsU0FBU0MsbUJBQW1CQSxDQUFDQyxJQUEwQixFQUFFQyxPQUF3QixFQUFpQjtFQUNoRyxPQUFPRCxJQUFJLENBQUNFLEdBQUcsQ0FBQ0MsR0FBRyxJQUFJO0lBQ3JCLE1BQU1DLFVBQVUsR0FBR0QsR0FBRyxDQUFDRSxxQkFBcUIsS0FBSyxDQUFDO0lBRWxELElBQUlDLElBQUksR0FBRyxFQUFFO0lBQ2IsSUFBSUgsR0FBRyxDQUFDSSxzQkFBc0IsRUFBRTtNQUM5QixNQUFNO1FBQUVDLGFBQWE7UUFBRUMsU0FBUztRQUFFQyxlQUFlO1FBQUVDO01BQWMsQ0FBQyxHQUFHUixHQUFHLENBQUNJLHNCQUFzQjtNQUMvRixNQUFNSyxTQUFtQixHQUFHLEVBQUU7TUFDOUIsSUFBSUosYUFBYSxFQUFFO1FBQ2pCSSxTQUFTLENBQUNDLElBQUksQ0FBQ0wsYUFBYSxDQUFDO01BQy9CO01BRUEsSUFBSUMsU0FBUyxFQUFFO1FBQ2JHLFNBQVMsQ0FBQ0MsSUFBSSxDQUFDLEdBQUdKLFNBQVMsR0FBRyxDQUFDO01BQ2pDO01BRUEsSUFBSUMsZUFBZSxFQUFFO1FBQ25CRSxTQUFTLENBQUNDLElBQUksQ0FBQ0gsZUFBZSxDQUFDO01BQ2pDO01BRUEsSUFBSUMsYUFBYSxFQUFFO1FBQ2pCQyxTQUFTLENBQUNDLElBQUksQ0FBQyxHQUFHRixhQUFhLEdBQUcsQ0FBQztNQUNyQztNQUVBLElBQUlDLFNBQVMsQ0FBQ0UsTUFBTSxFQUFFO1FBQ3BCUixJQUFJLEdBQUdNLFNBQVMsQ0FBQ0csSUFBSSxDQUFDLEdBQUcsQ0FBQztNQUM1QjtJQUNGO0lBRUEsTUFBTUMsTUFBbUIsR0FBRztNQUMxQkMsSUFBSSxFQUFFQyw4QkFBZ0IsQ0FBQ0MsTUFBTTtNQUM3QkMsVUFBVSxFQUFFakIsR0FBRyxDQUFDa0IsZUFBZTtNQUMvQkMsSUFBSSxFQUFFLElBQUFDLGVBQU0sRUFBQ3BCLEdBQUcsQ0FBQ3FCLFNBQVMsRUFBRTFCLFdBQVcsQ0FBQyxDQUFDMkIsV0FBVyxDQUFDLENBQUM7TUFDdERDLGFBQWEsRUFBRSxJQUFBSCxlQUFNLEVBQUNwQixHQUFHLENBQUN3QixTQUFTLEVBQUU3QixXQUFXLENBQUMsQ0FBQzJCLFdBQVcsQ0FBQyxDQUFDO01BQy9ERyxjQUFjLEVBQUV4QixVQUFVLEdBQUcsQ0FBQ0QsR0FBRyxDQUFDMEIsV0FBVyxHQUFHMUIsR0FBRyxDQUFDMEIsV0FBVztNQUMvREMsZ0JBQWdCLEVBQUUsS0FBSztNQUN2QkMsYUFBYSxFQUFFM0IsVUFBVSxHQUFHLENBQUNELEdBQUcsQ0FBQzBCLFdBQVcsR0FBRzFCLEdBQUcsQ0FBQzBCLFdBQVc7TUFDOURHLFdBQVcsRUFBRTdCLEdBQUcsQ0FBQzhCLG1CQUFtQixJQUFJLEVBQUU7TUFDMUNDLE1BQU0sRUFBRS9CLEdBQUcsQ0FBQ2dDLFlBQVksS0FBSyxDQUFDLEdBQUdDLGlDQUFtQixDQUFDQyxPQUFPLEdBQUdELGlDQUFtQixDQUFDRSxTQUFTO01BQzVGaEM7SUFDRixDQUFDO0lBRUQsSUFBSUwsT0FBTyxFQUFFc0MscUJBQXFCLEVBQUU7TUFDbEN2QixNQUFNLENBQUN3QixjQUFjLEdBQUcsSUFBQUMsZ0NBQWlCLEVBQUN0QyxHQUFHLENBQUM7SUFDaEQ7SUFFQSxPQUFPYSxNQUFNO0VBQ2YsQ0FBQyxDQUFDO0FBQ0o7QUFFQSxlQUFlMEIsY0FBY0EsQ0FBQ0MsSUFBVSxFQUFFO0VBQ3hDLE1BQU0sSUFBQUMsa0JBQVMsRUFBQyxNQUFNO0lBQ3BCLE9BQU9ELElBQUksQ0FBQ0UsUUFBUSxDQUFDLE1BQU0sQ0FBQyxDQUFDQyxNQUFNLENBQUNDLE9BQU8sQ0FBQztFQUM5QyxDQUFDLEVBQUUsMkJBQTJCLENBQUM7RUFFL0IsTUFBTS9CLE1BQU0sR0FBRyxNQUFNMkIsSUFBSSxDQUFDRSxRQUFRLENBQUMsTUFBTTtJQUN2QyxPQUFPQyxNQUFNLENBQUNDLE9BQU8sQ0FBQ0MsV0FBVztFQUNuQyxDQUFDLENBQUM7RUFFRixPQUFPaEMsTUFBTSxDQUFDaUMsS0FBSyxDQUFDLENBQUMsQ0FBQztBQUN4QjtBQUVBLGVBQWVDLHlCQUF5QkEsQ0FDdENQLElBQVUsRUFDVlEsR0FBVyxFQUNYQyxRQUFnQixFQUNnQztFQUNoRCxNQUFNQyxPQUFPLEdBQUcsTUFBTVYsSUFBSSxDQUFDVSxPQUFPLENBQUMsQ0FBQztFQUNwQyxNQUFNQyxVQUFVLEdBQUdELE9BQU8sQ0FBQ0UsSUFBSSxDQUFDQyxNQUFNLElBQUlBLE1BQU0sQ0FBQ0MsSUFBSSxLQUFLLFlBQVksQ0FBQztFQUN2RSxNQUFNQyxPQUE0QixHQUFHLENBQUMsQ0FBQztFQUN2QyxJQUFJSixVQUFVLElBQUksSUFBSSxFQUFFO0lBQ3RCSSxPQUFPLENBQUMsY0FBYyxDQUFDLEdBQUdKLFVBQVUsQ0FBQ0ssS0FBSztFQUM1QztFQUNBRCxPQUFPLENBQUNOLFFBQVEsR0FBR0EsUUFBUTtFQUMzQk0sT0FBTyxDQUFDRSxJQUFJLEdBQUcsSUFBQUMsa0JBQVUsRUFBQyxDQUFDO0VBQzNCSCxPQUFPLENBQUMsY0FBYyxDQUFDLEdBQUcsZ0NBQWdDO0VBQzFELE9BQU8sSUFBQUksMEJBQW1CLEVBQWlDbkIsSUFBSSxFQUFFUSxHQUFHLEVBQUUsRUFBRSxFQUFFTyxPQUFPLENBQUM7QUFDcEY7QUFFQSxlQUFlSyxhQUFhQSxDQUMxQkMsVUFBMEMsRUFDMUNDLE9BQWUsRUFDZnRCLElBQVUsRUFDVnVCLGFBQXFCLEVBQ29CO0VBQ3pDLE1BQU1DLFFBQVEsR0FBR0gsVUFBVSxDQUFDSSxZQUFZLENBQUNsRSxHQUFHLENBQUMsTUFBT21FLFdBQStCLElBQWtDO0lBQ25ILE1BQU07TUFBRUMsVUFBVTtNQUFFbkM7SUFBYSxDQUFDLEdBQUdrQyxXQUFXO0lBQ2hELElBQUlsQyxZQUFZLEtBQUssQ0FBQyxFQUFFO01BQ3RCLE1BQU1nQixHQUFHLEdBQUcsR0FBR2MsT0FBTyxHQUFHSyxVQUFVLGNBQWNKLGFBQWEsVUFBVTtNQUN4RSxNQUFNSyx1QkFBdUIsR0FBRyxDQUFDLE1BQU0sSUFBQUMseUJBQWtCLEVBQTBCN0IsSUFBSSxFQUFFUSxHQUFHLENBQUMsS0FBSyxFQUFFO01BQ3BHLElBQUlvQix1QkFBdUIsSUFBSUEsdUJBQXVCLENBQUN6RCxNQUFNLEVBQUU7UUFDN0QsTUFBTTtVQUFFMkQ7UUFBa0IsQ0FBQyxHQUFHRix1QkFBdUIsQ0FBQyxDQUFDLENBQUM7UUFDeEQsSUFBSUUsaUJBQWlCLEVBQUU7VUFDckIsT0FBTztZQUNMLEdBQUdKLFdBQVc7WUFDZGhELGVBQWUsRUFBRW9ELGlCQUFpQjtZQUNsQ0MscUJBQXFCLEVBQUVIO1VBQ3pCLENBQUM7UUFDSDtNQUNGO0lBQ0Y7SUFDQSxPQUFPRixXQUFXO0VBQ3BCLENBQUMsQ0FBQztFQUNGLE1BQU1NLEdBQUcsR0FBRyxNQUFNQyxPQUFPLENBQUNDLEdBQUcsQ0FBQ1YsUUFBUSxDQUFDO0VBQ3ZDLE9BQU87SUFBRUMsWUFBWSxFQUFFTztFQUFJLENBQUM7QUFDOUI7QUFFQSxlQUFlRyxzQkFBc0JBLENBQ25DYixPQUFlLEVBQ2ZjLFVBQWtCLEVBQ2xCcEMsSUFBVSxFQUNWdUIsYUFBcUIsRUFDckJjLFNBQWlCLEVBQ2pCQyxPQUFlLEVBQ2ZDLGdDQUFnQyxHQUFHLEtBQUssRUFDeENqRixPQUF3QixFQUN4QjtFQUNBLE1BQU1rRixPQUFPLEdBQUcsR0FBR0osVUFBVSwyQ0FBMkNiLGFBQWEsMENBQTBDZSxPQUFPLHVCQUF1QkQsU0FBUyxhQUFhO0VBQ25MLE1BQU1oQixVQUFVLEdBQUcsTUFBTWQseUJBQXlCLENBQUNQLElBQUksRUFBRXdDLE9BQU8sRUFBRSwrQkFBK0IsQ0FBQztFQUVsRyxNQUFNQyxXQUFXLEdBQ2ZGLGdDQUFnQyxJQUFJbEIsVUFBVSxFQUFFSSxZQUFZLENBQUN0RCxNQUFNLEdBQy9ELE1BQU1pRCxhQUFhLENBQUNDLFVBQVUsRUFBRUMsT0FBTyxFQUFFdEIsSUFBSSxFQUFFdUIsYUFBYSxDQUFDLEdBQzdERixVQUFVO0VBRWhCLE9BQU9qRSxtQkFBbUIsQ0FBQ3FGLFdBQVcsRUFBRWhCLFlBQVksSUFBSSxFQUFFLEVBQUVuRSxPQUFPLENBQUM7QUFDdEU7QUFFQSxlQUFlb0YsaUJBQWlCQSxDQUFDTixVQUFrQixFQUFFcEMsSUFBVSxFQUFFdUIsYUFBcUIsRUFBRTtFQUN0RixNQUFNb0Isd0JBQXdCLEdBQUcsR0FBR1AsVUFBVSw4REFBOERiLGFBQWEsdUJBQXVCO0VBQ2hKLE1BQU1xQixxQkFBcUIsR0FBRyxNQUFNLElBQUFmLHlCQUFrQixFQUF3QjdCLElBQUksRUFBRTJDLHdCQUF3QixDQUFDO0VBRTdHLE9BQU9DLHFCQUFxQixFQUFFQyxjQUFjO0FBQzlDO0FBRUEsZUFBZUMsZ0JBQWdCQSxDQUFDOUMsSUFBVSxFQUFFc0IsT0FBZSxFQUFFaEUsT0FBdUIsRUFBRTtFQUNwRixNQUFNK0MsV0FBVyxHQUFHLE1BQU1OLGNBQWMsQ0FBQ0MsSUFBSSxDQUFDO0VBQzlDLE1BQU1vQyxVQUFVLEdBQUcsR0FBR2QsT0FBTyxJQUFJakIsV0FBVyxFQUFFO0VBQzlDLE1BQU0wQyxjQUFjLEdBQUcsR0FBR3pCLE9BQU8sa0NBQWtDO0VBRW5FckUsS0FBSyxDQUFDLHdCQUF3QixDQUFDO0VBQy9CLE1BQU0rRixZQUFZLEdBQUcsQ0FBQyxNQUFNLElBQUFuQix5QkFBa0IsRUFBcUI3QixJQUFJLEVBQUUrQyxjQUFjLENBQUMsS0FBSyxFQUFFO0VBQy9GLE1BQU1FLGdCQUFnQixHQUFHRCxZQUFZLENBQUNFLE1BQU0sQ0FBQ0MsT0FBTyxJQUFJQSxPQUFPLENBQUNDLHdCQUF3QixLQUFLLENBQUMsQ0FBQztFQUMvRm5HLEtBQUssQ0FDSCx3RUFBd0UsRUFDeEVnRyxnQkFBZ0IsQ0FBQzlFLE1BQU0sRUFDdkI2RSxZQUFZLENBQUM3RSxNQUNmLENBQUM7RUFFRCxNQUFNa0Ysa0JBQWtCLEdBQUcsSUFBQXpFLGVBQU0sRUFBQyxDQUFDLENBQUMwRSxRQUFRLENBQUMsQ0FBQyxFQUFFLE9BQU8sQ0FBQyxDQUFDQyxHQUFHLENBQUMsQ0FBQyxFQUFFLEtBQUssQ0FBQztFQUN0RSxNQUFNbEIsU0FBUyxHQUFHL0UsT0FBTyxDQUFDK0UsU0FBUyxJQUFJZ0Isa0JBQWtCLENBQUNHLE1BQU0sQ0FBQyxDQUFDO0VBQ2xFLE1BQU1DLFdBQVcsR0FBRzdFLGVBQU0sQ0FBQzhFLEdBQUcsQ0FBQ0wsa0JBQWtCLEVBQUUsSUFBQXpFLGVBQU0sRUFBQ3lELFNBQVMsQ0FBQyxDQUFDO0VBQ3JFLE1BQU07SUFBRUU7RUFBaUMsQ0FBQyxHQUFHakYsT0FBTztFQUVwRCxNQUFNcUcsWUFBWSxHQUFHRixXQUFXLENBQUNHLE1BQU0sQ0FBQ3pHLFdBQVcsQ0FBQztFQUNwRCxNQUFNMEcsVUFBVSxHQUFHLElBQUFqRixlQUFNLEVBQUMsQ0FBQyxDQUFDZ0YsTUFBTSxDQUFDekcsV0FBVyxDQUFDO0VBRS9DLE1BQU0yRyxRQUErQixHQUFHLEVBQUU7RUFFMUMsS0FBSyxNQUFNWCxPQUFPLElBQUlGLGdCQUFnQixFQUFFO0lBQ3RDaEcsS0FBSyxDQUFDLG9DQUFvQyxFQUFFa0csT0FBTyxDQUFDNUIsYUFBYSxDQUFDO0lBQ2xFLE1BQU1BLGFBQWEsR0FBRyxHQUFHNEIsT0FBTyxDQUFDWSxVQUFVLElBQUlaLE9BQU8sQ0FBQ2EsWUFBWSxJQUFJYixPQUFPLENBQUM1QixhQUFhLEVBQUU7SUFFOUYsTUFBTTBDLE9BQU8sR0FBRyxNQUFNdkIsaUJBQWlCLENBQUNOLFVBQVUsRUFBRXBDLElBQUksRUFBRXVCLGFBQWEsQ0FBQztJQUN4RSxNQUFNbEUsSUFBSSxHQUFHLE1BQU04RSxzQkFBc0IsQ0FDdkNiLE9BQU8sRUFDUGMsVUFBVSxFQUNWcEMsSUFBSSxFQUNKdUIsYUFBYSxFQUNib0MsWUFBWSxFQUNaRSxVQUFVLEVBQ1Z0QixnQ0FBZ0MsRUFDaENqRixPQUNGLENBQUM7SUFFRHdHLFFBQVEsQ0FBQzVGLElBQUksQ0FBQztNQUNacUQsYUFBYTtNQUNiMEMsT0FBTztNQUNQNUc7SUFDRixDQUFDLENBQUM7RUFDSjtFQUVBLE1BQU02RyxXQUFXLEdBQUc7SUFDbEJDLE9BQU8sRUFBRSxJQUFJO0lBQ2JMO0VBQ0YsQ0FBQztFQUNEN0csS0FBSyxDQUFDLGdCQUFnQixDQUFDO0VBQ3ZCLE9BQU9pSCxXQUFXO0FBQ3BCO0FBRUEsTUFBTUUsaUJBQWlCLEdBQUcscUJBQXFCO0FBQy9DLE1BQU1DLG1CQUFtQixHQUFHLFlBQVk7QUFDeEMsTUFBTUMsa0JBQWtCLEdBQUcsbURBQW1EO0FBRTlFLFNBQVNDLHVCQUF1QkEsQ0FBQ2pELE9BQWUsRUFBRTtFQUNoRCxNQUFNa0QsSUFBMEIsR0FBRyxDQUFDLENBQUM7RUFDckNBLElBQUksQ0FBQ0Msb0NBQVksQ0FBQ0MsT0FBTyxDQUFDLEdBQUcsQ0FDM0IsR0FBR3BELE9BQU8sd0JBQXdCLEVBQ2xDLEdBQUdBLE9BQU8sK0JBQStCLEVBQ3pDLEdBQUdBLE9BQU8sNEJBQTRCLENBQ3ZDO0VBQ0RrRCxJQUFJLENBQUNDLG9DQUFZLENBQUNFLGVBQWUsQ0FBQyxHQUFHLENBQ25DLEdBQUdyRCxPQUFPLDhFQUE4RSxDQUN6RjtFQUNEa0QsSUFBSSxDQUFDQyxvQ0FBWSxDQUFDRyxjQUFjLENBQUMsR0FBRyxDQUNsQyxHQUFHdEQsT0FBTyxrREFBa0QsRUFDNUQseUJBQXlCLENBQzFCO0VBQ0RrRCxJQUFJLENBQUNDLG9DQUFZLENBQUNJLHlCQUF5QixDQUFDLEdBQUcsQ0FDN0MsTUFBT3ZILE9BQXlCLElBQUs7SUFDbkMsSUFBSSxDQUFDQSxPQUFPLEVBQUUwQyxJQUFJLEVBQUUsT0FBTyxLQUFLO0lBQ2hDLE9BQU8sQ0FBQyxFQUFFLE1BQU0xQyxPQUFPLENBQUMwQyxJQUFJLENBQUM4RSxDQUFDLENBQUNWLGlCQUFpQixDQUFDLENBQUM7RUFDcEQsQ0FBQyxDQUNGO0VBQ0QsT0FBT0ksSUFBSTtBQUNiO0FBRUEsU0FBU08saUJBQWlCQSxDQUFDQyxXQUF1QyxFQUFFO0VBQ2xFLE9BQU8sQ0FDTDtJQUFFQyxRQUFRLEVBQUUsV0FBVztJQUFFakUsS0FBSyxFQUFFZ0UsV0FBVyxDQUFDRTtFQUFTLENBQUMsRUFDdEQ7SUFBRUQsUUFBUSxFQUFFLFdBQVc7SUFBRWpFLEtBQUssRUFBRWdFLFdBQVcsQ0FBQ0c7RUFBUyxDQUFDLENBQ3ZEO0FBQ0g7QUFRQSxNQUFNQyxlQUFlLFNBQVNDLDhDQUFzQixDQUE2QjtFQUMvRSxJQUFJL0QsT0FBT0EsQ0FBQSxFQUFHO0lBQ1osT0FBTyxrQ0FBa0M7RUFDM0M7RUFFQWdFLGVBQWVBLENBQUNOLFdBQXVDLEVBQUU7SUFDdkQsT0FBTztNQUNMTyxRQUFRLEVBQUUsR0FBRyxJQUFJLENBQUNqRSxPQUFPLHdDQUF3QztNQUNqRWtFLE1BQU0sRUFBRVQsaUJBQWlCLENBQUNDLFdBQVcsQ0FBQztNQUN0Q1Msb0JBQW9CLEVBQUUsWUFBWTtNQUNsQ0MsVUFBVSxFQUFFLE1BQUFBLENBQUEsS0FBWTtRQUN0QixNQUFNQyxVQUFVLEdBQUcsTUFBTSxJQUFBQyx5QkFBYSxFQUFDLElBQUksQ0FBQzVGLElBQUksRUFBRSxJQUFJLENBQUM7UUFDdkQsTUFBTSxJQUFBQyxrQkFBUyxFQUNiLFlBQVk7VUFDVixJQUFJO1lBQ0YsTUFBTTRGLFVBQVUsR0FBRyxNQUFNLElBQUFELHlCQUFhLEVBQUMsSUFBSSxDQUFDNUYsSUFBSSxFQUFFLElBQUksQ0FBQztZQUN2RCxJQUFJNkYsVUFBVSxLQUFLRixVQUFVLEVBQUUsT0FBTyxJQUFJO1lBQzFDLE9BQU8sQ0FBQyxFQUFFLE1BQU0sSUFBSSxDQUFDM0YsSUFBSSxDQUFDOEUsQ0FBQyxDQUFDVixpQkFBaUIsQ0FBQyxDQUFDO1VBQ2pELENBQUMsQ0FBQyxNQUFNO1lBQ047WUFDQSxPQUFPLElBQUk7VUFDYjtRQUNGLENBQUMsRUFDRCxrQ0FBa0MsRUFDbEMsS0FBSyxFQUNMLElBQ0YsQ0FBQztNQUNILENBQUM7TUFDRDBCLGVBQWUsRUFBRXZCLHVCQUF1QixDQUFDLElBQUksQ0FBQ2pELE9BQU87SUFDdkQsQ0FBQztFQUNIO0VBRUEsTUFBTXlFLEtBQUtBLENBQUNmLFdBQXVDLEVBQStCO0lBQ2hGLE1BQU0zRyxNQUFNLEdBQUcsTUFBTSxLQUFLLENBQUMwSCxLQUFLLENBQUNmLFdBQVcsQ0FBQztJQUU3QyxJQUFJM0csTUFBTSxDQUFDOEYsT0FBTyxJQUFJOUYsTUFBTSxDQUFDMkgsU0FBUyxLQUFLQyx5QkFBaUIsQ0FBQ3BCLHlCQUF5QixFQUFFO01BQ3RGLE9BQU94RyxNQUFNO0lBQ2Y7O0lBRUE7SUFDQSxJQUFJLENBQUMyRyxXQUFXLENBQUNrQixnQkFBZ0IsRUFBRTtNQUNqQ2pKLEtBQUssQ0FBQywrQ0FBK0MsQ0FBQztNQUN0RCxPQUFPO1FBQ0xrSCxPQUFPLEVBQUUsS0FBSztRQUNkNkIsU0FBUyxFQUFFQyx5QkFBaUIsQ0FBQ3BCLHlCQUF5QjtRQUN0RHNCLFlBQVksRUFBRTtNQUNoQixDQUFDO0lBQ0g7SUFFQSxNQUFNQyxnQkFBZ0IsR0FBRyxDQUFDO0lBQzFCLEtBQUssSUFBSUMsT0FBTyxHQUFHLENBQUMsRUFBRUEsT0FBTyxJQUFJRCxnQkFBZ0IsRUFBRUMsT0FBTyxFQUFFLEVBQUU7TUFDNURwSixLQUFLLENBQUMsMERBQTBEb0osT0FBTyxJQUFJRCxnQkFBZ0IsR0FBRyxDQUFDO01BQy9GLE1BQU1FLE9BQU8sR0FBRyxNQUFNdEIsV0FBVyxDQUFDa0IsZ0JBQWdCLENBQUM7UUFBRUc7TUFBUSxDQUFDLENBQUM7TUFFL0RwSixLQUFLLENBQUMsbUJBQW1CLENBQUM7TUFDMUIsTUFBTXNKLFNBQVMsR0FBRyxNQUFNLElBQUksQ0FBQ3ZHLElBQUksQ0FBQ3dHLEVBQUUsQ0FBQyxHQUFHcEMsaUJBQWlCLHFCQUFxQixDQUFDO01BQy9FbkgsS0FBSyxDQUFDLDJCQUEyQixFQUFFc0osU0FBUyxDQUFDcEksTUFBTSxDQUFDO01BRXBELEtBQUssSUFBSXNJLENBQUMsR0FBRyxDQUFDLEVBQUVBLENBQUMsR0FBR0YsU0FBUyxDQUFDcEksTUFBTSxFQUFFc0ksQ0FBQyxFQUFFLEVBQUU7UUFDekMsTUFBTUYsU0FBUyxDQUFDRSxDQUFDLENBQUMsQ0FBQ0MsS0FBSyxDQUFDLENBQUM7UUFDMUIsTUFBTUgsU0FBUyxDQUFDRSxDQUFDLENBQUMsQ0FBQ3ZHLFFBQVEsQ0FBQ3lHLEVBQUUsSUFBSTtVQUNoQ0EsRUFBRSxDQUFDM0YsS0FBSyxHQUFHLEVBQUU7UUFDZixDQUFDLENBQUM7UUFDRixJQUFJeUYsQ0FBQyxHQUFHSCxPQUFPLENBQUNuSSxNQUFNLEVBQUU7VUFDdEIsTUFBTW9JLFNBQVMsQ0FBQ0UsQ0FBQyxDQUFDLENBQUNuSSxJQUFJLENBQUNnSSxPQUFPLENBQUNHLENBQUMsQ0FBQyxFQUFFO1lBQUVHLEtBQUssRUFBRTtVQUFHLENBQUMsQ0FBQztRQUNwRDtRQUNBLE1BQU0sSUFBQUMsY0FBSyxFQUFDLEdBQUcsQ0FBQztNQUNsQjtNQUVBNUosS0FBSyxDQUFDLGdCQUFnQixDQUFDO01BQ3ZCO01BQ0E7TUFDQSxNQUFNLElBQUksQ0FBQytDLElBQUksQ0FBQzBHLEtBQUssQ0FBQ3JDLG1CQUFtQixDQUFDO01BRTFDLElBQUk7UUFDRixNQUFNLElBQUFwRSxrQkFBUyxFQUNiLFlBQVk7VUFDVixNQUFNNkcsT0FBTyxHQUFHLE1BQU0sSUFBSSxDQUFDOUcsSUFBSSxDQUFDOEUsQ0FBQyxDQUFDVixpQkFBaUIsQ0FBQztVQUNwRCxNQUFNMkMsT0FBTyxHQUFHLE1BQU0sSUFBSSxDQUFDL0csSUFBSSxDQUFDOEUsQ0FBQyxDQUFDUixrQkFBa0IsQ0FBQztVQUNyRCxNQUFNOUQsR0FBRyxHQUFHLE1BQU0sSUFBQW9GLHlCQUFhLEVBQUMsSUFBSSxDQUFDNUYsSUFBSSxFQUFFLElBQUksQ0FBQztVQUNoRC9DLEtBQUssQ0FBQyxxQ0FBcUMsRUFBRSxDQUFDLENBQUM2SixPQUFPLEVBQUUsQ0FBQyxDQUFDQyxPQUFPLEVBQUV2RyxHQUFHLENBQUM7VUFDdkUsSUFBSSxDQUFDc0csT0FBTyxFQUFFLE9BQU8sU0FBUztVQUM5QixJQUFJQyxPQUFPLEVBQUUsT0FBTyxPQUFPO1VBQzNCLE9BQU8sS0FBSztRQUNkLENBQUMsRUFDRCx3QkFBd0IsRUFDeEIsS0FBSyxFQUNMLElBQ0YsQ0FBQztNQUNILENBQUMsQ0FBQyxNQUFNO1FBQ047UUFDQTlKLEtBQUssQ0FBQyxpREFBaUQsQ0FBQztNQUMxRDtNQUVBLElBQUksRUFBRSxNQUFNLElBQUksQ0FBQytDLElBQUksQ0FBQzhFLENBQUMsQ0FBQ1YsaUJBQWlCLENBQUMsQ0FBQyxFQUFFO1FBQzNDO1FBQ0EsTUFBTTRDLGVBQWUsR0FBRyxDQUN0Qix3QkFBd0IsRUFDeEIsK0JBQStCLEVBQy9CLDRCQUE0QixDQUM3QjtRQUNELElBQUk7VUFDRixNQUFNLElBQUEvRyxrQkFBUyxFQUNiLFlBQVk7WUFDVixNQUFNTyxHQUFHLEdBQUcsTUFBTSxJQUFBb0YseUJBQWEsRUFBQyxJQUFJLENBQUM1RixJQUFJLEVBQUUsSUFBSSxDQUFDO1lBQ2hEL0MsS0FBSyxDQUFDLGtDQUFrQyxFQUFFdUQsR0FBRyxDQUFDO1lBQzlDLE9BQU93RyxlQUFlLENBQUNDLElBQUksQ0FBQ0MsQ0FBQyxJQUFJMUcsR0FBRyxDQUFDMkcsUUFBUSxDQUFDRCxDQUFDLENBQUMsQ0FBQztVQUNuRCxDQUFDLEVBQ0QsaUNBQWlDLEVBQ2pDLEtBQUssRUFDTCxJQUNGLENBQUM7VUFDRGpLLEtBQUssQ0FBQyw0QkFBNEIsQ0FBQztVQUNuQyxPQUFPO1lBQUVrSCxPQUFPLEVBQUU7VUFBSyxDQUFDO1FBQzFCLENBQUMsQ0FBQyxNQUFNO1VBQ04sTUFBTWlELE9BQU8sR0FBRyxNQUFNLElBQUF4Qix5QkFBYSxFQUFDLElBQUksQ0FBQzVGLElBQUksRUFBRSxJQUFJLENBQUM7VUFDcEQvQyxLQUFLLENBQUMsMENBQTBDLEVBQUVtSyxPQUFPLENBQUM7VUFDMUQsT0FBTztZQUNMakQsT0FBTyxFQUFFLEtBQUs7WUFDZDZCLFNBQVMsRUFBRUMseUJBQWlCLENBQUNvQixPQUFPO1lBQ3BDbEIsWUFBWSxFQUFFO1VBQ2hCLENBQUM7UUFDSDtNQUNGO01BRUFsSixLQUFLLENBQUMsZUFBZW9KLE9BQU8saUNBQWlDLENBQUM7TUFDOUQsSUFBSUEsT0FBTyxLQUFLRCxnQkFBZ0IsRUFBRTtRQUNoQyxPQUFPO1VBQ0xqQyxPQUFPLEVBQUUsS0FBSztVQUNkNkIsU0FBUyxFQUFFQyx5QkFBaUIsQ0FBQ29CLE9BQU87VUFDcENsQixZQUFZLEVBQUUsaUNBQWlDQyxnQkFBZ0I7UUFDakUsQ0FBQztNQUNIO0lBQ0Y7SUFFQSxPQUFPO01BQ0xqQyxPQUFPLEVBQUUsS0FBSztNQUNkNkIsU0FBUyxFQUFFQyx5QkFBaUIsQ0FBQ29CLE9BQU87TUFDcENsQixZQUFZLEVBQUU7SUFDaEIsQ0FBQztFQUNIO0VBRUEsTUFBTW1CLFNBQVNBLENBQUEsRUFBRztJQUNoQixPQUFPeEUsZ0JBQWdCLENBQUMsSUFBSSxDQUFDOUMsSUFBSSxFQUFFLElBQUksQ0FBQ3NCLE9BQU8sRUFBRSxJQUFJLENBQUNoRSxPQUFPLENBQUM7RUFDaEU7QUFDRjtBQUFDLElBQUFpSyxRQUFBLEdBQUFDLE9BQUEsQ0FBQXhLLE9BQUEsR0FFY29JLGVBQWUiLCJpZ25vcmVMaXN0IjpbXX0=