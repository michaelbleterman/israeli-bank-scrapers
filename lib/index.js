"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
Object.defineProperty(exports, "AssetType", {
  enumerable: true,
  get: function () {
    return _portfolio.AssetType;
  }
});
Object.defineProperty(exports, "CompanyTypes", {
  enumerable: true,
  get: function () {
    return _definitions.CompanyTypes;
  }
});
Object.defineProperty(exports, "DeviceTrustData", {
  enumerable: true,
  get: function () {
    return _interface.DeviceTrustData;
  }
});
Object.defineProperty(exports, "OneZeroScraper", {
  enumerable: true,
  get: function () {
    return _oneZero.default;
  }
});
Object.defineProperty(exports, "SCRAPERS", {
  enumerable: true,
  get: function () {
    return _definitions.SCRAPERS;
  }
});
Object.defineProperty(exports, "ScaperLoginResult", {
  enumerable: true,
  get: function () {
    return _interface.ScraperLoginResult;
  }
});
Object.defineProperty(exports, "ScaperScrapingResult", {
  enumerable: true,
  get: function () {
    return _interface.ScraperScrapingResult;
  }
});
Object.defineProperty(exports, "Scraper", {
  enumerable: true,
  get: function () {
    return _interface.Scraper;
  }
});
Object.defineProperty(exports, "ScraperCredentials", {
  enumerable: true,
  get: function () {
    return _interface.ScraperCredentials;
  }
});
Object.defineProperty(exports, "ScraperLoginResult", {
  enumerable: true,
  get: function () {
    return _interface.ScraperLoginResult;
  }
});
Object.defineProperty(exports, "ScraperOptions", {
  enumerable: true,
  get: function () {
    return _interface.ScraperOptions;
  }
});
Object.defineProperty(exports, "ScraperScrapingResult", {
  enumerable: true,
  get: function () {
    return _interface.ScraperScrapingResult;
  }
});
Object.defineProperty(exports, "createScraper", {
  enumerable: true,
  get: function () {
    return _factory.default;
  }
});
exports.getPuppeteerConfig = getPuppeteerConfig;
var _definitions = require("./definitions");
var _factory = _interopRequireDefault(require("./scrapers/factory"));
var _portfolio = require("./portfolio");
var _interface = require("./scrapers/interface");
var _oneZero = _interopRequireDefault(require("./scrapers/one-zero"));
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
// Note: the typo ScaperScrapingResult & ScraperLoginResult (sic) are exported here for backward compatibility

function getPuppeteerConfig() {
  return {
    chromiumRevision: '1250580'
  }; // https://github.com/puppeteer/puppeteer/releases/tag/puppeteer-core-v22.5.0
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfZGVmaW5pdGlvbnMiLCJyZXF1aXJlIiwiX2ZhY3RvcnkiLCJfaW50ZXJvcFJlcXVpcmVEZWZhdWx0IiwiX3BvcnRmb2xpbyIsIl9pbnRlcmZhY2UiLCJfb25lWmVybyIsImUiLCJfX2VzTW9kdWxlIiwiZGVmYXVsdCIsImdldFB1cHBldGVlckNvbmZpZyIsImNocm9taXVtUmV2aXNpb24iXSwic291cmNlcyI6WyIuLi9zcmMvaW5kZXgudHMiXSwic291cmNlc0NvbnRlbnQiOlsiZXhwb3J0IHsgQ29tcGFueVR5cGVzLCBTQ1JBUEVSUyB9IGZyb20gJy4vZGVmaW5pdGlvbnMnO1xyXG5leHBvcnQgeyBkZWZhdWx0IGFzIGNyZWF0ZVNjcmFwZXIgfSBmcm9tICcuL3NjcmFwZXJzL2ZhY3RvcnknO1xyXG5leHBvcnQgeyBBc3NldFR5cGUgfSBmcm9tICcuL3BvcnRmb2xpbyc7XHJcbmV4cG9ydCB0eXBlIHsgUG9ydGZvbGlvQWNjb3VudCwgUG9zaXRpb24gfSBmcm9tICcuL3BvcnRmb2xpbyc7XHJcblxyXG4vLyBOb3RlOiB0aGUgdHlwbyBTY2FwZXJTY3JhcGluZ1Jlc3VsdCAmIFNjcmFwZXJMb2dpblJlc3VsdCAoc2ljKSBhcmUgZXhwb3J0ZWQgaGVyZSBmb3IgYmFja3dhcmQgY29tcGF0aWJpbGl0eVxyXG5leHBvcnQge1xyXG4gIFNjcmFwZXJMb2dpblJlc3VsdCBhcyBTY2FwZXJMb2dpblJlc3VsdCxcclxuICBTY3JhcGVyU2NyYXBpbmdSZXN1bHQgYXMgU2NhcGVyU2NyYXBpbmdSZXN1bHQsXHJcbiAgRGV2aWNlVHJ1c3REYXRhLFxyXG4gIFNjcmFwZXIsXHJcbiAgU2NyYXBlckNyZWRlbnRpYWxzLFxyXG4gIFNjcmFwZXJMb2dpblJlc3VsdCxcclxuICBTY3JhcGVyT3B0aW9ucyxcclxuICBTY3JhcGVyU2NyYXBpbmdSZXN1bHQsXHJcbn0gZnJvbSAnLi9zY3JhcGVycy9pbnRlcmZhY2UnO1xyXG5cclxuZXhwb3J0IHsgZGVmYXVsdCBhcyBPbmVaZXJvU2NyYXBlciB9IGZyb20gJy4vc2NyYXBlcnMvb25lLXplcm8nO1xyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGdldFB1cHBldGVlckNvbmZpZygpIHtcclxuICByZXR1cm4geyBjaHJvbWl1bVJldmlzaW9uOiAnMTI1MDU4MCcgfTsgLy8gaHR0cHM6Ly9naXRodWIuY29tL3B1cHBldGVlci9wdXBwZXRlZXIvcmVsZWFzZXMvdGFnL3B1cHBldGVlci1jb3JlLXYyMi41LjBcclxufVxyXG4iXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLElBQUFBLFlBQUEsR0FBQUMsT0FBQTtBQUNBLElBQUFDLFFBQUEsR0FBQUMsc0JBQUEsQ0FBQUYsT0FBQTtBQUNBLElBQUFHLFVBQUEsR0FBQUgsT0FBQTtBQUlBLElBQUFJLFVBQUEsR0FBQUosT0FBQTtBQVdBLElBQUFLLFFBQUEsR0FBQUgsc0JBQUEsQ0FBQUYsT0FBQTtBQUFnRSxTQUFBRSx1QkFBQUksQ0FBQSxXQUFBQSxDQUFBLElBQUFBLENBQUEsQ0FBQUMsVUFBQSxHQUFBRCxDQUFBLEtBQUFFLE9BQUEsRUFBQUYsQ0FBQTtBQVpoRTs7QUFjTyxTQUFTRyxrQkFBa0JBLENBQUEsRUFBRztFQUNuQyxPQUFPO0lBQUVDLGdCQUFnQixFQUFFO0VBQVUsQ0FBQyxDQUFDLENBQUM7QUFDMUMiLCJpZ25vcmVMaXN0IjpbXX0=