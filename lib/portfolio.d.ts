export declare enum AssetType {
    Stock = "stock",
    Bond = "bond",
    Etf = "etf",
    Fund = "fund",
    Option = "option",
    Future = "future",
    Cash = "cash",
    Other = "other"
}
export interface Position {
    name: string;
    symbol?: string;
    securityId: string;
    isin?: string;
    assetType?: AssetType;
    exchange?: string;
    quantity: number;
    currency: string;
    marketPrice?: number;
    marketValue: number;
    averageCost?: number;
    costBasis?: number;
    unrealizedPnl?: number;
    unrealizedPnlPct?: number;
    asOf?: string;
    rawPosition?: unknown;
}
export interface PortfolioAccount {
    accountNumber: string;
    baseCurrency?: string;
    totalValue?: number;
    cash?: number;
    positions: Position[];
}
