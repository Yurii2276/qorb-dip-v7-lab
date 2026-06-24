const fs = require("fs");

const FILE = "qorb_dip_v7_results.csv";

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines[0].split(",");

  return lines.slice(1).map((line) => {
    const values = line.split(",");
    const row = {};
    headers.forEach((h, i) => {
      row[h] = values[i];
    });
    return row;
  });
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function goodNumber(v) {
  return Number.isFinite(Number(v));
}

function key(row) {
  return [
    row.asset,
    row.indexMode,
    row.indexDrop,
    row.cryptoDipLookback,
    row.cryptoDip,
    row.reboundMode,
    row.holdDays,
  ].join("|");
}

function printRow(row, index) {
  console.log(`\n#${index}`);
  console.log("Config:", row.config);
  console.log("Asset:", row.asset);
  console.log(
    "Index:",
    row.indexMode,
    "| indexDrop <=",
    row.indexDrop + "%"
  );
  console.log(
    "Crypto dip:",
    row.cryptoDipLookback + "D <=",
    row.cryptoDip + "%"
  );
  console.log("DXY <=", row.dxyMax + "%", "| Gold >=", row.goldMin + "%");
  console.log("Rebound:", row.reboundMode, "| Hold:", row.holdDays, "days");

  console.log("ALL:");
  console.log(
    "Trades:",
    row.allTrades,
    "| WR:",
    row.allWinrate + "%",
    "| PF:",
    row.allPF,
    "| Return:",
    row.allReturn + "%",
    "| MaxDD:",
    row.allMaxDD + "%",
    "| Worst:",
    row.allWorst + "%"
  );

  console.log("OOS:");
  console.log(
    "Trades:",
    row.oosTrades,
    "| WR:",
    row.oosWinrate + "%",
    "| PF:",
    row.oosPF,
    "| Return:",
    row.oosReturn + "%",
    "| MaxDD:",
    row.oosMaxDD + "%",
    "| Worst:",
    row.oosWorst + "%"
  );
}

function main() {
  if (!fs.existsSync(FILE)) {
    console.error("File not found:", FILE);
    console.error("Run npm start first.");
    process.exit(1);
  }

  const rows = parseCSV(fs.readFileSync(FILE, "utf8"));

  console.log("========================================");
  console.log("QORB DIP VALIDATOR v7.2");
  console.log("Input:", FILE);
  console.log("Rows:", rows.length);
  console.log("========================================");

  const clean = rows.filter((r) => {
    if (!goodNumber(r.allTrades)) return false;
    if (!goodNumber(r.oosTrades)) return false;
    if (!goodNumber(r.allPF)) return false;
    if (!goodNumber(r.oosPF)) return false;
    if (!goodNumber(r.allReturn)) return false;
    if (!goodNumber(r.oosReturn)) return false;
    if (!goodNumber(r.allMaxDD)) return false;
    if (!goodNumber(r.oosMaxDD)) return false;

    // прибираємо фактично вимкнені фільтри
    if (Number(r.dxyMax) >= 99) return false;
    if (Number(r.goldMin) <= -99) return false;

    return true;
  });

  const robust = clean.filter((r) => {
    return (
      num(r.allTrades) >= 15 &&
      num(r.oosTrades) >= 8 &&
      num(r.allPF) >= 1.5 &&
      num(r.oosPF) >= 1.4 &&
      num(r.allReturn) > 0 &&
      num(r.oosReturn) > 0 &&
      num(r.allMaxDD) >= -25 &&
      num(r.oosMaxDD) >= -10 &&
      num(r.oosWorst) >= -8
    );
  });

  robust.sort((a, b) => {
    const scoreA =
      num(a.oosReturn) * 1.0 +
      num(a.oosPF) * 5 +
      num(a.oosWinrate) * 0.15 +
      num(a.allPF) * 5 +
      num(a.allReturn) * 0.4 +
      num(a.allMaxDD) * 0.8;

    const scoreB =
      num(b.oosReturn) * 1.0 +
      num(b.oosPF) * 5 +
      num(b.oosWinrate) * 0.15 +
      num(b.allPF) * 5 +
      num(b.allReturn) * 0.4 +
      num(b.allMaxDD) * 0.8;

    return scoreB - scoreA;
  });

  const unique = [];
  const seen = new Set();

  for (const r of robust) {
    const k = key(r);
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(r);
  }

  console.log("\nROBUST UNIQUE TOP 20");
  console.log("========================================");
  unique.slice(0, 20).forEach((r, i) => printRow(r, i + 1));

  const reboundOnly = unique.filter((r) => r.reboundMode !== "NONE");

  console.log("\nREBOUND ONLY TOP 20");
  console.log("========================================");

  if (!reboundOnly.length) {
    console.log("No robust rebound strategies found.");
    console.log("This means current best results come from pure dip logic, without rebound confirmation.");
  } else {
    reboundOnly.slice(0, 20).forEach((r, i) => printRow(r, i + 1));
  }

  console.log("\nSUMMARY");
  console.log("========================================");
  console.log("Clean rows:", clean.length);
  console.log("Robust rows:", robust.length);
  console.log("Unique robust rows:", unique.length);
  console.log("Rebound robust rows:", reboundOnly.length);
}

main();