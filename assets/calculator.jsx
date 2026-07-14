// ==================================================================
// RENTAL CALCULATOR
// Long-Term / Short-Term rental investment analysis.
// Loaded as a plain browser script (Babel standalone) — no build step.
// Depends on globals: React, ReactDOM, Recharts.
// ==================================================================

const { useState, useMemo } = React;
const {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine
} = Recharts;

const C = {
  navy: "#2E2013",
  navyDeep: "#1C1309",
  steel: "#9C7A42",
  steelLight: "#CBAD79",
  green: "#3E5C43",
  greenBright: "#4F7350",
  amber: "#B68A3E",
  red: "#A6453B",
  paper: "#F4EDDC",
  card: "#FBF7EC",
  ink: "#2E2013",
  inkSoft: "#6B5A44",
  line: "#DFCBA0",
};

const fmt$ = (v, dec = 0) =>
  (v < 0 ? "-$" : "$") +
  Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: dec, minimumFractionDigits: dec });
const fmtPct = (v, dec = 2) => `${v.toFixed(dec)}%`;

// ------------------------------------------------------------------
// Financial math
// ------------------------------------------------------------------
function monthlyPayment(principal, annualRatePct, years) {
  const n = Math.round(years * 12);
  const r = annualRatePct / 100 / 12;
  if (n <= 0 || principal <= 0) return 0;
  if (r === 0) return principal / n;
  return (principal * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
}

function amortize(balance, annualRatePct, pmt, horizonYears) {
  const r = annualRatePct / 100 / 12;
  let bal = balance;
  const years = [];
  for (let y = 1; y <= horizonYears; y++) {
    let int = 0, prin = 0;
    for (let i = 0; i < 12; i++) {
      if (bal <= 0.005) break;
      const iPay = bal * r;
      let pPay = Math.min(Math.max(pmt - iPay, 0), bal);
      int += iPay;
      prin += pPay;
      bal -= pPay;
    }
    years.push({ interest: int, principal: prin, endBalance: Math.max(bal, 0) });
  }
  return years;
}

function irr(cashflows) {
  const npv = (rate) =>
    cashflows.reduce((acc, cf, i) => acc + cf / Math.pow(1 + rate, i), 0);
  let lo = -0.95, hi = 5;
  if (npv(lo) * npv(hi) > 0) return null;
  for (let i = 0; i < 120; i++) {
    const mid = (lo + hi) / 2;
    if (npv(lo) * npv(mid) <= 0) hi = mid; else lo = mid;
  }
  return ((lo + hi) / 2) * 100;
}

// ------------------------------------------------------------------
// Core projection engine, shared by both rental types.
// p = full parameter object; p.type = "ltr" | "str"
// ------------------------------------------------------------------
function buildModel(p) {
  const owned = p.mode === "own";
  const isSTR = p.type === "str";

  // --- Financing setup ---
  let loan, pmt, equity0, investedBase, investedLabel, depPrice;
  if (owned) {
    loan = p.currentBalance;
    const mortMonthlyInt = p.currentBalance * (p.ownRate / 100) / 12;
    pmt = p.pmtOverride > 0
      ? Math.max(p.pmtOverride, mortMonthlyInt)
      : monthlyPayment(p.currentBalance, p.ownRate, p.remainingTerm);
    equity0 = p.marketValue - p.currentBalance;
    investedBase = Math.max(p.marketValue * (1 - p.sellCostPct / 100) - p.currentBalance, 1);
    investedLabel = "equity at stake (net of sale costs)";
    depPrice = p.origPrice;
  } else {
    const down = p.price * (p.downPct / 100);
    loan = p.price - down;
    pmt = monthlyPayment(loan, p.buyRate, p.term);
    equity0 = p.marketValue - loan;
    investedBase = down + p.closingCosts + p.initialRepairs;
    investedLabel = "initial cash invested";
    depPrice = p.price;
  }
  if (isSTR) {
    // Furnishing is cash out of pocket either way
    investedBase += p.furnishing;
    investedLabel += " + furnishing";
  }

  const activeRate = owned ? p.ownRate : p.buyRate;
  const amort = amortize(loan, activeRate, pmt, p.hold);

  // --- HELOC layer (owned mode only) ---
  const helocOn = owned && p.hasHeloc && p.helocBalance > 0;
  let helocRows = [];
  let helocPmt = 0;
  if (helocOn) {
    const monthlyInt = p.helocBalance * (p.helocRate / 100) / 12;
    if (p.helocPmtOverride > 0) {
      helocPmt = Math.max(p.helocPmtOverride, monthlyInt);
      helocRows = amortize(p.helocBalance, p.helocRate, helocPmt, p.hold);
    } else if (p.helocIO) {
      helocPmt = monthlyInt;
      for (let y = 1; y <= p.hold; y++) {
        helocRows.push({ interest: p.helocBalance * (p.helocRate / 100), principal: 0, endBalance: p.helocBalance });
      }
    } else {
      helocPmt = monthlyPayment(p.helocBalance, p.helocRate, p.helocTerm);
      helocRows = amortize(p.helocBalance, p.helocRate, helocPmt, p.hold);
    }
    equity0 -= p.helocBalance;
    investedBase = Math.max(investedBase - p.helocBalance, 1);
  }
  const totalDebt0 = loan + (helocOn ? p.helocBalance : 0);

  // --- Depreciation ---
  const depBasis = depPrice * (1 - p.landPct / 100) + (owned ? 0 : p.initialRepairs);
  const annualDepBldg = depBasis / 27.5;
  const annualDepFurn = isSTR ? p.furnishing / 5 : 0; // 5-yr property

  // --- Income setup ---
  const Q_DAYS = [90, 91, 92, 92];
  let baseAnnualIncome, incomeGrowthPct, incomeCapAnnual;
  let strTurns = 0, strGuestFees0 = 0;
  if (isSTR) {
    let nightly = 0, nights = 0;
    for (let q = 0; q < 4; q++) {
      const booked = Q_DAYS[q] * (p.occ[q] / 100);
      nightly += booked * p.adr[q];
      nights += booked;
    }
    strTurns = p.avgStay > 0 ? nights / p.avgStay : 0;
    strGuestFees0 = strTurns * p.guestCleanFee;
    baseAnnualIncome = nightly + strGuestFees0;
    incomeGrowthPct = p.adrGrowth;
    incomeCapAnnual = p.strRevCap;
  } else {
    baseAnnualIncome = (p.rent + p.otherIncome) * 12;
    incomeGrowthPct = p.rentGrowth;
    incomeCapAnnual = p.rentCap * 12;
  }

  // --- Year-by-year projection ---
  const rows = [];
  let cumCF = 0, cumPrin = 0, cumTax = 0;
  let incomeY = baseAnnualIncome;
  let valueY = p.marketValue;
  for (let y = 1; y <= p.hold; y++) {
    if (y > 1) {
      if (p.ceilingOn && incomeY >= incomeCapAnnual) {
        incomeY *= 1 + p.postCapGrowth / 100;
      } else {
        incomeY *= 1 + incomeGrowthPct / 100;
        if (p.ceilingOn) incomeY = Math.min(incomeY, incomeCapAnnual);
      }
    }
    const grossIncome = incomeY;
    const expFactor = Math.pow(1 + p.expGrowth / 100, y - 1);

    let egi, opEx;
    if (isSTR) {
      egi = grossIncome; // occupancy already embeds vacancy
      const scale = baseAnnualIncome > 0 ? grossIncome / baseAnnualIncome : 1;
      const cleaning = strTurns * scale * p.cleanPerTurn * expFactor;
      const platform = grossIncome * (p.platformPct / 100);
      const mgmt = grossIncome * (p.mgmtPct / 100);
      const pctMaint = grossIncome * ((p.maintPct + p.capexPct + p.furnReservePct) / 100);
      const fixedExp = (p.propTax + p.insurance + (p.hoa + p.utilities + p.otherExp) * 12) * expFactor;
      opEx = cleaning + platform + mgmt + pctMaint + fixedExp;
    } else {
      egi = grossIncome * (1 - p.vacancy / 100);
      const fixedExp = (p.propTax + p.insurance + (p.hoa + p.utilities + p.otherExp) * 12) * expFactor;
      const pctExp = grossIncome * ((p.maintPct + p.capexPct) / 100) + egi * (p.mgmtPct / 100);
      opEx = fixedExp + pctExp;
    }
    const noi = egi - opEx;

    const a = amort[y - 1] || { interest: 0, principal: 0, endBalance: 0 };
    const h = helocOn
      ? (helocRows[y - 1] || { interest: 0, principal: 0, endBalance: 0 })
      : { interest: 0, principal: 0, endBalance: 0 };
    const debtService = a.interest + a.principal + h.interest + h.principal;
    const cashFlow = noi - debtService;

    const dep = (y <= 27.5 ? annualDepBldg : 0) + (y <= 5 ? annualDepFurn : 0);
    const deductibleInterest = a.interest + (p.deductHelocInt ? h.interest : 0);
    const taxableIncome = noi - deductibleInterest - dep;
    const taxImpact = -taxableIncome * (p.taxRate / 100);

    if (p.ceilingOn && valueY >= p.valueCap) {
      valueY *= 1 + p.postCapGrowth / 100;
    } else {
      valueY *= 1 + p.appreciation / 100;
      if (p.ceilingOn) valueY = Math.min(valueY, p.valueCap);
    }
    const value = valueY;
    const totalBalance = a.endBalance + h.endBalance;
    const equity = value - totalBalance;

    cumCF += cashFlow;
    cumPrin += a.principal + h.principal;
    cumTax += taxImpact;

    rows.push({
      year: y, grossIncome, egi, opEx, noi, debtService,
      principal: a.principal + h.principal, cashFlow,
      afterTaxCF: cashFlow + taxImpact,
      taxImpact, value, balance: totalBalance, equity,
      expenseRatio: grossIncome > 0 ? opEx / grossIncome * 100 : 0,
    });
  }

  const y1 = rows[0];
  const valueEnd = rows[p.hold - 1].value;
  const appreciationGain = valueEnd - p.marketValue;
  const saleCosts = valueEnd * (p.sellCostPct / 100);
  const netSaleProceeds = valueEnd - saleCosts - rows[p.hold - 1].balance;
  const sellTodayProceeds = p.marketValue * (1 - p.sellCostPct / 100) - totalDebt0;

  const capRate = y1.noi / p.marketValue * 100;
  const capRateOnPrice = owned ? null : y1.noi / p.price * 100;
  const coc = y1.cashFlow / investedBase * 100;
  const dscr = y1.debtService > 0 ? y1.noi / y1.debtService : Infinity;
  const grm = y1.grossIncome > 0 ? p.marketValue / y1.grossIncome : 0;
  const nim = y1.noi > 0 ? p.marketValue / y1.noi : 0;
  const roe = (y1.cashFlow + y1.principal) / Math.max(equity0, 1) * 100;

  const cfs = [-investedBase];
  for (let y = 1; y <= p.hold; y++) {
    let cf = p.includeTaxInIRR ? rows[y - 1].afterTaxCF : rows[y - 1].cashFlow;
    if (y === p.hold) cf += netSaleProceeds;
    cfs.push(cf);
  }
  const irrVal = irr(cfs);

  const totalReturn = cumCF + cumPrin + appreciationGain + cumTax;
  const combinedROI = totalReturn / investedBase * 100;
  const avgAnnualROI = combinedROI / p.hold;

  return {
    loan, pmt, equity0, investedBase, investedLabel, rows, y1,
    capRate, capRateOnPrice, coc, dscr, grm, nim, roe,
    cumCF, cumPrin, cumTax, appreciationGain, totalReturn, combinedROI, avgAnnualROI,
    irrVal, valueEnd, netSaleProceeds, sellTodayProceeds,
    annualDep: annualDepBldg + annualDepFurn,
    helocOn, helocPmt, totalDebt0,
  };
}

// ------------------------------------------------------------------
// UI primitives
// ------------------------------------------------------------------
function Field({ label, value, onChange, prefix, suffix, step = 1, min = 0, max, hint }) {
  return (
    <label style={{ display: "block", marginBottom: 14 }}>
      <div style={{
        fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase",
        color: C.inkSoft, marginBottom: 5, fontFamily: "'Libre Franklin', sans-serif",
      }}>
        {label}
      </div>
      <div style={{
        display: "flex", alignItems: "center", background: "#fff",
        border: `1px solid ${C.line}`, borderRadius: 6, overflow: "hidden",
      }}>
        {prefix && <span style={{ padding: "0 0 0 10px", color: C.inkSoft, fontSize: 14 }}>{prefix}</span>}
        <input
          type="number"
          value={value}
          step={step}
          min={min}
          max={max}
          onChange={(e) => onChange(e.target.value === "" ? 0 : parseFloat(e.target.value))}
          style={{
            flex: 1, minWidth: 0, border: "none", outline: "none", padding: "9px 10px",
            fontSize: 15, fontFamily: "'Spline Sans Mono', monospace", color: C.ink,
            background: "transparent",
          }}
        />
        {suffix && <span style={{ padding: "0 10px 0 0", color: C.inkSoft, fontSize: 13 }}>{suffix}</span>}
      </div>
      {hint && <div style={{ fontSize: 11, color: C.inkSoft, marginTop: 4 }}>{hint}</div>}
    </label>
  );
}

function Section({ title, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ borderBottom: `1px solid ${C.line}`, paddingBottom: open ? 6 : 0 }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          width: "100%", background: "none", border: "none", cursor: "pointer",
          display: "flex", justifyContent: "space-between", alignItems: "center",
          padding: "14px 0 12px", fontFamily: "'Libre Franklin', sans-serif",
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 700, color: C.navy, letterSpacing: "0.04em", textTransform: "uppercase" }}>
          {title}
        </span>
        <span style={{ color: C.steel, fontSize: 13 }}>{open ? "−" : "+"}</span>
      </button>
      {open && <div>{children}</div>}
    </div>
  );
}

function Metric({ label, value, sub, tone, big }) {
  const color = tone === "good" ? C.green : tone === "bad" ? C.red : tone === "warn" ? C.amber : C.navy;
  return (
    <div style={{
      background: C.card, border: `1px solid ${C.line}`, borderRadius: 8,
      padding: "14px 16px", flex: "1 1 150px", minWidth: 140,
    }}>
      <div style={{
        fontSize: 10.5, fontWeight: 600, letterSpacing: "0.07em", textTransform: "uppercase",
        color: C.inkSoft, marginBottom: 6,
      }}>{label}</div>
      <div style={{
        fontSize: big ? 26 : 21, fontWeight: 600, color,
        fontFamily: "'Spline Sans Mono', monospace", lineHeight: 1.1,
      }}>{value}</div>
      {sub && <div style={{ fontSize: 11.5, color: C.inkSoft, marginTop: 5, lineHeight: 1.35 }}>{sub}</div>}
    </div>
  );
}

// ------------------------------------------------------------------
// Main component
// ------------------------------------------------------------------
function RentalCalculator() {
  const [tab, setTab] = useState("ltr"); // "ltr" | "str"

  // --- Property & financing (shared by both sub-calculators) ---
  const [mode, setMode] = useState("buy"); // "buy" | "own"
  const owned = mode === "own";
  const [price, setPrice] = useState(300000);
  const [marketValue, setMarketValue] = useState(300000);
  const [downPct, setDownPct] = useState(20);
  const [buyRate, setBuyRate] = useState(7.0);
  const [term, setTerm] = useState(30);
  const [closingCosts, setClosingCosts] = useState(7500);
  const [initialRepairs, setInitialRepairs] = useState(0);
  const [currentBalance, setCurrentBalance] = useState(240000);
  const [ownRate, setOwnRate] = useState(6.5);
  const [remainingTerm, setRemainingTerm] = useState(27);
  const [pmtOverride, setPmtOverride] = useState(0);
  const [origPrice, setOrigPrice] = useState(300000);

  // --- HELOC ---
  const [hasHeloc, setHasHeloc] = useState(false);
  const [helocBalance, setHelocBalance] = useState(30000);
  const [helocRate, setHelocRate] = useState(8.5);
  const [helocIO, setHelocIO] = useState(true);
  const [helocTerm, setHelocTerm] = useState(15);
  const [helocPmtOverride, setHelocPmtOverride] = useState(0);
  const [deductHelocInt, setDeductHelocInt] = useState(true);

  // --- LTR income ---
  const [rent, setRent] = useState(2000);
  const [otherIncome, setOtherIncome] = useState(0);
  const [rentGrowth, setRentGrowth] = useState(3);
  const [vacancy, setVacancy] = useState(5);
  const [ltrMgmtPct, setLtrMgmtPct] = useState(10);

  // --- STR income (quarterly) ---
  const [occ, setOcc] = useState([45, 60, 75, 50]);
  const [adr, setAdr] = useState([150, 195, 240, 175]);
  const [adrGrowth, setAdrGrowth] = useState(3);
  const [avgStay, setAvgStay] = useState(3);
  const [guestCleanFee, setGuestCleanFee] = useState(100);
  const [cleanPerTurn, setCleanPerTurn] = useState(120);
  const [platformPct, setPlatformPct] = useState(3);
  const [strMgmtPct, setStrMgmtPct] = useState(20);
  const [furnishing, setFurnishing] = useState(25000);
  const [furnReservePct, setFurnReservePct] = useState(3);

  // --- Operating expenses (shared) ---
  const [propTax, setPropTax] = useState(3200);
  const [insurance, setInsurance] = useState(1600);
  const [maintPct, setMaintPct] = useState(5);
  const [capexPct, setCapexPct] = useState(5);
  const [hoa, setHoa] = useState(0);
  const [utilities, setUtilities] = useState(0);
  const [otherExp, setOtherExp] = useState(0);
  const [expGrowth, setExpGrowth] = useState(2.5);

  // --- Growth, ceiling, exit, tax ---
  const [appreciation, setAppreciation] = useState(3.5);
  const [ceilingOn, setCeilingOn] = useState(false);
  const [rentCap, setRentCap] = useState(2800);
  const [strRevCap, setStrRevCap] = useState(90000);
  const [valueCap, setValueCap] = useState(450000);
  const [postCapGrowth, setPostCapGrowth] = useState(2);
  const [hold, setHold] = useState(5);
  const [sellCostPct, setSellCostPct] = useState(7);
  const [taxRate, setTaxRate] = useState(24);
  const [landPct, setLandPct] = useState(20);
  const [includeTaxInIRR, setIncludeTaxInIRR] = useState(true);

  const [printMsg, setPrintMsg] = useState(false);

  function downloadReport() {
    try {
      // Bake current input values into the DOM so the serialized copy shows them
      document.querySelectorAll("input").forEach((el) => el.setAttribute("value", el.value));
      document.querySelectorAll("select").forEach((el) => {
        Array.from(el.options).forEach((o) =>
          o.selected ? o.setAttribute("selected", "") : o.removeAttribute("selected")
        );
      });
      const autoPrint = "<scr" + "ipt>window.onload=function(){setTimeout(function(){window.print()},500)}</scr" + "ipt>";
      const html = "<!DOCTYPE html>" + document.documentElement.outerHTML.replace("</body>", autoPrint + "</body>");
      const blob = new Blob([html], { type: "text/html" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "rental-report.html";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      setPrintMsg(true);
      setTimeout(() => setPrintMsg(false), 5000);
    } catch (e) { /* download unavailable */ }
  }

  // --- Build the active model ---
  const params = {
    type: tab, mode, price, marketValue, downPct, buyRate, term, closingCosts, initialRepairs,
    currentBalance, ownRate, remainingTerm, pmtOverride, origPrice,
    hasHeloc, helocBalance, helocRate, helocIO, helocTerm, helocPmtOverride, deductHelocInt,
    rent, otherIncome, rentGrowth, vacancy,
    occ, adr, adrGrowth, avgStay, guestCleanFee, cleanPerTurn, platformPct, furnishing, furnReservePct,
    mgmtPct: tab === "str" ? strMgmtPct : ltrMgmtPct,
    propTax, insurance, maintPct, capexPct, hoa, utilities, otherExp, expGrowth,
    appreciation, ceilingOn, rentCap, strRevCap, valueCap, postCapGrowth,
    hold, sellCostPct, taxRate, landPct, includeTaxInIRR,
  };
  const m = useMemo(() => buildModel(params), [JSON.stringify(params)]);

  const isSTR = tab === "str";
  const incomeLabel = isSTR ? "Gross Revenue" : "Gross Rent";

  const sourcesData = [
    { name: "Cash Flow", value: Math.max(m.cumCF, 0), color: C.greenBright },
    { name: "Principal Paydown", value: m.cumPrin, color: C.steel },
    { name: "Appreciation", value: Math.max(m.appreciationGain, 0), color: C.navy },
    { name: "Tax Benefits", value: Math.max(m.cumTax, 0), color: C.amber },
  ].filter((d) => d.value > 0);

  const equityData = [
    { year: 0, value: marketValue, equity: m.equity0, balance: m.totalDebt0 },
    ...m.rows.map((r) => ({ year: r.year, value: r.value, equity: r.equity, balance: r.balance })),
  ];

  const cfData = m.rows.map((r) => ({
    year: `Yr ${r.year}`,
    "Pre-Tax Cash Flow": Math.round(r.cashFlow),
    "After-Tax Cash Flow": Math.round(r.afterTaxCF),
  }));

  const tipStyle = {
    background: C.navyDeep, border: "none", borderRadius: 6,
    fontSize: 12, fontFamily: "'Spline Sans Mono', monospace",
  };

  const dscrTone = m.dscr >= 1.25 ? "good" : m.dscr >= 1.0 ? "warn" : "bad";
  const cfTone = m.y1.cashFlow >= 0 ? "good" : "bad";

  const modeBtn = (id, label) => (
    <button onClick={() => setMode(id)} style={{
      flex: 1, padding: "9px 0", border: "none", cursor: "pointer",
      fontFamily: "'Libre Franklin', sans-serif", fontWeight: 700, fontSize: 12.5,
      letterSpacing: "0.04em", textTransform: "uppercase", borderRadius: 6,
      background: mode === id ? C.green : "transparent",
      color: mode === id ? "#fff" : C.steelLight,
      transition: "background 0.15s",
    }}>{label}</button>
  );

  const tabBtn = (id, label, sub) => (
    <button onClick={() => setTab(id)} style={{
      flex: "0 0 auto", padding: "10px 22px", border: "none", cursor: "pointer",
      fontFamily: "'Libre Franklin', sans-serif", textAlign: "left",
      background: tab === id ? C.paper : "transparent",
      borderRadius: "8px 8px 0 0",
      borderBottom: tab === id ? "none" : `1px solid rgba(255,255,255,0.12)`,
    }}>
      <div style={{ fontSize: 14, fontWeight: 800, color: tab === id ? C.navy : C.steelLight }}>{label}</div>
      <div style={{ fontSize: 10.5, color: tab === id ? C.inkSoft : "rgba(255,255,255,0.4)" }}>{sub}</div>
    </button>
  );

  const qNames = ["Q1 · Jan–Mar", "Q2 · Apr–Jun", "Q3 · Jul–Sep", "Q4 · Oct–Dec"];

  return (
    <div style={{ minHeight: "100vh", background: C.paper, color: C.ink, fontFamily: "'Libre Franklin', sans-serif" }}>
      <style>{`
        input[type=number]::-webkit-inner-spin-button { opacity: 0.4; }
        table.proj td, table.proj th { padding: 8px 10px; white-space: nowrap; }
        table.proj tbody tr:hover { background: #EFF4F8; }
        @media (max-width: 900px) { .rc-layout { flex-direction: column; } .rc-sidebar { width: 100% !important; } }
        .rc-print-only { display: none; }
        @media print {
          .rc-no-print { display: none !important; }
          .rc-print-only { display: block; }
          body { background: #fff; }
          .rc-layout { flex-direction: column; }
          .rc-sidebar { width: 100% !important; }
          a { text-decoration: none; color: inherit; }
        }
      `}</style>

      {/* ============ Header + tabs ============ */}
      <div style={{ background: C.navyDeep, padding: "26px 28px 0" }}>
        <div style={{ maxWidth: 1200, margin: "0 auto" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
            <div>
              <div style={{ fontSize: 11, letterSpacing: "0.14em", textTransform: "uppercase", color: C.steelLight, fontWeight: 600, marginBottom: 6 }}>
                Investment Analysis
              </div>
              <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800, color: "#fff", letterSpacing: "-0.01em" }}>
                Rental Calculator
              </h1>
              <div style={{ color: C.steelLight, fontSize: 13, marginTop: 5, marginBottom: 16 }}>
                Model any property as a long-term or short-term rental.
              </div>
            </div>
            <button className="rc-no-print" onClick={downloadReport} style={{
              padding: "9px 18px", borderRadius: 8, border: `1px solid ${C.steel}`,
              background: printMsg ? C.green : "transparent", color: printMsg ? "#fff" : C.steelLight, cursor: "pointer",
              fontWeight: 700, fontSize: 12.5, fontFamily: "'Libre Franklin', sans-serif",
              letterSpacing: "0.03em", whiteSpace: "nowrap", marginTop: 4,
            }}>
              {printMsg ? "Downloaded — open it to print" : "Print Report"}
            </button>
          </div>

          {/* Print-only report header */}
          <div className="rc-print-only" style={{ color: "#fff", paddingBottom: 14 }}>
            <div style={{ fontSize: 12, color: C.steelLight }}>
              {tab === "ltr" ? "Long-Term Rental" : "Short-Term Rental"} · {mode === "own" ? "Already Own (hold analysis)" : "Purchase analysis"}
              {" · Prepared "}{new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}
              {" · Stratus Property Ventures LLC"}
            </div>
          </div>

          {/* Tabs */}
          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
            {tabBtn("ltr", "Long-Term Rental", "12-month leases · monthly rent")}
            {tabBtn("str", "Short-Term Rental", "Nightly stays · seasonal revenue")}
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "20px 20px 60px" }}>

        {/* ============ Calculator layout ============ */}
        <div className="rc-layout" style={{ display: "flex", gap: 24 }}>

          {/* ---------------- Sidebar ---------------- */}
          <div className="rc-sidebar" style={{
            width: 300, flexShrink: 0, background: C.card, border: `1px solid ${C.line}`,
            borderRadius: 10, padding: "14px 18px 18px", alignSelf: "flex-start",
          }}>
            <div style={{ display: "flex", gap: 4, background: C.navyDeep, borderRadius: 8, padding: 4, marginBottom: 6 }}>
              {modeBtn("buy", "Buying")}
              {modeBtn("own", "Already Own")}
            </div>
            <div style={{ fontSize: 11.5, color: C.inkSoft, marginBottom: 8, lineHeight: 1.45 }}>
              {owned
                ? "Analyzes the property as a hold: returns are measured against the equity you'd free up by selling today."
                : "Analyzes a new acquisition: returns are measured against cash invested at closing."}
            </div>

            {owned ? (
              <Section title="Your Current Loan">
                <Field label="Current Loan Balance" value={currentBalance} onChange={setCurrentBalance} prefix="$" step={500} />
                <Field label="Interest Rate" value={ownRate} onChange={setOwnRate} suffix="%" step={0.01} />
                <Field label="Remaining Term" value={remainingTerm} onChange={setRemainingTerm} suffix="yrs" step={0.1} min={0.5} max={40} />
                <Field label="Your Monthly Payment (P&I)" value={pmtOverride} onChange={setPmtOverride} prefix="$" step={5}
                  hint="Principal and interest only — leave out escrow, since taxes and insurance are counted below. Anything above the required payment pays down the balance faster. Leave 0 to compute from balance, rate, and term." />
                <Field label="Original Purchase Price" value={origPrice} onChange={setOrigPrice} prefix="$" step={1000}
                  hint="Sets the depreciation basis" />
                <Field label="Current Market Value" value={marketValue} onChange={setMarketValue} prefix="$" step={1000} />
              </Section>
            ) : (
              <Section title="Purchase & Financing">
                <Field label="Purchase Price" value={price} onChange={setPrice} prefix="$" step={1000} />
                <Field label="Current Market Value" value={marketValue} onChange={setMarketValue} prefix="$" step={1000}
                  hint="Basis for cap rate, appreciation, and equity" />
                <Field label="Down Payment" value={downPct} onChange={setDownPct} suffix="%" step={1} max={100} />
                <Field label="Interest Rate" value={buyRate} onChange={setBuyRate} suffix="%" step={0.01} />
                <Field label="Loan Term" value={term} onChange={setTerm} suffix="yrs" step={1} min={1} max={40} />
                <Field label="Closing Costs" value={closingCosts} onChange={setClosingCosts} prefix="$" step={250} />
                <Field label="Initial Repairs / Rehab" value={initialRepairs} onChange={setInitialRepairs} prefix="$" step={500} />
              </Section>
            )}

            {owned && (
              <Section title="HELOC" defaultOpen={hasHeloc}>
                <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, color: C.ink, marginBottom: 12, cursor: "pointer", fontWeight: 600 }}>
                  <input type="checkbox" checked={hasHeloc} onChange={(e) => setHasHeloc(e.target.checked)} />
                  Property has a HELOC drawn against it
                </label>
                {hasHeloc && (
                  <>
                    <Field label="Drawn Balance" value={helocBalance} onChange={setHelocBalance} prefix="$" step={1000}
                      hint="What you actually owe, not the credit limit" />
                    <Field label="HELOC Rate" value={helocRate} onChange={setHelocRate} suffix="%" step={0.1}
                      hint="Usually variable — model your current rate, then stress it up" />
                    <div style={{ marginBottom: 12 }}>
                      <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: C.inkSoft, marginBottom: 6 }}>
                        Payment Structure
                      </div>
                      <div style={{ display: "flex", gap: 4, background: C.paper, borderRadius: 6, padding: 3, border: `1px solid ${C.line}` }}>
                        <button onClick={() => setHelocIO(true)} style={{
                          flex: 1, padding: "7px 0", border: "none", cursor: "pointer", borderRadius: 4,
                          fontSize: 12, fontWeight: 600, fontFamily: "'Libre Franklin', sans-serif",
                          background: helocIO ? C.steel : "transparent", color: helocIO ? "#fff" : C.inkSoft,
                        }}>Interest-Only</button>
                        <button onClick={() => setHelocIO(false)} style={{
                          flex: 1, padding: "7px 0", border: "none", cursor: "pointer", borderRadius: 4,
                          fontSize: 12, fontWeight: 600, fontFamily: "'Libre Franklin', sans-serif",
                          background: !helocIO ? C.steel : "transparent", color: !helocIO ? "#fff" : C.inkSoft,
                        }}>Amortizing</button>
                      </div>
                    </div>
                    {!helocIO && (
                      <Field label="Repayment Term" value={helocTerm} onChange={setHelocTerm} suffix="yrs" step={1} min={1} max={30} />
                    )}
                    <Field label="Your Monthly Payment" value={helocPmtOverride} onChange={setHelocPmtOverride} prefix="$" step={5}
                      hint="Enter your actual payment and it drives the schedule — anything above interest pays down the balance. Leave 0 to compute." />
                    <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5, color: C.inkSoft, marginBottom: 6, cursor: "pointer" }}>
                      <input type="checkbox" checked={deductHelocInt} onChange={(e) => setDeductHelocInt(e.target.checked)} />
                      Deduct HELOC interest against rental income
                    </label>
                    <div style={{ fontSize: 11, color: C.inkSoft, lineHeight: 1.45 }}>
                      Deductible only if the draw was spent on this rental (interest tracing rules). Uncheck if the money went elsewhere.
                    </div>
                  </>
                )}
              </Section>
            )}

            {isSTR ? (
              <>
                <Section title="Seasonal Revenue">
                  <div style={{ fontSize: 11.5, color: C.inkSoft, marginBottom: 10, lineHeight: 1.45 }}>
                    Occupancy and average daily rate per quarter. Vacancy is already built into occupancy.
                  </div>
                  {[0, 1, 2, 3].map((q) => (
                    <div key={q} style={{ marginBottom: 4 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: C.navy, marginBottom: 6 }}>{qNames[q]}</div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <div style={{ flex: 1 }}>
                          <Field label="Occupancy" value={occ[q]}
                            onChange={(v) => setOcc((o) => o.map((x, i) => (i === q ? v : x)))}
                            suffix="%" step={1} max={100} />
                        </div>
                        <div style={{ flex: 1 }}>
                          <Field label="ADR" value={adr[q]}
                            onChange={(v) => setAdr((a) => a.map((x, i) => (i === q ? v : x)))}
                            prefix="$" step={5} />
                        </div>
                      </div>
                    </div>
                  ))}
                  <Field label="ADR Growth" value={adrGrowth} onChange={setAdrGrowth} suffix="%/yr" step={0.1} />
                  <Field label="Average Stay" value={avgStay} onChange={setAvgStay} suffix="nights" step={0.5} min={1}
                    hint="Drives the number of turnovers" />
                  <Field label="Guest Cleaning Fee" value={guestCleanFee} onChange={setGuestCleanFee} prefix="$" step={5}
                    hint="Charged per stay, counted as income" />
                </Section>
                <Section title="STR Costs">
                  <Field label="Cleaning Cost per Turnover" value={cleanPerTurn} onChange={setCleanPerTurn} prefix="$" step={5}
                    hint="What you pay the cleaner per stay" />
                  <Field label="Platform Fees" value={platformPct} onChange={setPlatformPct} suffix="% rev" step={0.5}
                    hint="Airbnb host fee ~3%; some channels run higher" />
                  <Field label="STR Management" value={strMgmtPct} onChange={setStrMgmtPct} suffix="% rev" step={0.5}
                    hint="Full-service STR management typically runs 15–25%. Set 0 if self-managing." />
                  <Field label="Furnishing Budget" value={furnishing} onChange={setFurnishing} prefix="$" step={500}
                    hint="Added to your cash invested; depreciated over 5 years" />
                  <Field label="Furniture Reserve" value={furnReservePct} onChange={setFurnReservePct} suffix="% rev" step={0.5}
                    hint="Ongoing replacement of furniture and linens" />
                </Section>
              </>
            ) : (
              <Section title="Income">
                <Field label="Monthly Rent" value={rent} onChange={setRent} prefix="$" step={25} />
                <Field label="Other Monthly Income" value={otherIncome} onChange={setOtherIncome} prefix="$" step={10}
                  hint="Pet rent, storage, laundry" />
                <Field label="Annual Rent Growth" value={rentGrowth} onChange={setRentGrowth} suffix="%" step={0.1} />
                <Field label="Vacancy Rate" value={vacancy} onChange={setVacancy} suffix="%" step={0.5} />
                <Field label="Property Management" value={ltrMgmtPct} onChange={setLtrMgmtPct} suffix="% coll." step={0.5}
                  hint="Applied to collected rent (after vacancy)" />
              </Section>
            )}

            <Section title="Operating Expenses">
              <Field label="Property Taxes / yr" value={propTax} onChange={setPropTax} prefix="$" step={100} />
              <Field label="Insurance / yr" value={insurance} onChange={setInsurance} prefix="$" step={50}
                hint={isSTR ? "STR policies cost more than landlord policies — quote it" : undefined} />
              <Field label="Maintenance" value={maintPct} onChange={setMaintPct} suffix="% rev" step={0.5} />
              <Field label="CapEx Reserve" value={capexPct} onChange={setCapexPct} suffix="% rev" step={0.5} />
              <Field label="HOA / mo" value={hoa} onChange={setHoa} prefix="$" step={10} />
              <Field label="Utilities (owner-paid) / mo" value={utilities} onChange={setUtilities} prefix="$" step={10}
                hint={isSTR ? "STRs carry all utilities plus internet" : undefined} />
              <Field label="Other / mo" value={otherExp} onChange={setOtherExp} prefix="$" step={10} />
              <Field label="Expense Growth" value={expGrowth} onChange={setExpGrowth} suffix="%/yr" step={0.1} />
            </Section>

            <Section title="Growth, Exit & Tax">
              <Field label="Appreciation" value={appreciation} onChange={setAppreciation} suffix="%/yr" step={0.1} />
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, color: C.ink, marginBottom: 10, cursor: "pointer", fontWeight: 600 }}>
                <input type="checkbox" checked={ceilingOn} onChange={(e) => setCeilingOn(e.target.checked)} />
                Apply a market ceiling
              </label>
              {ceilingOn && (
                <>
                  <div style={{ fontSize: 11.5, color: C.inkSoft, marginBottom: 12, lineHeight: 1.45 }}>
                    Growth runs at the rates above until income or value hits its ceiling, then slows to the
                    post-ceiling rate. Expenses keep growing regardless — that margin squeeze is the real
                    cost of a maxed-out market.
                  </div>
                  {isSTR ? (
                    <Field label="Max Annual Revenue" value={strRevCap} onChange={setStrRevCap} prefix="$" step={1000}
                      hint="Ceiling for total yearly STR revenue in this market" />
                  ) : (
                    <Field label="Max Monthly Rent" value={rentCap} onChange={setRentCap} prefix="$" step={50}
                      hint="What the local market will actually bear — check top comps" />
                  )}
                  <Field label="Max Property Value" value={valueCap} onChange={setValueCap} prefix="$" step={5000}
                    hint="Ceiling for this street and house type" />
                  <Field label="Growth After Ceiling" value={postCapGrowth} onChange={setPostCapGrowth} suffix="%/yr" step={0.1}
                    hint="Long-run drift once maxed out — inflation is a fair default" />
                </>
              )}
              <Field label="Hold Period" value={hold} onChange={(v) => setHold(Math.max(1, Math.min(30, Math.round(v))))} suffix="yrs" step={1} min={1} max={30} />
              <Field label="Selling Costs at Exit" value={sellCostPct} onChange={setSellCostPct} suffix="%" step={0.5}
                hint="Agent commission + closing" />
              <Field label="Marginal Tax Rate" value={taxRate} onChange={setTaxRate} suffix="%" step={1} />
              <Field label="Land Value" value={landPct} onChange={setLandPct} suffix="% of price" step={1}
                hint="Land is not depreciable; building basis ÷ 27.5 yrs" />
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5, color: C.inkSoft, marginTop: 4, cursor: "pointer" }}>
                <input type="checkbox" checked={includeTaxInIRR} onChange={(e) => setIncludeTaxInIRR(e.target.checked)} />
                Include tax impact in IRR &amp; totals
              </label>
            </Section>
          </div>

          {/* ---------------- Results ---------------- */}
          <div style={{ flex: 1, minWidth: 0 }}>

            {owned && (
              <div style={{
                background: C.navy, borderRadius: 10, padding: "14px 18px", marginBottom: 12,
                display: "flex", gap: 24, flexWrap: "wrap", alignItems: "center",
              }}>
                <div>
                  <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: "0.07em", textTransform: "uppercase", color: C.steelLight }}>
                    Gross Equity Today
                  </div>
                  <div style={{ fontSize: 22, fontWeight: 600, color: "#fff", fontFamily: "'Spline Sans Mono', monospace" }}>
                    {fmt$(m.equity0)}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: "0.07em", textTransform: "uppercase", color: C.steelLight }}>
                    If You Sold Today
                  </div>
                  <div style={{ fontSize: 22, fontWeight: 600, color: C.greenBright, fontFamily: "'Spline Sans Mono', monospace" }}>
                    {fmt$(m.sellTodayProceeds)}
                  </div>
                </div>
                <div style={{ flex: 1, minWidth: 220, fontSize: 12, color: C.steelLight, lineHeight: 1.5 }}>
                  Holding means leaving {fmt$(m.investedBase)} invested in this property.
                  Every return below is measured against that number — the honest keep-vs-sell comparison.
                </div>
              </div>
            )}

            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
              <Metric big label="Monthly Cash Flow (Yr 1)" value={fmt$(m.y1.cashFlow / 12)} tone={cfTone}
                sub={`${fmt$(m.y1.cashFlow)} / yr pre-tax · ${fmt$(m.y1.afterTaxCF)} after tax`} />
              <Metric big label={owned ? "Cash Return on Equity" : "Cash-on-Cash Return"} value={fmtPct(m.coc)}
                sub={`On ${fmt$(m.investedBase)} ${m.investedLabel}`} />
              <Metric big label={`IRR (${hold}-yr, ${includeTaxInIRR ? "after-tax" : "pre-tax"})`}
                value={m.irrVal === null ? "—" : fmtPct(m.irrVal)}
                sub={`Includes sale at ${fmt$(m.valueEnd)} less ${fmtPct(sellCostPct, 1)} costs`} />
              <Metric big label={`Combined ROI (${hold} yr)`} value={fmtPct(m.combinedROI, 1)}
                sub={`${fmt$(m.totalReturn)} total return · ${fmtPct(m.avgAnnualROI, 1)}/yr avg`} />
            </div>

            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
              <Metric label="Cap Rate (Value)" value={fmtPct(m.capRate)}
                sub={owned || m.capRateOnPrice === null ? "NOI ÷ current market value" : `${fmtPct(m.capRateOnPrice)} on purchase price`} />
              <Metric label="DSCR" value={m.dscr === Infinity ? "—" : m.dscr.toFixed(2)} tone={dscrTone}
                sub="Lenders typically want 1.20–1.25+" />
              <Metric label="Expense Ratio" value={fmtPct(m.y1.expenseRatio, 1)} sub={`OpEx ÷ ${incomeLabel.toLowerCase()}, Yr 1`} />
              <Metric label={isSTR ? "Gross Revenue Multiplier" : "Gross Rent Multiplier"} value={m.grm.toFixed(2)} sub={`Value ÷ ${incomeLabel.toLowerCase()}`} />
              <Metric label="Net Income Multiplier" value={m.nim.toFixed(2)} sub="Value ÷ NOI" />
              <Metric label="Return on Equity (Yr 1)" value={fmtPct(m.roe)} sub="(Cash flow + paydown) ÷ gross equity" />
            </div>

            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20 }}>
              <Metric label={owned ? (m.helocOn ? "Total Debt" : "Loan Balance") : "Loan Amount"}
                value={fmt$(m.totalDebt0)}
                sub={m.helocOn
                  ? `Mortgage ${fmt$(m.loan)} @ ${fmt$(m.pmt, 0)}/mo + HELOC ${fmt$(helocBalance)} @ ${fmt$(m.helocPmt, 0)}/mo`
                  : `${fmt$(m.pmt, 0)}/mo P&I`} />
              <Metric label="NOI (Yr 1)" value={fmt$(m.y1.noi)} sub={`Income ${fmt$(m.y1.egi)} − OpEx ${fmt$(m.y1.opEx)}`} />
              <Metric label="Annual Depreciation" value={fmt$(m.annualDep)}
                sub={`Yr 1 tax impact: ${fmt$(m.y1.taxImpact)}${isSTR ? " · includes 5-yr furnishing" : ""}`} />
              <Metric label={`Net Sale Proceeds (Yr ${hold})`} value={fmt$(m.netSaleProceeds)}
                sub="Value − selling costs − loan balance. Cap gains & depreciation recapture not modeled." />
            </div>

            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 20 }}>
              <div style={{ flex: "1 1 320px", background: C.card, border: `1px solid ${C.line}`, borderRadius: 10, padding: 18 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.navy, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>
                  Sources of Return · {hold} Years
                </div>
                <div style={{ fontSize: 12, color: C.inkSoft, marginBottom: 8 }}>Total {fmt$(m.totalReturn)}</div>
                <ResponsiveContainer width="100%" height={220}>
                  <PieChart>
                    <Pie data={sourcesData} dataKey="value" nameKey="name" innerRadius={55} outerRadius={85} paddingAngle={2}>
                      {sourcesData.map((d, i) => <Cell key={i} fill={d.color} />)}
                    </Pie>
                    <Tooltip formatter={(v) => fmt$(v)} contentStyle={tipStyle} itemStyle={{ color: "#fff" }} />
                  </PieChart>
                </ResponsiveContainer>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, fontSize: 12.5 }}>
                  {sourcesData.map((d, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 7 }}>
                      <span style={{ width: 10, height: 10, borderRadius: 2, background: d.color, flexShrink: 0 }} />
                      <span style={{ color: C.inkSoft }}>{d.name}</span>
                      <span style={{ marginLeft: "auto", fontFamily: "'Spline Sans Mono', monospace" }}>{fmt$(d.value)}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ flex: "1 1 380px", background: C.card, border: `1px solid ${C.line}`, borderRadius: 10, padding: 18 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.navy, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 12 }}>
                  Value, Equity &amp; Loan Balance
                </div>
                <ResponsiveContainer width="100%" height={252}>
                  <AreaChart data={equityData} margin={{ top: 4, right: 6, left: 6, bottom: 0 }}>
                    <CartesianGrid stroke={C.line} strokeDasharray="3 3" />
                    <XAxis dataKey="year" tick={{ fontSize: 11 }} tickFormatter={(v) => `Yr ${v}`} />
                    <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `$${Math.round(v / 1000)}k`} width={48} />
                    <Tooltip formatter={(v) => fmt$(v)} labelFormatter={(l) => `Year ${l}`} contentStyle={tipStyle} itemStyle={{ color: "#fff" }} labelStyle={{ color: C.steelLight }} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Area type="monotone" dataKey="value" name="Property Value" stroke={C.navy} fill={C.navy} fillOpacity={0.10} strokeWidth={2} />
                    <Area type="monotone" dataKey="equity" name="Equity" stroke={C.green} fill={C.green} fillOpacity={0.18} strokeWidth={2} />
                    <Area type="monotone" dataKey="balance" name="Loan Balance" stroke={C.steel} fill="none" strokeWidth={1.5} strokeDasharray="5 4" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 10, padding: 18, marginBottom: 20 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.navy, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 12 }}>
                Annual Cash Flow Projection
              </div>
              <ResponsiveContainer width="100%" height={230}>
                <BarChart data={cfData} margin={{ top: 4, right: 6, left: 6, bottom: 0 }}>
                  <CartesianGrid stroke={C.line} strokeDasharray="3 3" />
                  <XAxis dataKey="year" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `$${(v / 1000).toFixed(1)}k`} width={52} />
                  <Tooltip formatter={(v) => fmt$(v)} contentStyle={tipStyle} itemStyle={{ color: "#fff" }} labelStyle={{ color: C.steelLight }} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <ReferenceLine y={0} stroke={C.inkSoft} />
                  <Bar dataKey="Pre-Tax Cash Flow" fill={C.steel} radius={[3, 3, 0, 0]} />
                  <Bar dataKey="After-Tax Cash Flow" fill={C.greenBright} radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 10, padding: 18 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.navy, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 12 }}>
                Year-by-Year Projection
              </div>
              <div style={{ overflowX: "auto" }}>
                <table className="proj" style={{ borderCollapse: "collapse", width: "100%", fontSize: 12.5, fontFamily: "'Spline Sans Mono', monospace" }}>
                  <thead>
                    <tr style={{ background: C.navy, color: "#fff", fontFamily: "'Libre Franklin', sans-serif", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                      <th style={{ textAlign: "left" }}>Yr</th>
                      <th style={{ textAlign: "right" }}>{incomeLabel}</th>
                      <th style={{ textAlign: "right" }}>OpEx</th>
                      <th style={{ textAlign: "right" }}>NOI</th>
                      <th style={{ textAlign: "right" }}>Debt Svc</th>
                      <th style={{ textAlign: "right" }}>Cash Flow</th>
                      <th style={{ textAlign: "right" }}>Tax Impact</th>
                      <th style={{ textAlign: "right" }}>Paydown</th>
                      <th style={{ textAlign: "right" }}>Value</th>
                      <th style={{ textAlign: "right" }}>Equity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {m.rows.map((r) => (
                      <tr key={r.year} style={{ borderBottom: `1px solid ${C.line}` }}>
                        <td style={{ fontWeight: 600 }}>{r.year}</td>
                        <td style={{ textAlign: "right" }}>{fmt$(r.grossIncome)}</td>
                        <td style={{ textAlign: "right" }}>{fmt$(r.opEx)}</td>
                        <td style={{ textAlign: "right" }}>{fmt$(r.noi)}</td>
                        <td style={{ textAlign: "right" }}>{fmt$(r.debtService)}</td>
                        <td style={{ textAlign: "right", color: r.cashFlow >= 0 ? C.green : C.red, fontWeight: 600 }}>{fmt$(r.cashFlow)}</td>
                        <td style={{ textAlign: "right", color: r.taxImpact >= 0 ? C.green : C.red }}>{fmt$(r.taxImpact)}</td>
                        <td style={{ textAlign: "right" }}>{fmt$(r.principal)}</td>
                        <td style={{ textAlign: "right" }}>{fmt$(r.value)}</td>
                        <td style={{ textAlign: "right", fontWeight: 600 }}>{fmt$(r.equity)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ fontSize: 11.5, color: C.inkSoft, marginTop: 12, lineHeight: 1.55 }}>
                Methodology: NOI = effective gross income minus operating expenses; debt service excluded.
                LTR applies vacancy to gross rent; STR occupancy already embeds vacancy. STR revenue = Σ quarterly (days × occupancy × ADR)
                plus guest cleaning fees; cleaning, platform, and management costs scale with revenue; furnishing is added to cash invested
                and depreciated over 5 years. Tax impact = (NOI − deductible interest − depreciation) × marginal rate — passive loss limits
                may apply depending on AGI and material participation. In Already Own mode, returns are measured against the after-cost equity
                you would net by selling today (all liens paid off). With a market ceiling on, income and value grow at stated rates until
                reaching their caps, then drift at the post-ceiling rate while expenses continue growing. Exit proceeds exclude capital
                gains tax and depreciation recapture. Estimates, not guarantees.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<RentalCalculator />);
