// Everything that talks to Studionet lives here: the read client, the burner
// wallet, funding, typed contract reads, and the write-and-wait loop with
// leader-error detection. scripts/live_run.ts imports this same module.
import { createAccount, createClient, generatePrivateKey } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionHashVariant, TransactionStatus } from "genlayer-js/types";

export const CONTRACT = "0x0D7367C51dBDf8De80d52A912BB7f067120eE93C" as const;
export const RPC_URL = studionet.rpcUrls.default.http[0];
export const EXPLORER = "https://explorer-studio.genlayer.com";
export const GEN = 10n ** 18n;

// limits enforced by the contract (contracts/mm_sla_escrow.py)
export const LIMITS = {
  minInterval: 600,
  maxInterval: 86_400,
  maxSlots: 744,
  maxStartDelay: 30 * 86_400,
  startGrace: 600, // start may be up to MIN_INTERVAL_S in the past
  subWindows: 3, // SUB_WINDOWS: each slot takes at most one recorded check per sub-window
};

const PK_KEY = "mmsla.burner.pk";

export const reader = createClient({ chain: studionet });

/* ---------- burner wallet ---------- */

type Pk = `0x${string}`;

function loadPk(): Pk | null {
  try {
    const v = localStorage.getItem(PK_KEY);
    return v && /^0x[0-9a-fA-F]{64}$/.test(v) ? (v as Pk) : null;
  } catch {
    return null;
  }
}

let account = (() => {
  const pk = loadPk();
  return pk ? createAccount(pk) : null;
})();

export function getAccount() {
  return account;
}

export function createBurner() {
  const pk = generatePrivateKey();
  try {
    localStorage.setItem(PK_KEY, pk);
  } catch {
    /* private mode: the wallet lives for this tab only */
  }
  account = createAccount(pk);
  return account;
}

/** Use a given key without storing it (the node live-run script). */
export function useKey(pk: Pk) {
  account = createAccount(pk);
  return account;
}

export function forgetBurner() {
  try {
    localStorage.removeItem(PK_KEY);
  } catch {
    /* ignore */
  }
  account = null;
}

export function exportPk(): string | null {
  return loadPk();
}

/** A fresh address whose key is thrown away: payouts sent there are unreachable. */
export function throwawayAddress(): string {
  return createAccount(generatePrivateKey()).address;
}

export async function getBalance(address: `0x${string}`): Promise<bigint> {
  return reader.getBalance({ address });
}

/** Studionet's faucet. studio.genlayer.com/api reflects the request origin in CORS, so this works from a browser. */
export async function fundAccount(address: string, gen = 100n): Promise<void> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "sim_fundAccount",
      params: [address, Number(gen * GEN)],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(body.error.message ?? JSON.stringify(body.error));
}

/* ---------- contract reads ---------- */

export type Venue = "upbit" | "bithumb";

export type Terms = {
  max_spread_bps: number;
  band_bps: number;
  min_depth_krw: number;
  min_uptime_pct: number;
};

export type Agreement = {
  id: number;
  project: string;
  mm: string;
  venue: Venue;
  market: string;
  terms: Terms;
  retainer: bigint;
  start: number;
  interval_s: number;
  n_slots: number;
  passed: number;
  failed: number;
  settled: boolean;
  paid_mm: bigint;
};

export type Observation = {
  ts: number;
  mid: string;
  best_bid: string;
  best_ask: string;
  spread_bps: number;
  bid_depth: number;
  ask_depth: number;
  bid_truncated: boolean;
  ask_truncated: boolean;
  pass: boolean;
};

export type SlotState = {
  status: "unchecked" | "pass" | "fail";
  checks: number;
  windows: number[]; // sub-windows (0-based) that have a recorded check, in order
  obs?: Observation; // the last recorded check, i.e. the one in the highest sub-window
  by?: string;
};

const plain = (v: any): any => {
  if (v instanceof Map) return Object.fromEntries([...v].map(([k, x]) => [k, plain(x)]));
  if (Array.isArray(v)) return v.map(plain);
  return v;
};

// Studionet allows each IP 30 gen_call reads a minute (X-RateLimit-Bucket: standard).
// The 429 it sends past that has no CORS header, so a browser only sees "Failed to fetch".
// Reads that fail that way are retried with a pause; listeners can tell the user why.
let retryListener: (waitS: number | null) => void = () => {};
export function onReadRetry(fn: (waitS: number | null) => void) {
  retryListener = fn;
}
const RETRY_WAITS = [8, 15, 25];
const looksThrottled = (e: any) => /fetch|unknown rpc|429|rate|network|html|json/i.test(String(e?.shortMessage ?? e?.message ?? e));

// "latest-nonfinal": state as accepted by consensus, before the appeal window closes.
// Without it a fresh write would not be visible for a long time on Studionet.
async function read(functionName: string, args: (string | number | boolean)[] = []): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    try {
      const v = await reader.readContract({
        address: CONTRACT,
        functionName,
        args,
        transactionHashVariant: TransactionHashVariant.LATEST_NONFINAL,
      });
      if (attempt) retryListener(null);
      return plain(v);
    } catch (e) {
      if (attempt >= RETRY_WAITS.length || !looksThrottled(e)) {
        if (attempt) retryListener(null);
        throw e;
      }
      retryListener(RETRY_WAITS[attempt]);
      await new Promise((r) => setTimeout(r, RETRY_WAITS[attempt] * 1000));
    }
  }
}

const big = (v: unknown) => BigInt(String(v ?? 0));
const num = (v: unknown) => Number(v ?? 0);

export async function getCount(): Promise<number> {
  return num(await read("get_count"));
}

export async function getAgreement(id: number): Promise<Agreement> {
  const a = await read("get_agreement", [id]);
  const t = a.terms ?? {};
  return {
    id,
    project: a.project,
    mm: a.mm,
    venue: a.venue,
    market: a.market,
    terms: {
      max_spread_bps: num(t.max_spread_bps),
      band_bps: num(t.band_bps),
      min_depth_krw: num(t.min_depth_krw),
      min_uptime_pct: num(t.min_uptime_pct),
    },
    retainer: big(a.retainer),
    start: num(a.start),
    interval_s: num(a.interval_s),
    n_slots: num(a.n_slots),
    passed: num(a.passed),
    failed: num(a.failed),
    settled: Boolean(a.settled),
    paid_mm: big(a.paid_mm),
  };
}

export function normObs(o: any): Observation {
  return {
    ts: num(o.ts),
    mid: String(o.mid),
    best_bid: String(o.best_bid),
    best_ask: String(o.best_ask),
    spread_bps: num(o.spread_bps),
    bid_depth: num(o.bid_depth),
    ask_depth: num(o.ask_depth),
    bid_truncated: Boolean(o.bid_truncated),
    ask_truncated: Boolean(o.ask_truncated),
    pass: Boolean(o.pass),
  };
}

export async function getSlot(id: number, slot: number): Promise<SlotState> {
  const s = await read("get_slot", [id, slot]);
  const windows = Array.isArray(s.windows) ? s.windows.map(num) : [];
  return { status: s.status, checks: num(s.checks), windows, obs: s.obs ? normObs(s.obs) : undefined, by: s.by };
}

/** -1 before the term starts, n_slots after it ends (contract clock). */
export async function getCurrentSlot(id: number): Promise<number> {
  return num(await read("current_slot", [id]));
}

/* ---------- sub-windows: the same arithmetic as the contract's check() ---------- */

/** Unix time at which sub-window k (0..subWindows) of a slot opens; k = subWindows is the slot's end.
 *  The contract computes window = (now - start - slot * interval) * SUB_WINDOWS // interval. */
export function subWindowStart(a: Agreement, slot: number, k: number): number {
  return a.start + slot * a.interval_s + Math.ceil((k * a.interval_s) / LIMITS.subWindows);
}

/** Slot and sub-window the contract would use at unix time t, or null outside the term. */
export function subWindowAt(a: Agreement, t: number): { slot: number; window: number } | null {
  if (t < a.start || t >= a.start + a.interval_s * a.n_slots) return null;
  const slot = Math.floor((t - a.start) / a.interval_s);
  return { slot, window: Math.floor(((t - a.start - slot * a.interval_s) * LIMITS.subWindows) / a.interval_s) };
}

/** pass / fail: a recorded check; open: running now, no check yet; missed: ended without a check;
 *  closed: the slot failed earlier, so the contract takes no more checks; future: not started. */
export type SubWindowCell = "pass" | "fail" | "open" | "missed" | "closed" | "future";

export function subWindowCells(a: Agreement, slot: number, s: SlotState | undefined, t: number): SubWindowCell[] {
  const windows = s?.windows ?? [];
  const last = windows.length ? windows[windows.length - 1] : -1;
  return Array.from({ length: LIMITS.subWindows }, (_, k): SubWindowCell => {
    // a failing check fails the slot and ends checking, so only the last recorded one can be the fail
    if (windows.includes(k)) return s?.status === "fail" && k === last ? "fail" : "pass";
    if (s?.status === "fail") return "closed";
    if (t < subWindowStart(a, slot, k)) return "future";
    return t >= subWindowStart(a, slot, k + 1) ? "missed" : "open";
  });
}

/** Why the contract would refuse a check at time t, judged from the slot state read before sending. */
export type CheckBlock = { kind: "failed" | "window-used"; slot: number; window: number; nextAt: number; nextIsSlot: boolean; termEnds: boolean };

export function checkBlock(a: Agreement, s: SlotState | undefined, t: number): CheckBlock | null {
  const at = subWindowAt(a, t);
  if (!at || !s) return null;
  const used = s.windows.includes(at.window);
  if (s.status !== "fail" && !used) return null;
  // after a fail the next chance is the next slot; after a used sub-window, the next sub-window
  const nextIsSlot = s.status === "fail" || at.window === LIMITS.subWindows - 1;
  const nextAt = nextIsSlot ? subWindowStart(a, at.slot, LIMITS.subWindows) : subWindowStart(a, at.slot, at.window + 1);
  return { kind: s.status === "fail" ? "failed" : "window-used", ...at, nextAt, nextIsSlot, termEnds: nextIsSlot && at.slot === a.n_slots - 1 };
}

/* ---------- writes ---------- */

export type TxOutcome =
  | { ok: true; hash: string; status: string; votes: string[]; returned?: string }
  | { ok: false; hash?: string; status?: string; code: string; message: string; votes: string[] };

export type TxProgress = (phase: "signing" | "pending", hash?: string) => void;

/**
 * Send a write and wait until consensus accepts it. "ACCEPTED" alone is not
 * success: if the leader hit a contract UserError (e.g. "slot 2 has already
 * failed") or an exchange error, validators agree on the error and the tx is
 * still ACCEPTED with no state change. So look at the leader receipt.
 * And a decided status other than ACCEPTED (UNDETERMINED, timeouts) is never success.
 */
export async function sendTx(
  functionName: string,
  args: (string | number | boolean)[],
  value: bigint,
  onProgress: TxProgress = () => {},
): Promise<TxOutcome> {
  if (!account) throw new Error("no wallet");
  const writer = createClient({ chain: studionet, account });
  onProgress("signing");
  const hash = (await writer.writeContract({ account, address: CONTRACT, functionName, args, value })) as string;
  onProgress("pending", hash);
  let r: any;
  for (let i = 0; !r; i++) {
    try {
      r = await reader.waitForTransactionReceipt({
        hash: hash as any,
        status: TransactionStatus.ACCEPTED,
        retries: 150,
        interval: 4000,
      });
    } catch (e) {
      // Studionet's RPC sometimes answers with an HTML error page; the transaction is still there
      if (i >= 4) throw e;
      await new Promise((res) => setTimeout(res, 10_000));
    }
  }
  const leader = r?.consensus_data?.leader_receipt?.[0];
  const exec = leader?.execution_result;
  const status = r?.statusName ?? r?.status_name ?? "ACCEPTED";
  const votes: string[] = r?.last_round?.validator_votes_name ?? [];
  // waitForTransactionReceipt(ACCEPTED) also returns on UNDETERMINED and the timeouts. For check()
  // that is the normal outcome when the book sits at the threshold and validators' own snapshots
  // give different verdicts: the leader succeeded, but nothing was recorded.
  if (status !== "ACCEPTED" && status !== "FINALIZED") {
    return {
      ok: false, hash, status, code: "NO_CONSENSUS", votes,
      message: `Validators did not reproduce the leader's result (${status}). Nothing was recorded; the slot is unchanged.`,
    };
  }
  if (exec !== "ERROR") return { ok: true, hash, status, votes, returned: leader?.result?.payload?.readable };
  const code: string = leader?.genvm_result?.error_code ?? "ERROR";
  const message: string =
    (typeof leader?.result?.payload === "string" ? leader.result.payload : "") ||
    leader?.genvm_result?.error_description ||
    leader?.result?.payload?.readable ||
    leader?.genvm_result?.stderr ||
    code;
  return { ok: false, hash, status, code, message: String(message).replace(/^"|"$/g, "").trim(), votes };
}
