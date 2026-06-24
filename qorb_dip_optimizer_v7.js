const axios = require("axios");
const fs = require("fs");

const START_DATE = "2023-01-01";
const OOS_DATE = "2025-01-01";
const START_BALANCE = 1000;
const ROUND_TRIP_FEE_PCT = 0.2;

const YAHOO_SYMBOLS = {
  ES: "ES=F",
  NQ: "NQ=F",
  RTY: "RTY=F",
  DXY: "DX-Y.NYB",
  GOLD: "GC=F",
};

const CRYPTO_ASSETS = ["ETH-USDT", "BTC-USDT", "SOL-USDT"];

const INDEX_MODES = ["ES", "NQ", "ES_OR_NQ", "RTY"];
const INDEX_DROP_THRESHOLDS = [-0.8, -1.0, -1.5, -2.0, -2.5];

const CRYPTO_DIP_LOOKBACKS = [1, 2, 3];
const CRYPTO_DIP_THRESHOLDS = [-2.5, -3.5, -5.0, -7.0, -10.0];

const DXY_MAX_THRESHOLDS = [0.3, 0.6, 1.0, 99];
const GOLD_MIN_THRESHOLDS = [-3.0, -2.0, -1.0, -99];

const REBOUND_MODES = [
  "NONE",
  "GREEN_DAY",
  "CLOSE_ABOVE_PREV_CLOSE",
  "WICK_RECOVERY",
];

const HOLD_DAYS = [2, 3, 5];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dateKeyFromMs(ms) {
  return new Date(Number(ms)).toISOString().slice(0, 10);
}

function dateKeyFromUnix(sec) {
  return new Date(Number(sec) * 1000).toISOString().slice(0, 10);
}

function pct(a, b) {
  if (!a || !b) return null;
  return ((a / b) - 1) * 100;
}

function round(n, d = 3) {
  if (n === null || n === undefined || Number.isNaN(n)) return "";
  return Number(n).toFixed(d);
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function calcStats(trades) {
  if (!trades.length) {
    return {
      trades: 0,
      wins: 0,
      losses: 0,
      winrate: 0,
      avg: 0,
      median: 0,
      best: 0,
      worst: 0,
      pf: 0,
      totalReturn: 0,
      finalBalance: START_BALANCE,
      maxDD: 0,
    };
  }

  let balance = START_BALANCE;
  let peak = START_BALANCE;
  let maxDD = 0;

  let wins = 0;
  let losses = 0;
  let winSum = 0;
  let lossSum = 0;

  const returns = [];

  for (const t of trades) {
    const r = t.netPct;
    returns.push(r);

    if (r > 0) {
      wins++;
      winSum += r;
    } else {
      losses++;
      lossSum += Math.abs(r);
    }

    balance *= 1 + r / 100;

    if (balance > peak) peak = balance;

    const dd = ((balance / peak) - 1) * 100;
    if (dd < maxDD) maxDD = dd;
  }

  const totalReturn = ((balance / START_BALANCE) - 1) * 100;
  const avg = returns.reduce((a, b) => a + b, 0) / returns.length;
  const pf = lossSum === 0 ? 999 : winSum / lossSum;

  return {
    trades: trades.length,
    wins,
    losses,
    winrate: (wins / trades.length) * 100,
    avg,
    median: median(returns),
    best: Math.max(...returns),
    worst: Math.min(...returns),
    pf,
    totalReturn,
    finalBalance: balance,
    maxDD,
  };
}

async function fetchYahooDaily(symbol) {
  const period1 = Math.floor(new Date(START_DATE + "T00:00:00Z").getTime() / 1000);
  const period2 = Math.floor((Date.now() + 3 * 24 * 60 * 60 * 1000) / 1000);

  const url =
    "https://query1.finance.yahoo.com/v8/finance/chart/" +
    encodeURIComponent(symbol);

  const res = await axios.get(url, {
    timeout: 20000,
    params: {
      period1,
      period2,
      interval: "1d",
      events: "history",
      includeAdjustedClose: "true",
    },
    headers: {
      "User-Agent": "Mozilla/5.0",
    },
  });

  const result = res.data?.chart?.result?.[0];

  if (!result) {
    throw new Error("No Yahoo data for " + symbol);
  }

  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const adj = result.indicators?.adjclose?.[0]?.adjclose || [];

  const out = [];

  for (let i = 0; i < timestamps.length; i++) {
    const close = Number(adj[i] || quote.close?.[i]);
    const open = Number(quote.open?.[i]);
    const high = Number(quote.high?.[i]);
    const low = Number(quote.low?.[i]);

    if (!Number.isFinite(close) || !Number.isFinite(open)) continue;

    out.push({
      date: dateKeyFromUnix(timestamps[i]),
      open,
      high,
      low,
      close,
    });
  }

  out.sort((a, b) => a.date.localeCompare(b.date));

  for (let i = 1; i < out.length; i++) {
    out[i].ret1 = pct(out[i].close, out[i - 1].close);
  }

  return out;
}

async function fetchOkxDaily(instId) {
  let all = [];
  let after = undefined;
  let lastOldest = null;

  for (let page = 0; page < 20; page++) {
    const params = {
      instId,
      bar: "1Dutc",
      limit: "100",
    };

    if (after) params.after = after;

    const res = await axios.get("https://www.okx.com/api/v5/market/history-candles", {
      timeout: 20000,
      params,
      headers: {
        "User-Agent": "Mozilla/5.0",
      },
    });

    const data = res.data?.data || [];

    if (!data.length) break;

    for (const row of data) {
      all.push({
        ts: Number(row[0]),
        date: dateKeyFromMs(row[0]),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
      });
    }

    const oldest = Math.min(...data.map((r) => Number(r[0])));

    if (oldest === lastOldest) break;

    lastOldest = oldest;
    after = String(oldest);

    if (oldest < new Date(START_DATE + "T00:00:00Z").getTime()) break;

    await sleep(120);
  }

  const map = new Map();

  for (const c of all) {
    if (!map.has(c.date)) map.set(c.date, c);
  }

  const out = [...map.values()]
    .filter((x) => x.date >= START_DATE)
    .sort((a, b) => a.date.localeCompare(b.date));

  for (let i = 1; i < out.length; i++) {
    out[i].ret1 = pct(out[i].close, out[i - 1].close);
  }

  return out;
}

function toMap(arr) {
  const m = new Map();

  for (const x of arr) {
    m.set(x.date, x);
  }

  return m;
}

function getIndexRet(mode, date, maps) {
  const es = maps.ES.get(date)?.ret1;
  const nq = maps.NQ.get(date)?.ret1;
  const rty = maps.RTY.get(date)?.ret1;

  if (mode === "ES") return es;
  if (mode === "NQ") return nq;
  if (mode === "RTY") return rty;

  if (mode === "ES_OR_NQ") {
    const values = [es, nq].filter((v) => Number.isFinite(v));
    if (!values.length) return null;
    return Math.min(...values);
  }

  return null;
}

function cryptoDipPct(candles, i, lookback) {
  if (i - lookback < 0) return null;
  return pct(candles[i].close, candles[i - lookback].close);
}

function reboundPass(mode, candles, i) {
  const c = candles[i];
  const prev = candles[i - 1];

  if (!c || !prev) return false;

  if (mode === "NONE") return true;

  if (mode === "GREEN_DAY") {
    return c.close > c.open;
  }

  if (mode === "CLOSE_ABOVE_PREV_CLOSE") {
    return c.close > prev.close;
  }

  if (mode === "WICK_RECOVERY") {
    const range = c.high - c.low;

    if (range <= 0) return false;

    const closePos = (c.close - c.low) / range;

    return c.close > c.open && closePos >= 0.6;
  }

  return false;
}

function simulateStrategy(config, data) {
  const candles = data.crypto[config.asset];
  const trades = [];

  let lastExitIndex = -1;

  for (let i = 5; i < candles.length - config.holdDays; i++) {
    if (i <= lastExitIndex) continue;

    const c = candles[i];
    const date = c.date;

    const idxRet = getIndexRet(config.indexMode, date, data.maps);
    const dxyRet = data.maps.DXY.get(date)?.ret1;
    const goldRet = data.maps.GOLD.get(date)?.ret1;

    if (!Number.isFinite(idxRet)) continue;
    if (!Number.isFinite(dxyRet)) continue;
    if (!Number.isFinite(goldRet)) continue;

    const dip = cryptoDipPct(candles, i, config.cryptoDipLookback);

    if (dip === null) continue;

    const indexOk = idxRet <= config.indexDrop;
    const cryptoDipOk = dip <= config.cryptoDip;
    const dxyOk = dxyRet <= config.dxyMax;
    const goldOk = goldRet >= config.goldMin;
    const rebOk = reboundPass(config.reboundMode, candles, i);

    if (!indexOk || !cryptoDipOk || !dxyOk || !goldOk || !rebOk) continue;

    const exitIndex = i + config.holdDays;
    const exit = candles[exitIndex];

    const grossPct = pct(exit.close, c.close);
    const netPct = grossPct - ROUND_TRIP_FEE_PCT;

    trades.push({
      asset: config.asset,
      entryDate: c.date,
      exitDate: exit.date,
      entry: c.close,
      exit: exit.close,
      grossPct,
      netPct,
      idxRet,
      dxyRet,
      goldRet,
      dip,
      holdDays: config.holdDays,
      indexMode: config.indexMode,
      indexDrop: config.indexDrop,
      cryptoDipLookback: config.cryptoDipLookback,
      cryptoDip: config.cryptoDip,
      reboundMode: config.reboundMode,
    });

    lastExitIndex = exitIndex;
  }

  return trades;
}

function configName(c) {
  return [
    c.asset,
    c.indexMode,
    "IDX<=" + c.indexDrop,
    "DIP" + c.cryptoDipLookback + "D<=" + c.cryptoDip,
    "DXY<=" + c.dxyMax,
    "GOLD>=" + c.goldMin,
    c.reboundMode,
    "HOLD" + c.holdDays,
  ].join("_");
}

function scoreResult(r) {
  if (r.oos.trades < 8) return -999999;
  if (r.all.trades < 15) return -999999;

  return (
    r.oos.totalReturn * 1.0 +
    r.oos.pf * 8 +
    r.oos.winrate * 0.15 +
    r.oos.median * 5 +
    r.oos.maxDD * 1.2
  );
}

function csvEscape(v) {
  if (v === null || v === undefined) return "";

  const s = String(v);

  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }

  return s;
}

function writeCsv(filename, rows) {
  if (!rows.length) {
    fs.writeFileSync(filename, "");
    return;
  }

  const headers = Object.keys(rows[0]);

  const lines = [
    headers.join(","),
    ...rows.map((r) => headers.map((h) => csvEscape(r[h])).join(",")),
  ];

  fs.writeFileSync(filename, lines.join("\n"));
}

async function main() {
  console.log("========================================");
  console.log("QORB DIP OPTIMIZER v7.1");
  console.log("Research mode only. No live orders.");
  console.log("Start date:", START_DATE);
  console.log("OOS date:", OOS_DATE);
  console.log("========================================");

  console.log("\nDownloading Yahoo macro/index data...");

  const yahoo = {};

  for (const [key, symbol] of Object.entries(YAHOO_SYMBOLS)) {
    yahoo[key] = await fetchYahooDaily(symbol);
    console.log(key, symbol, "candles:", yahoo[key].length);
    await sleep(200);
  }

  console.log("\nDownloading OKX crypto data...");

  const crypto = {};

  for (const asset of CRYPTO_ASSETS) {
    crypto[asset] = await fetchOkxDaily(asset);
    console.log(asset, "candles:", crypto[asset].length);
    await sleep(200);
  }

  const maps = {};

  for (const [key, arr] of Object.entries(yahoo)) {
    maps[key] = toMap(arr);
  }

  const data = { maps, crypto };

  const results = [];

  let tested = 0;

  for (const asset of CRYPTO_ASSETS) {
    for (const indexMode of INDEX_MODES) {
      for (const indexDrop of INDEX_DROP_THRESHOLDS) {
        for (const cryptoDipLookback of CRYPTO_DIP_LOOKBACKS) {
          for (const cryptoDip of CRYPTO_DIP_THRESHOLDS) {
            for (const dxyMax of DXY_MAX_THRESHOLDS) {
              for (const goldMin of GOLD_MIN_THRESHOLDS) {
                for (const reboundMode of REBOUND_MODES) {
                  for (const holdDays of HOLD_DAYS) {
                    const config = {
                      asset,
                      indexMode,
                      indexDrop,
                      cryptoDipLookback,
                      cryptoDip,
                      dxyMax,
                      goldMin,
                      reboundMode,
                      holdDays,
                    };

                    tested++;

                    const trades = simulateStrategy(config, data);
                    const oosTrades = trades.filter((t) => t.entryDate >= OOS_DATE);

                    const allStats = calcStats(trades);
                    const oosStats = calcStats(oosTrades);

                    if (allStats.trades < 10 || oosStats.trades < 5) continue;

                    const result = {
                      config: configName(config),
                      ...config,
                      all: allStats,
                      oos: oosStats,
                      score: 0,
                      trades,
                      oosTrades,
                    };

                    result.score = scoreResult(result);

                    results.push(result);
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  results.sort((a, b) => b.score - a.score);

  const rows = results.map((r) => ({
    config: r.config,
    asset: r.asset,
    indexMode: r.indexMode,
    indexDrop: r.indexDrop,
    cryptoDipLookback: r.cryptoDipLookback,
    cryptoDip: r.cryptoDip,
    dxyMax: r.dxyMax,
    goldMin: r.goldMin,
    reboundMode: r.reboundMode,
    holdDays: r.holdDays,

    allTrades: r.all.trades,
    allWinrate: round(r.all.winrate, 2),
    allPF: round(r.all.pf, 3),
    allAvg: round(r.all.avg, 3),
    allMedian: round(r.all.median, 3),
    allReturn: round(r.all.totalReturn, 2),
    allMaxDD: round(r.all.maxDD, 2),
    allWorst: round(r.all.worst, 2),

    oosTrades: r.oos.trades,
    oosWinrate: round(r.oos.winrate, 2),
    oosPF: round(r.oos.pf, 3),
    oosAvg: round(r.oos.avg, 3),
    oosMedian: round(r.oos.median, 3),
    oosReturn: round(r.oos.totalReturn, 2),
    oosMaxDD: round(r.oos.maxDD, 2),
    oosWorst: round(r.oos.worst, 2),
    score: round(r.score, 3),
  }));

  writeCsv("qorb_dip_v7_results.csv", rows);

  const top = results.slice(0, 20);

  const tradeRows = [];

  for (const r of top.slice(0, 5)) {
    for (const t of r.oosTrades) {
      tradeRows.push({
        config: r.config,
        asset: t.asset,
        entryDate: t.entryDate,
        exitDate: t.exitDate,
        entry: round(t.entry, 4),
        exit: round(t.exit, 4),
        grossPct: round(t.grossPct, 3),
        netPct: round(t.netPct, 3),
        idxRet: round(t.idxRet, 3),
        dxyRet: round(t.dxyRet, 3),
        goldRet: round(t.goldRet, 3),
        dip: round(t.dip, 3),
        reboundMode: t.reboundMode,
        holdDays: t.holdDays,
      });
    }
  }

  writeCsv("qorb_dip_v7_top_trades.csv", tradeRows);

  console.log("\n========================================");
  console.log("TESTED CONFIGS:", tested);
  console.log("VALID CONFIGS:", results.length);
  console.log("Saved:");
  console.log("qorb_dip_v7_results.csv");
  console.log("qorb_dip_v7_top_trades.csv");
  console.log("========================================");

  console.log("\nTOP 20 DIP STRATEGIES BY OOS SCORE");
  console.log("========================================");

  top.forEach((r, idx) => {
    console.log(`\n#${idx + 1}`);
    console.log("Config:", r.config);
    console.log("Asset:", r.asset);
    console.log("Index:", r.indexMode, "| indexDrop <=", r.indexDrop + "%");

    console.log(
      "Crypto dip:",
      r.cryptoDipLookback + "D <=",
      r.cryptoDip + "%"
    );

    console.log("DXY <=", r.dxyMax + "%", "| Gold >=", r.goldMin + "%");
    console.log("Rebound:", r.reboundMode, "| Hold:", r.holdDays, "days");

    console.log("ALL:");

    console.log(
      "Trades:",
      r.all.trades,
      "| WR:",
      round(r.all.winrate, 2) + "%",
      "| PF:",
      round(r.all.pf, 3),
      "| Return:",
      round(r.all.totalReturn, 2) + "%",
      "| MaxDD:",
      round(r.all.maxDD, 2) + "%",
      "| Median:",
      round(r.all.median, 3) + "%"
    );

    console.log("OOS:");

    console.log(
      "Trades:",
      r.oos.trades,
      "| WR:",
      round(r.oos.winrate, 2) + "%",
      "| PF:",
      round(r.oos.pf, 3),
      "| Return:",
      round(r.oos.totalReturn, 2) + "%",
      "| MaxDD:",
      round(r.oos.maxDD, 2) + "%",
      "| Median:",
      round(r.oos.median, 3) + "%",
      "| Worst:",
      round(r.oos.worst, 2) + "%"
    );
  });

  console.log("\nNEXT STEP:");
  console.log("Send me the terminal output and qorb_dip_v7_results.csv if needed.");
}

main().catch((err) => {
  console.error("FATAL ERROR:", err.message);

  if (err.response?.data) {
    console.error(JSON.stringify(err.response.data, null, 2));
  }

  process.exit(1);
});