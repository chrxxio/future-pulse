// What the app tracks. Edit freely: add/remove instruments, feeds or topics.
//
// Prices come from Yahoo Finance's public chart endpoint. Each micro contract
// quotes the same price as its full-size parent (MES = ES points, MGC = GC $/oz),
// so the full-size symbol is tried first (deeper history/volume) and the micro
// symbol is the fallback.
//
// group: drives which news/macro rules apply.
// day:   the instrument's main US day session in ET minutes [start, end] — used
//        for "NY open", day-session close and the initial balance.
// pointValue: $ per 1.00 price move for ONE micro contract (CME contract specs).
// stooq: fallback daily-data symbol on stooq.com (front-month continuous); used only
//        when Yahoo refuses. Best effort — if one fails, Feed health shows it.

export const INSTRUMENTS = [
  { id: 'MES', name: 'Micro E-mini S&P 500', group: 'equity', tags: ['spx'],
    yahoo: ['ES=F', 'MES=F'], stooq: 'es.f', tick: 0.25, pointValue: 5, day: [570, 960], ib: true },
  { id: 'MNQ', name: 'Micro E-mini Nasdaq-100', group: 'equity', tags: ['tech'],
    yahoo: ['NQ=F', 'MNQ=F'], stooq: 'nq.f', tick: 0.25, pointValue: 2, day: [570, 960], ib: true },
  { id: 'MYM', name: 'Micro E-mini Dow', group: 'equity', tags: ['dow'],
    yahoo: ['YM=F', 'MYM=F'], stooq: 'ym.f', tick: 1, pointValue: 0.5, day: [570, 960], ib: true },
  { id: 'M2K', name: 'Micro E-mini Russell 2000', group: 'equity', tags: ['smallcap'],
    yahoo: ['RTY=F', 'M2K=F'], stooq: 'rty.f', tick: 0.1, pointValue: 5, day: [570, 960], ib: true },
  { id: 'MGC', name: 'Micro Gold', group: 'gold', tags: ['metal'],
    yahoo: ['GC=F', 'MGC=F'], stooq: 'gc.f', tick: 0.1, pointValue: 10, day: [500, 810] },
  { id: 'SIL', name: 'Micro Silver', group: 'silver', tags: ['metal'],
    yahoo: ['SI=F', 'SIL=F'], stooq: 'si.f', tick: 0.005, pointValue: 1000, day: [505, 805] },
  { id: 'MCL', name: 'Micro WTI Crude Oil', group: 'oil', tags: ['energy'],
    yahoo: ['CL=F', 'MCL=F'], stooq: 'cl.f', tick: 0.01, pointValue: 100, day: [540, 870] },
  { id: 'MBT', name: 'Micro Bitcoin', group: 'crypto', tags: ['btc'],
    yahoo: ['BTC=F', 'MBT=F'], tick: 5, pointValue: 0.1, day: [570, 960] },
];

// Cross-asset context used in the sentiment model.
export const MACRO = [
  { id: 'VIX', name: 'VIX', yahoo: '^VIX', unit: '' },
  { id: 'DXY', name: 'US Dollar Index', yahoo: 'DX-Y.NYB', unit: '' },
  { id: 'US10Y', name: '10Y Treasury yield', yahoo: '^TNX', unit: '%' },
];

// RSS feeds. All are fetched from GitHub's servers (no CORS issues). Any feed that
// fails is skipped and reported under Settings → Feed health in the app.
export const FEEDS = [
  { name: 'MarketWatch Bulletins', url: 'https://feeds.content.dowjones.io/public/rss/mw_bulletins', weight: 1.2 },
  { name: 'MarketWatch Top Stories', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories', weight: 1 },
  { name: 'Federal Reserve', url: 'https://www.federalreserve.gov/feeds/press_all.xml', weight: 1.5, official: true },
  { name: 'Investing.com Stocks', url: 'https://www.investing.com/rss/news_25.rss', weight: 1 },
  { name: 'Investing.com Commodities', url: 'https://www.investing.com/rss/news_11.rss', weight: 1 },
  { name: 'Investing.com Economy', url: 'https://www.investing.com/rss/news_14.rss', weight: 1 },
  { name: 'Investing.com Indicators', url: 'https://www.investing.com/rss/news_95.rss', weight: 1 },
  { name: 'OilPrice.com', url: 'https://oilprice.com/rss/main', weight: 1 },
  { name: 'FXStreet', url: 'https://www.fxstreet.com/rss/news', weight: 0.8 },
  { name: 'Yahoo Finance', url: 'https://finance.yahoo.com/news/rssindex', weight: 0.9 },
  { name: 'CNBC Top News', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html', weight: 1 },
];

// Google News topic searches (last 24h). Each becomes one RSS request.
export const NEWS_TOPICS = [
  { name: 'Stocks & index futures', q: '"stock market" OR "S&P 500" OR Nasdaq OR "Dow Jones" OR "stock futures"' },
  { name: 'Fed & rates', q: '"Federal Reserve" OR FOMC OR "rate cut" OR "rate hike" OR "Fed chair"' },
  { name: 'Inflation & jobs', q: 'CPI OR PCE OR inflation OR "jobs report" OR payrolls OR "jobless claims" OR GDP' },
  { name: 'Crude oil', q: '"crude oil" OR "oil prices" OR OPEC OR Brent OR "Strait of Hormuz"' },
  { name: 'Gold & silver', q: '"gold price" OR "gold futures" OR bullion OR "silver price"' },
  { name: 'Trade & tariffs', q: 'tariffs OR "trade war" OR "export controls" OR sanctions' },
  { name: 'Geopolitics', q: 'war OR missile OR ceasefire OR airstrike OR invasion' },
  { name: 'Bonds & dollar', q: '"Treasury yields" OR "bond market" OR "dollar index" OR "government shutdown"' },
  { name: 'Bitcoin', q: 'bitcoin OR "crypto market" OR "bitcoin ETF"' },
];
export const googleNewsUrl = (q) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:1d')}&hl=en-US&gl=US&ceid=US:en`;

// Economic calendar (Forex Factory's public weekly JSON). Fetched at most hourly.
export const CALENDAR_URLS = [
  'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
  'https://nfs.faireconomy.media/ff_calendar_nextweek.json',
];

export const SETTINGS = {
  newsMaxAgeHours: 36,
  newsHalfLifeHours: 8,
  breakingMinutes: 90,
  levelRangeAtr: 2.5,      // show levels within this many daily ATRs of price
  minLevelsEachSide: 4,
  aiIntervalMinutes: Number(process.env.AI_INTERVAL_MINUTES || 30),
  aiModel: process.env.AI_MODEL || 'claude-haiku-5-5',
  maxPushPerRun: 5,
};
