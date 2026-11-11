// Live order book preview, fetched by the browser from the same public URLs the
// validators use. measure() is a line-by-line port of _measure() in
// contracts/mm_sla_escrow.py, so the preview applies the contract's own rules.
// It is still only this browser's snapshot: validators fetch their own, seconds later.
import type { Observation, Terms, Venue } from "./chain";

export const BOOK_URL: Record<Venue, (m: string) => string> = {
  upbit: (m) => `https://api.upbit.com/v1/orderbook?markets=${encodeURIComponent(m)}`,
  bithumb: (m) => `https://api.bithumb.com/v1/orderbook?markets=${encodeURIComponent(m)}`,
};

export const MARKET_RE = /^KRW-[A-Z0-9]{1,15}$/;

export type Level = { price: number; size: number };

export type BookSnapshot = {
  venue: Venue;
  market: string;
  fetchedAt: number; // ms, this browser's clock
  bids: Level[]; // after dropping size-0 levels, best first
  asks: Level[];
  levels: number; // levels the API returned per side
  obs: Observation;
};

export class BookError extends Error {
  constructor(
    message: string,
    public kind: "no-market" | "blocked" | "http" | "format",
  ) {
    super(message);
  }
}

export async function fetchBook(venue: Venue, market: string): Promise<any> {
  let res: Response;
  try {
    res = await fetch(BOOK_URL[venue](market), { cache: "no-store" });
  } catch {
    // fetch() only throws like this on a network failure or a CORS refusal
    throw new BookError(
      `Your browser could not read ${venue}'s order book (network error or the venue refused a cross-origin request). The contract fetches it server-side, so check() is not affected.`,
      "blocked",
    );
  }
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    if (res.ok) throw new BookError(`${venue} returned something that isn't JSON`, "format");
  }
  if (res.status === 404 || (data && !Array.isArray(data) && data.error)) {
    // Upbit answers 404, Bithumb answers 200 with an error object
    throw new BookError(`${venue} has no market ${market}`, "no-market");
  }
  if (!res.ok) throw new BookError(`${venue} returned HTTP ${res.status}`, "http");
  if (!Array.isArray(data) || data.length !== 1 || data[0]?.market !== market) {
    throw new BookError(`${venue} returned an unexpected order book`, "format");
  }
  return data[0];
}

/** Port of _measure(): the numbers the agreement is about, from one snapshot. */
export function measure(book: any, terms: Terms): { obs: Observation; bids: Level[]; asks: Level[] } {
  const units: any[] = book.orderbook_units ?? [];
  let bids: Level[] = units.map((u) => ({ price: Number(u.bid_price), size: Number(u.bid_size) }));
  let asks: Level[] = units.map((u) => ({ price: Number(u.ask_price), size: Number(u.ask_size) }));
  const ts = Number(book.timestamp);
  if ([...bids, ...asks].some((l) => !Number.isFinite(l.price) || !Number.isFinite(l.size)) || !Number.isFinite(ts)) {
    throw new BookError("unexpected order book format", "format");
  }
  // Bithumb lists levels with size 0, sometimes at the top of the book
  bids = bids.filter((l) => l.price > 0 && l.size > 0);
  asks = asks.filter((l) => l.price > 0 && l.size > 0);
  if (!bids.length || !asks.length || asks[0].price <= bids[0].price) {
    return {
      bids,
      asks,
      obs: {
        ts, mid: "0", best_bid: "0", best_ask: "0", spread_bps: 10_000,
        bid_depth: 0, ask_depth: 0, bid_truncated: false, ask_truncated: false, pass: false,
      },
    };
  }
  const bid = bids[0].price;
  const ask = asks[0].price;
  const mid = (bid + ask) / 2;
  const lo = mid * (1 - terms.band_bps / 10_000);
  const hi = mid * (1 + terms.band_bps / 10_000);
  const bidDepth = bids.filter((l) => l.price >= lo).reduce((s, l) => s + l.price * l.size, 0);
  const askDepth = asks.filter((l) => l.price <= hi).reduce((s, l) => s + l.price * l.size, 0);
  const spread = Math.ceil(((ask - bid) / mid) * 10_000 - 1e-9);
  const obs: Observation = {
    ts,
    mid: String(Math.round(mid * 1e8) / 1e8),
    best_bid: String(bid),
    best_ask: String(ask),
    spread_bps: spread,
    bid_depth: Math.floor(bidDepth),
    ask_depth: Math.floor(askDepth),
    bid_truncated: bids[bids.length - 1].price >= lo,
    ask_truncated: asks[asks.length - 1].price <= hi,
    pass: false,
  };
  obs.pass = obs.spread_bps <= terms.max_spread_bps && obs.bid_depth >= terms.min_depth_krw && obs.ask_depth >= terms.min_depth_krw;
  return { obs, bids, asks };
}

export async function snapshot(venue: Venue, market: string, terms: Terms): Promise<BookSnapshot> {
  const raw = await fetchBook(venue, market);
  const { obs, bids, asks } = measure(raw, terms);
  return { venue, market, fetchedAt: Date.now(), bids, asks, levels: (raw.orderbook_units ?? []).length, obs };
}

/** Below this headroom the preview warns that validators may split (a UI hint, not a contract rule). */
export const NEAR_LINE_PCT = 20;

/**
 * Headroom to the thresholds, in % of each threshold: positive = on the passing side.
 * Since v2 a validator votes for the leader only if it computes the same pass bit from its own
 * fetch, so a book near the line can end with no consensus (nothing recorded) rather than with
 * the leader's verdict.
 */
export function headroom(obs: Observation, terms: Terms): { spreadPct: number; depthPct: number; near: boolean } {
  const spreadPct = ((terms.max_spread_bps - obs.spread_bps) / terms.max_spread_bps) * 100;
  const depthPct = ((Math.min(obs.bid_depth, obs.ask_depth) - terms.min_depth_krw) / terms.min_depth_krw) * 100;
  const binding = obs.pass ? Math.min(spreadPct, depthPct) : Math.max(-spreadPct, -depthPct);
  return { spreadPct, depthPct, near: binding < NEAR_LINE_PCT };
}
