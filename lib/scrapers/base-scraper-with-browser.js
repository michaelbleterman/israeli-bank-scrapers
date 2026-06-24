"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.LoginResults = exports.BaseScraperWithBrowser = void 0;
var _puppeteer = _interopRequireDefault(require("puppeteer"));
var _definitions = require("../definitions");
var _debug = require("../helpers/debug");
var _elementsInteractions = require("../helpers/elements-interactions");
var _navigation = require("../helpers/navigation");
var _baseScraper = require("./base-scraper");
var _errors = require("./errors");
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
const debug = (0, _debug.getDebug)('base-scraper-with-browser');
var LoginBaseResults = /*#__PURE__*/function (LoginBaseResults) {
  LoginBaseResults["Success"] = "SUCCESS";
  LoginBaseResults["UnknownError"] = "UNKNOWN_ERROR";
  return LoginBaseResults;
}(LoginBaseResults || {});
const {
  Timeout,
  Generic,
  General,
  ...rest
} = _errors.ScraperErrorTypes;
const LoginResults = exports.LoginResults = {
  ...rest,
  ...LoginBaseResults
};
async function getKeyByValue(object, value, page) {
  const keys = Object.keys(object);
  for (const key of keys) {
    // @ts-ignore
    const conditions = object[key];
    for (const condition of conditions) {
      let result = false;
      if (condition instanceof RegExp) {
        result = condition.test(value);
      } else if (typeof condition === 'function') {
        result = await condition({
          page,
          value
        });
      } else {
        result = value.toLowerCase() === condition.toLowerCase();
      }
      if (result) {
        // @ts-ignore
        return Promise.resolve(key);
      }
    }
  }
  return Promise.resolve(LoginResults.UnknownError);
}
function createGeneralError() {
  return {
    success: false,
    errorType: _errors.ScraperErrorTypes.General
  };
}
async function safeCleanup(cleanup) {
  try {
    await cleanup();
  } catch (e) {
    debug(`Cleanup function failed: ${e.message}`);
  }
}
class BaseScraperWithBrowser extends _baseScraper.BaseScraper {
  cleanups = [];
  defaultViewportSize = {
    width: 1024,
    height: 768
  };

  // NOTICE - it is discouraged to use bang (!) in general. It is used here because
  // all the classes that inherit from this base assume is it mandatory.

  getViewPort() {
    return this.options.viewportSize ?? this.defaultViewportSize;
  }
  async initialize() {
    await super.initialize();
    debug('initialize scraper');
    this.emitProgress(_definitions.ScraperProgressTypes.Initializing);
    const page = await this.initializePage();
    await page.setCacheEnabled(false); // Clear cache and avoid 300's response status

    if (!page) {
      debug('failed to initiate a browser page, exit');
      return;
    }
    this.page = page;
    this.cleanups.push(() => page.close());
    if (this.options.defaultTimeout) {
      this.page.setDefaultTimeout(this.options.defaultTimeout);
    }
    if (this.options.preparePage) {
      debug("execute 'preparePage' interceptor provided in options");
      await this.options.preparePage(this.page);
    }
    const viewport = this.getViewPort();
    debug(`set viewport to width ${viewport.width}, height ${viewport.height}`);
    await this.page.setViewport({
      width: viewport.width,
      height: viewport.height
    });
    this.page.on('requestfailed', request => {
      debug('Request failed: %s %s', request.failure()?.errorText, request.url());
    });
    if (this.options.deviceTrustData) {
      try {
        await this.injectDeviceTrustData(this.options.deviceTrustData);
      } catch (e) {
        debug(`failed to inject device trust data, continuing without it: ${e.message}`);
      }
    }
  }
  async initializePage() {
    debug('initialize browser page');
    if ('browserContext' in this.options) {
      debug('Using the browser context provided in options');
      return this.options.browserContext.newPage();
    }
    if ('browser' in this.options) {
      debug('Using the browser instance provided in options');
      const {
        browser
      } = this.options;

      /**
       * For backward compatibility, we will close the browser even if we didn't create it
       */
      if (!this.options.skipCloseBrowser) {
        this.cleanups.push(async () => {
          debug('closing the browser');
          await browser.close();
        });
      }
      return browser.newPage();
    }
    const {
      timeout,
      args,
      executablePath,
      showBrowser
    } = this.options;
    const headless = !showBrowser;
    debug(`launch a browser with headless mode = ${headless}`);
    const browser = await _puppeteer.default.launch({
      env: this.options.verbose ? {
        DEBUG: '*',
        ...process.env
      } : undefined,
      headless,
      executablePath,
      args,
      timeout
    });
    this.cleanups.push(async () => {
      debug('closing the browser');
      await browser.close();
    });
    if (this.options.prepareBrowser) {
      debug("execute 'prepareBrowser' interceptor provided in options");
      await this.options.prepareBrowser(browser);
    }
    debug('create a new browser page');
    return browser.newPage();
  }
  async navigateTo(url, waitUntil = 'load', retries = this.options.navigationRetryCount ?? 0) {
    const response = await this.page?.goto(url, {
      waitUntil
    });
    if (response === null) {
      // note: response will be null when navigating to same url while changing the hash part.
      // the condition below will always accept null as valid result.
      return;
    }
    if (!response) {
      throw new Error(`Error while trying to navigate to url ${url}, response is undefined`);
    }
    if (!response.ok()) {
      const status = response.status();
      if (retries > 0) {
        debug(`Failed to navigate to url ${url}, status code: ${status}, retrying ${retries} more times`);
        await this.navigateTo(url, waitUntil, retries - 1);
      } else {
        throw new Error(`Failed to navigate to url ${url}, status code: ${status}`);
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getLoginOptions(_credentials) {
    throw new Error(`getLoginOptions() is not created in ${this.options.companyId}`);
  }
  async fillInputs(pageOrFrame, fields) {
    const modified = [...fields];
    const input = modified.shift();
    if (!input) {
      return;
    }
    await (0, _elementsInteractions.fillInput)(pageOrFrame, input.selector, input.value);
    if (modified.length) {
      await this.fillInputs(pageOrFrame, modified);
    }
  }
  async login(credentials) {
    if (!credentials || !this.page) {
      return createGeneralError();
    }
    debug('execute login process');
    const loginOptions = this.getLoginOptions(credentials);
    if (loginOptions.userAgent) {
      debug('set custom user agent provided in options');
      await this.page.setUserAgent(loginOptions.userAgent);
    }
    debug('navigate to login url');
    await this.navigateTo(loginOptions.loginUrl, loginOptions.waitUntil);
    if (loginOptions.checkReadiness) {
      debug("execute 'checkReadiness' interceptor provided in login options");
      await loginOptions.checkReadiness();
    } else if (typeof loginOptions.submitButtonSelector === 'string') {
      debug('wait until submit button is available');
      await (0, _elementsInteractions.waitUntilElementFound)(this.page, loginOptions.submitButtonSelector);
    }
    let loginFrameOrPage = this.page;
    if (loginOptions.preAction) {
      debug("execute 'preAction' interceptor provided in login options");
      loginFrameOrPage = (await loginOptions.preAction()) || this.page;
    }
    debug('fill login components input with relevant values');
    await this.fillInputs(loginFrameOrPage, loginOptions.fields);
    debug('click on login submit button');
    if (typeof loginOptions.submitButtonSelector === 'string') {
      await (0, _elementsInteractions.clickButton)(loginFrameOrPage, loginOptions.submitButtonSelector);
    } else {
      await loginOptions.submitButtonSelector();
    }
    this.emitProgress(_definitions.ScraperProgressTypes.LoggingIn);
    if (loginOptions.postAction) {
      debug("execute 'postAction' interceptor provided in login options");
      await loginOptions.postAction();
    } else {
      debug('wait for page navigation');
      await (0, _navigation.waitForNavigation)(this.page);
    }
    debug('check login result');
    const current = await (0, _navigation.getCurrentUrl)(this.page, true);
    const loginResult = await getKeyByValue(loginOptions.possibleResults, current, this.page);
    debug(`handle login results ${loginResult}`);
    return this.handleLoginResult(loginResult);
  }
  async scrape(credentials) {
    this.extractedDeviceTrustData = undefined;
    const result = await super.scrape(credentials);
    if (result.success && this.extractedDeviceTrustData) {
      result.deviceTrustData = this.extractedDeviceTrustData;
    }
    return result;
  }
  async terminate(_success) {
    debug(`terminating browser with success = ${_success}`);
    this.emitProgress(_definitions.ScraperProgressTypes.Terminating);
    if (!_success && !!this.options.storeFailureScreenShotPath) {
      debug(`create a snapshot before terminated in ${this.options.storeFailureScreenShotPath}`);
      await this.page.screenshot({
        path: this.options.storeFailureScreenShotPath,
        fullPage: true
      });
    }
    if (_success && this.page) {
      try {
        this.extractedDeviceTrustData = await this.extractDeviceTrustData();
        debug('extracted device trust data: %d cookies, %d localStorage entries', this.extractedDeviceTrustData.cookies.length, Object.keys(this.extractedDeviceTrustData.localStorage).length);
      } catch (e) {
        debug(`failed to extract device trust data: ${e.message}`);
      }
    }
    await Promise.all(this.cleanups.reverse().map(safeCleanup));
    this.cleanups = [];
  }
  async injectDeviceTrustData(data) {
    debug('injecting device trust data');
    if (data.cookies?.length) {
      await this.page.setCookie(...data.cookies);
      debug(`injected ${data.cookies.length} cookies`);
    }
    if (data.localStorage && Object.keys(data.localStorage).length) {
      // localStorage is origin-scoped — it MUST be restored on the same origin it was captured
      // from, otherwise the bank's login JS reads an empty device-trust id and re-challenges 2FA.
      // Prefer the recorded origin; fall back (for older trust data) to the most specific
      // host-only cookie domain rather than the first cookie's (often a wildcard parent) domain.
      const fallbackDomain = (data.cookies ?? []).map(c => c.domain).filter(d => !!d && !d.startsWith('.')).sort((a, b) => b.length - a.length)[0];
      const origin = data.origin ?? (fallbackDomain ? `https://${fallbackDomain}` : undefined);
      if (origin) {
        await this.page.goto(origin, {
          waitUntil: 'domcontentloaded'
        });
        await this.page.evaluate(items => {
          for (const [key, value] of Object.entries(items)) {
            window.localStorage.setItem(key, value);
          }
        }, data.localStorage);
        debug(`injected ${Object.keys(data.localStorage).length} localStorage entries at ${origin}`);
      }
    }
  }
  async extractDeviceTrustData() {
    const rawCookies = await this.page.cookies();
    const cookies = rawCookies.map(({
      name,
      value,
      domain,
      path,
      expires,
      httpOnly,
      secure,
      sameSite
    }) => ({
      name,
      value,
      domain,
      path,
      expires,
      httpOnly,
      secure,
      sameSite
    }));
    const localStorage = await this.page.evaluate(() => {
      const items = {};
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        items[key] = window.localStorage.getItem(key);
      }
      return items;
    });
    const origin = await this.page.evaluate(() => window.location.origin);
    return {
      cookies,
      localStorage,
      origin
    };
  }
  handleLoginResult(loginResult) {
    switch (loginResult) {
      case LoginResults.Success:
        this.emitProgress(_definitions.ScraperProgressTypes.LoginSuccess);
        return {
          success: true
        };
      case LoginResults.InvalidPassword:
      case LoginResults.UnknownError:
        this.emitProgress(_definitions.ScraperProgressTypes.LoginFailed);
        return {
          success: false,
          errorType: loginResult === LoginResults.InvalidPassword ? _errors.ScraperErrorTypes.InvalidPassword : _errors.ScraperErrorTypes.General,
          errorMessage: `Login failed with ${loginResult} error`
        };
      case LoginResults.ChangePassword:
        this.emitProgress(_definitions.ScraperProgressTypes.ChangePassword);
        return {
          success: false,
          errorType: _errors.ScraperErrorTypes.ChangePassword
        };
      case LoginResults.TwoFactorRetrieverMissing:
        this.emitProgress(_definitions.ScraperProgressTypes.LoginFailed);
        return {
          success: false,
          errorType: _errors.ScraperErrorTypes.TwoFactorRetrieverMissing
        };
      default:
        throw new Error(`unexpected login result "${loginResult}"`);
    }
  }
}
exports.BaseScraperWithBrowser = BaseScraperWithBrowser;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfcHVwcGV0ZWVyIiwiX2ludGVyb3BSZXF1aXJlRGVmYXVsdCIsInJlcXVpcmUiLCJfZGVmaW5pdGlvbnMiLCJfZGVidWciLCJfZWxlbWVudHNJbnRlcmFjdGlvbnMiLCJfbmF2aWdhdGlvbiIsIl9iYXNlU2NyYXBlciIsIl9lcnJvcnMiLCJlIiwiX19lc01vZHVsZSIsImRlZmF1bHQiLCJkZWJ1ZyIsImdldERlYnVnIiwiTG9naW5CYXNlUmVzdWx0cyIsIlRpbWVvdXQiLCJHZW5lcmljIiwiR2VuZXJhbCIsInJlc3QiLCJTY3JhcGVyRXJyb3JUeXBlcyIsIkxvZ2luUmVzdWx0cyIsImV4cG9ydHMiLCJnZXRLZXlCeVZhbHVlIiwib2JqZWN0IiwidmFsdWUiLCJwYWdlIiwia2V5cyIsIk9iamVjdCIsImtleSIsImNvbmRpdGlvbnMiLCJjb25kaXRpb24iLCJyZXN1bHQiLCJSZWdFeHAiLCJ0ZXN0IiwidG9Mb3dlckNhc2UiLCJQcm9taXNlIiwicmVzb2x2ZSIsIlVua25vd25FcnJvciIsImNyZWF0ZUdlbmVyYWxFcnJvciIsInN1Y2Nlc3MiLCJlcnJvclR5cGUiLCJzYWZlQ2xlYW51cCIsImNsZWFudXAiLCJtZXNzYWdlIiwiQmFzZVNjcmFwZXJXaXRoQnJvd3NlciIsIkJhc2VTY3JhcGVyIiwiY2xlYW51cHMiLCJkZWZhdWx0Vmlld3BvcnRTaXplIiwid2lkdGgiLCJoZWlnaHQiLCJnZXRWaWV3UG9ydCIsIm9wdGlvbnMiLCJ2aWV3cG9ydFNpemUiLCJpbml0aWFsaXplIiwiZW1pdFByb2dyZXNzIiwiU2NyYXBlclByb2dyZXNzVHlwZXMiLCJJbml0aWFsaXppbmciLCJpbml0aWFsaXplUGFnZSIsInNldENhY2hlRW5hYmxlZCIsInB1c2giLCJjbG9zZSIsImRlZmF1bHRUaW1lb3V0Iiwic2V0RGVmYXVsdFRpbWVvdXQiLCJwcmVwYXJlUGFnZSIsInZpZXdwb3J0Iiwic2V0Vmlld3BvcnQiLCJvbiIsInJlcXVlc3QiLCJmYWlsdXJlIiwiZXJyb3JUZXh0IiwidXJsIiwiZGV2aWNlVHJ1c3REYXRhIiwiaW5qZWN0RGV2aWNlVHJ1c3REYXRhIiwiYnJvd3NlckNvbnRleHQiLCJuZXdQYWdlIiwiYnJvd3NlciIsInNraXBDbG9zZUJyb3dzZXIiLCJ0aW1lb3V0IiwiYXJncyIsImV4ZWN1dGFibGVQYXRoIiwic2hvd0Jyb3dzZXIiLCJoZWFkbGVzcyIsInB1cHBldGVlciIsImxhdW5jaCIsImVudiIsInZlcmJvc2UiLCJERUJVRyIsInByb2Nlc3MiLCJ1bmRlZmluZWQiLCJwcmVwYXJlQnJvd3NlciIsIm5hdmlnYXRlVG8iLCJ3YWl0VW50aWwiLCJyZXRyaWVzIiwibmF2aWdhdGlvblJldHJ5Q291bnQiLCJyZXNwb25zZSIsImdvdG8iLCJFcnJvciIsIm9rIiwic3RhdHVzIiwiZ2V0TG9naW5PcHRpb25zIiwiX2NyZWRlbnRpYWxzIiwiY29tcGFueUlkIiwiZmlsbElucHV0cyIsInBhZ2VPckZyYW1lIiwiZmllbGRzIiwibW9kaWZpZWQiLCJpbnB1dCIsInNoaWZ0IiwiZmlsbElucHV0Iiwic2VsZWN0b3IiLCJsZW5ndGgiLCJsb2dpbiIsImNyZWRlbnRpYWxzIiwibG9naW5PcHRpb25zIiwidXNlckFnZW50Iiwic2V0VXNlckFnZW50IiwibG9naW5VcmwiLCJjaGVja1JlYWRpbmVzcyIsInN1Ym1pdEJ1dHRvblNlbGVjdG9yIiwid2FpdFVudGlsRWxlbWVudEZvdW5kIiwibG9naW5GcmFtZU9yUGFnZSIsInByZUFjdGlvbiIsImNsaWNrQnV0dG9uIiwiTG9nZ2luZ0luIiwicG9zdEFjdGlvbiIsIndhaXRGb3JOYXZpZ2F0aW9uIiwiY3VycmVudCIsImdldEN1cnJlbnRVcmwiLCJsb2dpblJlc3VsdCIsInBvc3NpYmxlUmVzdWx0cyIsImhhbmRsZUxvZ2luUmVzdWx0Iiwic2NyYXBlIiwiZXh0cmFjdGVkRGV2aWNlVHJ1c3REYXRhIiwidGVybWluYXRlIiwiX3N1Y2Nlc3MiLCJUZXJtaW5hdGluZyIsInN0b3JlRmFpbHVyZVNjcmVlblNob3RQYXRoIiwic2NyZWVuc2hvdCIsInBhdGgiLCJmdWxsUGFnZSIsImV4dHJhY3REZXZpY2VUcnVzdERhdGEiLCJjb29raWVzIiwibG9jYWxTdG9yYWdlIiwiYWxsIiwicmV2ZXJzZSIsIm1hcCIsImRhdGEiLCJzZXRDb29raWUiLCJmYWxsYmFja0RvbWFpbiIsImMiLCJkb21haW4iLCJmaWx0ZXIiLCJkIiwic3RhcnRzV2l0aCIsInNvcnQiLCJhIiwiYiIsIm9yaWdpbiIsImV2YWx1YXRlIiwiaXRlbXMiLCJlbnRyaWVzIiwid2luZG93Iiwic2V0SXRlbSIsInJhd0Nvb2tpZXMiLCJuYW1lIiwiZXhwaXJlcyIsImh0dHBPbmx5Iiwic2VjdXJlIiwic2FtZVNpdGUiLCJpIiwiZ2V0SXRlbSIsImxvY2F0aW9uIiwiU3VjY2VzcyIsIkxvZ2luU3VjY2VzcyIsIkludmFsaWRQYXNzd29yZCIsIkxvZ2luRmFpbGVkIiwiZXJyb3JNZXNzYWdlIiwiQ2hhbmdlUGFzc3dvcmQiLCJUd29GYWN0b3JSZXRyaWV2ZXJNaXNzaW5nIl0sInNvdXJjZXMiOlsiLi4vLi4vc3JjL3NjcmFwZXJzL2Jhc2Utc2NyYXBlci13aXRoLWJyb3dzZXIudHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHB1cHBldGVlciwgeyB0eXBlIEZyYW1lLCB0eXBlIFBhZ2UsIHR5cGUgUHVwcGV0ZWVyTGlmZUN5Y2xlRXZlbnQgfSBmcm9tICdwdXBwZXRlZXInO1xyXG5pbXBvcnQgeyBTY3JhcGVyUHJvZ3Jlc3NUeXBlcyB9IGZyb20gJy4uL2RlZmluaXRpb25zJztcclxuaW1wb3J0IHsgZ2V0RGVidWcgfSBmcm9tICcuLi9oZWxwZXJzL2RlYnVnJztcclxuaW1wb3J0IHsgY2xpY2tCdXR0b24sIGZpbGxJbnB1dCwgd2FpdFVudGlsRWxlbWVudEZvdW5kIH0gZnJvbSAnLi4vaGVscGVycy9lbGVtZW50cy1pbnRlcmFjdGlvbnMnO1xyXG5pbXBvcnQgeyBnZXRDdXJyZW50VXJsLCB3YWl0Rm9yTmF2aWdhdGlvbiB9IGZyb20gJy4uL2hlbHBlcnMvbmF2aWdhdGlvbic7XHJcbmltcG9ydCB7IEJhc2VTY3JhcGVyIH0gZnJvbSAnLi9iYXNlLXNjcmFwZXInO1xyXG5pbXBvcnQgeyBTY3JhcGVyRXJyb3JUeXBlcyB9IGZyb20gJy4vZXJyb3JzJztcclxuaW1wb3J0IHsgdHlwZSBEZXZpY2VUcnVzdERhdGEsIHR5cGUgU2NyYXBlckNyZWRlbnRpYWxzLCB0eXBlIFNjcmFwZXJTY3JhcGluZ1Jlc3VsdCB9IGZyb20gJy4vaW50ZXJmYWNlJztcclxuXHJcbmNvbnN0IGRlYnVnID0gZ2V0RGVidWcoJ2Jhc2Utc2NyYXBlci13aXRoLWJyb3dzZXInKTtcclxuXHJcbmVudW0gTG9naW5CYXNlUmVzdWx0cyB7XHJcbiAgU3VjY2VzcyA9ICdTVUNDRVNTJyxcclxuICBVbmtub3duRXJyb3IgPSAnVU5LTk9XTl9FUlJPUicsXHJcbn1cclxuXHJcbmNvbnN0IHsgVGltZW91dCwgR2VuZXJpYywgR2VuZXJhbCwgLi4ucmVzdCB9ID0gU2NyYXBlckVycm9yVHlwZXM7XHJcbmV4cG9ydCBjb25zdCBMb2dpblJlc3VsdHMgPSB7XHJcbiAgLi4ucmVzdCxcclxuICAuLi5Mb2dpbkJhc2VSZXN1bHRzLFxyXG59O1xyXG5cclxuZXhwb3J0IHR5cGUgTG9naW5SZXN1bHRzID1cclxuICB8IEV4Y2x1ZGU8U2NyYXBlckVycm9yVHlwZXMsIFNjcmFwZXJFcnJvclR5cGVzLlRpbWVvdXQgfCBTY3JhcGVyRXJyb3JUeXBlcy5HZW5lcmljIHwgU2NyYXBlckVycm9yVHlwZXMuR2VuZXJhbD5cclxuICB8IExvZ2luQmFzZVJlc3VsdHM7XHJcblxyXG5leHBvcnQgdHlwZSBQb3NzaWJsZUxvZ2luUmVzdWx0cyA9IHtcclxuICBba2V5IGluIExvZ2luUmVzdWx0c10/OiAoc3RyaW5nIHwgUmVnRXhwIHwgKChvcHRpb25zPzogeyBwYWdlPzogUGFnZSB9KSA9PiBQcm9taXNlPGJvb2xlYW4+KSlbXTtcclxufTtcclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgTG9naW5PcHRpb25zIHtcclxuICBsb2dpblVybDogc3RyaW5nO1xyXG4gIGNoZWNrUmVhZGluZXNzPzogKCkgPT4gUHJvbWlzZTx2b2lkPjtcclxuICBmaWVsZHM6IHsgc2VsZWN0b3I6IHN0cmluZzsgdmFsdWU6IHN0cmluZyB9W107XHJcbiAgc3VibWl0QnV0dG9uU2VsZWN0b3I6IHN0cmluZyB8ICgoKSA9PiBQcm9taXNlPHZvaWQ+KTtcclxuICBwcmVBY3Rpb24/OiAoKSA9PiBQcm9taXNlPEZyYW1lIHwgdm9pZD47XHJcbiAgcG9zdEFjdGlvbj86ICgpID0+IFByb21pc2U8dm9pZD47XHJcbiAgcG9zc2libGVSZXN1bHRzOiBQb3NzaWJsZUxvZ2luUmVzdWx0cztcclxuICB1c2VyQWdlbnQ/OiBzdHJpbmc7XHJcbiAgd2FpdFVudGlsPzogUHVwcGV0ZWVyTGlmZUN5Y2xlRXZlbnQ7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGdldEtleUJ5VmFsdWUob2JqZWN0OiBQb3NzaWJsZUxvZ2luUmVzdWx0cywgdmFsdWU6IHN0cmluZywgcGFnZTogUGFnZSk6IFByb21pc2U8TG9naW5SZXN1bHRzPiB7XHJcbiAgY29uc3Qga2V5cyA9IE9iamVjdC5rZXlzKG9iamVjdCk7XHJcbiAgZm9yIChjb25zdCBrZXkgb2Yga2V5cykge1xyXG4gICAgLy8gQHRzLWlnbm9yZVxyXG4gICAgY29uc3QgY29uZGl0aW9ucyA9IG9iamVjdFtrZXldO1xyXG5cclxuICAgIGZvciAoY29uc3QgY29uZGl0aW9uIG9mIGNvbmRpdGlvbnMpIHtcclxuICAgICAgbGV0IHJlc3VsdCA9IGZhbHNlO1xyXG5cclxuICAgICAgaWYgKGNvbmRpdGlvbiBpbnN0YW5jZW9mIFJlZ0V4cCkge1xyXG4gICAgICAgIHJlc3VsdCA9IGNvbmRpdGlvbi50ZXN0KHZhbHVlKTtcclxuICAgICAgfSBlbHNlIGlmICh0eXBlb2YgY29uZGl0aW9uID09PSAnZnVuY3Rpb24nKSB7XHJcbiAgICAgICAgcmVzdWx0ID0gYXdhaXQgY29uZGl0aW9uKHsgcGFnZSwgdmFsdWUgfSk7XHJcbiAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgcmVzdWx0ID0gdmFsdWUudG9Mb3dlckNhc2UoKSA9PT0gY29uZGl0aW9uLnRvTG93ZXJDYXNlKCk7XHJcbiAgICAgIH1cclxuXHJcbiAgICAgIGlmIChyZXN1bHQpIHtcclxuICAgICAgICAvLyBAdHMtaWdub3JlXHJcbiAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZShrZXkpO1xyXG4gICAgICB9XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKExvZ2luUmVzdWx0cy5Vbmtub3duRXJyb3IpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBjcmVhdGVHZW5lcmFsRXJyb3IoKTogU2NyYXBlclNjcmFwaW5nUmVzdWx0IHtcclxuICByZXR1cm4ge1xyXG4gICAgc3VjY2VzczogZmFsc2UsXHJcbiAgICBlcnJvclR5cGU6IFNjcmFwZXJFcnJvclR5cGVzLkdlbmVyYWwsXHJcbiAgfTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gc2FmZUNsZWFudXAoY2xlYW51cDogKCkgPT4gUHJvbWlzZTx2b2lkPikge1xyXG4gIHRyeSB7XHJcbiAgICBhd2FpdCBjbGVhbnVwKCk7XHJcbiAgfSBjYXRjaCAoZSkge1xyXG4gICAgZGVidWcoYENsZWFudXAgZnVuY3Rpb24gZmFpbGVkOiAkeyhlIGFzIEVycm9yKS5tZXNzYWdlfWApO1xyXG4gIH1cclxufVxyXG5cclxuY2xhc3MgQmFzZVNjcmFwZXJXaXRoQnJvd3NlcjxUQ3JlZGVudGlhbHMgZXh0ZW5kcyBTY3JhcGVyQ3JlZGVudGlhbHM+IGV4dGVuZHMgQmFzZVNjcmFwZXI8VENyZWRlbnRpYWxzPiB7XHJcbiAgcHJpdmF0ZSBjbGVhbnVwczogQXJyYXk8KCkgPT4gUHJvbWlzZTx2b2lkPj4gPSBbXTtcclxuXHJcbiAgcHJpdmF0ZSBleHRyYWN0ZWREZXZpY2VUcnVzdERhdGE/OiBEZXZpY2VUcnVzdERhdGE7XHJcblxyXG4gIHByaXZhdGUgZGVmYXVsdFZpZXdwb3J0U2l6ZSA9IHtcclxuICAgIHdpZHRoOiAxMDI0LFxyXG4gICAgaGVpZ2h0OiA3NjgsXHJcbiAgfTtcclxuXHJcbiAgLy8gTk9USUNFIC0gaXQgaXMgZGlzY291cmFnZWQgdG8gdXNlIGJhbmcgKCEpIGluIGdlbmVyYWwuIEl0IGlzIHVzZWQgaGVyZSBiZWNhdXNlXHJcbiAgLy8gYWxsIHRoZSBjbGFzc2VzIHRoYXQgaW5oZXJpdCBmcm9tIHRoaXMgYmFzZSBhc3N1bWUgaXMgaXQgbWFuZGF0b3J5LlxyXG4gIHByb3RlY3RlZCBwYWdlITogUGFnZTtcclxuXHJcbiAgcHJvdGVjdGVkIGdldFZpZXdQb3J0KCkge1xyXG4gICAgcmV0dXJuIHRoaXMub3B0aW9ucy52aWV3cG9ydFNpemUgPz8gdGhpcy5kZWZhdWx0Vmlld3BvcnRTaXplO1xyXG4gIH1cclxuXHJcbiAgYXN5bmMgaW5pdGlhbGl6ZSgpIHtcclxuICAgIGF3YWl0IHN1cGVyLmluaXRpYWxpemUoKTtcclxuICAgIGRlYnVnKCdpbml0aWFsaXplIHNjcmFwZXInKTtcclxuICAgIHRoaXMuZW1pdFByb2dyZXNzKFNjcmFwZXJQcm9ncmVzc1R5cGVzLkluaXRpYWxpemluZyk7XHJcblxyXG4gICAgY29uc3QgcGFnZSA9IGF3YWl0IHRoaXMuaW5pdGlhbGl6ZVBhZ2UoKTtcclxuICAgIGF3YWl0IHBhZ2Uuc2V0Q2FjaGVFbmFibGVkKGZhbHNlKTsgLy8gQ2xlYXIgY2FjaGUgYW5kIGF2b2lkIDMwMCdzIHJlc3BvbnNlIHN0YXR1c1xyXG5cclxuICAgIGlmICghcGFnZSkge1xyXG4gICAgICBkZWJ1ZygnZmFpbGVkIHRvIGluaXRpYXRlIGEgYnJvd3NlciBwYWdlLCBleGl0Jyk7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuXHJcbiAgICB0aGlzLnBhZ2UgPSBwYWdlO1xyXG5cclxuICAgIHRoaXMuY2xlYW51cHMucHVzaCgoKSA9PiBwYWdlLmNsb3NlKCkpO1xyXG5cclxuICAgIGlmICh0aGlzLm9wdGlvbnMuZGVmYXVsdFRpbWVvdXQpIHtcclxuICAgICAgdGhpcy5wYWdlLnNldERlZmF1bHRUaW1lb3V0KHRoaXMub3B0aW9ucy5kZWZhdWx0VGltZW91dCk7XHJcbiAgICB9XHJcblxyXG4gICAgaWYgKHRoaXMub3B0aW9ucy5wcmVwYXJlUGFnZSkge1xyXG4gICAgICBkZWJ1ZyhcImV4ZWN1dGUgJ3ByZXBhcmVQYWdlJyBpbnRlcmNlcHRvciBwcm92aWRlZCBpbiBvcHRpb25zXCIpO1xyXG4gICAgICBhd2FpdCB0aGlzLm9wdGlvbnMucHJlcGFyZVBhZ2UodGhpcy5wYWdlKTtcclxuICAgIH1cclxuXHJcbiAgICBjb25zdCB2aWV3cG9ydCA9IHRoaXMuZ2V0Vmlld1BvcnQoKTtcclxuICAgIGRlYnVnKGBzZXQgdmlld3BvcnQgdG8gd2lkdGggJHt2aWV3cG9ydC53aWR0aH0sIGhlaWdodCAke3ZpZXdwb3J0LmhlaWdodH1gKTtcclxuICAgIGF3YWl0IHRoaXMucGFnZS5zZXRWaWV3cG9ydCh7XHJcbiAgICAgIHdpZHRoOiB2aWV3cG9ydC53aWR0aCxcclxuICAgICAgaGVpZ2h0OiB2aWV3cG9ydC5oZWlnaHQsXHJcbiAgICB9KTtcclxuXHJcbiAgICB0aGlzLnBhZ2Uub24oJ3JlcXVlc3RmYWlsZWQnLCByZXF1ZXN0ID0+IHtcclxuICAgICAgZGVidWcoJ1JlcXVlc3QgZmFpbGVkOiAlcyAlcycsIHJlcXVlc3QuZmFpbHVyZSgpPy5lcnJvclRleHQsIHJlcXVlc3QudXJsKCkpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgaWYgKHRoaXMub3B0aW9ucy5kZXZpY2VUcnVzdERhdGEpIHtcclxuICAgICAgdHJ5IHtcclxuICAgICAgICBhd2FpdCB0aGlzLmluamVjdERldmljZVRydXN0RGF0YSh0aGlzLm9wdGlvbnMuZGV2aWNlVHJ1c3REYXRhKTtcclxuICAgICAgfSBjYXRjaCAoZSkge1xyXG4gICAgICAgIGRlYnVnKGBmYWlsZWQgdG8gaW5qZWN0IGRldmljZSB0cnVzdCBkYXRhLCBjb250aW51aW5nIHdpdGhvdXQgaXQ6ICR7KGUgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XHJcbiAgICAgIH1cclxuICAgIH1cclxuICB9XHJcblxyXG4gIHByaXZhdGUgYXN5bmMgaW5pdGlhbGl6ZVBhZ2UoKSB7XHJcbiAgICBkZWJ1ZygnaW5pdGlhbGl6ZSBicm93c2VyIHBhZ2UnKTtcclxuICAgIGlmICgnYnJvd3NlckNvbnRleHQnIGluIHRoaXMub3B0aW9ucykge1xyXG4gICAgICBkZWJ1ZygnVXNpbmcgdGhlIGJyb3dzZXIgY29udGV4dCBwcm92aWRlZCBpbiBvcHRpb25zJyk7XHJcbiAgICAgIHJldHVybiB0aGlzLm9wdGlvbnMuYnJvd3NlckNvbnRleHQubmV3UGFnZSgpO1xyXG4gICAgfVxyXG5cclxuICAgIGlmICgnYnJvd3NlcicgaW4gdGhpcy5vcHRpb25zKSB7XHJcbiAgICAgIGRlYnVnKCdVc2luZyB0aGUgYnJvd3NlciBpbnN0YW5jZSBwcm92aWRlZCBpbiBvcHRpb25zJyk7XHJcbiAgICAgIGNvbnN0IHsgYnJvd3NlciB9ID0gdGhpcy5vcHRpb25zO1xyXG5cclxuICAgICAgLyoqXHJcbiAgICAgICAqIEZvciBiYWNrd2FyZCBjb21wYXRpYmlsaXR5LCB3ZSB3aWxsIGNsb3NlIHRoZSBicm93c2VyIGV2ZW4gaWYgd2UgZGlkbid0IGNyZWF0ZSBpdFxyXG4gICAgICAgKi9cclxuICAgICAgaWYgKCF0aGlzLm9wdGlvbnMuc2tpcENsb3NlQnJvd3Nlcikge1xyXG4gICAgICAgIHRoaXMuY2xlYW51cHMucHVzaChhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgICBkZWJ1ZygnY2xvc2luZyB0aGUgYnJvd3NlcicpO1xyXG4gICAgICAgICAgYXdhaXQgYnJvd3Nlci5jbG9zZSgpO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICB9XHJcblxyXG4gICAgICByZXR1cm4gYnJvd3Nlci5uZXdQYWdlKCk7XHJcbiAgICB9XHJcblxyXG4gICAgY29uc3QgeyB0aW1lb3V0LCBhcmdzLCBleGVjdXRhYmxlUGF0aCwgc2hvd0Jyb3dzZXIgfSA9IHRoaXMub3B0aW9ucztcclxuXHJcbiAgICBjb25zdCBoZWFkbGVzcyA9ICFzaG93QnJvd3NlcjtcclxuICAgIGRlYnVnKGBsYXVuY2ggYSBicm93c2VyIHdpdGggaGVhZGxlc3MgbW9kZSA9ICR7aGVhZGxlc3N9YCk7XHJcblxyXG4gICAgY29uc3QgYnJvd3NlciA9IGF3YWl0IHB1cHBldGVlci5sYXVuY2goe1xyXG4gICAgICBlbnY6IHRoaXMub3B0aW9ucy52ZXJib3NlID8geyBERUJVRzogJyonLCAuLi5wcm9jZXNzLmVudiB9IDogdW5kZWZpbmVkLFxyXG4gICAgICBoZWFkbGVzcyxcclxuICAgICAgZXhlY3V0YWJsZVBhdGgsXHJcbiAgICAgIGFyZ3MsXHJcbiAgICAgIHRpbWVvdXQsXHJcbiAgICB9KTtcclxuXHJcbiAgICB0aGlzLmNsZWFudXBzLnB1c2goYXN5bmMgKCkgPT4ge1xyXG4gICAgICBkZWJ1ZygnY2xvc2luZyB0aGUgYnJvd3NlcicpO1xyXG4gICAgICBhd2FpdCBicm93c2VyLmNsb3NlKCk7XHJcbiAgICB9KTtcclxuXHJcbiAgICBpZiAodGhpcy5vcHRpb25zLnByZXBhcmVCcm93c2VyKSB7XHJcbiAgICAgIGRlYnVnKFwiZXhlY3V0ZSAncHJlcGFyZUJyb3dzZXInIGludGVyY2VwdG9yIHByb3ZpZGVkIGluIG9wdGlvbnNcIik7XHJcbiAgICAgIGF3YWl0IHRoaXMub3B0aW9ucy5wcmVwYXJlQnJvd3Nlcihicm93c2VyKTtcclxuICAgIH1cclxuXHJcbiAgICBkZWJ1ZygnY3JlYXRlIGEgbmV3IGJyb3dzZXIgcGFnZScpO1xyXG4gICAgcmV0dXJuIGJyb3dzZXIubmV3UGFnZSgpO1xyXG4gIH1cclxuXHJcbiAgYXN5bmMgbmF2aWdhdGVUbyhcclxuICAgIHVybDogc3RyaW5nLFxyXG4gICAgd2FpdFVudGlsOiBQdXBwZXRlZXJMaWZlQ3ljbGVFdmVudCB8IHVuZGVmaW5lZCA9ICdsb2FkJyxcclxuICAgIHJldHJpZXMgPSB0aGlzLm9wdGlvbnMubmF2aWdhdGlvblJldHJ5Q291bnQgPz8gMCxcclxuICApOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgdGhpcy5wYWdlPy5nb3RvKHVybCwgeyB3YWl0VW50aWwgfSk7XHJcbiAgICBpZiAocmVzcG9uc2UgPT09IG51bGwpIHtcclxuICAgICAgLy8gbm90ZTogcmVzcG9uc2Ugd2lsbCBiZSBudWxsIHdoZW4gbmF2aWdhdGluZyB0byBzYW1lIHVybCB3aGlsZSBjaGFuZ2luZyB0aGUgaGFzaCBwYXJ0LlxyXG4gICAgICAvLyB0aGUgY29uZGl0aW9uIGJlbG93IHdpbGwgYWx3YXlzIGFjY2VwdCBudWxsIGFzIHZhbGlkIHJlc3VsdC5cclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG5cclxuICAgIGlmICghcmVzcG9uc2UpIHtcclxuICAgICAgdGhyb3cgbmV3IEVycm9yKGBFcnJvciB3aGlsZSB0cnlpbmcgdG8gbmF2aWdhdGUgdG8gdXJsICR7dXJsfSwgcmVzcG9uc2UgaXMgdW5kZWZpbmVkYCk7XHJcbiAgICB9XHJcblxyXG4gICAgaWYgKCFyZXNwb25zZS5vaygpKSB7XHJcbiAgICAgIGNvbnN0IHN0YXR1cyA9IHJlc3BvbnNlLnN0YXR1cygpO1xyXG4gICAgICBpZiAocmV0cmllcyA+IDApIHtcclxuICAgICAgICBkZWJ1ZyhgRmFpbGVkIHRvIG5hdmlnYXRlIHRvIHVybCAke3VybH0sIHN0YXR1cyBjb2RlOiAke3N0YXR1c30sIHJldHJ5aW5nICR7cmV0cmllc30gbW9yZSB0aW1lc2ApO1xyXG4gICAgICAgIGF3YWl0IHRoaXMubmF2aWdhdGVUbyh1cmwsIHdhaXRVbnRpbCwgcmV0cmllcyAtIDEpO1xyXG4gICAgICB9IGVsc2Uge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgRmFpbGVkIHRvIG5hdmlnYXRlIHRvIHVybCAke3VybH0sIHN0YXR1cyBjb2RlOiAke3N0YXR1c31gKTtcclxuICAgICAgfVxyXG4gICAgfVxyXG4gIH1cclxuXHJcbiAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIEB0eXBlc2NyaXB0LWVzbGludC9uby11bnVzZWQtdmFyc1xyXG4gIGdldExvZ2luT3B0aW9ucyhfY3JlZGVudGlhbHM6IFNjcmFwZXJDcmVkZW50aWFscyk6IExvZ2luT3B0aW9ucyB7XHJcbiAgICB0aHJvdyBuZXcgRXJyb3IoYGdldExvZ2luT3B0aW9ucygpIGlzIG5vdCBjcmVhdGVkIGluICR7dGhpcy5vcHRpb25zLmNvbXBhbnlJZH1gKTtcclxuICB9XHJcblxyXG4gIGFzeW5jIGZpbGxJbnB1dHMocGFnZU9yRnJhbWU6IFBhZ2UgfCBGcmFtZSwgZmllbGRzOiB7IHNlbGVjdG9yOiBzdHJpbmc7IHZhbHVlOiBzdHJpbmcgfVtdKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBjb25zdCBtb2RpZmllZCA9IFsuLi5maWVsZHNdO1xyXG4gICAgY29uc3QgaW5wdXQgPSBtb2RpZmllZC5zaGlmdCgpO1xyXG5cclxuICAgIGlmICghaW5wdXQpIHtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgYXdhaXQgZmlsbElucHV0KHBhZ2VPckZyYW1lLCBpbnB1dC5zZWxlY3RvciwgaW5wdXQudmFsdWUpO1xyXG4gICAgaWYgKG1vZGlmaWVkLmxlbmd0aCkge1xyXG4gICAgICBhd2FpdCB0aGlzLmZpbGxJbnB1dHMocGFnZU9yRnJhbWUsIG1vZGlmaWVkKTtcclxuICAgIH1cclxuICB9XHJcblxyXG4gIGFzeW5jIGxvZ2luKGNyZWRlbnRpYWxzOiBTY3JhcGVyQ3JlZGVudGlhbHMpOiBQcm9taXNlPFNjcmFwZXJTY3JhcGluZ1Jlc3VsdD4ge1xyXG4gICAgaWYgKCFjcmVkZW50aWFscyB8fCAhdGhpcy5wYWdlKSB7XHJcbiAgICAgIHJldHVybiBjcmVhdGVHZW5lcmFsRXJyb3IoKTtcclxuICAgIH1cclxuXHJcbiAgICBkZWJ1ZygnZXhlY3V0ZSBsb2dpbiBwcm9jZXNzJyk7XHJcbiAgICBjb25zdCBsb2dpbk9wdGlvbnMgPSB0aGlzLmdldExvZ2luT3B0aW9ucyhjcmVkZW50aWFscyk7XHJcblxyXG4gICAgaWYgKGxvZ2luT3B0aW9ucy51c2VyQWdlbnQpIHtcclxuICAgICAgZGVidWcoJ3NldCBjdXN0b20gdXNlciBhZ2VudCBwcm92aWRlZCBpbiBvcHRpb25zJyk7XHJcbiAgICAgIGF3YWl0IHRoaXMucGFnZS5zZXRVc2VyQWdlbnQobG9naW5PcHRpb25zLnVzZXJBZ2VudCk7XHJcbiAgICB9XHJcblxyXG4gICAgZGVidWcoJ25hdmlnYXRlIHRvIGxvZ2luIHVybCcpO1xyXG4gICAgYXdhaXQgdGhpcy5uYXZpZ2F0ZVRvKGxvZ2luT3B0aW9ucy5sb2dpblVybCwgbG9naW5PcHRpb25zLndhaXRVbnRpbCk7XHJcbiAgICBpZiAobG9naW5PcHRpb25zLmNoZWNrUmVhZGluZXNzKSB7XHJcbiAgICAgIGRlYnVnKFwiZXhlY3V0ZSAnY2hlY2tSZWFkaW5lc3MnIGludGVyY2VwdG9yIHByb3ZpZGVkIGluIGxvZ2luIG9wdGlvbnNcIik7XHJcbiAgICAgIGF3YWl0IGxvZ2luT3B0aW9ucy5jaGVja1JlYWRpbmVzcygpO1xyXG4gICAgfSBlbHNlIGlmICh0eXBlb2YgbG9naW5PcHRpb25zLnN1Ym1pdEJ1dHRvblNlbGVjdG9yID09PSAnc3RyaW5nJykge1xyXG4gICAgICBkZWJ1Zygnd2FpdCB1bnRpbCBzdWJtaXQgYnV0dG9uIGlzIGF2YWlsYWJsZScpO1xyXG4gICAgICBhd2FpdCB3YWl0VW50aWxFbGVtZW50Rm91bmQodGhpcy5wYWdlLCBsb2dpbk9wdGlvbnMuc3VibWl0QnV0dG9uU2VsZWN0b3IpO1xyXG4gICAgfVxyXG5cclxuICAgIGxldCBsb2dpbkZyYW1lT3JQYWdlOiBQYWdlIHwgRnJhbWUgfCBudWxsID0gdGhpcy5wYWdlO1xyXG4gICAgaWYgKGxvZ2luT3B0aW9ucy5wcmVBY3Rpb24pIHtcclxuICAgICAgZGVidWcoXCJleGVjdXRlICdwcmVBY3Rpb24nIGludGVyY2VwdG9yIHByb3ZpZGVkIGluIGxvZ2luIG9wdGlvbnNcIik7XHJcbiAgICAgIGxvZ2luRnJhbWVPclBhZ2UgPSAoYXdhaXQgbG9naW5PcHRpb25zLnByZUFjdGlvbigpKSB8fCB0aGlzLnBhZ2U7XHJcbiAgICB9XHJcblxyXG4gICAgZGVidWcoJ2ZpbGwgbG9naW4gY29tcG9uZW50cyBpbnB1dCB3aXRoIHJlbGV2YW50IHZhbHVlcycpO1xyXG4gICAgYXdhaXQgdGhpcy5maWxsSW5wdXRzKGxvZ2luRnJhbWVPclBhZ2UsIGxvZ2luT3B0aW9ucy5maWVsZHMpO1xyXG4gICAgZGVidWcoJ2NsaWNrIG9uIGxvZ2luIHN1Ym1pdCBidXR0b24nKTtcclxuICAgIGlmICh0eXBlb2YgbG9naW5PcHRpb25zLnN1Ym1pdEJ1dHRvblNlbGVjdG9yID09PSAnc3RyaW5nJykge1xyXG4gICAgICBhd2FpdCBjbGlja0J1dHRvbihsb2dpbkZyYW1lT3JQYWdlLCBsb2dpbk9wdGlvbnMuc3VibWl0QnV0dG9uU2VsZWN0b3IpO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgYXdhaXQgbG9naW5PcHRpb25zLnN1Ym1pdEJ1dHRvblNlbGVjdG9yKCk7XHJcbiAgICB9XHJcbiAgICB0aGlzLmVtaXRQcm9ncmVzcyhTY3JhcGVyUHJvZ3Jlc3NUeXBlcy5Mb2dnaW5nSW4pO1xyXG5cclxuICAgIGlmIChsb2dpbk9wdGlvbnMucG9zdEFjdGlvbikge1xyXG4gICAgICBkZWJ1ZyhcImV4ZWN1dGUgJ3Bvc3RBY3Rpb24nIGludGVyY2VwdG9yIHByb3ZpZGVkIGluIGxvZ2luIG9wdGlvbnNcIik7XHJcbiAgICAgIGF3YWl0IGxvZ2luT3B0aW9ucy5wb3N0QWN0aW9uKCk7XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICBkZWJ1Zygnd2FpdCBmb3IgcGFnZSBuYXZpZ2F0aW9uJyk7XHJcbiAgICAgIGF3YWl0IHdhaXRGb3JOYXZpZ2F0aW9uKHRoaXMucGFnZSk7XHJcbiAgICB9XHJcblxyXG4gICAgZGVidWcoJ2NoZWNrIGxvZ2luIHJlc3VsdCcpO1xyXG4gICAgY29uc3QgY3VycmVudCA9IGF3YWl0IGdldEN1cnJlbnRVcmwodGhpcy5wYWdlLCB0cnVlKTtcclxuICAgIGNvbnN0IGxvZ2luUmVzdWx0ID0gYXdhaXQgZ2V0S2V5QnlWYWx1ZShsb2dpbk9wdGlvbnMucG9zc2libGVSZXN1bHRzLCBjdXJyZW50LCB0aGlzLnBhZ2UpO1xyXG4gICAgZGVidWcoYGhhbmRsZSBsb2dpbiByZXN1bHRzICR7bG9naW5SZXN1bHR9YCk7XHJcbiAgICByZXR1cm4gdGhpcy5oYW5kbGVMb2dpblJlc3VsdChsb2dpblJlc3VsdCk7XHJcbiAgfVxyXG5cclxuICBhc3luYyBzY3JhcGUoY3JlZGVudGlhbHM6IFRDcmVkZW50aWFscyk6IFByb21pc2U8U2NyYXBlclNjcmFwaW5nUmVzdWx0PiB7XHJcbiAgICB0aGlzLmV4dHJhY3RlZERldmljZVRydXN0RGF0YSA9IHVuZGVmaW5lZDtcclxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHN1cGVyLnNjcmFwZShjcmVkZW50aWFscyk7XHJcbiAgICBpZiAocmVzdWx0LnN1Y2Nlc3MgJiYgdGhpcy5leHRyYWN0ZWREZXZpY2VUcnVzdERhdGEpIHtcclxuICAgICAgcmVzdWx0LmRldmljZVRydXN0RGF0YSA9IHRoaXMuZXh0cmFjdGVkRGV2aWNlVHJ1c3REYXRhO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHJlc3VsdDtcclxuICB9XHJcblxyXG4gIGFzeW5jIHRlcm1pbmF0ZShfc3VjY2VzczogYm9vbGVhbikge1xyXG4gICAgZGVidWcoYHRlcm1pbmF0aW5nIGJyb3dzZXIgd2l0aCBzdWNjZXNzID0gJHtfc3VjY2Vzc31gKTtcclxuICAgIHRoaXMuZW1pdFByb2dyZXNzKFNjcmFwZXJQcm9ncmVzc1R5cGVzLlRlcm1pbmF0aW5nKTtcclxuXHJcbiAgICBpZiAoIV9zdWNjZXNzICYmICEhdGhpcy5vcHRpb25zLnN0b3JlRmFpbHVyZVNjcmVlblNob3RQYXRoKSB7XHJcbiAgICAgIGRlYnVnKGBjcmVhdGUgYSBzbmFwc2hvdCBiZWZvcmUgdGVybWluYXRlZCBpbiAke3RoaXMub3B0aW9ucy5zdG9yZUZhaWx1cmVTY3JlZW5TaG90UGF0aH1gKTtcclxuICAgICAgYXdhaXQgdGhpcy5wYWdlLnNjcmVlbnNob3Qoe1xyXG4gICAgICAgIHBhdGg6IHRoaXMub3B0aW9ucy5zdG9yZUZhaWx1cmVTY3JlZW5TaG90UGF0aCxcclxuICAgICAgICBmdWxsUGFnZTogdHJ1ZSxcclxuICAgICAgfSk7XHJcbiAgICB9XHJcblxyXG4gICAgaWYgKF9zdWNjZXNzICYmIHRoaXMucGFnZSkge1xyXG4gICAgICB0cnkge1xyXG4gICAgICAgIHRoaXMuZXh0cmFjdGVkRGV2aWNlVHJ1c3REYXRhID0gYXdhaXQgdGhpcy5leHRyYWN0RGV2aWNlVHJ1c3REYXRhKCk7XHJcbiAgICAgICAgZGVidWcoXHJcbiAgICAgICAgICAnZXh0cmFjdGVkIGRldmljZSB0cnVzdCBkYXRhOiAlZCBjb29raWVzLCAlZCBsb2NhbFN0b3JhZ2UgZW50cmllcycsXHJcbiAgICAgICAgICB0aGlzLmV4dHJhY3RlZERldmljZVRydXN0RGF0YS5jb29raWVzLmxlbmd0aCxcclxuICAgICAgICAgIE9iamVjdC5rZXlzKHRoaXMuZXh0cmFjdGVkRGV2aWNlVHJ1c3REYXRhLmxvY2FsU3RvcmFnZSkubGVuZ3RoLFxyXG4gICAgICAgICk7XHJcbiAgICAgIH0gY2F0Y2ggKGUpIHtcclxuICAgICAgICBkZWJ1ZyhgZmFpbGVkIHRvIGV4dHJhY3QgZGV2aWNlIHRydXN0IGRhdGE6ICR7KGUgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XHJcbiAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICBhd2FpdCBQcm9taXNlLmFsbCh0aGlzLmNsZWFudXBzLnJldmVyc2UoKS5tYXAoc2FmZUNsZWFudXApKTtcclxuICAgIHRoaXMuY2xlYW51cHMgPSBbXTtcclxuICB9XHJcblxyXG4gIHByaXZhdGUgYXN5bmMgaW5qZWN0RGV2aWNlVHJ1c3REYXRhKGRhdGE6IERldmljZVRydXN0RGF0YSkge1xyXG4gICAgZGVidWcoJ2luamVjdGluZyBkZXZpY2UgdHJ1c3QgZGF0YScpO1xyXG4gICAgaWYgKGRhdGEuY29va2llcz8ubGVuZ3RoKSB7XHJcbiAgICAgIGF3YWl0IHRoaXMucGFnZS5zZXRDb29raWUoLi4uZGF0YS5jb29raWVzKTtcclxuICAgICAgZGVidWcoYGluamVjdGVkICR7ZGF0YS5jb29raWVzLmxlbmd0aH0gY29va2llc2ApO1xyXG4gICAgfVxyXG4gICAgaWYgKGRhdGEubG9jYWxTdG9yYWdlICYmIE9iamVjdC5rZXlzKGRhdGEubG9jYWxTdG9yYWdlKS5sZW5ndGgpIHtcclxuICAgICAgLy8gbG9jYWxTdG9yYWdlIGlzIG9yaWdpbi1zY29wZWQg4oCUIGl0IE1VU1QgYmUgcmVzdG9yZWQgb24gdGhlIHNhbWUgb3JpZ2luIGl0IHdhcyBjYXB0dXJlZFxyXG4gICAgICAvLyBmcm9tLCBvdGhlcndpc2UgdGhlIGJhbmsncyBsb2dpbiBKUyByZWFkcyBhbiBlbXB0eSBkZXZpY2UtdHJ1c3QgaWQgYW5kIHJlLWNoYWxsZW5nZXMgMkZBLlxyXG4gICAgICAvLyBQcmVmZXIgdGhlIHJlY29yZGVkIG9yaWdpbjsgZmFsbCBiYWNrIChmb3Igb2xkZXIgdHJ1c3QgZGF0YSkgdG8gdGhlIG1vc3Qgc3BlY2lmaWNcclxuICAgICAgLy8gaG9zdC1vbmx5IGNvb2tpZSBkb21haW4gcmF0aGVyIHRoYW4gdGhlIGZpcnN0IGNvb2tpZSdzIChvZnRlbiBhIHdpbGRjYXJkIHBhcmVudCkgZG9tYWluLlxyXG4gICAgICBjb25zdCBmYWxsYmFja0RvbWFpbiA9IChkYXRhLmNvb2tpZXMgPz8gW10pXHJcbiAgICAgICAgLm1hcChjID0+IGMuZG9tYWluKVxyXG4gICAgICAgIC5maWx0ZXIoKGQpOiBkIGlzIHN0cmluZyA9PiAhIWQgJiYgIWQuc3RhcnRzV2l0aCgnLicpKVxyXG4gICAgICAgIC5zb3J0KChhLCBiKSA9PiBiLmxlbmd0aCAtIGEubGVuZ3RoKVswXTtcclxuICAgICAgY29uc3Qgb3JpZ2luID0gZGF0YS5vcmlnaW4gPz8gKGZhbGxiYWNrRG9tYWluID8gYGh0dHBzOi8vJHtmYWxsYmFja0RvbWFpbn1gIDogdW5kZWZpbmVkKTtcclxuICAgICAgaWYgKG9yaWdpbikge1xyXG4gICAgICAgIGF3YWl0IHRoaXMucGFnZS5nb3RvKG9yaWdpbiwgeyB3YWl0VW50aWw6ICdkb21jb250ZW50bG9hZGVkJyB9KTtcclxuICAgICAgICBhd2FpdCB0aGlzLnBhZ2UuZXZhbHVhdGUoKGl0ZW1zOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+KSA9PiB7XHJcbiAgICAgICAgICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhpdGVtcykpIHtcclxuICAgICAgICAgICAgd2luZG93LmxvY2FsU3RvcmFnZS5zZXRJdGVtKGtleSwgdmFsdWUpO1xyXG4gICAgICAgICAgfVxyXG4gICAgICAgIH0sIGRhdGEubG9jYWxTdG9yYWdlKTtcclxuICAgICAgICBkZWJ1ZyhgaW5qZWN0ZWQgJHtPYmplY3Qua2V5cyhkYXRhLmxvY2FsU3RvcmFnZSkubGVuZ3RofSBsb2NhbFN0b3JhZ2UgZW50cmllcyBhdCAke29yaWdpbn1gKTtcclxuICAgICAgfVxyXG4gICAgfVxyXG4gIH1cclxuXHJcbiAgcHJpdmF0ZSBhc3luYyBleHRyYWN0RGV2aWNlVHJ1c3REYXRhKCk6IFByb21pc2U8RGV2aWNlVHJ1c3REYXRhPiB7XHJcbiAgICBjb25zdCByYXdDb29raWVzID0gYXdhaXQgdGhpcy5wYWdlLmNvb2tpZXMoKTtcclxuICAgIGNvbnN0IGNvb2tpZXMgPSByYXdDb29raWVzLm1hcCgoeyBuYW1lLCB2YWx1ZSwgZG9tYWluLCBwYXRoLCBleHBpcmVzLCBodHRwT25seSwgc2VjdXJlLCBzYW1lU2l0ZSB9KSA9PiAoe1xyXG4gICAgICBuYW1lLFxyXG4gICAgICB2YWx1ZSxcclxuICAgICAgZG9tYWluLFxyXG4gICAgICBwYXRoLFxyXG4gICAgICBleHBpcmVzLFxyXG4gICAgICBodHRwT25seSxcclxuICAgICAgc2VjdXJlLFxyXG4gICAgICBzYW1lU2l0ZSxcclxuICAgIH0pKTtcclxuXHJcbiAgICBjb25zdCBsb2NhbFN0b3JhZ2UgPSBhd2FpdCB0aGlzLnBhZ2UuZXZhbHVhdGUoKCkgPT4ge1xyXG4gICAgICBjb25zdCBpdGVtczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xyXG4gICAgICBmb3IgKGxldCBpID0gMDsgaSA8IHdpbmRvdy5sb2NhbFN0b3JhZ2UubGVuZ3RoOyBpKyspIHtcclxuICAgICAgICBjb25zdCBrZXkgPSB3aW5kb3cubG9jYWxTdG9yYWdlLmtleShpKSE7XHJcbiAgICAgICAgaXRlbXNba2V5XSA9IHdpbmRvdy5sb2NhbFN0b3JhZ2UuZ2V0SXRlbShrZXkpITtcclxuICAgICAgfVxyXG4gICAgICByZXR1cm4gaXRlbXM7XHJcbiAgICB9KTtcclxuXHJcbiAgICBjb25zdCBvcmlnaW4gPSBhd2FpdCB0aGlzLnBhZ2UuZXZhbHVhdGUoKCkgPT4gd2luZG93LmxvY2F0aW9uLm9yaWdpbik7XHJcblxyXG4gICAgcmV0dXJuIHsgY29va2llcywgbG9jYWxTdG9yYWdlLCBvcmlnaW4gfTtcclxuICB9XHJcblxyXG4gIHByaXZhdGUgaGFuZGxlTG9naW5SZXN1bHQobG9naW5SZXN1bHQ6IExvZ2luUmVzdWx0cykge1xyXG4gICAgc3dpdGNoIChsb2dpblJlc3VsdCkge1xyXG4gICAgICBjYXNlIExvZ2luUmVzdWx0cy5TdWNjZXNzOlxyXG4gICAgICAgIHRoaXMuZW1pdFByb2dyZXNzKFNjcmFwZXJQcm9ncmVzc1R5cGVzLkxvZ2luU3VjY2Vzcyk7XHJcbiAgICAgICAgcmV0dXJuIHsgc3VjY2VzczogdHJ1ZSB9O1xyXG4gICAgICBjYXNlIExvZ2luUmVzdWx0cy5JbnZhbGlkUGFzc3dvcmQ6XHJcbiAgICAgIGNhc2UgTG9naW5SZXN1bHRzLlVua25vd25FcnJvcjpcclxuICAgICAgICB0aGlzLmVtaXRQcm9ncmVzcyhTY3JhcGVyUHJvZ3Jlc3NUeXBlcy5Mb2dpbkZhaWxlZCk7XHJcbiAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgIHN1Y2Nlc3M6IGZhbHNlLFxyXG4gICAgICAgICAgZXJyb3JUeXBlOlxyXG4gICAgICAgICAgICBsb2dpblJlc3VsdCA9PT0gTG9naW5SZXN1bHRzLkludmFsaWRQYXNzd29yZFxyXG4gICAgICAgICAgICAgID8gU2NyYXBlckVycm9yVHlwZXMuSW52YWxpZFBhc3N3b3JkXHJcbiAgICAgICAgICAgICAgOiBTY3JhcGVyRXJyb3JUeXBlcy5HZW5lcmFsLFxyXG4gICAgICAgICAgZXJyb3JNZXNzYWdlOiBgTG9naW4gZmFpbGVkIHdpdGggJHtsb2dpblJlc3VsdH0gZXJyb3JgLFxyXG4gICAgICAgIH07XHJcbiAgICAgIGNhc2UgTG9naW5SZXN1bHRzLkNoYW5nZVBhc3N3b3JkOlxyXG4gICAgICAgIHRoaXMuZW1pdFByb2dyZXNzKFNjcmFwZXJQcm9ncmVzc1R5cGVzLkNoYW5nZVBhc3N3b3JkKTtcclxuICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgc3VjY2VzczogZmFsc2UsXHJcbiAgICAgICAgICBlcnJvclR5cGU6IFNjcmFwZXJFcnJvclR5cGVzLkNoYW5nZVBhc3N3b3JkLFxyXG4gICAgICAgIH07XHJcbiAgICAgIGNhc2UgTG9naW5SZXN1bHRzLlR3b0ZhY3RvclJldHJpZXZlck1pc3Npbmc6XHJcbiAgICAgICAgdGhpcy5lbWl0UHJvZ3Jlc3MoU2NyYXBlclByb2dyZXNzVHlwZXMuTG9naW5GYWlsZWQpO1xyXG4gICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICBzdWNjZXNzOiBmYWxzZSxcclxuICAgICAgICAgIGVycm9yVHlwZTogU2NyYXBlckVycm9yVHlwZXMuVHdvRmFjdG9yUmV0cmlldmVyTWlzc2luZyxcclxuICAgICAgICB9O1xyXG4gICAgICBkZWZhdWx0OlxyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgdW5leHBlY3RlZCBsb2dpbiByZXN1bHQgXCIke2xvZ2luUmVzdWx0fVwiYCk7XHJcbiAgICB9XHJcbiAgfVxyXG59XHJcblxyXG5leHBvcnQgeyBCYXNlU2NyYXBlcldpdGhCcm93c2VyIH07XHJcbiJdLCJtYXBwaW5ncyI6Ijs7Ozs7O0FB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