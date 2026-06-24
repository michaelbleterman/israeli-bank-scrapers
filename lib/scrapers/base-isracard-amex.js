"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;
var _moment = _interopRequireDefault(require("moment"));
var _constants = require("../constants");
var _definitions = require("../definitions");
var _dates = _interopRequireDefault(require("../helpers/dates"));
var _debug = require("../helpers/debug");
var _fetch = require("../helpers/fetch");
var _arrays = require("../helpers/arrays");
var _transactions = require("../helpers/transactions");
var _waiting = require("../helpers/waiting");
var _transactions2 = require("../transactions");
var _baseScraperWithBrowser = require("./base-scraper-with-browser");
var _errors = require("./errors");
var _browser = require("../helpers/browser");
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
const RATE_LIMIT = {
  SLEEP_BETWEEN: 1000,
  TRANSACTIONS_BATCH_SIZE: 10
};
const COUNTRY_CODE = '212';
const ID_TYPE = '1';
const INSTALLMENTS_KEYWORD = 'תשלום';
const DATE_FORMAT = 'DD/MM/YYYY';
const debug = (0, _debug.getDebug)('base-isracard-amex');
function getAccountsUrl(servicesUrl, monthMoment) {
  const billingDate = monthMoment.format('YYYY-MM-DD');
  const url = new URL(servicesUrl);
  url.searchParams.set('reqName', 'DashboardMonth');
  url.searchParams.set('actionCode', '0');
  url.searchParams.set('billingDate', billingDate);
  url.searchParams.set('format', 'Json');
  return url.toString();
}
async function fetchAccounts(page, servicesUrl, monthMoment) {
  const dataUrl = getAccountsUrl(servicesUrl, monthMoment);
  debug(`fetching accounts from ${dataUrl}`);
  const dataResult = await (0, _fetch.fetchGetWithinPage)(page, dataUrl);
  if (dataResult && dataResult.Header?.Status === '1' && dataResult.DashboardMonthBean) {
    const {
      cardsCharges
    } = dataResult.DashboardMonthBean;
    if (cardsCharges) {
      return cardsCharges.map(cardCharge => {
        return {
          index: parseInt(cardCharge.cardIndex, 10),
          accountNumber: cardCharge.cardNumber,
          processedDate: (0, _moment.default)(cardCharge.billingDate, DATE_FORMAT).toISOString()
        };
      });
    }
  }
  return [];
}
function getTransactionsUrl(servicesUrl, monthMoment) {
  const month = monthMoment.month() + 1;
  const year = monthMoment.year();
  const monthStr = month < 10 ? `0${month}` : month.toString();
  const url = new URL(servicesUrl);
  url.searchParams.set('reqName', 'CardsTransactionsList');
  url.searchParams.set('month', monthStr);
  url.searchParams.set('year', `${year}`);
  url.searchParams.set('requiredDate', 'N');
  return url.toString();
}
function convertCurrency(currencyStr) {
  if (currencyStr === _constants.SHEKEL_CURRENCY_KEYWORD || currencyStr === _constants.ALT_SHEKEL_CURRENCY) {
    return _constants.SHEKEL_CURRENCY;
  }
  return currencyStr;
}
function getInstallmentsInfo(txn) {
  if (!txn.moreInfo || !txn.moreInfo.includes(INSTALLMENTS_KEYWORD)) {
    return undefined;
  }
  const matches = txn.moreInfo.match(/\d+/g);
  if (!matches || matches.length < 2) {
    return undefined;
  }
  return {
    number: parseInt(matches[0], 10),
    total: parseInt(matches[1], 10)
  };
}
function getTransactionType(txn) {
  return getInstallmentsInfo(txn) ? _transactions2.TransactionTypes.Installments : _transactions2.TransactionTypes.Normal;
}
function convertTransactions(txns, processedDate, options) {
  const filteredTxns = txns.filter(txn => txn.dealSumType !== '1' && txn.voucherNumberRatz !== '000000000' && txn.voucherNumberRatzOutbound !== '000000000');
  return filteredTxns.map(txn => {
    const isOutbound = txn.dealSumOutbound;
    const txnDateStr = isOutbound ? txn.fullPurchaseDateOutbound : txn.fullPurchaseDate;
    const txnMoment = (0, _moment.default)(txnDateStr, DATE_FORMAT);
    const currentProcessedDate = txn.fullPaymentDate ? (0, _moment.default)(txn.fullPaymentDate, DATE_FORMAT).toISOString() : processedDate;
    const result = {
      type: getTransactionType(txn),
      identifier: parseInt(isOutbound ? txn.voucherNumberRatzOutbound : txn.voucherNumberRatz, 10),
      date: txnMoment.toISOString(),
      processedDate: currentProcessedDate,
      originalAmount: isOutbound ? -txn.dealSumOutbound : -txn.dealSum,
      originalCurrency: convertCurrency(txn.currentPaymentCurrency ?? txn.currencyId),
      chargedAmount: isOutbound ? -txn.paymentSumOutbound : -txn.paymentSum,
      chargedCurrency: convertCurrency(txn.currencyId),
      description: isOutbound ? txn.fullSupplierNameOutbound : txn.fullSupplierNameHeb,
      memo: txn.moreInfo || '',
      installments: getInstallmentsInfo(txn) || undefined,
      status: _transactions2.TransactionStatuses.Completed
    };
    if (options?.includeRawTransaction) {
      result.rawTransaction = (0, _transactions.getRawTransaction)(txn);
    }
    return result;
  });
}
async function fetchTransactions(page, options, companyServiceOptions, startMoment, monthMoment) {
  const accounts = await fetchAccounts(page, companyServiceOptions.servicesUrl, monthMoment);
  const dataUrl = getTransactionsUrl(companyServiceOptions.servicesUrl, monthMoment);
  await (0, _waiting.sleep)(RATE_LIMIT.SLEEP_BETWEEN);
  debug(`fetching transactions from ${dataUrl} for month ${monthMoment.format('YYYY-MM')}`);
  const dataResult = await (0, _fetch.fetchGetWithinPage)(page, dataUrl);
  if (dataResult && dataResult.Header?.Status === '1' && dataResult.CardsTransactionsListBean) {
    const accountTxns = {};
    accounts.forEach(account => {
      const txnGroups = dataResult.CardsTransactionsListBean?.[`Index${account.index}`]?.CurrentCardTransactions;
      if (txnGroups) {
        let allTxns = [];
        txnGroups.forEach(txnGroup => {
          if (txnGroup.txnIsrael) {
            const txns = convertTransactions(txnGroup.txnIsrael, account.processedDate, options);
            allTxns.push(...txns);
          }
          if (txnGroup.txnAbroad) {
            const txns = convertTransactions(txnGroup.txnAbroad, account.processedDate, options);
            allTxns.push(...txns);
          }
        });
        if (!options.combineInstallments) {
          allTxns = (0, _transactions.fixInstallments)(allTxns);
        }
        if (options.outputData?.enableTransactionsFilterByDate ?? true) {
          allTxns = (0, _transactions.filterOldTransactions)(allTxns, startMoment, options.combineInstallments || false);
        }
        accountTxns[account.accountNumber] = {
          accountNumber: account.accountNumber,
          index: account.index,
          txns: allTxns
        };
      }
    });
    return accountTxns;
  }
  return {};
}
async function getExtraScrapTransaction(page, options, month, accountIndex, transaction) {
  const url = new URL(options.servicesUrl);
  url.searchParams.set('reqName', 'PirteyIska_204');
  url.searchParams.set('CardIndex', accountIndex.toString());
  url.searchParams.set('shovarRatz', transaction.identifier.toString());
  url.searchParams.set('moedChiuv', month.format('MMYYYY'));
  debug(`fetching extra scrap for transaction ${transaction.identifier} for month ${month.format('YYYY-MM')}`);
  const data = await (0, _fetch.fetchGetWithinPage)(page, url.toString());
  if (!data) {
    return transaction;
  }
  const rawCategory = data.PirteyIska_204Bean?.sector ?? '';
  return {
    ...transaction,
    category: rawCategory.trim(),
    rawTransaction: (0, _transactions.getRawTransaction)(data, transaction)
  };
}
async function getExtraScrapAccount(page, options, accountMap, month) {
  const accounts = [];
  for (const account of Object.values(accountMap)) {
    debug(`get extra scrap for ${account.accountNumber} with ${account.txns.length} transactions`, month.format('YYYY-MM'));
    const txns = [];
    for (const txnsChunk of (0, _arrays.chunk)(account.txns, RATE_LIMIT.TRANSACTIONS_BATCH_SIZE)) {
      debug(`processing chunk of ${txnsChunk.length} transactions for account ${account.accountNumber}`);
      const updatedTxns = await Promise.all(txnsChunk.map(t => getExtraScrapTransaction(page, options, month, account.index, t)));
      await (0, _waiting.sleep)(RATE_LIMIT.SLEEP_BETWEEN);
      txns.push(...updatedTxns);
    }
    accounts.push({
      ...account,
      txns
    });
  }
  return accounts.reduce((m, x) => ({
    ...m,
    [x.accountNumber]: x
  }), {});
}
async function getAdditionalTransactionInformation(scraperOptions, accountsWithIndex, page, options, allMonths) {
  if (!scraperOptions.additionalTransactionInformation || scraperOptions.optInFeatures?.includes('isracard-amex:skipAdditionalTransactionInformation')) {
    return accountsWithIndex;
  }
  return (0, _waiting.runSerial)(accountsWithIndex.map((a, i) => () => getExtraScrapAccount(page, options, a, allMonths[i])));
}
async function fetchAllTransactions(page, options, companyServiceOptions, startMoment) {
  const futureMonthsToScrape = options.futureMonthsToScrape ?? 1;
  const allMonths = (0, _dates.default)(startMoment, futureMonthsToScrape);
  const results = await (0, _waiting.runSerial)(allMonths.map(monthMoment => () => {
    return fetchTransactions(page, options, companyServiceOptions, startMoment, monthMoment);
  }));
  const finalResult = await getAdditionalTransactionInformation(options, results, page, companyServiceOptions, allMonths);
  const combinedTxns = {};
  finalResult.forEach(result => {
    Object.keys(result).forEach(accountNumber => {
      let txnsForAccount = combinedTxns[accountNumber];
      if (!txnsForAccount) {
        txnsForAccount = [];
        combinedTxns[accountNumber] = txnsForAccount;
      }
      const toBeAddedTxns = result[accountNumber].txns;
      combinedTxns[accountNumber].push(...toBeAddedTxns);
    });
  });
  const accounts = Object.keys(combinedTxns).map(accountNumber => {
    return {
      accountNumber,
      txns: combinedTxns[accountNumber]
    };
  });
  return {
    success: true,
    accounts
  };
}
class IsracardAmexBaseScraper extends _baseScraperWithBrowser.BaseScraperWithBrowser {
  constructor(options, baseUrl, companyCode) {
    super(options);
    this.baseUrl = baseUrl;
    this.companyCode = companyCode;
    this.servicesUrl = `${baseUrl}/services/ProxyRequestHandler.ashx`;
  }
  async login(credentials) {
    await this.page.setRequestInterception(true);
    this.page.on('request', request => {
      if (request.url().includes('detector-dom.min.js')) {
        debug('force abort for request do download detector-dom.min.js resource');
        void request.abort(undefined, _browser.interceptionPriorities.abort);
      } else {
        void request.continue(undefined, _browser.interceptionPriorities.continue);
      }
    });
    await (0, _browser.maskHeadlessUserAgent)(this.page);
    await this.navigateTo(`${this.baseUrl}/personalarea/Login`);
    this.emitProgress(_definitions.ScraperProgressTypes.LoggingIn);
    const validateUrl = `${this.servicesUrl}?reqName=ValidateIdData`;
    const validateRequest = {
      id: credentials.id,
      cardSuffix: credentials.card6Digits,
      countryCode: COUNTRY_CODE,
      idType: ID_TYPE,
      checkLevel: '1',
      companyCode: this.companyCode
    };
    debug('logging in with validate request');
    const validateResult = await (0, _fetch.fetchPostWithinPage)(this.page, validateUrl, validateRequest);
    if (!validateResult || !validateResult.Header || validateResult.Header.Status !== '1' || !validateResult.ValidateIdDataBean) {
      throw new Error('unknown error during login');
    }
    const validateReturnCode = validateResult.ValidateIdDataBean.returnCode;
    debug(`user validate with return code '${validateReturnCode}'`);
    if (validateReturnCode === '1') {
      const {
        userName
      } = validateResult.ValidateIdDataBean;
      const loginUrl = `${this.servicesUrl}?reqName=performLogonI`;
      const request = {
        KodMishtamesh: userName,
        MisparZihuy: credentials.id,
        Sisma: credentials.password,
        cardSuffix: credentials.card6Digits,
        countryCode: COUNTRY_CODE,
        idType: ID_TYPE
      };
      debug('user login started');
      const loginResult = await (0, _fetch.fetchPostWithinPage)(this.page, loginUrl, request);
      debug(`user login with status '${loginResult?.status}'`, loginResult);
      if (loginResult && loginResult.status === '1') {
        this.emitProgress(_definitions.ScraperProgressTypes.LoginSuccess);
        return {
          success: true
        };
      }
      if (loginResult && loginResult.status === '3') {
        this.emitProgress(_definitions.ScraperProgressTypes.ChangePassword);
        return {
          success: false,
          errorType: _errors.ScraperErrorTypes.ChangePassword
        };
      }
      this.emitProgress(_definitions.ScraperProgressTypes.LoginFailed);
      return {
        success: false,
        errorType: _errors.ScraperErrorTypes.InvalidPassword
      };
    }
    if (validateReturnCode === '4') {
      this.emitProgress(_definitions.ScraperProgressTypes.ChangePassword);
      return {
        success: false,
        errorType: _errors.ScraperErrorTypes.ChangePassword
      };
    }
    this.emitProgress(_definitions.ScraperProgressTypes.LoginFailed);
    return {
      success: false,
      errorType: _errors.ScraperErrorTypes.InvalidPassword
    };
  }
  async fetchData() {
    const defaultStartMoment = (0, _moment.default)().subtract(1, 'years');
    const startDate = this.options.startDate || defaultStartMoment.toDate();
    const startMoment = _moment.default.max(defaultStartMoment, (0, _moment.default)(startDate));
    return fetchAllTransactions(this.page, this.options, {
      servicesUrl: this.servicesUrl,
      companyCode: this.companyCode
    }, startMoment);
  }
}
var _default = exports.default = IsracardAmexBaseScraper;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfbW9tZW50IiwiX2ludGVyb3BSZXF1aXJlRGVmYXVsdCIsInJlcXVpcmUiLCJfY29uc3RhbnRzIiwiX2RlZmluaXRpb25zIiwiX2RhdGVzIiwiX2RlYnVnIiwiX2ZldGNoIiwiX2FycmF5cyIsIl90cmFuc2FjdGlvbnMiLCJfd2FpdGluZyIsIl90cmFuc2FjdGlvbnMyIiwiX2Jhc2VTY3JhcGVyV2l0aEJyb3dzZXIiLCJfZXJyb3JzIiwiX2Jyb3dzZXIiLCJlIiwiX19lc01vZHVsZSIsImRlZmF1bHQiLCJSQVRFX0xJTUlUIiwiU0xFRVBfQkVUV0VFTiIsIlRSQU5TQUNUSU9OU19CQVRDSF9TSVpFIiwiQ09VTlRSWV9DT0RFIiwiSURfVFlQRSIsIklOU1RBTExNRU5UU19LRVlXT1JEIiwiREFURV9GT1JNQVQiLCJkZWJ1ZyIsImdldERlYnVnIiwiZ2V0QWNjb3VudHNVcmwiLCJzZXJ2aWNlc1VybCIsIm1vbnRoTW9tZW50IiwiYmlsbGluZ0RhdGUiLCJmb3JtYXQiLCJ1cmwiLCJVUkwiLCJzZWFyY2hQYXJhbXMiLCJzZXQiLCJ0b1N0cmluZyIsImZldGNoQWNjb3VudHMiLCJwYWdlIiwiZGF0YVVybCIsImRhdGFSZXN1bHQiLCJmZXRjaEdldFdpdGhpblBhZ2UiLCJIZWFkZXIiLCJTdGF0dXMiLCJEYXNoYm9hcmRNb250aEJlYW4iLCJjYXJkc0NoYXJnZXMiLCJtYXAiLCJjYXJkQ2hhcmdlIiwiaW5kZXgiLCJwYXJzZUludCIsImNhcmRJbmRleCIsImFjY291bnROdW1iZXIiLCJjYXJkTnVtYmVyIiwicHJvY2Vzc2VkRGF0ZSIsIm1vbWVudCIsInRvSVNPU3RyaW5nIiwiZ2V0VHJhbnNhY3Rpb25zVXJsIiwibW9udGgiLCJ5ZWFyIiwibW9udGhTdHIiLCJjb252ZXJ0Q3VycmVuY3kiLCJjdXJyZW5jeVN0ciIsIlNIRUtFTF9DVVJSRU5DWV9LRVlXT1JEIiwiQUxUX1NIRUtFTF9DVVJSRU5DWSIsIlNIRUtFTF9DVVJSRU5DWSIsImdldEluc3RhbGxtZW50c0luZm8iLCJ0eG4iLCJtb3JlSW5mbyIsImluY2x1ZGVzIiwidW5kZWZpbmVkIiwibWF0Y2hlcyIsIm1hdGNoIiwibGVuZ3RoIiwibnVtYmVyIiwidG90YWwiLCJnZXRUcmFuc2FjdGlvblR5cGUiLCJUcmFuc2FjdGlvblR5cGVzIiwiSW5zdGFsbG1lbnRzIiwiTm9ybWFsIiwiY29udmVydFRyYW5zYWN0aW9ucyIsInR4bnMiLCJvcHRpb25zIiwiZmlsdGVyZWRUeG5zIiwiZmlsdGVyIiwiZGVhbFN1bVR5cGUiLCJ2b3VjaGVyTnVtYmVyUmF0eiIsInZvdWNoZXJOdW1iZXJSYXR6T3V0Ym91bmQiLCJpc091dGJvdW5kIiwiZGVhbFN1bU91dGJvdW5kIiwidHhuRGF0ZVN0ciIsImZ1bGxQdXJjaGFzZURhdGVPdXRib3VuZCIsImZ1bGxQdXJjaGFzZURhdGUiLCJ0eG5Nb21lbnQiLCJjdXJyZW50UHJvY2Vzc2VkRGF0ZSIsImZ1bGxQYXltZW50RGF0ZSIsInJlc3VsdCIsInR5cGUiLCJpZGVudGlmaWVyIiwiZGF0ZSIsIm9yaWdpbmFsQW1vdW50IiwiZGVhbFN1bSIsIm9yaWdpbmFsQ3VycmVuY3kiLCJjdXJyZW50UGF5bWVudEN1cnJlbmN5IiwiY3VycmVuY3lJZCIsImNoYXJnZWRBbW91bnQiLCJwYXltZW50U3VtT3V0Ym91bmQiLCJwYXltZW50U3VtIiwiY2hhcmdlZEN1cnJlbmN5IiwiZGVzY3JpcHRpb24iLCJmdWxsU3VwcGxpZXJOYW1lT3V0Ym91bmQiLCJmdWxsU3VwcGxpZXJOYW1lSGViIiwibWVtbyIsImluc3RhbGxtZW50cyIsInN0YXR1cyIsIlRyYW5zYWN0aW9uU3RhdHVzZXMiLCJDb21wbGV0ZWQiLCJpbmNsdWRlUmF3VHJhbnNhY3Rpb24iLCJyYXdUcmFuc2FjdGlvbiIsImdldFJhd1RyYW5zYWN0aW9uIiwiZmV0Y2hUcmFuc2FjdGlvbnMiLCJjb21wYW55U2VydmljZU9wdGlvbnMiLCJzdGFydE1vbWVudCIsImFjY291bnRzIiwic2xlZXAiLCJDYXJkc1RyYW5zYWN0aW9uc0xpc3RCZWFuIiwiYWNjb3VudFR4bnMiLCJmb3JFYWNoIiwiYWNjb3VudCIsInR4bkdyb3VwcyIsIkN1cnJlbnRDYXJkVHJhbnNhY3Rpb25zIiwiYWxsVHhucyIsInR4bkdyb3VwIiwidHhuSXNyYWVsIiwicHVzaCIsInR4bkFicm9hZCIsImNvbWJpbmVJbnN0YWxsbWVudHMiLCJmaXhJbnN0YWxsbWVudHMiLCJvdXRwdXREYXRhIiwiZW5hYmxlVHJhbnNhY3Rpb25zRmlsdGVyQnlEYXRlIiwiZmlsdGVyT2xkVHJhbnNhY3Rpb25zIiwiZ2V0RXh0cmFTY3JhcFRyYW5zYWN0aW9uIiwiYWNjb3VudEluZGV4IiwidHJhbnNhY3Rpb24iLCJkYXRhIiwicmF3Q2F0ZWdvcnkiLCJQaXJ0ZXlJc2thXzIwNEJlYW4iLCJzZWN0b3IiLCJjYXRlZ29yeSIsInRyaW0iLCJnZXRFeHRyYVNjcmFwQWNjb3VudCIsImFjY291bnRNYXAiLCJPYmplY3QiLCJ2YWx1ZXMiLCJ0eG5zQ2h1bmsiLCJjaHVuayIsInVwZGF0ZWRUeG5zIiwiUHJvbWlzZSIsImFsbCIsInQiLCJyZWR1Y2UiLCJtIiwieCIsImdldEFkZGl0aW9uYWxUcmFuc2FjdGlvbkluZm9ybWF0aW9uIiwic2NyYXBlck9wdGlvbnMiLCJhY2NvdW50c1dpdGhJbmRleCIsImFsbE1vbnRocyIsImFkZGl0aW9uYWxUcmFuc2FjdGlvbkluZm9ybWF0aW9uIiwib3B0SW5GZWF0dXJlcyIsInJ1blNlcmlhbCIsImEiLCJpIiwiZmV0Y2hBbGxUcmFuc2FjdGlvbnMiLCJmdXR1cmVNb250aHNUb1NjcmFwZSIsImdldEFsbE1vbnRoTW9tZW50cyIsInJlc3VsdHMiLCJmaW5hbFJlc3VsdCIsImNvbWJpbmVkVHhucyIsImtleXMiLCJ0eG5zRm9yQWNjb3VudCIsInRvQmVBZGRlZFR4bnMiLCJzdWNjZXNzIiwiSXNyYWNhcmRBbWV4QmFzZVNjcmFwZXIiLCJCYXNlU2NyYXBlcldpdGhCcm93c2VyIiwiY29uc3RydWN0b3IiLCJiYXNlVXJsIiwiY29tcGFueUNvZGUiLCJsb2dpbiIsImNyZWRlbnRpYWxzIiwic2V0UmVxdWVzdEludGVyY2VwdGlvbiIsIm9uIiwicmVxdWVzdCIsImFib3J0IiwiaW50ZXJjZXB0aW9uUHJpb3JpdGllcyIsImNvbnRpbnVlIiwibWFza0hlYWRsZXNzVXNlckFnZW50IiwibmF2aWdhdGVUbyIsImVtaXRQcm9ncmVzcyIsIlNjcmFwZXJQcm9ncmVzc1R5cGVzIiwiTG9nZ2luZ0luIiwidmFsaWRhdGVVcmwiLCJ2YWxpZGF0ZVJlcXVlc3QiLCJpZCIsImNhcmRTdWZmaXgiLCJjYXJkNkRpZ2l0cyIsImNvdW50cnlDb2RlIiwiaWRUeXBlIiwiY2hlY2tMZXZlbCIsInZhbGlkYXRlUmVzdWx0IiwiZmV0Y2hQb3N0V2l0aGluUGFnZSIsIlZhbGlkYXRlSWREYXRhQmVhbiIsIkVycm9yIiwidmFsaWRhdGVSZXR1cm5Db2RlIiwicmV0dXJuQ29kZSIsInVzZXJOYW1lIiwibG9naW5VcmwiLCJLb2RNaXNodGFtZXNoIiwiTWlzcGFyWmlodXkiLCJTaXNtYSIsInBhc3N3b3JkIiwibG9naW5SZXN1bHQiLCJMb2dpblN1Y2Nlc3MiLCJDaGFuZ2VQYXNzd29yZCIsImVycm9yVHlwZSIsIlNjcmFwZXJFcnJvclR5cGVzIiwiTG9naW5GYWlsZWQiLCJJbnZhbGlkUGFzc3dvcmQiLCJmZXRjaERhdGEiLCJkZWZhdWx0U3RhcnRNb21lbnQiLCJzdWJ0cmFjdCIsInN0YXJ0RGF0ZSIsInRvRGF0ZSIsIm1heCIsIl9kZWZhdWx0IiwiZXhwb3J0cyJdLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9zY3JhcGVycy9iYXNlLWlzcmFjYXJkLWFtZXgudHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IG1vbWVudCwgeyB0eXBlIE1vbWVudCB9IGZyb20gJ21vbWVudCc7XHJcbmltcG9ydCB7IHR5cGUgUGFnZSB9IGZyb20gJ3B1cHBldGVlcic7XHJcbmltcG9ydCB7IEFMVF9TSEVLRUxfQ1VSUkVOQ1ksIFNIRUtFTF9DVVJSRU5DWSwgU0hFS0VMX0NVUlJFTkNZX0tFWVdPUkQgfSBmcm9tICcuLi9jb25zdGFudHMnO1xyXG5pbXBvcnQgeyBTY3JhcGVyUHJvZ3Jlc3NUeXBlcyB9IGZyb20gJy4uL2RlZmluaXRpb25zJztcclxuaW1wb3J0IGdldEFsbE1vbnRoTW9tZW50cyBmcm9tICcuLi9oZWxwZXJzL2RhdGVzJztcclxuaW1wb3J0IHsgZ2V0RGVidWcgfSBmcm9tICcuLi9oZWxwZXJzL2RlYnVnJztcclxuaW1wb3J0IHsgZmV0Y2hHZXRXaXRoaW5QYWdlLCBmZXRjaFBvc3RXaXRoaW5QYWdlIH0gZnJvbSAnLi4vaGVscGVycy9mZXRjaCc7XHJcbmltcG9ydCB7IGNodW5rIH0gZnJvbSAnLi4vaGVscGVycy9hcnJheXMnO1xyXG5pbXBvcnQgeyBmaWx0ZXJPbGRUcmFuc2FjdGlvbnMsIGZpeEluc3RhbGxtZW50cywgZ2V0UmF3VHJhbnNhY3Rpb24gfSBmcm9tICcuLi9oZWxwZXJzL3RyYW5zYWN0aW9ucyc7XHJcbmltcG9ydCB7IHJ1blNlcmlhbCwgc2xlZXAgfSBmcm9tICcuLi9oZWxwZXJzL3dhaXRpbmcnO1xyXG5pbXBvcnQge1xyXG4gIFRyYW5zYWN0aW9uU3RhdHVzZXMsXHJcbiAgVHJhbnNhY3Rpb25UeXBlcyxcclxuICB0eXBlIFRyYW5zYWN0aW9uLFxyXG4gIHR5cGUgVHJhbnNhY3Rpb25JbnN0YWxsbWVudHMsXHJcbiAgdHlwZSBUcmFuc2FjdGlvbnNBY2NvdW50LFxyXG59IGZyb20gJy4uL3RyYW5zYWN0aW9ucyc7XHJcbmltcG9ydCB7IEJhc2VTY3JhcGVyV2l0aEJyb3dzZXIgfSBmcm9tICcuL2Jhc2Utc2NyYXBlci13aXRoLWJyb3dzZXInO1xyXG5pbXBvcnQgeyBTY3JhcGVyRXJyb3JUeXBlcyB9IGZyb20gJy4vZXJyb3JzJztcclxuaW1wb3J0IHsgdHlwZSBTY3JhcGVyT3B0aW9ucywgdHlwZSBTY3JhcGVyU2NyYXBpbmdSZXN1bHQgfSBmcm9tICcuL2ludGVyZmFjZSc7XHJcbmltcG9ydCB7IGludGVyY2VwdGlvblByaW9yaXRpZXMsIG1hc2tIZWFkbGVzc1VzZXJBZ2VudCB9IGZyb20gJy4uL2hlbHBlcnMvYnJvd3Nlcic7XHJcblxyXG5jb25zdCBSQVRFX0xJTUlUID0ge1xyXG4gIFNMRUVQX0JFVFdFRU46IDEwMDAsXHJcbiAgVFJBTlNBQ1RJT05TX0JBVENIX1NJWkU6IDEwLFxyXG59IGFzIGNvbnN0O1xyXG5cclxuY29uc3QgQ09VTlRSWV9DT0RFID0gJzIxMic7XHJcbmNvbnN0IElEX1RZUEUgPSAnMSc7XHJcbmNvbnN0IElOU1RBTExNRU5UU19LRVlXT1JEID0gJ9eq16nXnNeV150nO1xyXG5cclxuY29uc3QgREFURV9GT1JNQVQgPSAnREQvTU0vWVlZWSc7XHJcblxyXG5jb25zdCBkZWJ1ZyA9IGdldERlYnVnKCdiYXNlLWlzcmFjYXJkLWFtZXgnKTtcclxuXHJcbnR5cGUgQ29tcGFueVNlcnZpY2VPcHRpb25zID0ge1xyXG4gIHNlcnZpY2VzVXJsOiBzdHJpbmc7XHJcbiAgY29tcGFueUNvZGU6IHN0cmluZztcclxufTtcclxuXHJcbnR5cGUgU2NyYXBlZEFjY291bnRzV2l0aEluZGV4ID0gUmVjb3JkPHN0cmluZywgVHJhbnNhY3Rpb25zQWNjb3VudCAmIHsgaW5kZXg6IG51bWJlciB9PjtcclxuXHJcbmludGVyZmFjZSBTY3JhcGVkVHJhbnNhY3Rpb24ge1xyXG4gIGRlYWxTdW1UeXBlOiBzdHJpbmc7XHJcbiAgdm91Y2hlck51bWJlclJhdHpPdXRib3VuZDogc3RyaW5nO1xyXG4gIHZvdWNoZXJOdW1iZXJSYXR6OiBzdHJpbmc7XHJcbiAgbW9yZUluZm8/OiBzdHJpbmc7XHJcbiAgZGVhbFN1bU91dGJvdW5kOiBib29sZWFuO1xyXG4gIGN1cnJlbmN5SWQ6IHN0cmluZztcclxuICBjdXJyZW50UGF5bWVudEN1cnJlbmN5OiBzdHJpbmc7XHJcbiAgZGVhbFN1bTogbnVtYmVyO1xyXG4gIGZ1bGxQYXltZW50RGF0ZT86IHN0cmluZztcclxuICBmdWxsUHVyY2hhc2VEYXRlPzogc3RyaW5nO1xyXG4gIGZ1bGxQdXJjaGFzZURhdGVPdXRib3VuZD86IHN0cmluZztcclxuICBmdWxsU3VwcGxpZXJOYW1lSGViOiBzdHJpbmc7XHJcbiAgZnVsbFN1cHBsaWVyTmFtZU91dGJvdW5kOiBzdHJpbmc7XHJcbiAgcGF5bWVudFN1bTogbnVtYmVyO1xyXG4gIHBheW1lbnRTdW1PdXRib3VuZDogbnVtYmVyO1xyXG59XHJcblxyXG5pbnRlcmZhY2UgU2NyYXBlZEFjY291bnQge1xyXG4gIGluZGV4OiBudW1iZXI7XHJcbiAgYWNjb3VudE51bWJlcjogc3RyaW5nO1xyXG4gIHByb2Nlc3NlZERhdGU6IHN0cmluZztcclxufVxyXG5cclxuaW50ZXJmYWNlIFNjcmFwZWRMb2dpblZhbGlkYXRpb24ge1xyXG4gIEhlYWRlcjoge1xyXG4gICAgU3RhdHVzOiBzdHJpbmc7XHJcbiAgfTtcclxuICBWYWxpZGF0ZUlkRGF0YUJlYW4/OiB7XHJcbiAgICB1c2VyTmFtZT86IHN0cmluZztcclxuICAgIHJldHVybkNvZGU6IHN0cmluZztcclxuICB9O1xyXG59XHJcblxyXG5pbnRlcmZhY2UgU2NyYXBlZEFjY291bnRzV2l0aGluUGFnZVJlc3BvbnNlIHtcclxuICBIZWFkZXI6IHtcclxuICAgIFN0YXR1czogc3RyaW5nO1xyXG4gIH07XHJcbiAgRGFzaGJvYXJkTW9udGhCZWFuPzoge1xyXG4gICAgY2FyZHNDaGFyZ2VzOiB7XHJcbiAgICAgIGNhcmRJbmRleDogc3RyaW5nO1xyXG4gICAgICBjYXJkTnVtYmVyOiBzdHJpbmc7XHJcbiAgICAgIGJpbGxpbmdEYXRlOiBzdHJpbmc7XHJcbiAgICB9W107XHJcbiAgfTtcclxufVxyXG5cclxuaW50ZXJmYWNlIFNjcmFwZWRDdXJyZW50Q2FyZFRyYW5zYWN0aW9ucyB7XHJcbiAgdHhuSXNyYWVsPzogU2NyYXBlZFRyYW5zYWN0aW9uW107XHJcbiAgdHhuQWJyb2FkPzogU2NyYXBlZFRyYW5zYWN0aW9uW107XHJcbn1cclxuXHJcbmludGVyZmFjZSBTY3JhcGVkVHJhbnNhY3Rpb25EYXRhIHtcclxuICBIZWFkZXI/OiB7XHJcbiAgICBTdGF0dXM6IHN0cmluZztcclxuICB9O1xyXG4gIFBpcnRleUlza2FfMjA0QmVhbj86IHtcclxuICAgIHNlY3Rvcjogc3RyaW5nO1xyXG4gIH07XHJcblxyXG4gIENhcmRzVHJhbnNhY3Rpb25zTGlzdEJlYW4/OiBSZWNvcmQ8XHJcbiAgICBzdHJpbmcsXHJcbiAgICB7XHJcbiAgICAgIEN1cnJlbnRDYXJkVHJhbnNhY3Rpb25zOiBTY3JhcGVkQ3VycmVudENhcmRUcmFuc2FjdGlvbnNbXTtcclxuICAgIH1cclxuICA+O1xyXG59XHJcblxyXG5mdW5jdGlvbiBnZXRBY2NvdW50c1VybChzZXJ2aWNlc1VybDogc3RyaW5nLCBtb250aE1vbWVudDogTW9tZW50KSB7XHJcbiAgY29uc3QgYmlsbGluZ0RhdGUgPSBtb250aE1vbWVudC5mb3JtYXQoJ1lZWVktTU0tREQnKTtcclxuICBjb25zdCB1cmwgPSBuZXcgVVJMKHNlcnZpY2VzVXJsKTtcclxuICB1cmwuc2VhcmNoUGFyYW1zLnNldCgncmVxTmFtZScsICdEYXNoYm9hcmRNb250aCcpO1xyXG4gIHVybC5zZWFyY2hQYXJhbXMuc2V0KCdhY3Rpb25Db2RlJywgJzAnKTtcclxuICB1cmwuc2VhcmNoUGFyYW1zLnNldCgnYmlsbGluZ0RhdGUnLCBiaWxsaW5nRGF0ZSk7XHJcbiAgdXJsLnNlYXJjaFBhcmFtcy5zZXQoJ2Zvcm1hdCcsICdKc29uJyk7XHJcbiAgcmV0dXJuIHVybC50b1N0cmluZygpO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBmZXRjaEFjY291bnRzKHBhZ2U6IFBhZ2UsIHNlcnZpY2VzVXJsOiBzdHJpbmcsIG1vbnRoTW9tZW50OiBNb21lbnQpOiBQcm9taXNlPFNjcmFwZWRBY2NvdW50W10+IHtcclxuICBjb25zdCBkYXRhVXJsID0gZ2V0QWNjb3VudHNVcmwoc2VydmljZXNVcmwsIG1vbnRoTW9tZW50KTtcclxuICBkZWJ1ZyhgZmV0Y2hpbmcgYWNjb3VudHMgZnJvbSAke2RhdGFVcmx9YCk7XHJcbiAgY29uc3QgZGF0YVJlc3VsdCA9IGF3YWl0IGZldGNoR2V0V2l0aGluUGFnZTxTY3JhcGVkQWNjb3VudHNXaXRoaW5QYWdlUmVzcG9uc2U+KHBhZ2UsIGRhdGFVcmwpO1xyXG4gIGlmIChkYXRhUmVzdWx0ICYmIGRhdGFSZXN1bHQuSGVhZGVyPy5TdGF0dXMgPT09ICcxJyAmJiBkYXRhUmVzdWx0LkRhc2hib2FyZE1vbnRoQmVhbikge1xyXG4gICAgY29uc3QgeyBjYXJkc0NoYXJnZXMgfSA9IGRhdGFSZXN1bHQuRGFzaGJvYXJkTW9udGhCZWFuO1xyXG4gICAgaWYgKGNhcmRzQ2hhcmdlcykge1xyXG4gICAgICByZXR1cm4gY2FyZHNDaGFyZ2VzLm1hcChjYXJkQ2hhcmdlID0+IHtcclxuICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgaW5kZXg6IHBhcnNlSW50KGNhcmRDaGFyZ2UuY2FyZEluZGV4LCAxMCksXHJcbiAgICAgICAgICBhY2NvdW50TnVtYmVyOiBjYXJkQ2hhcmdlLmNhcmROdW1iZXIsXHJcbiAgICAgICAgICBwcm9jZXNzZWREYXRlOiBtb21lbnQoY2FyZENoYXJnZS5iaWxsaW5nRGF0ZSwgREFURV9GT1JNQVQpLnRvSVNPU3RyaW5nKCksXHJcbiAgICAgICAgfTtcclxuICAgICAgfSk7XHJcbiAgICB9XHJcbiAgfVxyXG4gIHJldHVybiBbXTtcclxufVxyXG5cclxuZnVuY3Rpb24gZ2V0VHJhbnNhY3Rpb25zVXJsKHNlcnZpY2VzVXJsOiBzdHJpbmcsIG1vbnRoTW9tZW50OiBNb21lbnQpIHtcclxuICBjb25zdCBtb250aCA9IG1vbnRoTW9tZW50Lm1vbnRoKCkgKyAxO1xyXG4gIGNvbnN0IHllYXIgPSBtb250aE1vbWVudC55ZWFyKCk7XHJcbiAgY29uc3QgbW9udGhTdHIgPSBtb250aCA8IDEwID8gYDAke21vbnRofWAgOiBtb250aC50b1N0cmluZygpO1xyXG4gIGNvbnN0IHVybCA9IG5ldyBVUkwoc2VydmljZXNVcmwpO1xyXG4gIHVybC5zZWFyY2hQYXJhbXMuc2V0KCdyZXFOYW1lJywgJ0NhcmRzVHJhbnNhY3Rpb25zTGlzdCcpO1xyXG4gIHVybC5zZWFyY2hQYXJhbXMuc2V0KCdtb250aCcsIG1vbnRoU3RyKTtcclxuICB1cmwuc2VhcmNoUGFyYW1zLnNldCgneWVhcicsIGAke3llYXJ9YCk7XHJcbiAgdXJsLnNlYXJjaFBhcmFtcy5zZXQoJ3JlcXVpcmVkRGF0ZScsICdOJyk7XHJcbiAgcmV0dXJuIHVybC50b1N0cmluZygpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBjb252ZXJ0Q3VycmVuY3koY3VycmVuY3lTdHI6IHN0cmluZykge1xyXG4gIGlmIChjdXJyZW5jeVN0ciA9PT0gU0hFS0VMX0NVUlJFTkNZX0tFWVdPUkQgfHwgY3VycmVuY3lTdHIgPT09IEFMVF9TSEVLRUxfQ1VSUkVOQ1kpIHtcclxuICAgIHJldHVybiBTSEVLRUxfQ1VSUkVOQ1k7XHJcbiAgfVxyXG4gIHJldHVybiBjdXJyZW5jeVN0cjtcclxufVxyXG5cclxuZnVuY3Rpb24gZ2V0SW5zdGFsbG1lbnRzSW5mbyh0eG46IFNjcmFwZWRUcmFuc2FjdGlvbik6IFRyYW5zYWN0aW9uSW5zdGFsbG1lbnRzIHwgdW5kZWZpbmVkIHtcclxuICBpZiAoIXR4bi5tb3JlSW5mbyB8fCAhdHhuLm1vcmVJbmZvLmluY2x1ZGVzKElOU1RBTExNRU5UU19LRVlXT1JEKSkge1xyXG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcclxuICB9XHJcbiAgY29uc3QgbWF0Y2hlcyA9IHR4bi5tb3JlSW5mby5tYXRjaCgvXFxkKy9nKTtcclxuICBpZiAoIW1hdGNoZXMgfHwgbWF0Y2hlcy5sZW5ndGggPCAyKSB7XHJcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xyXG4gIH1cclxuXHJcbiAgcmV0dXJuIHtcclxuICAgIG51bWJlcjogcGFyc2VJbnQobWF0Y2hlc1swXSwgMTApLFxyXG4gICAgdG90YWw6IHBhcnNlSW50KG1hdGNoZXNbMV0sIDEwKSxcclxuICB9O1xyXG59XHJcblxyXG5mdW5jdGlvbiBnZXRUcmFuc2FjdGlvblR5cGUodHhuOiBTY3JhcGVkVHJhbnNhY3Rpb24pIHtcclxuICByZXR1cm4gZ2V0SW5zdGFsbG1lbnRzSW5mbyh0eG4pID8gVHJhbnNhY3Rpb25UeXBlcy5JbnN0YWxsbWVudHMgOiBUcmFuc2FjdGlvblR5cGVzLk5vcm1hbDtcclxufVxyXG5cclxuZnVuY3Rpb24gY29udmVydFRyYW5zYWN0aW9ucyhcclxuICB0eG5zOiBTY3JhcGVkVHJhbnNhY3Rpb25bXSxcclxuICBwcm9jZXNzZWREYXRlOiBzdHJpbmcsXHJcbiAgb3B0aW9ucz86IFNjcmFwZXJPcHRpb25zLFxyXG4pOiBUcmFuc2FjdGlvbltdIHtcclxuICBjb25zdCBmaWx0ZXJlZFR4bnMgPSB0eG5zLmZpbHRlcihcclxuICAgIHR4biA9PlxyXG4gICAgICB0eG4uZGVhbFN1bVR5cGUgIT09ICcxJyAmJiB0eG4udm91Y2hlck51bWJlclJhdHogIT09ICcwMDAwMDAwMDAnICYmIHR4bi52b3VjaGVyTnVtYmVyUmF0ek91dGJvdW5kICE9PSAnMDAwMDAwMDAwJyxcclxuICApO1xyXG5cclxuICByZXR1cm4gZmlsdGVyZWRUeG5zLm1hcCh0eG4gPT4ge1xyXG4gICAgY29uc3QgaXNPdXRib3VuZCA9IHR4bi5kZWFsU3VtT3V0Ym91bmQ7XHJcbiAgICBjb25zdCB0eG5EYXRlU3RyID0gaXNPdXRib3VuZCA/IHR4bi5mdWxsUHVyY2hhc2VEYXRlT3V0Ym91bmQgOiB0eG4uZnVsbFB1cmNoYXNlRGF0ZTtcclxuICAgIGNvbnN0IHR4bk1vbWVudCA9IG1vbWVudCh0eG5EYXRlU3RyLCBEQVRFX0ZPUk1BVCk7XHJcblxyXG4gICAgY29uc3QgY3VycmVudFByb2Nlc3NlZERhdGUgPSB0eG4uZnVsbFBheW1lbnREYXRlXHJcbiAgICAgID8gbW9tZW50KHR4bi5mdWxsUGF5bWVudERhdGUsIERBVEVfRk9STUFUKS50b0lTT1N0cmluZygpXHJcbiAgICAgIDogcHJvY2Vzc2VkRGF0ZTtcclxuICAgIGNvbnN0IHJlc3VsdDogVHJhbnNhY3Rpb24gPSB7XHJcbiAgICAgIHR5cGU6IGdldFRyYW5zYWN0aW9uVHlwZSh0eG4pLFxyXG4gICAgICBpZGVudGlmaWVyOiBwYXJzZUludChpc091dGJvdW5kID8gdHhuLnZvdWNoZXJOdW1iZXJSYXR6T3V0Ym91bmQgOiB0eG4udm91Y2hlck51bWJlclJhdHosIDEwKSxcclxuICAgICAgZGF0ZTogdHhuTW9tZW50LnRvSVNPU3RyaW5nKCksXHJcbiAgICAgIHByb2Nlc3NlZERhdGU6IGN1cnJlbnRQcm9jZXNzZWREYXRlLFxyXG4gICAgICBvcmlnaW5hbEFtb3VudDogaXNPdXRib3VuZCA/IC10eG4uZGVhbFN1bU91dGJvdW5kIDogLXR4bi5kZWFsU3VtLFxyXG4gICAgICBvcmlnaW5hbEN1cnJlbmN5OiBjb252ZXJ0Q3VycmVuY3kodHhuLmN1cnJlbnRQYXltZW50Q3VycmVuY3kgPz8gdHhuLmN1cnJlbmN5SWQpLFxyXG4gICAgICBjaGFyZ2VkQW1vdW50OiBpc091dGJvdW5kID8gLXR4bi5wYXltZW50U3VtT3V0Ym91bmQgOiAtdHhuLnBheW1lbnRTdW0sXHJcbiAgICAgIGNoYXJnZWRDdXJyZW5jeTogY29udmVydEN1cnJlbmN5KHR4bi5jdXJyZW5jeUlkKSxcclxuICAgICAgZGVzY3JpcHRpb246IGlzT3V0Ym91bmQgPyB0eG4uZnVsbFN1cHBsaWVyTmFtZU91dGJvdW5kIDogdHhuLmZ1bGxTdXBwbGllck5hbWVIZWIsXHJcbiAgICAgIG1lbW86IHR4bi5tb3JlSW5mbyB8fCAnJyxcclxuICAgICAgaW5zdGFsbG1lbnRzOiBnZXRJbnN0YWxsbWVudHNJbmZvKHR4bikgfHwgdW5kZWZpbmVkLFxyXG4gICAgICBzdGF0dXM6IFRyYW5zYWN0aW9uU3RhdHVzZXMuQ29tcGxldGVkLFxyXG4gICAgfTtcclxuXHJcbiAgICBpZiAob3B0aW9ucz8uaW5jbHVkZVJhd1RyYW5zYWN0aW9uKSB7XHJcbiAgICAgIHJlc3VsdC5yYXdUcmFuc2FjdGlvbiA9IGdldFJhd1RyYW5zYWN0aW9uKHR4bik7XHJcbiAgICB9XHJcblxyXG4gICAgcmV0dXJuIHJlc3VsdDtcclxuICB9KTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gZmV0Y2hUcmFuc2FjdGlvbnMoXHJcbiAgcGFnZTogUGFnZSxcclxuICBvcHRpb25zOiBTY3JhcGVyT3B0aW9ucyxcclxuICBjb21wYW55U2VydmljZU9wdGlvbnM6IENvbXBhbnlTZXJ2aWNlT3B0aW9ucyxcclxuICBzdGFydE1vbWVudDogTW9tZW50LFxyXG4gIG1vbnRoTW9tZW50OiBNb21lbnQsXHJcbik6IFByb21pc2U8U2NyYXBlZEFjY291bnRzV2l0aEluZGV4PiB7XHJcbiAgY29uc3QgYWNjb3VudHMgPSBhd2FpdCBmZXRjaEFjY291bnRzKHBhZ2UsIGNvbXBhbnlTZXJ2aWNlT3B0aW9ucy5zZXJ2aWNlc1VybCwgbW9udGhNb21lbnQpO1xyXG4gIGNvbnN0IGRhdGFVcmwgPSBnZXRUcmFuc2FjdGlvbnNVcmwoY29tcGFueVNlcnZpY2VPcHRpb25zLnNlcnZpY2VzVXJsLCBtb250aE1vbWVudCk7XHJcbiAgYXdhaXQgc2xlZXAoUkFURV9MSU1JVC5TTEVFUF9CRVRXRUVOKTtcclxuICBkZWJ1ZyhgZmV0Y2hpbmcgdHJhbnNhY3Rpb25zIGZyb20gJHtkYXRhVXJsfSBmb3IgbW9udGggJHttb250aE1vbWVudC5mb3JtYXQoJ1lZWVktTU0nKX1gKTtcclxuICBjb25zdCBkYXRhUmVzdWx0ID0gYXdhaXQgZmV0Y2hHZXRXaXRoaW5QYWdlPFNjcmFwZWRUcmFuc2FjdGlvbkRhdGE+KHBhZ2UsIGRhdGFVcmwpO1xyXG4gIGlmIChkYXRhUmVzdWx0ICYmIGRhdGFSZXN1bHQuSGVhZGVyPy5TdGF0dXMgPT09ICcxJyAmJiBkYXRhUmVzdWx0LkNhcmRzVHJhbnNhY3Rpb25zTGlzdEJlYW4pIHtcclxuICAgIGNvbnN0IGFjY291bnRUeG5zOiBTY3JhcGVkQWNjb3VudHNXaXRoSW5kZXggPSB7fTtcclxuICAgIGFjY291bnRzLmZvckVhY2goYWNjb3VudCA9PiB7XHJcbiAgICAgIGNvbnN0IHR4bkdyb3VwczogU2NyYXBlZEN1cnJlbnRDYXJkVHJhbnNhY3Rpb25zW10gfCB1bmRlZmluZWQgPVxyXG4gICAgICAgIGRhdGFSZXN1bHQuQ2FyZHNUcmFuc2FjdGlvbnNMaXN0QmVhbj8uW2BJbmRleCR7YWNjb3VudC5pbmRleH1gXT8uQ3VycmVudENhcmRUcmFuc2FjdGlvbnM7XHJcbiAgICAgIGlmICh0eG5Hcm91cHMpIHtcclxuICAgICAgICBsZXQgYWxsVHhuczogVHJhbnNhY3Rpb25bXSA9IFtdO1xyXG4gICAgICAgIHR4bkdyb3Vwcy5mb3JFYWNoKHR4bkdyb3VwID0+IHtcclxuICAgICAgICAgIGlmICh0eG5Hcm91cC50eG5Jc3JhZWwpIHtcclxuICAgICAgICAgICAgY29uc3QgdHhucyA9IGNvbnZlcnRUcmFuc2FjdGlvbnModHhuR3JvdXAudHhuSXNyYWVsLCBhY2NvdW50LnByb2Nlc3NlZERhdGUsIG9wdGlvbnMpO1xyXG4gICAgICAgICAgICBhbGxUeG5zLnB1c2goLi4udHhucyk7XHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgICBpZiAodHhuR3JvdXAudHhuQWJyb2FkKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHR4bnMgPSBjb252ZXJ0VHJhbnNhY3Rpb25zKHR4bkdyb3VwLnR4bkFicm9hZCwgYWNjb3VudC5wcm9jZXNzZWREYXRlLCBvcHRpb25zKTtcclxuICAgICAgICAgICAgYWxsVHhucy5wdXNoKC4uLnR4bnMpO1xyXG4gICAgICAgICAgfVxyXG4gICAgICAgIH0pO1xyXG5cclxuICAgICAgICBpZiAoIW9wdGlvbnMuY29tYmluZUluc3RhbGxtZW50cykge1xyXG4gICAgICAgICAgYWxsVHhucyA9IGZpeEluc3RhbGxtZW50cyhhbGxUeG5zKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKG9wdGlvbnMub3V0cHV0RGF0YT8uZW5hYmxlVHJhbnNhY3Rpb25zRmlsdGVyQnlEYXRlID8/IHRydWUpIHtcclxuICAgICAgICAgIGFsbFR4bnMgPSBmaWx0ZXJPbGRUcmFuc2FjdGlvbnMoYWxsVHhucywgc3RhcnRNb21lbnQsIG9wdGlvbnMuY29tYmluZUluc3RhbGxtZW50cyB8fCBmYWxzZSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGFjY291bnRUeG5zW2FjY291bnQuYWNjb3VudE51bWJlcl0gPSB7XHJcbiAgICAgICAgICBhY2NvdW50TnVtYmVyOiBhY2NvdW50LmFjY291bnROdW1iZXIsXHJcbiAgICAgICAgICBpbmRleDogYWNjb3VudC5pbmRleCxcclxuICAgICAgICAgIHR4bnM6IGFsbFR4bnMsXHJcbiAgICAgICAgfTtcclxuICAgICAgfVxyXG4gICAgfSk7XHJcbiAgICByZXR1cm4gYWNjb3VudFR4bnM7XHJcbiAgfVxyXG5cclxuICByZXR1cm4ge307XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGdldEV4dHJhU2NyYXBUcmFuc2FjdGlvbihcclxuICBwYWdlOiBQYWdlLFxyXG4gIG9wdGlvbnM6IENvbXBhbnlTZXJ2aWNlT3B0aW9ucyxcclxuICBtb250aDogTW9tZW50LFxyXG4gIGFjY291bnRJbmRleDogbnVtYmVyLFxyXG4gIHRyYW5zYWN0aW9uOiBUcmFuc2FjdGlvbixcclxuKTogUHJvbWlzZTxUcmFuc2FjdGlvbj4ge1xyXG4gIGNvbnN0IHVybCA9IG5ldyBVUkwob3B0aW9ucy5zZXJ2aWNlc1VybCk7XHJcbiAgdXJsLnNlYXJjaFBhcmFtcy5zZXQoJ3JlcU5hbWUnLCAnUGlydGV5SXNrYV8yMDQnKTtcclxuICB1cmwuc2VhcmNoUGFyYW1zLnNldCgnQ2FyZEluZGV4JywgYWNjb3VudEluZGV4LnRvU3RyaW5nKCkpO1xyXG4gIHVybC5zZWFyY2hQYXJhbXMuc2V0KCdzaG92YXJSYXR6JywgdHJhbnNhY3Rpb24uaWRlbnRpZmllciEudG9TdHJpbmcoKSk7XHJcbiAgdXJsLnNlYXJjaFBhcmFtcy5zZXQoJ21vZWRDaGl1dicsIG1vbnRoLmZvcm1hdCgnTU1ZWVlZJykpO1xyXG5cclxuICBkZWJ1ZyhgZmV0Y2hpbmcgZXh0cmEgc2NyYXAgZm9yIHRyYW5zYWN0aW9uICR7dHJhbnNhY3Rpb24uaWRlbnRpZmllcn0gZm9yIG1vbnRoICR7bW9udGguZm9ybWF0KCdZWVlZLU1NJyl9YCk7XHJcbiAgY29uc3QgZGF0YSA9IGF3YWl0IGZldGNoR2V0V2l0aGluUGFnZTxTY3JhcGVkVHJhbnNhY3Rpb25EYXRhPihwYWdlLCB1cmwudG9TdHJpbmcoKSk7XHJcbiAgaWYgKCFkYXRhKSB7XHJcbiAgICByZXR1cm4gdHJhbnNhY3Rpb247XHJcbiAgfVxyXG5cclxuICBjb25zdCByYXdDYXRlZ29yeSA9IGRhdGEuUGlydGV5SXNrYV8yMDRCZWFuPy5zZWN0b3IgPz8gJyc7XHJcbiAgcmV0dXJuIHtcclxuICAgIC4uLnRyYW5zYWN0aW9uLFxyXG4gICAgY2F0ZWdvcnk6IHJhd0NhdGVnb3J5LnRyaW0oKSxcclxuICAgIHJhd1RyYW5zYWN0aW9uOiBnZXRSYXdUcmFuc2FjdGlvbihkYXRhLCB0cmFuc2FjdGlvbiksXHJcbiAgfTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gZ2V0RXh0cmFTY3JhcEFjY291bnQoXHJcbiAgcGFnZTogUGFnZSxcclxuICBvcHRpb25zOiBDb21wYW55U2VydmljZU9wdGlvbnMsXHJcbiAgYWNjb3VudE1hcDogU2NyYXBlZEFjY291bnRzV2l0aEluZGV4LFxyXG4gIG1vbnRoOiBtb21lbnQuTW9tZW50LFxyXG4pOiBQcm9taXNlPFNjcmFwZWRBY2NvdW50c1dpdGhJbmRleD4ge1xyXG4gIGNvbnN0IGFjY291bnRzOiBTY3JhcGVkQWNjb3VudHNXaXRoSW5kZXhbc3RyaW5nXVtdID0gW107XHJcbiAgZm9yIChjb25zdCBhY2NvdW50IG9mIE9iamVjdC52YWx1ZXMoYWNjb3VudE1hcCkpIHtcclxuICAgIGRlYnVnKFxyXG4gICAgICBgZ2V0IGV4dHJhIHNjcmFwIGZvciAke2FjY291bnQuYWNjb3VudE51bWJlcn0gd2l0aCAke2FjY291bnQudHhucy5sZW5ndGh9IHRyYW5zYWN0aW9uc2AsXHJcbiAgICAgIG1vbnRoLmZvcm1hdCgnWVlZWS1NTScpLFxyXG4gICAgKTtcclxuICAgIGNvbnN0IHR4bnM6IFRyYW5zYWN0aW9uW10gPSBbXTtcclxuICAgIGZvciAoY29uc3QgdHhuc0NodW5rIG9mIGNodW5rKGFjY291bnQudHhucywgUkFURV9MSU1JVC5UUkFOU0FDVElPTlNfQkFUQ0hfU0laRSkpIHtcclxuICAgICAgZGVidWcoYHByb2Nlc3NpbmcgY2h1bmsgb2YgJHt0eG5zQ2h1bmsubGVuZ3RofSB0cmFuc2FjdGlvbnMgZm9yIGFjY291bnQgJHthY2NvdW50LmFjY291bnROdW1iZXJ9YCk7XHJcbiAgICAgIGNvbnN0IHVwZGF0ZWRUeG5zID0gYXdhaXQgUHJvbWlzZS5hbGwoXHJcbiAgICAgICAgdHhuc0NodW5rLm1hcCh0ID0+IGdldEV4dHJhU2NyYXBUcmFuc2FjdGlvbihwYWdlLCBvcHRpb25zLCBtb250aCwgYWNjb3VudC5pbmRleCwgdCkpLFxyXG4gICAgICApO1xyXG4gICAgICBhd2FpdCBzbGVlcChSQVRFX0xJTUlULlNMRUVQX0JFVFdFRU4pO1xyXG4gICAgICB0eG5zLnB1c2goLi4udXBkYXRlZFR4bnMpO1xyXG4gICAgfVxyXG4gICAgYWNjb3VudHMucHVzaCh7IC4uLmFjY291bnQsIHR4bnMgfSk7XHJcbiAgfVxyXG5cclxuICByZXR1cm4gYWNjb3VudHMucmVkdWNlKChtLCB4KSA9PiAoeyAuLi5tLCBbeC5hY2NvdW50TnVtYmVyXTogeCB9KSwge30pO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBnZXRBZGRpdGlvbmFsVHJhbnNhY3Rpb25JbmZvcm1hdGlvbihcclxuICBzY3JhcGVyT3B0aW9uczogU2NyYXBlck9wdGlvbnMsXHJcbiAgYWNjb3VudHNXaXRoSW5kZXg6IFNjcmFwZWRBY2NvdW50c1dpdGhJbmRleFtdLFxyXG4gIHBhZ2U6IFBhZ2UsXHJcbiAgb3B0aW9uczogQ29tcGFueVNlcnZpY2VPcHRpb25zLFxyXG4gIGFsbE1vbnRoczogbW9tZW50Lk1vbWVudFtdLFxyXG4pOiBQcm9taXNlPFNjcmFwZWRBY2NvdW50c1dpdGhJbmRleFtdPiB7XHJcbiAgaWYgKFxyXG4gICAgIXNjcmFwZXJPcHRpb25zLmFkZGl0aW9uYWxUcmFuc2FjdGlvbkluZm9ybWF0aW9uIHx8XHJcbiAgICBzY3JhcGVyT3B0aW9ucy5vcHRJbkZlYXR1cmVzPy5pbmNsdWRlcygnaXNyYWNhcmQtYW1leDpza2lwQWRkaXRpb25hbFRyYW5zYWN0aW9uSW5mb3JtYXRpb24nKVxyXG4gICkge1xyXG4gICAgcmV0dXJuIGFjY291bnRzV2l0aEluZGV4O1xyXG4gIH1cclxuICByZXR1cm4gcnVuU2VyaWFsKGFjY291bnRzV2l0aEluZGV4Lm1hcCgoYSwgaSkgPT4gKCkgPT4gZ2V0RXh0cmFTY3JhcEFjY291bnQocGFnZSwgb3B0aW9ucywgYSwgYWxsTW9udGhzW2ldKSkpO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBmZXRjaEFsbFRyYW5zYWN0aW9ucyhcclxuICBwYWdlOiBQYWdlLFxyXG4gIG9wdGlvbnM6IFNjcmFwZXJPcHRpb25zLFxyXG4gIGNvbXBhbnlTZXJ2aWNlT3B0aW9uczogQ29tcGFueVNlcnZpY2VPcHRpb25zLFxyXG4gIHN0YXJ0TW9tZW50OiBNb21lbnQsXHJcbikge1xyXG4gIGNvbnN0IGZ1dHVyZU1vbnRoc1RvU2NyYXBlID0gb3B0aW9ucy5mdXR1cmVNb250aHNUb1NjcmFwZSA/PyAxO1xyXG4gIGNvbnN0IGFsbE1vbnRocyA9IGdldEFsbE1vbnRoTW9tZW50cyhzdGFydE1vbWVudCwgZnV0dXJlTW9udGhzVG9TY3JhcGUpO1xyXG4gIGNvbnN0IHJlc3VsdHM6IFNjcmFwZWRBY2NvdW50c1dpdGhJbmRleFtdID0gYXdhaXQgcnVuU2VyaWFsKFxyXG4gICAgYWxsTW9udGhzLm1hcChtb250aE1vbWVudCA9PiAoKSA9PiB7XHJcbiAgICAgIHJldHVybiBmZXRjaFRyYW5zYWN0aW9ucyhwYWdlLCBvcHRpb25zLCBjb21wYW55U2VydmljZU9wdGlvbnMsIHN0YXJ0TW9tZW50LCBtb250aE1vbWVudCk7XHJcbiAgICB9KSxcclxuICApO1xyXG5cclxuICBjb25zdCBmaW5hbFJlc3VsdCA9IGF3YWl0IGdldEFkZGl0aW9uYWxUcmFuc2FjdGlvbkluZm9ybWF0aW9uKFxyXG4gICAgb3B0aW9ucyxcclxuICAgIHJlc3VsdHMsXHJcbiAgICBwYWdlLFxyXG4gICAgY29tcGFueVNlcnZpY2VPcHRpb25zLFxyXG4gICAgYWxsTW9udGhzLFxyXG4gICk7XHJcbiAgY29uc3QgY29tYmluZWRUeG5zOiBSZWNvcmQ8c3RyaW5nLCBUcmFuc2FjdGlvbltdPiA9IHt9O1xyXG5cclxuICBmaW5hbFJlc3VsdC5mb3JFYWNoKHJlc3VsdCA9PiB7XHJcbiAgICBPYmplY3Qua2V5cyhyZXN1bHQpLmZvckVhY2goYWNjb3VudE51bWJlciA9PiB7XHJcbiAgICAgIGxldCB0eG5zRm9yQWNjb3VudCA9IGNvbWJpbmVkVHhuc1thY2NvdW50TnVtYmVyXTtcclxuICAgICAgaWYgKCF0eG5zRm9yQWNjb3VudCkge1xyXG4gICAgICAgIHR4bnNGb3JBY2NvdW50ID0gW107XHJcbiAgICAgICAgY29tYmluZWRUeG5zW2FjY291bnROdW1iZXJdID0gdHhuc0ZvckFjY291bnQ7XHJcbiAgICAgIH1cclxuICAgICAgY29uc3QgdG9CZUFkZGVkVHhucyA9IHJlc3VsdFthY2NvdW50TnVtYmVyXS50eG5zO1xyXG4gICAgICBjb21iaW5lZFR4bnNbYWNjb3VudE51bWJlcl0ucHVzaCguLi50b0JlQWRkZWRUeG5zKTtcclxuICAgIH0pO1xyXG4gIH0pO1xyXG5cclxuICBjb25zdCBhY2NvdW50cyA9IE9iamVjdC5rZXlzKGNvbWJpbmVkVHhucykubWFwKGFjY291bnROdW1iZXIgPT4ge1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgYWNjb3VudE51bWJlcixcclxuICAgICAgdHhuczogY29tYmluZWRUeG5zW2FjY291bnROdW1iZXJdLFxyXG4gICAgfTtcclxuICB9KTtcclxuXHJcbiAgcmV0dXJuIHtcclxuICAgIHN1Y2Nlc3M6IHRydWUsXHJcbiAgICBhY2NvdW50cyxcclxuICB9O1xyXG59XHJcblxyXG50eXBlIFNjcmFwZXJTcGVjaWZpY0NyZWRlbnRpYWxzID0geyBpZDogc3RyaW5nOyBwYXNzd29yZDogc3RyaW5nOyBjYXJkNkRpZ2l0czogc3RyaW5nIH07XHJcbmNsYXNzIElzcmFjYXJkQW1leEJhc2VTY3JhcGVyIGV4dGVuZHMgQmFzZVNjcmFwZXJXaXRoQnJvd3NlcjxTY3JhcGVyU3BlY2lmaWNDcmVkZW50aWFscz4ge1xyXG4gIHByaXZhdGUgYmFzZVVybDogc3RyaW5nO1xyXG5cclxuICBwcml2YXRlIGNvbXBhbnlDb2RlOiBzdHJpbmc7XHJcblxyXG4gIHByaXZhdGUgc2VydmljZXNVcmw6IHN0cmluZztcclxuXHJcbiAgY29uc3RydWN0b3Iob3B0aW9uczogU2NyYXBlck9wdGlvbnMsIGJhc2VVcmw6IHN0cmluZywgY29tcGFueUNvZGU6IHN0cmluZykge1xyXG4gICAgc3VwZXIob3B0aW9ucyk7XHJcblxyXG4gICAgdGhpcy5iYXNlVXJsID0gYmFzZVVybDtcclxuICAgIHRoaXMuY29tcGFueUNvZGUgPSBjb21wYW55Q29kZTtcclxuICAgIHRoaXMuc2VydmljZXNVcmwgPSBgJHtiYXNlVXJsfS9zZXJ2aWNlcy9Qcm94eVJlcXVlc3RIYW5kbGVyLmFzaHhgO1xyXG4gIH1cclxuXHJcbiAgYXN5bmMgbG9naW4oY3JlZGVudGlhbHM6IFNjcmFwZXJTcGVjaWZpY0NyZWRlbnRpYWxzKTogUHJvbWlzZTxTY3JhcGVyU2NyYXBpbmdSZXN1bHQ+IHtcclxuICAgIGF3YWl0IHRoaXMucGFnZS5zZXRSZXF1ZXN0SW50ZXJjZXB0aW9uKHRydWUpO1xyXG4gICAgdGhpcy5wYWdlLm9uKCdyZXF1ZXN0JywgcmVxdWVzdCA9PiB7XHJcbiAgICAgIGlmIChyZXF1ZXN0LnVybCgpLmluY2x1ZGVzKCdkZXRlY3Rvci1kb20ubWluLmpzJykpIHtcclxuICAgICAgICBkZWJ1ZygnZm9yY2UgYWJvcnQgZm9yIHJlcXVlc3QgZG8gZG93bmxvYWQgZGV0ZWN0b3ItZG9tLm1pbi5qcyByZXNvdXJjZScpO1xyXG4gICAgICAgIHZvaWQgcmVxdWVzdC5hYm9ydCh1bmRlZmluZWQsIGludGVyY2VwdGlvblByaW9yaXRpZXMuYWJvcnQpO1xyXG4gICAgICB9IGVsc2Uge1xyXG4gICAgICAgIHZvaWQgcmVxdWVzdC5jb250aW51ZSh1bmRlZmluZWQsIGludGVyY2VwdGlvblByaW9yaXRpZXMuY29udGludWUpO1xyXG4gICAgICB9XHJcbiAgICB9KTtcclxuXHJcbiAgICBhd2FpdCBtYXNrSGVhZGxlc3NVc2VyQWdlbnQodGhpcy5wYWdlKTtcclxuXHJcbiAgICBhd2FpdCB0aGlzLm5hdmlnYXRlVG8oYCR7dGhpcy5iYXNlVXJsfS9wZXJzb25hbGFyZWEvTG9naW5gKTtcclxuXHJcbiAgICB0aGlzLmVtaXRQcm9ncmVzcyhTY3JhcGVyUHJvZ3Jlc3NUeXBlcy5Mb2dnaW5nSW4pO1xyXG5cclxuICAgIGNvbnN0IHZhbGlkYXRlVXJsID0gYCR7dGhpcy5zZXJ2aWNlc1VybH0/cmVxTmFtZT1WYWxpZGF0ZUlkRGF0YWA7XHJcbiAgICBjb25zdCB2YWxpZGF0ZVJlcXVlc3QgPSB7XHJcbiAgICAgIGlkOiBjcmVkZW50aWFscy5pZCxcclxuICAgICAgY2FyZFN1ZmZpeDogY3JlZGVudGlhbHMuY2FyZDZEaWdpdHMsXHJcbiAgICAgIGNvdW50cnlDb2RlOiBDT1VOVFJZX0NPREUsXHJcbiAgICAgIGlkVHlwZTogSURfVFlQRSxcclxuICAgICAgY2hlY2tMZXZlbDogJzEnLFxyXG4gICAgICBjb21wYW55Q29kZTogdGhpcy5jb21wYW55Q29kZSxcclxuICAgIH07XHJcbiAgICBkZWJ1ZygnbG9nZ2luZyBpbiB3aXRoIHZhbGlkYXRlIHJlcXVlc3QnKTtcclxuICAgIGNvbnN0IHZhbGlkYXRlUmVzdWx0ID0gYXdhaXQgZmV0Y2hQb3N0V2l0aGluUGFnZTxTY3JhcGVkTG9naW5WYWxpZGF0aW9uPih0aGlzLnBhZ2UsIHZhbGlkYXRlVXJsLCB2YWxpZGF0ZVJlcXVlc3QpO1xyXG4gICAgaWYgKFxyXG4gICAgICAhdmFsaWRhdGVSZXN1bHQgfHxcclxuICAgICAgIXZhbGlkYXRlUmVzdWx0LkhlYWRlciB8fFxyXG4gICAgICB2YWxpZGF0ZVJlc3VsdC5IZWFkZXIuU3RhdHVzICE9PSAnMScgfHxcclxuICAgICAgIXZhbGlkYXRlUmVzdWx0LlZhbGlkYXRlSWREYXRhQmVhblxyXG4gICAgKSB7XHJcbiAgICAgIHRocm93IG5ldyBFcnJvcigndW5rbm93biBlcnJvciBkdXJpbmcgbG9naW4nKTtcclxuICAgIH1cclxuXHJcbiAgICBjb25zdCB2YWxpZGF0ZVJldHVybkNvZGUgPSB2YWxpZGF0ZVJlc3VsdC5WYWxpZGF0ZUlkRGF0YUJlYW4ucmV0dXJuQ29kZTtcclxuICAgIGRlYnVnKGB1c2VyIHZhbGlkYXRlIHdpdGggcmV0dXJuIGNvZGUgJyR7dmFsaWRhdGVSZXR1cm5Db2RlfSdgKTtcclxuICAgIGlmICh2YWxpZGF0ZVJldHVybkNvZGUgPT09ICcxJykge1xyXG4gICAgICBjb25zdCB7IHVzZXJOYW1lIH0gPSB2YWxpZGF0ZVJlc3VsdC5WYWxpZGF0ZUlkRGF0YUJlYW47XHJcblxyXG4gICAgICBjb25zdCBsb2dpblVybCA9IGAke3RoaXMuc2VydmljZXNVcmx9P3JlcU5hbWU9cGVyZm9ybUxvZ29uSWA7XHJcbiAgICAgIGNvbnN0IHJlcXVlc3QgPSB7XHJcbiAgICAgICAgS29kTWlzaHRhbWVzaDogdXNlck5hbWUsXHJcbiAgICAgICAgTWlzcGFyWmlodXk6IGNyZWRlbnRpYWxzLmlkLFxyXG4gICAgICAgIFNpc21hOiBjcmVkZW50aWFscy5wYXNzd29yZCxcclxuICAgICAgICBjYXJkU3VmZml4OiBjcmVkZW50aWFscy5jYXJkNkRpZ2l0cyxcclxuICAgICAgICBjb3VudHJ5Q29kZTogQ09VTlRSWV9DT0RFLFxyXG4gICAgICAgIGlkVHlwZTogSURfVFlQRSxcclxuICAgICAgfTtcclxuICAgICAgZGVidWcoJ3VzZXIgbG9naW4gc3RhcnRlZCcpO1xyXG4gICAgICBjb25zdCBsb2dpblJlc3VsdCA9IGF3YWl0IGZldGNoUG9zdFdpdGhpblBhZ2U8eyBzdGF0dXM6IHN0cmluZyB9Pih0aGlzLnBhZ2UsIGxvZ2luVXJsLCByZXF1ZXN0KTtcclxuICAgICAgZGVidWcoYHVzZXIgbG9naW4gd2l0aCBzdGF0dXMgJyR7bG9naW5SZXN1bHQ/LnN0YXR1c30nYCwgbG9naW5SZXN1bHQpO1xyXG5cclxuICAgICAgaWYgKGxvZ2luUmVzdWx0ICYmIGxvZ2luUmVzdWx0LnN0YXR1cyA9PT0gJzEnKSB7XHJcbiAgICAgICAgdGhpcy5lbWl0UHJvZ3Jlc3MoU2NyYXBlclByb2dyZXNzVHlwZXMuTG9naW5TdWNjZXNzKTtcclxuICAgICAgICByZXR1cm4geyBzdWNjZXNzOiB0cnVlIH07XHJcbiAgICAgIH1cclxuXHJcbiAgICAgIGlmIChsb2dpblJlc3VsdCAmJiBsb2dpblJlc3VsdC5zdGF0dXMgPT09ICczJykge1xyXG4gICAgICAgIHRoaXMuZW1pdFByb2dyZXNzKFNjcmFwZXJQcm9ncmVzc1R5cGVzLkNoYW5nZVBhc3N3b3JkKTtcclxuICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgc3VjY2VzczogZmFsc2UsXHJcbiAgICAgICAgICBlcnJvclR5cGU6IFNjcmFwZXJFcnJvclR5cGVzLkNoYW5nZVBhc3N3b3JkLFxyXG4gICAgICAgIH07XHJcbiAgICAgIH1cclxuXHJcbiAgICAgIHRoaXMuZW1pdFByb2dyZXNzKFNjcmFwZXJQcm9ncmVzc1R5cGVzLkxvZ2luRmFpbGVkKTtcclxuICAgICAgcmV0dXJuIHtcclxuICAgICAgICBzdWNjZXNzOiBmYWxzZSxcclxuICAgICAgICBlcnJvclR5cGU6IFNjcmFwZXJFcnJvclR5cGVzLkludmFsaWRQYXNzd29yZCxcclxuICAgICAgfTtcclxuICAgIH1cclxuXHJcbiAgICBpZiAodmFsaWRhdGVSZXR1cm5Db2RlID09PSAnNCcpIHtcclxuICAgICAgdGhpcy5lbWl0UHJvZ3Jlc3MoU2NyYXBlclByb2dyZXNzVHlwZXMuQ2hhbmdlUGFzc3dvcmQpO1xyXG4gICAgICByZXR1cm4ge1xyXG4gICAgICAgIHN1Y2Nlc3M6IGZhbHNlLFxyXG4gICAgICAgIGVycm9yVHlwZTogU2NyYXBlckVycm9yVHlwZXMuQ2hhbmdlUGFzc3dvcmQsXHJcbiAgICAgIH07XHJcbiAgICB9XHJcblxyXG4gICAgdGhpcy5lbWl0UHJvZ3Jlc3MoU2NyYXBlclByb2dyZXNzVHlwZXMuTG9naW5GYWlsZWQpO1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgc3VjY2VzczogZmFsc2UsXHJcbiAgICAgIGVycm9yVHlwZTogU2NyYXBlckVycm9yVHlwZXMuSW52YWxpZFBhc3N3b3JkLFxyXG4gICAgfTtcclxuICB9XHJcblxyXG4gIGFzeW5jIGZldGNoRGF0YSgpIHtcclxuICAgIGNvbnN0IGRlZmF1bHRTdGFydE1vbWVudCA9IG1vbWVudCgpLnN1YnRyYWN0KDEsICd5ZWFycycpO1xyXG4gICAgY29uc3Qgc3RhcnREYXRlID0gdGhpcy5vcHRpb25zLnN0YXJ0RGF0ZSB8fCBkZWZhdWx0U3RhcnRNb21lbnQudG9EYXRlKCk7XHJcbiAgICBjb25zdCBzdGFydE1vbWVudCA9IG1vbWVudC5tYXgoZGVmYXVsdFN0YXJ0TW9tZW50LCBtb21lbnQoc3RhcnREYXRlKSk7XHJcblxyXG4gICAgcmV0dXJuIGZldGNoQWxsVHJhbnNhY3Rpb25zKFxyXG4gICAgICB0aGlzLnBhZ2UsXHJcbiAgICAgIHRoaXMub3B0aW9ucyxcclxuICAgICAge1xyXG4gICAgICAgIHNlcnZpY2VzVXJsOiB0aGlzLnNlcnZpY2VzVXJsLFxyXG4gICAgICAgIGNvbXBhbnlDb2RlOiB0aGlzLmNvbXBhbnlDb2RlLFxyXG4gICAgICB9LFxyXG4gICAgICBzdGFydE1vbWVudCxcclxuICAgICk7XHJcbiAgfVxyXG59XHJcblxyXG5leHBvcnQgZGVmYXVsdCBJc3JhY2FyZEFtZXhCYXNlU2NyYXBlcjtcclxuIl0sIm1hcHBpbmdzIjoiOzs7Ozs7QUFBQSxJQUFBQSxPQUFBLEdBQUFDLHNCQUFBLENBQUFDLE9BQUE7QUFFQSxJQUFBQyxVQUFBLEdBQUFELE9BQUE7QUFDQSxJQUFB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