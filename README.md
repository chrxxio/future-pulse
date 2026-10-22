# Futures Pulse

A phone app for CME micro futures that runs entirely on GitHub: **MES, MNQ, MYM, M2K, MGC, SIL, MCL, MBT**.

Every ~10 minutes a GitHub Actions job pulls prices, headlines and the economic calendar, then rebuilds:

- **Support and resistance with reasons.** Prior day high/low/close, overnight high/low, Globex and day-session opens, initial balance, session high/low, daily floor and Camarilla pivots, prior week/month highs, lows and closes, weekly and monthly opens, 52-week extremes, VWAP and its bands, prior-day and 5-day volume profile (POC / value area), daily and hourly swing zones, round numbers and ATR range targets. Levels that sit together merge into one zone, rated 1–5 by confluence. Tap any level to see what it is, how price treated it over the last 3 sessions (held / broke), whether it flipped today, and the news context.
- **Sentiment per market** (−100 to +100). It combines technical structure (50%), news flow (30%) and the macro tape (20%): VIX, dollar index and the 10-year yield. Every driver behind the score is listed.
- **Live news.** Headlines from MarketWatch, Investing.com, OilPrice, FXStreet, Yahoo Finance, CNBC, the Federal Reserve and Google News topic searches. Stories are de-duplicated across outlets, rated by impact, and tagged with which markets they push up or down and why. Anything under 90 minutes old with medium or high impact is flagged as breaking.
- **Scheduled catalysts.** The week's US medium/high-impact releases plus global high-impact ones, each mapped to the markets they move.
- **Alerts** between updates: level crosses, sentiment shifts, new high-impact headlines and releases about 30 minutes out. They can also be pushed to your phone.

On a phone it is a compact list. On a computer (browser window 1024px or wider) it opens as a **light-string globe**: a warm, old-school Christmas-light star system where every tracked thing is a bulb.

| Bulb | Meaning |
|---|---|
| Big C9 bulbs on the orbit strings | Markets: green bullish, red bearish, amber neutral; bigger bulb = stronger conviction |
| Small moons beside each market | Its key levels: red above price (resistance), green below (support). Hover or click the market to see the full column |
| Fairy lights on the globe | Headlines, grouped into regions (Equities, Fed and data, Energy, Geopolitics and trade, Metals, Crypto); blinking = breaking |
| Beams | Which markets a high-impact headline moves |
| Outer light string | Scheduled releases on a 24-hour clock counting toward the gold "now" bulb; blue = high impact |
| Gold ring around a market | How much of a normal day's range (14-day ATR) is already used; turns red past 100% |
| Gold lanterns near the globe | VIX, dollar index and the 10-year yield |
| Shooting stars | Headlines that arrived in the latest update; markets whose sentiment flipped flash, and a level cross sets off sparks |

**Article pop-ups**: a card in the bottom-right spotlights one headline at a time (high-impact and recent ones first, in a shuffled order). The globe turns to that headline's light and a glowing wire runs from it to the card; Previous / Next (or the **N** and **P** keys) step through them, hovering pauses the timer, and the *Article pop-ups* button or the card's × turns them off. Clicking a headline's light shows it in the card.

Drag to turn it, scroll to zoom (or arrow keys and +/−), press **F** for a full-screen globe, space to pause the spin, hover any bulb for details, click a market for its level ladder, click a headline to open the article. Layer buttons turn each bulb type on or off, and *Phone layout* switches to the list view (the globe icon switches back). The globe pauses its animation when your system asks for reduced motion, and lowers its glow quality automatically on slower machines.

There is no server to run. The app is a static page on GitHub Pages; the workflow redeploys it with fresh data.

---

## Setup (about 5 minutes)

1. **Create a public repository**, e.g. `futures-pulse`. Public is recommended. Pages on private repos needs a paid GitHub plan, and a 10-minute schedule uses far more than the 2,000 free Actions minutes a private repo gets each month. Public repos have no Actions minute limit on standard runners.
2. **Upload these files** to the repo, keeping the folder structure. The workflow **must** end up at exactly `.github/workflows/update.yml`; GitHub ignores workflow files anywhere else. Web uploads often drop the hidden `.github` folder, so the safest way is: open `.github/workflows/update.yml` on GitHub (or *Add file → Create new file* and type that path), paste the contents, and commit. On a Mac, Finder hides `.github`; press <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>.</kbd> to show it.
3. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
4. **Actions tab →** enable workflows if asked, open **update**, click **Run workflow**. The first run takes 1–2 minutes.
5. Open `https://<your-username>.github.io/<repo>/` on your iPhone in Safari → **Share → Add to Home Screen**.

From then on it updates itself every 10 minutes Sunday–Friday and every 3 hours on Saturday.

### Optional extras

| What | How |
|---|---|
| **AI write-ups** per market (why each key level matters right now, bull/bear case, what to watch) | Add the repository secret `ANTHROPIC_API_KEY`. The default model is `claude-haiku-5-5`, refreshed every 30 min (sooner when sentiment flips or a new high-impact story lands). Override with repository variables `AI_MODEL` and `AI_INTERVAL_MINUTES`. The model only sees this run's numbers and headlines and cites headlines by id. The app links each citation to its article. |
| **Push notifications** | Install the free **ntfy** app, subscribe to a hard-to-guess topic name, and add it as secret `NTFY_TOPIC`. A `DISCORD_WEBHOOK_URL` secret works too. Variable `PUSH_MIN_PRIORITY` (default 4): 5 = breaking headlines only, 4 adds strong level crosses, sentiment flips and releases 30 minutes out, 3 adds all level crosses. |
| **"Start update" button in the app** | Settings (gear) → paste a fine-grained GitHub token limited to this repo with **Actions: Read and write**. It is stored only in your phone's browser. Useful when GitHub runs the schedule late. |

Secrets: *Settings → Secrets and variables → Actions → Secrets*. Variables: same page, *Variables* tab.

---

## Price relay (reliable free prices)

Yahoo and Stooq refuse many requests that come from GitHub's servers; the app then shows *HTTP 429* or *HTTP 403* instead of prices. The workflow tries a browser-style connection first, but whether that gets through changes from day to day. Home internet connections aren't treated that way, so the dependable free option is to let your own computer fetch the prices and hand them to the app. While the relay runs, the site also refreshes every 5 minutes instead of waiting for GitHub's schedule.

**Setup (Windows, about 5 minutes)**

1. Install [Node.js](https://nodejs.org) 18 or newer, then get this repository onto your computer (`git clone https://github.com/<you>/<repo>.git`, or *Code → Download ZIP* and extract it).
2. Create a token: GitHub → *Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token*. Repository access: **only this repository**. Permissions: **Contents: Read and write** and **Actions: Read and write**.
3. Save it in your home folder (not in the repo) as `C:\Users\<you>\.futures-pulse-relay.json`:
   ```json
   { "repo": "<you>/<repo>", "token": "github_pat_..." }
   ```
4. Test it from the repo folder: `node scripts/relay.mjs`. You should see `sent 27 series (full history, … KB), update started`; about two minutes later the app shows prices with *via Yahoo (your computer (relay))* in each market's details.
5. Keep it running, either way:
   - `npm run relay` in a terminal and leave the window open while you trade, or
   - run once as administrator: `powershell -ExecutionPolicy Bypass -File scripts\relay-windows.ps1`. That starts it hidden in the background at every sign-in. Remove it with `Unregister-ScheduledTask -TaskName "Futures Pulse price relay" -Confirm:$false`.

On a Mac or Linux box, add a cron entry instead: `*/5 * * * * cd ~/futures-pulse && /usr/local/bin/node scripts/relay.mjs >> ~/futures-pulse-relay.log 2>&1`.

What it does: every 5 minutes it downloads the same Yahoo price history the app uses (the full history every 30 minutes, the latest bars in between, about 11–27 requests), uploads it as one compressed file to a `price-relay` branch (a single commit that is replaced each time, so the repository doesn't grow), and starts the update workflow. The workflow ignores relay data older than 30 minutes, so when your computer is off the app falls back to GitHub-side fetching and then to the last good prices, and says so. While futures are closed it checks only once an hour.

## Level codes

| Code | Meaning |
|---|---|
| PDH / PDL / PDC | Prior day high, low, day-session close (≈ settlement) |
| ONH / ONL | Overnight (Globex) high and low |
| GO / NYO | Globex open (6pm ET), day-session open |
| IBH / IBL | Initial balance (first hour of the day session) high/low, index futures |
| HOD / LOD | Session high/low so far |
| P, R1–R3, S1–S3 | Daily floor pivots from the prior session |
| H3, H4, L3, L4 | Camarilla pivots |
| PWH / PWL / PWC, WO, WP | Prior week high/low/close, weekly open, weekly pivot |
| PMH / PML / PMC, MO | Prior month high/low/close, monthly open |
| 52WH / 52WL | 52-week high/low |
| VWAP, VWAP±1σ/2σ | Session VWAP and standard-deviation bands |
| PD POC/VAH/VAL, 5D POC/VAH/VAL | Volume profile point of control and 70% value area (prior day, 5 days) |
| D-SW×n / H-SW×n | Daily / hourly swing zone with n turning points |
| RN / rn | Major / minor round number (grid scales with ATR) |
| ATR↑ / ATR↓ | Session low + 14-day ATR / session high − ATR |

Day sessions used for opens, closes and the initial balance (ET): index futures and Micro Bitcoin 9:30–16:00, gold 8:20–13:30, silver 8:25–13:25, crude 9:00–14:30. Globex sessions run 6pm–5pm ET.

## How the scores work

- **Technical (50%)**: hourly 20/50 EMA trend, price vs session VWAP, price vs daily pivot, change vs prior close in ATR terms, position in or outside the prior day range, and daily 20 EMA slope.
- **News (30%)**: transparent keyword rules (`scripts/lib/news.mjs`). For example: a dovish Fed lifts index futures and gold, a supply cut lifts crude, a stronger dollar weighs on metals, and escalation lifts gold and crude while hitting stocks. Negations like "no rush to cut" count as hawkish. Each story is weighted by impact, how many outlets carry it, and age (8-hour half-life). The score is the net direction of that flow. With fewer than 3 scored stories, news gets less weight.
- **Macro (20%)**: today's change in VIX, DXY and the 10Y yield, with signs per market (e.g. higher yields are a headwind for MNQ and gold).

Labels: ≥ +40 strong bullish, ≥ +15 bullish, between −15 and +15 neutral, ≤ −15 bearish, ≤ −40 strong bearish. Confidence reflects whether the three components agree. All of this is computed analysis, not advice.

## Limits to know about

- **Prices** come from Yahoo Finance's public chart data, using the full-size continuous contract (ES, NQ, YM, RTY, GC, SI, CL, BTC) because its history is deeper. Micro and full-size contracts trade at the same price. Yahoo answers plain requests from GitHub's servers with HTTP 429, so the workflow fetches with a browser-style connection (`scripts/fetch_prices.py`, using `curl_cffi`) and caches the daily and hourly history between runs so each update makes only a handful of requests. If Yahoo still refuses, the app falls back to Stooq daily data and says so on screen (fewer levels: no overnight, VWAP or volume-profile levels). Free quotes can lag your broker's feed by several minutes; each market shows its quote time. Around contract rolls, prior-day levels can be off by the roll spread for a session.
- **Timing**: GitHub starts scheduled runs late under load, sometimes by 15+ minutes. The header turns amber after 15 minutes and red after 40. Use *Start update* if needed.
- **Inactivity**: GitHub disables schedules in public repos with no repository activity for 60 days. The workflow commits a timestamp to `.github/keepalive` when the last commit is 50 days old, which should keep it active. If it ever does get paused, GitHub emails you; click *Enable workflow* in the Actions tab.
- **Uptime**: the page itself is static and stays online around the clock on GitHub Pages; only the data refreshes on the schedule. Pages limits are 1 GB per site and a soft 100 GB of bandwidth per month, far above what one person uses. Anyone with the link can open it, but repository secrets (API keys, push topics) never reach the page.
- **Feeds** occasionally block or change. Failures are skipped and listed in *Settings → Feed health*; edit the list in `scripts/config.mjs`.
- **News scoring** is rule-based on headlines. It surfaces direction and impact fast but cannot read nuance the way a person can; the "Why it matters" line shows which rule fired so you can judge it.

## Customize

`scripts/config.mjs` holds the instruments (add M6E, MHG, etc. with their Yahoo symbol, tick, $/point and day session), feeds, Google News topics and thresholds.

## Run locally

```bash
npm run sample   # offline: synthetic data through the real pipeline -> dist/
npm run serve    # http://localhost:8080
npm test         # offline checks
npm run update   # live data (needs internet)
```

Node 18.17+ and no dependencies.
