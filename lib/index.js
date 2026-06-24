"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
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
var _interface = require("./scrapers/interface");
var _oneZero = _interopRequireDefault(require("./scrapers/one-zero"));
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
// Note: the typo ScaperScrapingResult & ScraperLoginResult (sic) are exported here for backward compatibility

function getPuppeteerConfig() {
  return {
    chromiumRevision: '1250580'
  }; // https://github.com/puppeteer/puppeteer/releases/tag/puppeteer-core-v22.5.0
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfZGVmaW5pdGlvbnMiLCJyZXF1aXJlIiwiX2ZhY3RvcnkiLCJfaW50ZXJvcFJlcXVpcmVEZWZhdWx0IiwiX2ludGVyZmFjZSIsIl9vbmVaZXJvIiwiZSIsIl9fZXNNb2R1bGUiLCJkZWZhdWx0IiwiZ2V0UHVwcGV0ZWVyQ29uZmlnIiwiY2hyb21pdW1SZXZpc2lvbiJdLCJzb3VyY2VzIjpbIi4uL3NyYy9pbmRleC50cyJdLCJzb3VyY2VzQ29udGVudCI6WyJleHBvcnQgeyBDb21wYW55VHlwZXMsIFNDUkFQRVJTIH0gZnJvbSAnLi9kZWZpbml0aW9ucyc7XHJcbmV4cG9ydCB7IGRlZmF1bHQgYXMgY3JlYXRlU2NyYXBlciB9IGZyb20gJy4vc2NyYXBlcnMvZmFjdG9yeSc7XHJcblxyXG4vLyBOb3RlOiB0aGUgdHlwbyBTY2FwZXJTY3JhcGluZ1Jlc3VsdCAmIFNjcmFwZXJMb2dpblJlc3VsdCAoc2ljKSBhcmUgZXhwb3J0ZWQgaGVyZSBmb3IgYmFja3dhcmQgY29tcGF0aWJpbGl0eVxyXG5leHBvcnQge1xyXG4gIFNjcmFwZXJMb2dpblJlc3VsdCBhcyBTY2FwZXJMb2dpblJlc3VsdCxcclxuICBTY3JhcGVyU2NyYXBpbmdSZXN1bHQgYXMgU2NhcGVyU2NyYXBpbmdSZXN1bHQsXHJcbiAgRGV2aWNlVHJ1c3REYXRhLFxyXG4gIFNjcmFwZXIsXHJcbiAgU2NyYXBlckNyZWRlbnRpYWxzLFxyXG4gIFNjcmFwZXJMb2dpblJlc3VsdCxcclxuICBTY3JhcGVyT3B0aW9ucyxcclxuICBTY3JhcGVyU2NyYXBpbmdSZXN1bHQsXHJcbn0gZnJvbSAnLi9zY3JhcGVycy9pbnRlcmZhY2UnO1xyXG5cclxuZXhwb3J0IHsgZGVmYXVsdCBhcyBPbmVaZXJvU2NyYXBlciB9IGZyb20gJy4vc2NyYXBlcnMvb25lLXplcm8nO1xyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGdldFB1cHBldGVlckNvbmZpZygpIHtcclxuICByZXR1cm4geyBjaHJvbWl1bVJldmlzaW9uOiAnMTI1MDU4MCcgfTsgLy8gaHR0cHM6Ly9naXRodWIuY29tL3B1cHBldGVlci9wdXBwZXRlZXIvcmVsZWFzZXMvdGFnL3B1cHBldGVlci1jb3JlLXYyMi41LjBcclxufVxyXG4iXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLElBQUFBLFlBQUEsR0FBQUMsT0FBQTtBQUNBLElBQUFDLFFBQUEsR0FBQUMsc0JBQUEsQ0FBQUYsT0FBQTtBQUdBLElBQUFHLFVBQUEsR0FBQUgsT0FBQTtBQVdBLElBQUFJLFFBQUEsR0FBQUYsc0JBQUEsQ0FBQUYsT0FBQTtBQUFnRSxTQUFBRSx1QkFBQUcsQ0FBQSxXQUFBQSxDQUFBLElBQUFBLENBQUEsQ0FBQUMsVUFBQSxHQUFBRCxDQUFBLEtBQUFFLE9BQUEsRUFBQUYsQ0FBQTtBQVpoRTs7QUFjTyxTQUFTRyxrQkFBa0JBLENBQUEsRUFBRztFQUNuQyxPQUFPO0lBQUVDLGdCQUFnQixFQUFFO0VBQVUsQ0FBQyxDQUFDLENBQUM7QUFDMUMiLCJpZ25vcmVMaXN0IjpbXX0=