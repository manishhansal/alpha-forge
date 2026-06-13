// Sector → NSE F&O constituents (no .NS suffix; the API route appends it).
// Curated from the project's data/fno_cache.csv. Some stocks intentionally
// appear in two sectors (e.g. PSU banks also belong to the broader Bank list,
// and power utilities also live under Energy per the Nifty Energy index).

export const SECTOR_STOCKS: Record<string, string[]> = {
  Bank: [
    "HDFCBANK", "ICICIBANK", "SBIN", "KOTAKBANK", "AXISBANK", "INDUSINDBK",
    "BANKBARODA", "PNB", "CANBK", "UNIONBANK", "INDIANB", "BANKINDIA",
    "FEDERALBNK", "IDFCFIRSTB", "BANDHANBNK", "RBLBANK", "YESBANK", "AUBANK",
  ],

  "PSU Bank": [
    "SBIN", "BANKBARODA", "PNB", "CANBK", "UNIONBANK", "INDIANB", "BANKINDIA",
  ],

  IT: [
    "TCS", "INFY", "WIPRO", "HCLTECH", "TECHM", "LTM", "MPHASIS", "COFORGE",
    "PERSISTENT", "OFSS", "TATAELXSI", "KPITTECH",
  ],

  Auto: [
    "MARUTI", "TMPV", "HYUNDAI", "M&M", "EICHERMOT", "TVSMOTOR", "BAJAJ-AUTO",
    "HEROMOTOCO", "ASHOKLEY", "BHARATFORG", "MOTHERSON", "BOSCHLTD", "EXIDEIND",
    "SONACOMS", "UNOMINDA", "TIINDIA", "FORCEMOT",
  ],

  Pharma: [
    "SUNPHARMA", "DRREDDY", "CIPLA", "DIVISLAB", "LUPIN", "AUROPHARMA",
    "BIOCON", "ALKEM", "TORNTPHARM", "MANKIND", "ZYDUSLIFE", "GLENMARK",
    "LAURUSLABS", "APOLLOHOSP", "MAXHEALTH", "FORTIS",
  ],

  FMCG: [
    "HINDUNILVR", "ITC", "NESTLEIND", "BRITANNIA", "DABUR", "GODREJCP",
    "MARICO", "COLPAL", "TATACONSUM", "UNITDSPR", "VBL", "PATANJALI",
    "GODFRYPHLP",
  ],

  Metal: [
    "TATASTEEL", "JSWSTEEL", "HINDALCO", "JINDALSTEL", "NMDC", "NATIONALUM",
    "VEDL", "HINDZINC", "SAIL", "APLAPOLLO",
  ],

  Energy: [
    "RELIANCE", "ONGC", "BPCL", "HINDPETRO", "IOC", "OIL", "GAIL", "COALINDIA",
    "PETRONET", "NTPC", "POWERGRID", "TATAPOWER", "ADANIPOWER", "ADANIGREEN",
    "JSWENERGY", "NHPC", "SUZLON", "WAAREEENER", "INOXWIND", "PREMIERENE",
    "IREDA", "RECLTD", "PFC", "IEX",
  ],

  Realty: [
    "DLF", "LODHA", "GODREJPROP", "OBEROIRLTY", "PHOENIXLTD", "PRESTIGE",
  ],

  "Fin Services": [
    "BAJFINANCE", "BAJAJFINSV", "BAJAJHLDNG", "SHRIRAMFIN", "CHOLAFIN",
    "MUTHOOTFIN", "MANAPPURAM", "SBICARD", "LICHSGFIN", "PNBHOUSING", "LTF",
    "MFSL", "HDFCAMC", "HDFCLIFE", "SBILIFE", "ICICIPRULI", "ICICIGI", "LICI",
    "NAM-INDIA", "CAMS", "KFINTECH", "ANGELONE", "MOTILALOFS", "NUVAMA",
    "360ONE", "POLICYBZR", "PAYTM", "JIOFIN", "ABCAPITAL", "SAMMAANCAP",
    "CDSL", "BSE", "MCX",
  ],

  Media: [],

  Infra: [
    "LT", "BHEL", "SIEMENS", "ABB", "CUMMINSIND", "CGPOWER", "POWERINDIA",
    "KAYNES", "BEL", "BDL", "HAL", "COCHINSHIP", "MAZDOCK", "IRFC", "RVNL",
    "NBCC", "GMRAIRPORT", "CONCOR", "ADANIPORTS", "ADANIENSOL", "ADANIENT",
  ],
};
