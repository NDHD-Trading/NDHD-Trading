// Made-up data for the mocked tests. Shapes mirror web/src/types.ts.

export const account = {
  status: "ACTIVE",
  currency: "USD",
  equity: 101000,
  cash: 40000,
  buying_power: 80000,
  portfolio_value: 101000,
  trading_blocked: false,
  account_blocked: false,
  paper: true,
  live_trading: false,
  orders_enabled: true,
  pdt_fields_present: true,
  daytrade_count: 0,
};

export const stockPosition = {
  symbol: "AAPL",
  asset_class: "us_equity",
  is_option: false,
  side: "long",
  qty: 10,
  avg_entry_price: 150,
  current_price: 160,
  market_value: 1600,
  unrealized_pl: 100,
  unrealized_plpc: 6.67,
};

export const optionPosition = {
  symbol: "XYZ261218P00100000",
  asset_class: "us_option",
  is_option: true,
  side: "short",
  qty: -1,
  avg_entry_price: 2.5,
  current_price: 3,
  market_value: -300,
  unrealized_pl: -50,
  unrealized_plpc: -20,
};

export const order = {
  id: "order-1",
  symbol: "MSFT",
  side: "buy",
  type: "limit",
  status: "new",
  qty: 5,
  filled_qty: 0,
  limit_price: 400,
  stop_price: null,
  filled_avg_price: null,
  client_order_id: "client-1",
  submitted_at: "2026-11-06T15:00:00Z",
  time_in_force: "day",
};

export const alertOld = {
  ts: "2026-11-06T15:00:00Z",
  subject: "Old alert subject",
  body: "Old alert body",
  key: null,
  severity: "warning",
};

export const alertNew = {
  ts: "2026-11-06T16:00:00Z",
  subject: "New alert subject",
  body: "New alert body",
  key: null,
  severity: "critical",
};

export const tick = {
  type: "tick",
  account,
  positions: [stockPosition, optionPosition],
  orders: [order],
  alerts: [alertOld],
};

export const risk = {
  equity: 101000,
  session_start_equity: 100000,
  daily_drawdown_pct: 0.5,
  daily_drawdown_limit_pct: 3,
  daily_risk_halted: false,
  kill_switch_active: false,
  kill_switch_date: null,
  stock_exposure: 1600,
  stock_exposure_cap: 60000,
  stock_exposure_pct_of_cap: 2.67,
  sector_exposure_pct: { technology: 1.6 },
  sector_cap_pct: 25,
  stock_position_count: 1,
  stock_position_cap: 8,
  wheel_collateral_cap_pct: 50,
  pdt_protection: { enabled_in_config: true, effective: true, note: "Fields present." },
};

const indicators = {
  available: true,
  error: null,
  price: 160,
  ema_fast: 158,
  ema_slow: 150,
  atr: 3.2,
  adx: 28.5,
  trending: true,
  signal: "LONG",
  spread_pct: 0.012,
};

export const stockLong = {
  symbol: "AAPL",
  direction: "long",
  status: "LONG",
  entry_price: 150,
  initial_stop_price: 140,
  trailing_stop_price: 152,
  activated_trailing: true,
  last_signal: "LONG",
  last_atr: 3.2,
  indicators,
};

export const stockNoData = {
  symbol: "MSFT",
  direction: "long",
  status: "IDLE",
  entry_price: null,
  initial_stop_price: null,
  trailing_stop_price: null,
  activated_trailing: false,
  last_signal: null,
  last_atr: null,
  indicators: { ...indicators, available: false, error: "Not enough bars", signal: null },
};

export const wheelOpen = {
  symbol: "XYZ",
  phase: "CASH_PUT",
  option_symbol: "XYZ261218P00100000",
  option_type: "put",
  entry_premium: 2.5,
  assignment_basis: null,
  contracts: 1,
  expected_shares: 0,
  quote: { bid: 2.9, ask: 3.1, mid: 3 },
  unrealized_gain_pct: -20,
};

export const wheelEmpty = {
  symbol: "ABC",
  phase: "COVERED_CALL",
  option_symbol: null,
  option_type: null,
  entry_premium: null,
  assignment_basis: 95,
  contracts: 0,
  expected_shares: 100,
  quote: null,
  unrealized_gain_pct: null,
};

export const strategy = {
  type: "strategy",
  stocks: [stockLong, stockNoData],
  wheels: [wheelOpen, wheelEmpty],
  risk,
  market: { is_open: true, next_open: null, next_close: "2026-11-09T21:00:00Z" },
};

export const logs = {
  type: "log",
  entries: [
    { line: "2026-11-06 | INFO | Loop started", level: "INFO" },
    { line: "2026-11-06 | WARNING | Spread too wide", level: "WARNING" },
    { line: "2026-11-06 | ERROR | Quote failed", level: "ERROR" },
  ],
};

const trade = {
  filer: "Test Lawmaker",
  party: "D",
  chamber: "House",
  ticker: "AAPL",
  asset_name: "Apple Inc.",
  direction: "Buy",
  transaction_type: "P",
  owner: "self",
  trade_date: "2026-10-20",
  filing_date: "2026-11-02",
  filing_lag_days: 13,
  amount_low: 1001,
  amount_high: 15000,
  amount_mid_estimate: 8000,
  source_status: "verified",
  filing_url: "https://example.com/filing.pdf",
  lots: 1,
};

export const congress = {
  status: "ok",
  message: null,
  data_file: "data/congress_trades.json",
  as_of: "2026-11-06",
  window_days: 60,
  business_days_old: 0,
  stale: false,
  engine_flag_in_env: false,
  engine: { running: false, seen_at: null, congress_context_enabled: null, paper: null },
  counts: { verified: 12, unverified: 3 },
  by_party: { D: { buys: 4, sells: 2 }, R: { buys: 1, sells: 5 } },
  your_symbols: [
    {
      symbol: "AAPL",
      roles: ["stock"],
      engine_alert: true,
      reason: "2 lawmakers bought in the last 14 days",
      headline: null,
      cluster: { direction: "Buy", filers: ["A", "B"] },
      window_buyers: 2,
      window_sellers: 0,
      verified_trades: [trade],
      unverified_count: 0,
    },
  ],
  engine_rule_clusters: [{ ticker: "AAPL", direction: "Buy", filers: ["A", "B"], headline: "h" }],
  most_active: [
    {
      ticker: "AAPL",
      name: "Apple Inc.",
      sector: "technology",
      buyers: ["A", "B"],
      sellers: [],
      trades: 2,
      buy_est: 16000,
      sell_est: 0,
      latest_filing: "2026-11-02",
    },
  ],
  recent_verified: [trade],
  needs_review: [],
  ledger_available: false,
  store: {
    filings_total: 101,
    first_filing_date: "2026-09-01",
    last_filing_date: "2026-11-02",
    last_pull_at: "2026-11-06T12:00:00Z",
    last_pull_new_filings: 4,
  },
  note: "Congress note.",
};

export const congressPullIdle = {
  state: "idle",
  started_at: null,
  finished_at: null,
  message: "",
  log: [],
  result: null,
};

const holding = {
  symbol: "AAPL",
  quantity: 10,
  avg_cost: 150,
  price: 160,
  value: 1600,
  cost: 1500,
  pl: 100,
  pl_pct: 6.7,
  weight_pct: 50,
  next_earnings: null,
  earnings_timing: null,
  earnings_confirmed: null,
  days_to_earnings: null,
};

const rhAccount = {
  label: "Sample",
  last4: "0000",
  kind: "individual",
  managed: false,
  default: true,
  agent_can_trade: false,
  trade_approvals_required: null,
  total_value: 3200,
  cash: 100,
  pending_deposits: 0,
  buying_power: 100,
};

export const robinhood = {
  status: "ok",
  message: null,
  data_file: "data/snapshot.json",
  taken_at: "2026-11-06T12:00:00Z",
  age_days: 0,
  stale: false,
  prices_note: "Prices at the snapshot time.",
  accounts: [rhAccount],
  main: rhAccount,
  totals: {
    all_accounts: 3200,
    stocks: { value: 1600, cost: 1500, pl: 100, pl_pct: 6.7 },
    crypto: { value: 200, cost: 250, pl: -50, pl_pct: -20 },
    options_value: 0,
  },
  stocks: [holding],
  crypto: [{ ...holding, symbol: "SAMPLECOIN", quantity: 2, value: 200, pl: -50, pl_pct: -20 }],
  covered_calls: [],
  open_orders: [],
  rule_checks: [
    { rule: "Largest position", detail: "single name", unit: "%", limit: 10, actual: 50, ok: false },
  ],
  suggestions: [{ tone: "warn", title: "Sample suggestion", detail: "Sample detail", who: "You" }],
  note: "Robinhood note.",
};

export const watch = {
  tickers: ["TSLA", "BAD"],
  rows: [
    {
      symbol: "TSLA",
      error: null,
      price: 250,
      as_of: "2026-11-06",
      change_pct: 1.5,
      trend: "up",
      ema_fast: 245,
      ema_slow: 230,
      adx: 31,
      trending: true,
      signal: "LONG",
      crossover_ignored: false,
      bars_since_cross: 0,
      atr_pct: 3,
      year_high: 300,
      year_low: 150,
      from_high_pct: -16,
      from_low_pct: 66,
      next_earnings: null,
      days_to_earnings: null,
      earnings_blackout: false,
      below_min_price: false,
      held_qty: null,
      avg_cost: null,
      vs_cost_pct: null,
      also_traded: false,
    },
    { symbol: "BAD", error: "no bars", price: null },
  ],
  computed_at: "2026-11-06T12:00:00Z",
  min_stock_price: 10,
  adx_min_strength: 20,
  note: "Watch note.",
};
