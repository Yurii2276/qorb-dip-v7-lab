const axios = require("axios");

const CONFIG = {
  name: "BTC_RTY_DIP_V7_3D",
  asset: "BTC-USDT",
  indexSymbol: "RTY",
  yahoo: {
    RTY: "RTY=F",
    DXY: "DX-Y.NYB",
    GOLD: "GC=F",
  },
  indexDropMax: -1.0,
  cryptoDipLookback: 2,
  cryptoDipMax: -2.5,
  dxyMax: 1.0,
  goldMin: -2.0,
  holdDays: 3,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dateKeyFromUnix(sec) {
  return new Date(Number(sec) * 1000).toISOString().slice(0, 10);
}

function dateKeyFromMs(ms) {
  return new Date(Number(ms)).toISOString().slice(0, 10);
}

function pct(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return ((a / b) - 1) * 100;
}

function round(n, d = 3) {
  if (!Number.isFinite(n)) return "N/A";
  return Number(n).toFixed(d);
}

function toMap(rows) {
  const m = new Map();
  for (const r of rows) {
    m.set(r.date, r);
  }
  return m;
}

async function fetchYahooDaily(symbol, daysBack = 120) {
  const period1 = Math.floor((Date.now() - daysBack * 24 * 60 * 60 * 1000) / 1000);
  const period2 = Math.floor((Date.now() + 2 * 24 * 60 * 60 * 1000) / 1000);

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
  if (!result) throw new Error("No Yahoo data for " + symbol);

  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const adj = result.indicators?.adjclose?.[0]?.adjclose || [];

  const rows = [];

  for (let i = 0; i < timestamps.length; i++) {
    const close = Number(adj[i] || quote.close?.[i]);
    const open = Number(quote.open?.[i]);
    const high = Number(quote.high?.[i]);
    const low = Number(quote.low?.[i]);

    if (!Number.isFinite(close) || !Number.isFinite(open)) continue;

    rows.push({
      date: dateKeyFromUnix(timestamps[i]),
      open,
      high,
      low,
      close,
    });
  }

  rows.sort((a, b) => a.date.localeCompare(b.date));

  for (let i = 1; i < rows.length; i++) {
    rows[i].ret1 = pct(rows[i].close, rows[i - 1].close);
  }

  return rows;
}

async function fetchOkxDaily(instId, limit = 120) {
  const res = await axios.get("https://www.okx.com/api/v5/market/history-candles", {
    timeout: 20000,
    params: {
      instId,
      bar: "1Dutc",
      limit: String(limit),
    },
    headers: {
      "User-Agent": "Mozilla/5.0",
    },
  });

  const data = res.data?.data || [];

  const rows = data
    .map((row) => ({
      ts: Number(row[0]),
      date: dateKeyFromMs(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
    }))
    .filter((x) => Number.isFinite(x.close))
    .sort((a, b) => a.date.localeCompare(b.date));

  for (let i = 1; i < rows.length; i++) {
    rows[i].ret1 = pct(rows[i].close, rows[i - 1].close);
  }

  return rows;
}

function latestCommonClosedDate(maps) {
  const todayUTC = new Date().toISOString().slice(0, 10);

  const dateSets = Object.values(maps).map((m) => {
    return new Set(
      [...m.keys()].filter((d) => d < todayUTC)
    );
  });

  const common = [...dateSets[0]]
    .filter((d) => dateSets.every((s) => s.has(d)))
    .sort();

  if (common.length < 3) {
    throw new Error("Not enough common closed dates");
  }

  return common[common.length - 1];
}

function getCryptoDip(cryptoRows, date, lookback) {
  const i = cryptoRows.findIndex((r) => r.date === date);
  if (i < lookback) return null;

  const now = cryptoRows[i];
  const prev = cryptoRows[i - lookback];

  return pct(now.close, prev.close);
}

async function main() {
  console.log("========================================");
  console.log("QORB DIP CURRENT CHECK v7.3");
  console.log("Research / Telegram signal mode only.");
  console.log("No live orders.");
  console.log("========================================");

  console.log("Config:", CONFIG.name);
  console.log("Asset:", CONFIG.asset);
  console.log("Index:", CONFIG.indexSymbol);
  console.log("");

  const rty = await fetchYahooDaily(CONFIG.yahoo.RTY);
  await sleep(200);

  const dxy = await fetchYahooDaily(CONFIG.yahoo.DXY);
  await sleep(200);

  const gold = await fetchYahooDaily(CONFIG.yahoo.GOLD);
  await sleep(200);

  const btc = await fetchOkxDaily(CONFIG.asset);

  const maps = {
    RTY: toMap(rty),
    DXY: toMap(dxy),
    GOLD: toMap(gold),
    BTC: toMap(btc),
  };

  const signalDate = latestCommonClosedDate(maps);

  const rtyRow = maps.RTY.get(signalDate);
  const dxyRow = maps.DXY.get(signalDate);
  const goldRow = maps.GOLD.get(signalDate);
  const btcRow = maps.BTC.get(signalDate);

  const cryptoDip = getCryptoDip(btc, signalDate, CONFIG.cryptoDipLookback);

  if (
    !Number.isFinite(rtyRow?.ret1) ||
    !Number.isFinite(dxyRow?.ret1) ||
    !Number.isFinite(goldRow?.ret1) ||
    !Number.isFinite(cryptoDip)
  ) {
    throw new Error("Bad data for signal date " + signalDate);
  }

  const indexOk = rtyRow.ret1 <= CONFIG.indexDropMax;
  const cryptoOk = cryptoDip <= CONFIG.cryptoDipMax;
  const dxyOk = dxyRow.ret1 <= CONFIG.dxyMax;
  const goldOk = goldRow.ret1 >= CONFIG.goldMin;

  const signal = indexOk && cryptoOk && dxyOk && goldOk;

  console.log("Signal date:", signalDate);
  console.log("BTC close:", round(btcRow.close, 2));
  console.log("");
  console.log("RULES");
  console.log("RTY <=", CONFIG.indexDropMax + "%");
  console.log("BTC dip", CONFIG.cryptoDipLookback + "D <=", CONFIG.cryptoDipMax + "%");
  console.log("DXY <=", CONFIG.dxyMax + "%");
  console.log("Gold >=", CONFIG.goldMin + "%");
  console.log("Hold days:", CONFIG.holdDays);
  console.log("");
  console.log("CURRENT VALUES");
  console.log("RTY:", round(rtyRow.ret1, 3) + "%", indexOk ? "PASS" : "FAIL");
  console.log("BTC dip:", round(cryptoDip, 3) + "%", cryptoOk ? "PASS" : "FAIL");
  console.log("DXY:", round(dxyRow.ret1, 3) + "%", dxyOk ? "PASS" : "FAIL");
  console.log("Gold:", round(goldRow.ret1, 3) + "%", goldOk ? "PASS" : "FAIL");
  console.log("");

  if (signal) {
    console.log("STATUS: PAPER_SIGNAL");
    console.log("ACTION: BTC DIP SETUP DETECTED");
    console.log("Planned paper hold:", CONFIG.holdDays, "days");
  } else {
    console.log("STATUS: WAIT");
    console.log("ACTION: NO PAPER SIGNAL");
  }

  console.log("========================================");
}

main().catch((err) => {
  console.error("FATAL ERROR:", err.message);
  if (err.response?.data) {
    console.error(JSON.stringify(err.response.data, null, 2));
  }
  process.exit(1);
});