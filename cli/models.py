from enum import Enum


class AnalystType(str, Enum):
    MARKET = "market"
    # Wire value stays "social" for saved-config and string-keyed-caller
    # back-compat; the user-facing label is "Sentiment Analyst".
    SOCIAL = "social"
    NEWS = "news"
    FUNDAMENTALS = "fundamentals"


class AssetType(str, Enum):
    STOCK = "stock"
    CRYPTO = "crypto"
    CN_ETF = "cn_etf"
    US_ETF = "us_etf"
    CN_EQUITY = "cn_equity"
    US_EQUITY = "us_equity"
    HK_EQUITY = "hk_equity"
    BENCHMARK = "benchmark"
    CRYPTO_DRIVER = "crypto_driver"
