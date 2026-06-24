const axios = require("axios");
const fs = require("fs");
const http = require("http");

const HEALTH_PORT = process.env.PORT || 3000;
const CHECK_INTERVAL_MINUTES = Number(process.env.CHECK_INTERVAL_MINUTES || 360);
const STATE_FILE = "qorb_dip_live_state.json";

http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("QORB DIP v7 bot is running\n");
  })
  .listen(HEALTH_PORT, "0.0.0.0", () => {
    console.log("Health server listening on port " + HEALTH_PORT);
  });

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

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return {};
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (e) {
    return {};
  }
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error("State save failed:", e.message);
  }
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log("Telegram not configured. Message not sent.");
    return;
  }

  await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });

  console.log("Telegram message sent.");
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

  if (!result) {
    throw new Error("No Yahoo data for " + symbol);
  }

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
    return new Set([...m.keys()].filter((d) => d < todayUTC));
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

function buildMessage(result) {
  const statusEmoji = result.signal ? "🟢" : "⚪";

  return [
    `${statusEmoji} <b>QORB DIP v7</b>`,
    ``,
    `<b>Status:</b> ${result.signal ? "PAPER_SIGNAL" : "WAIT"}`,
    `<b>Action:</b> ${result.signal ? "BTC DIP SETUP DETECTED" : "NO PAPER SIGNAL"}`,
    ``,
    `<b>Signal date:</b> ${result.signalDate}`,
    `<b>BTC close:</b> ${round(result.btcClose, 2)}`,
    ``,
    `<b>Rules</b>`,
    `RTY ≤ ${CONFIG.indexDropMax}%`,
    `BTC dip ${CONFIG.cryptoDipLookback}D ≤ ${CONFIG.cryptoDipMax}%`,
    `DXY ≤ ${CONFIG.dxyMax}%`,
    `Gold ≥ ${CONFIG.goldMin}%`,
    `Paper hold: ${CONFIG.holdDays} days`,
    ``,
    `<b>Current values</b>`,
    `RTY: ${round(result.rtyRet, 3)}% ${result.indexOk ? "PASS" : "FAIL"}`,
    `BTC dip: ${round(result.cryptoDip, 3)}% ${result.cryptoOk ? "PASS" : "FAIL"}`,
    `DXY: ${round(result.dxyRet, 3)}% ${result.dxyOk ? "PASS" : "FAIL"}`,
    `Gold: ${round(result.goldRet, 3)}% ${result.goldOk ? "PASS" : "FAIL"}`,
    ``,
    `Research / paper signal only. No live orders.`,
  ].join("\n");
}

async function checkSignal() {
  console.log("========================================");
  console.log("QORB DIP LIVE v7");
  console.log("Telegram paper signal mode only.");
  console.log("No live orders.");
  console.log("========================================");

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

  const result = {
    signalDate,
    btcClose: btcRow.close,
    rtyRet: rtyRow.ret1,
    dxyRet: dxyRow.ret1,
    goldRet: goldRow.ret1,
    cryptoDip,
    indexOk,
    cryptoOk,
    dxyOk,
    goldOk,
    signal,
  };

  console.log("Signal date:", result.signalDate);
  console.log("BTC close:", round(result.btcClose, 2));
  console.log("RTY:", round(result.rtyRet, 3) + "%", result.indexOk ? "PASS" : "FAIL");
  console.log("BTC dip:", round(result.cryptoDip, 3) + "%", result.cryptoOk ? "PASS" : "FAIL");
  console.log("DXY:", round(result.dxyRet, 3) + "%", result.dxyOk ? "PASS" : "FAIL");
  console.log("Gold:", round(result.goldRet, 3) + "%", result.goldOk ? "PASS" : "FAIL");
  console.log("STATUS:", result.signal ? "PAPER_SIGNAL" : "WAIT");

  const shouldSendStatus = process.env.SEND_STATUS_TELEGRAM === "1";
  const state = loadState();
  const telegramKey = result.signalDate + ":" + (result.signal ? "SIGNAL" : "WAIT");

  const shouldSend =
    state.lastTelegramKey !== telegramKey &&
    (result.signal || shouldSendStatus);

  if (shouldSend) {
    await sendTelegram(buildMessage(result));
    state.lastTelegramKey = telegramKey;
    state.lastRunAt = new Date().toISOString();
    saveState(state);
  } else {
    console.log("Telegram skipped. No new signal/status for this signal date.");
  }

  console.log("========================================");

  return result;
}


async function runOnce() {
  try {
    await checkSignal();
  } catch (err) {
    console.error("FATAL ERROR:", err.message);

    try {
      await sendTelegram(
        [
          "🔴 <b>QORB DIP v7 ERROR</b>",
          "",
          `<b>Error:</b> ${err.message}`,
          "",
          "Research / paper signal only.",
        ].join("\n")
      );
    } catch (e) {
      console.error("Telegram error notification failed:", e.message);
    }
  }
}

async function mainLoop() {
  await runOnce();

  if (process.env.RUN_ONCE === "1") {
    console.log("RUN_ONCE=1. Exiting after one check.");
    return;
  }

  const intervalMs = CHECK_INTERVAL_MINUTES * 60 * 1000;

  console.log("Next check in", CHECK_INTERVAL_MINUTES, "minutes.");

  setInterval(runOnce, intervalMs);
}

mainLoop();
