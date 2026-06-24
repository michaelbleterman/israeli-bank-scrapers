export { CompanyTypes, SCRAPERS } from './definitions';
export { default as createScraper } from './scrapers/factory';
export { ScraperLoginResult as ScaperLoginResult, ScraperScrapingResult as ScaperScrapingResult, DeviceTrustData, Scraper, ScraperCredentials, ScraperLoginResult, ScraperOptions, ScraperScrapingResult, } from './scrapers/interface';
export { default as OneZeroScraper } from './scrapers/one-zero';
export declare function getPuppeteerConfig(): {
    chromiumRevision: string;
};
