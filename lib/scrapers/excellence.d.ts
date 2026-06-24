import { type Page } from 'puppeteer';
import { AssetType, type PortfolioAccount } from '../portfolio';
import { BaseScraperWithBrowser, type PossibleLoginResults } from './base-scraper-with-browser';
import { type ScraperLoginResult, type ScraperOptions } from './interface';
interface SecurityMeta {
    '-Key': string | number;
    HebName?: string | null;
    EngName?: string | null;
    HebSymbol?: string | null;
    EngSymbol?: string | null;
    Symbol?: string | null;
    ItemType?: string | number | null;
    StockType?: string | number | null;
    IsEtf?: boolean | string | number | null;
    IsForeign?: boolean | string | number | null;
}
interface BalancePosition {
    EquityNumber?: string | number;
    OnlineNV?: number;
    AvailableNV?: number;
    LastRate?: number;
    BaseRate?: number;
    OnlineVL?: number;
    OnlineNisVL?: number;
    AveragePrice?: number;
    ProfitLoss?: number;
    AveragePriceProfitLoss?: number;
    AveragePriceProfitLossPercentage?: number;
    OnlinePercentage?: number;
    CurrencyCode?: string;
    ExpiryDate?: string;
    ValueDate?: string;
    SubAccount?: unknown;
    SubAccountName?: string;
    LienNv?: number;
    LoanNv?: number;
}
interface AccountView {
    OnlineValue?: number;
    MorningValue?: number;
    OnlineCash?: number;
    MorningCash?: number;
    CurrencyCode?: string;
    ProfitLoss?: number;
    ProfitLossPercentage?: number;
    BalanceCacheDate?: string;
    AccountPosition?: {
        Balance?: BalancePosition | BalancePosition[];
    };
}
interface BalancesResponse {
    View?: {
        Account?: AccountView;
        Meta?: {
            Security?: SecurityMeta | SecurityMeta[];
        };
    };
}
/**
 * Map Excellence ItemType/StockType/IsEtf flags to AssetType.
 *
 * Values confirmed against a live balances response (2026-06-24): `ItemType` is a
 * string label such as "Equity" or "Fund"; `StockType` may be null, "Equity", or
 * "ETF"; `IsEtf` is a boolean. We treat an ETF marker (IsEtf true, or StockType
 * "ETF") as ETF first, since an ETF is also reported with ItemType "Equity"/"Fund".
 * Numeric/string fallbacks are kept defensively for codes we may not have observed.
 */
export declare function mapAssetType(meta: SecurityMeta): AssetType;
/**
 * Map the balances API response for a single account into a PortfolioAccount.
 *
 * @param accountNumber - The account key (e.g. "00-000000")
 * @param balancesResponse - The raw JSON from GET /account/view/balances
 * @param options - Scraper options (used to gate rawPosition via includeRawTransaction)
 */
export declare function mapBalancesToPortfolioAccount(accountNumber: string, balancesResponse: BalancesResponse, options?: Pick<ScraperOptions, 'includeRawTransaction'>): PortfolioAccount;
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
export declare function detectOtpChallenge(page: Page | undefined): Promise<boolean>;
type ExcellenceCredentials = {
    username: string;
    password: string;
};
declare class ExcellenceScraper extends BaseScraperWithBrowser<ExcellenceCredentials> {
    /** The SessionKey (UUID) from the /login response, used as the `session` header. Never logged. */
    private sessionKey;
    /**
     * Client-generated `csession` value. Generated once per scrape and reused on the
     * login request and every authenticated call (the server binds the SessionKey to it).
     * Never logged.
     */
    private csession;
    private get tokens();
    get baseUrl(): string;
    getLoginOptions(credentials: ExcellenceCredentials): {
        loginUrl: string;
        fields: {
            selector: string;
            value: string;
        }[];
        submitButtonSelector: () => Promise<void>;
        possibleResults: PossibleLoginResults;
    };
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
    login(credentials: ExcellenceCredentials): Promise<ScraperLoginResult>;
    fetchData(): Promise<{
        success: boolean;
        portfolioAccounts: PortfolioAccount[];
    }>;
}
export default ExcellenceScraper;
