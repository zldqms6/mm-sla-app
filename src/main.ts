import "./style.css";
import {
  CONTRACT,
  EXPLORER,
  LIMITS,
  createBurner,
  exportPk,
  forgetBurner,
  fundAccount,
  getAccount,
  getAgreement,
  getBalance,
  getCount,
  getCurrentSlot,
  getSlot,
  onReadRetry,
  sendTx,
  throwawayAddress,
  type Agreement,
  type Observation,
  type SlotState,
  type Terms,
  type TxOutcome,
  type Venue,
} from "./chain";
import { BookError, MARKET_RE, clearness, snapshot, type BookSnapshot } from "./book";
import { bpsPct, duration, esc, fromKstInput, gen, kst, krw, nowSec, parseGen, relTime, short, toKstInput } from "./format";

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) =>
  Array.from(root.querySelectorAll(sel)) as T[];

const PAGE = 12;
const SLOT_WINDOW = 12;
const VENUE_NAME: Record<Venue, string> = { upbit: "Upbit", bithumb: "Bithumb" };

const app = $("#app");
const view = () => $("#view");

/* =====================================================================
   Shell
   ===================================================================== */

app.innerHTML = `
  <header class="top">
    <div class="top-inner">
      <a class="brand" href="#/">
        <span class="logo" aria-hidden="true"><svg viewBox="0 0 32 32"><path d="M8 13h16M8 19h16" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/><path d="M12 9v4M20 19v4" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg></span>
        <span class="brand-text"><b>MM SLA Escrow</b><small>retainers paid by the order book</small></span>
      </a>
      <nav class="tabs" aria-label="Screens">
        <a href="#/" data-tab="list">Agreements</a>
        <a href="#/create" data-tab="create">New agreement</a>
        <a href="#/how" data-tab="how">How it works</a>
      </nav>
      <div class="top-right">
        <span class="net" title="GenLayer Studionet. Testnet, GEN here has no value."><i></i>Studionet</span>
        <button class="wallet-btn" id="wallet-btn" type="button"></button>
      </div>
    </div>
  </header>
  <div class="net-note wrap" id="net-note" hidden></div>
  <main id="view" class="wrap"></main>
  <footer class="foot wrap">
    <div>
      <b>Who decides.</b> Neither the project nor the market maker. Each GenLayer validator fetches the public order book itself, measures it with the code in the contract, and has to agree with the leader before a slot is recorded.
    </div>
    <div class="foot-meta">
      Contract <a href="${EXPLORER}/address/${CONTRACT}" target="_blank" rel="noopener"><code>${short(CONTRACT, 8)}</code></a>
      · GenLayer Studionet · testnet only, no real funds
    </div>
  </footer>
  <aside class="dock" id="dock" hidden></aside>
  <dialog class="sheet" id="wallet-sheet"></dialog>
`;

onReadRetry((waitS) => {
  const n = $("#net-note");
  n.hidden = waitS === null;
  if (waitS !== null)
    n.textContent = `Studionet refused a read, most likely its limit of 30 contract reads per minute per IP. Retrying in ${waitS} s…`;
});

/* Agreements read by the list are reused by the detail page for a short while; settled ones never change. */
const agCache = new Map<number, { at: number; a: Agreement }>();
async function loadAgreement(id: number, fresh = false): Promise<Agreement> {
  const c = agCache.get(id);
  if (!fresh && c && (c.a.settled || Date.now() - c.at < 20_000)) return c.a;
  const a = await getAgreement(id);
  agCache.set(id, { at: Date.now(), a });
  return a;
}

/* =====================================================================
   Wallet
   ===================================================================== */

let balance: bigint | null = null;

async function refreshBalance() {
  const acc = getAccount();
  if (!acc) balance = null;
  else {
    try {
      balance = await getBalance(acc.address);
    } catch {
      /* keep last */
    }
  }
  paintWalletBtn();
  if (($("#wallet-sheet") as HTMLDialogElement).open) paintWalletSheet();
}

function paintWalletBtn() {
  const acc = getAccount();
  const b = $("#wallet-btn");
  b.innerHTML = acc
    ? `<span class="dot"></span><span class="mono">${short(acc.address, 5)}</span><span class="bal">${balance === null ? "…" : gen(balance)} GEN</span>`
    : `Create wallet`;
  b.classList.toggle("empty", !acc);
}

function paintWalletSheet(msg = "") {
  const sheet = $("#wallet-sheet") as HTMLDialogElement;
  const acc = getAccount();
  sheet.innerHTML = `
    <form method="dialog" class="sheet-head">
      <h2>Testnet wallet</h2>
      <button class="icon-btn" aria-label="Close">✕</button>
    </form>
    <div class="callout warn">
      A <b>throwaway testnet key</b> made in this browser and kept in its localStorage. Don't send real assets to it. Studionet GEN has no value.
    </div>
    ${
      acc
        ? `<dl class="kv">
            <dt>Address</dt><dd><code class="mono break">${acc.address}</code> <button class="link-btn" data-copy="${acc.address}" type="button">copy</button></dd>
            <dt>Balance</dt><dd><b class="big">${balance === null ? "…" : gen(balance, 4)}</b> GEN</dd>
          </dl>
          <div class="row gap mt">
            <button class="btn primary" id="w-fund" type="button">Get 100 test GEN</button>
            <a class="btn ghost" href="${EXPLORER}/address/${acc.address}" target="_blank" rel="noopener">Explorer</a>
          </div>
          <details class="adv"><summary>Advanced</summary>
            <div class="row gap mt">
              <button class="btn ghost" id="w-export" type="button">Show private key</button>
              <button class="btn danger" id="w-forget" type="button">Delete wallet</button>
            </div>
            <div id="w-pk"></div>
          </details>`
        : `<button class="btn primary mt" id="w-create" type="button">Create a testnet wallet</button>`
    }
    <div class="sheet-msg" id="w-msg">${msg}</div>
  `;
  $("#w-create", sheet)?.addEventListener("click", async () => {
    createBurner();
    paintWalletSheet(`<span class="muted">Wallet created. Funding it with 100 test GEN…</span>`);
    await doFund();
  });
  $("#w-fund", sheet)?.addEventListener("click", doFund);
  $("#w-export", sheet)?.addEventListener("click", () => {
    $("#w-pk", sheet).innerHTML = `<p class="small muted mt">Anyone with this key controls the wallet.</p><code class="mono break block">${esc(exportPk() ?? "")}</code>`;
  });
  $("#w-forget", sheet)?.addEventListener("click", () => {
    if (!confirm("Delete this wallet's key from the browser? Test GEN in it will be unreachable.")) return;
    forgetBurner();
    refreshBalance();
    paintWalletSheet();
  });
  $$("[data-copy]", sheet).forEach((b) => b.addEventListener("click", () => navigator.clipboard?.writeText(b.dataset.copy!)));
}

async function doFund() {
  const acc = getAccount();
  if (!acc) return;
  const m = () => $("#w-msg");
  if (m()) m().innerHTML = `<span class="muted">Calling sim_fundAccount…</span>`;
  try {
    await fundAccount(acc.address);
    await refreshBalance();
    if (m()) m().innerHTML = `<span class="ok-t">Funded with 100 test GEN.</span>`;
  } catch (e: any) {
    if (m())
      m().innerHTML = `<span class="no-t">Faucet failed: ${esc(e?.message ?? e)}</span>
        <p class="small muted">Same call from a terminal:</p>
        <code class="mono break block">curl -X POST https://studio.genlayer.com/api -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"sim_fundAccount","params":["${acc.address}",100000000000000000000]}'</code>`;
  }
}

$("#wallet-btn").addEventListener("click", () => {
  paintWalletSheet();
  ($("#wallet-sheet") as HTMLDialogElement).showModal();
});

/* =====================================================================
   Transactions: one at a time, shown in a dock
   ===================================================================== */

let busy = false;

async function runTx(label: string, fn: string, args: (string | number | boolean)[], value: bigint): Promise<TxOutcome | null> {
  if (busy) return null;
  if (!getAccount()) {
    paintWalletSheet(`<span class="no-t">Create and fund a wallet first.</span>`);
    ($("#wallet-sheet") as HTMLDialogElement).showModal();
    return null;
  }
  busy = true;
  const dock = $("#dock");
  dock.hidden = false;
  const t0 = Date.now();
  let hash = "";
  let phase = "Signing";
  const paint = (extra = "") => {
    const secs = Math.round((Date.now() - t0) / 1000);
    dock.innerHTML = `<div class="dock-in"><span class="spin"></span><div><b>${esc(label)}</b>
      <div class="small muted">${phase} · ${secs}s${hash ? ` · <a href="${EXPLORER}/tx/${hash}" target="_blank" rel="noopener" class="mono">${short(hash, 8)}</a>` : ""}</div>${extra}</div></div>`;
  };
  paint();
  const timer = setInterval(() => paint(), 1000);
  try {
    const r = await sendTx(fn, args, value, (p, h) => {
      if (h) hash = h;
      phase = p === "signing" ? "Signing" : "Waiting for validators";
      paint();
    });
    clearInterval(timer);
    const secs = Math.round((Date.now() - t0) / 1000);
    const link = `<a href="${EXPLORER}/tx/${r.hash}" target="_blank" rel="noopener" class="mono">${short(r.hash ?? "", 8)}</a>`;
    dock.innerHTML = r.ok
      ? `<div class="dock-in ok"><b>${esc(label)}: accepted</b><div class="small muted">${secs}s · ${link}${r.votes.length ? ` · votes ${esc(r.votes.join(", "))}` : ""}</div><button class="icon-btn" data-close>✕</button></div>`
      : `<div class="dock-in bad"><b>${esc(label)}: not applied</b><div class="small">${esc(r.message)}</div><div class="small muted">Validators agreed the call failed, nothing changed on chain. ${secs}s · ${link}</div><button class="icon-btn" data-close>✕</button></div>`;
    $("[data-close]", dock)?.addEventListener("click", () => (dock.hidden = true));
    refreshBalance();
    return r;
  } catch (e: any) {
    clearInterval(timer);
    dock.innerHTML = `<div class="dock-in bad"><b>${esc(label)}: error</b><div class="small">${esc(e?.shortMessage ?? e?.message ?? e)}</div><button class="icon-btn" data-close>✕</button></div>`;
    $("[data-close]", dock)?.addEventListener("click", () => (dock.hidden = true));
    return null;
  } finally {
    busy = false;
  }
}

/* =====================================================================
   Helpers shared by screens
   ===================================================================== */

type Phase = { key: "pending" | "running" | "ended" | "settled"; slot: number };

/** Term phase by this browser's clock (the contract uses its own; the detail page also reads current_slot). */
function phaseOf(a: Agreement, slotFromChain?: number): Phase {
  const slot = slotFromChain ?? (nowSec() < a.start ? -1 : Math.min(Math.floor((nowSec() - a.start) / a.interval_s), a.n_slots));
  if (a.settled) return { key: "settled", slot };
  if (slot < 0) return { key: "pending", slot };
  if (slot >= a.n_slots) return { key: "ended", slot };
  return { key: "running", slot };
}

const endOf = (a: Agreement) => a.start + a.interval_s * a.n_slots;

function phasePill(a: Agreement, p: Phase): string {
  switch (p.key) {
    case "pending":
      return `<span class="pill wait">Starts ${relTime(a.start)}</span>`;
    case "running":
      return `<span class="pill live">Slot ${p.slot + 1} of ${a.n_slots}</span>`;
    case "ended":
      return `<span class="pill wait">Ended, not settled</span>`;
    case "settled":
      return `<span class="pill done">Settled</span>`;
  }
}

/** Payout under the contract's settle() formula with the current counts. */
function payoutNow(a: Agreement) {
  const met = a.passed * 100 >= a.terms.min_uptime_pct * a.n_slots;
  const toMm = met ? (a.retainer * BigInt(a.passed)) / BigInt(a.n_slots) : 0n;
  return { met, toMm, toProject: a.retainer - toMm };
}

function termsLine(t: Terms): string {
  return `spread ≤ ${t.max_spread_bps} bps · ≥ ${krw(t.min_depth_krw)} won each side within ±${bpsPct(t.band_bps)} of mid · min ${t.min_uptime_pct}% of slots`;
}

function obsBlock(o: Observation, t: Terms, title: string, note = ""): string {
  const row = (label: string, val: string, limit: string, ok: boolean, extra = "") =>
    `<tr><th>${label}</th><td class="num">${val}</td><td class="num muted">${limit}</td><td>${ok ? `<span class="ok-t">✓</span>` : `<span class="no-t">✗</span>`}${extra}</td></tr>`;
  const empty = o.mid === "0";
  return `
    <div class="obs ${o.pass ? "pass" : "fail"}">
      <div class="obs-head"><b>${title}</b><span class="pill ${o.pass ? "done" : "bad"}">${o.pass ? "PASS" : "FAIL"}</span></div>
      ${empty ? `<p class="small">One side of the book was empty or crossed, so there was nothing to measure: counts as a fail.</p>` : ""}
      <table class="obs-t">
        <thead><tr><th></th><th class="num">measured</th><th class="num">required</th><th></th></tr></thead>
        <tbody>
          ${row("Spread", `${o.spread_bps} bps`, `≤ ${t.max_spread_bps} bps`, o.spread_bps <= t.max_spread_bps)}
          ${row("Bid depth", `${krw(o.bid_depth)} won`, `≥ ${krw(t.min_depth_krw)}`, o.bid_depth >= t.min_depth_krw, o.bid_truncated ? ` <span class="tiny muted" title="All visible levels sit inside the band; true depth is larger.">lower bound</span>` : "")}
          ${row("Ask depth", `${krw(o.ask_depth)} won`, `≥ ${krw(t.min_depth_krw)}`, o.ask_depth >= t.min_depth_krw, o.ask_truncated ? ` <span class="tiny muted" title="All visible levels sit inside the band; true depth is larger.">lower bound</span>` : "")}
        </tbody>
      </table>
      <div class="tiny muted">best bid ${esc(o.best_bid)} · best ask ${esc(o.best_ask)} · mid ${esc(o.mid)} · book time ${kst(Math.floor(o.ts / 1000), true)}${note}</div>
    </div>`;
}

/* ---------- live order book preview ---------- */

function previewShell(id: string): string {
  return `<section class="card" id="${id}">
    <div class="card-head"><h3>Live order book <small>fetched by your browser</small></h3><button class="btn ghost sm" data-refresh type="button">Refresh</button></div>
    <div data-body><p class="muted small">Loading…</p></div>
  </section>`;
}

async function paintPreview(root: HTMLElement, venue: Venue, market: string, terms: Terms) {
  const body = $("[data-body]", root);
  body.innerHTML = `<p class="muted small">Fetching ${esc(VENUE_NAME[venue])} ${esc(market)}…</p>`;
  let s: BookSnapshot;
  try {
    s = await snapshot(venue, market, terms);
  } catch (e: any) {
    const kind = e instanceof BookError ? e.kind : "http";
    body.innerHTML = `<div class="callout ${kind === "blocked" ? "warn" : "bad"}">${esc(e?.message ?? e)}</div>
      ${kind === "no-market" ? `<p class="small muted">A check() on this market would end with <code>[EXTERNAL] ${esc(venue)} has no market ${esc(market)}</code> and record nothing.</p>` : ""}`;
    return;
  }
  const c = clearness(s.obs, terms);
  const verdict =
    c === "clear-pass"
      ? `Clearly passing: spread at most half the limit and both sides at least twice the minimum. Validators should agree on PASS even if the book moves a little.`
      : c === "clear-fail"
        ? `Clearly failing: spread at least twice the limit or one side at most half the minimum. A check now would almost certainly record FAIL, and that slot can't be recovered.`
        : `Borderline. Validators fetch a few seconds apart and only reject the leader on a clear contradiction, so the leader's own snapshot decides. ${s.obs.pass ? "It may pass or fail." : "Likely to fail."}`;
  const mid = Number(s.obs.mid);
  const lo = mid * (1 - terms.band_bps / 10_000);
  const hi = mid * (1 + terms.band_bps / 10_000);
  const rows = Math.min(10, Math.max(s.bids.length, s.asks.length));
  let ladder = "";
  for (let i = 0; i < rows; i++) {
    const b = s.bids[i];
    const a = s.asks[i];
    ladder += `<tr>
      <td class="num ${b && b.price >= lo ? "" : "out"}">${b ? krw(b.price * b.size) : ""}</td>
      <td class="num bid ${b && b.price >= lo ? "" : "out"}">${b ? b.price.toLocaleString("en-US", { maximumFractionDigits: 8 }) : ""}</td>
      <td class="num ask ${a && a.price <= hi ? "" : "out"}">${a ? a.price.toLocaleString("en-US", { maximumFractionDigits: 8 }) : ""}</td>
      <td class="num ${a && a.price <= hi ? "" : "out"}">${a ? krw(a.price * a.size) : ""}</td></tr>`;
  }
  body.innerHTML = `
    ${obsBlock(s.obs, terms, "If a check ran on this snapshot", ` · fetched ${new Date(s.fetchedAt).toLocaleTimeString("en-GB")}`)}
    <p class="small mt">${verdict}</p>
    ${
      mid > 0
        ? `<details class="adv"><summary>Top ${rows} levels (won value per level; grey = outside ±${bpsPct(terms.band_bps)} band)</summary>
          <table class="ladder"><thead><tr><th class="num">bid value</th><th class="num">bid</th><th class="num">ask</th><th class="num">ask value</th></tr></thead><tbody>${ladder}</tbody></table>
          <p class="tiny muted">${s.levels} levels returned per side${s.levels - s.bids.length || s.levels - s.asks.length ? `; ${s.levels - s.bids.length} bid / ${s.levels - s.asks.length} ask levels had size 0 and were skipped, as the contract does` : ""}.</p>
        </details>`
        : ""
    }
    <p class="tiny muted">This is one snapshot from your browser using a copy of the contract's measuring code. It is not a vote and is not recorded anywhere.</p>`;
}

function mountPreview(root: HTMLElement, get: () => { venue: Venue; market: string; terms: Terms } | null) {
  const run = () => {
    const p = get();
    if (!p) {
      $("[data-body]", root).innerHTML = `<p class="muted small">Enter a valid market (like KRW-XRP) and terms to preview.</p>`;
      return;
    }
    paintPreview(root, p.venue, p.market, p.terms);
  };
  $("[data-refresh]", root).addEventListener("click", run);
  run();
  return run;
}

/* =====================================================================
   Screen: agreements list
   ===================================================================== */

let listShown = PAGE;

async function screenList() {
  const v = view();
  v.innerHTML = `
    <section class="hero">
      <h1>Pay the market maker for the hours the book was actually there</h1>
      <p>A token project locks a market maker's retainer here with fixed terms: max spread, and won depth on each side near mid. The term is cut into time slots. Anyone can press <b>Check</b> during a slot; GenLayer validators each read the live Upbit or Bithumb order book and record pass or fail. At the end, the MM gets the share of slots that passed and the project gets the rest back.</p>
      <div class="row gap"><a class="btn primary" href="#/create">New agreement</a><a class="btn ghost" href="#/how">How the checking works</a></div>
    </section>
    <div class="list-head"><h2>Agreements</h2><span class="muted small" id="count"></span></div>
    <div class="grid" id="grid"><p class="muted">Reading the contract…</p></div>
    <div class="row end mt" id="more"></div>`;
  let n: number;
  try {
    n = await getCount();
  } catch (e: any) {
    $("#grid").innerHTML = `<div class="callout bad">Couldn't read the contract: ${esc(e?.shortMessage ?? e?.message ?? e)}</div>`;
    return;
  }
  $("#count").textContent = `${n} on chain`;
  if (!n) {
    $("#grid").innerHTML = `<p class="muted">No agreements yet.</p>`;
    return;
  }
  const ids = Array.from({ length: Math.min(listShown, n) }, (_, i) => n - 1 - i);
  $("#grid").innerHTML = ids.map((id) => `<a class="card ag" href="#/a/${id}" data-id="${id}"><p class="muted small">#${id} loading…</p></a>`).join("");
  if (n > listShown) {
    $("#more").innerHTML = `<button class="btn ghost" type="button">Load older</button>`;
    $("button", $("#more")).addEventListener("click", () => {
      listShown += PAGE;
      screenList();
    });
  }
  // a few at a time: Studionet limits each IP to about 30 RPC calls a minute
  for (let i = 0; i < ids.length; i += 4) {
    await Promise.all(
      ids.slice(i, i + 4).map(async (id) => {
        const el = $(`[data-id="${id}"]`);
        try {
          const a = await loadAgreement(id);
          if (el) el.innerHTML = agCard(a);
        } catch (e: any) {
          if (el) el.innerHTML = `<p class="no-t small">#${id}: ${esc(e?.shortMessage ?? e?.message ?? e)}</p>`;
        }
      }),
    );
  }
}

function agCard(a: Agreement): string {
  const p = phaseOf(a);
  const elapsed = Math.max(0, Math.min(p.slot, a.n_slots));
  const unchecked = Math.max(0, elapsed - a.passed - a.failed);
  return `
    <div class="ag-top"><span class="mono muted">#${a.id}</span>${phasePill(a, p)}</div>
    <div class="ag-mkt"><b>${esc(a.market)}</b> <span class="muted">on ${VENUE_NAME[a.venue] ?? esc(a.venue)}</span></div>
    <div class="ag-ret"><b>${gen(a.retainer)}</b> GEN retainer${a.settled ? ` · <b>${gen(a.paid_mm)}</b> paid to MM` : ""}</div>
    <div class="bar">${slotBar(a)}</div>
    <div class="small"><span class="ok-t">${a.passed} passed</span> · <span class="no-t">${a.failed} failed</span>${unchecked ? ` · <span class="muted">${unchecked} unchecked</span>` : ""} · ${a.n_slots} × ${duration(a.interval_s)}</div>
    <div class="tiny muted">${termsLine(a.terms)}</div>`;
}

function slotBar(a: Agreement): string {
  const w = (x: number) => `${((x / a.n_slots) * 100).toFixed(2)}%`;
  return `<i class="ok" style="width:${w(a.passed)}"></i><i class="bad" style="width:${w(a.failed)}"></i>`;
}

/* =====================================================================
   Screen: agreement detail
   ===================================================================== */

const slotCache = new Map<string, SlotState>();
let lastCheck: { id: number; slot: number; state: SlotState; tx: TxOutcome } | null = null;

async function screenAgreement(id: number, fresh = false) {
  const v = view();
  v.innerHTML = `<p class="muted">Reading agreement #${id}…</p>`;
  let a: Agreement, cur: number;
  try {
    [a, cur] = await Promise.all([loadAgreement(id, fresh), getCurrentSlot(id)]);
  } catch (e: any) {
    v.innerHTML = `<div class="callout bad">Couldn't read agreement #${id}: ${esc(e?.shortMessage ?? e?.message ?? e)}</div><a href="#/">Back</a>`;
    return;
  }
  const p = phaseOf(a, cur);
  const me = getAccount()?.address.toLowerCase();
  const role = me === a.project.toLowerCase() ? "project" : me === a.mm.toLowerCase() ? "market maker" : "";
  const pay = payoutNow(a);
  const elapsed = Math.max(0, Math.min(cur, a.n_slots));
  const unchecked = Math.max(0, elapsed - a.passed - a.failed);
  const canSettle = p.key === "ended";
  // the current slot's state decides whether the contract would accept another check
  let curState: SlotState | undefined;
  if (p.key === "running") {
    curState = await getSlot(id, cur).catch(() => undefined);
    if (curState) slotCache.set(`${id}:${cur}`, curState);
  }
  const slotEnd = a.start + (cur + 1) * a.interval_s;
  const blocked =
    curState?.status === "fail"
      ? `Slot ${cur + 1} already failed, so the contract refuses further checks in it.`
      : curState && curState.checks >= LIMITS.maxChecksPerSlot
        ? `Slot ${cur + 1} already has ${LIMITS.maxChecksPerSlot} checks, the maximum; it stays ${curState.status}.`
        : "";
  const canCheck = p.key === "running" && !blocked;

  v.innerHTML = `
    <a href="#/" class="back small">← Agreements</a>
    <div class="detail-head">
      <h1>${esc(a.market)} <small>on ${VENUE_NAME[a.venue] ?? esc(a.venue)} · agreement #${a.id}</small></h1>
      ${phasePill(a, p)}
      ${role ? `<span class="pill">you are the ${role}</span>` : ""}
    </div>
    <div class="cols">
      <div class="col">
        <section class="card">
          <h3>Action</h3>
          ${
            canCheck
              ? `<p class="small">Slot <b>${cur + 1}</b> of ${a.n_slots} runs until ${kst(slotEnd)} (${relTime(slotEnd)}). A check asks validators to read the book now. One failing check fails this slot for good; at most ${LIMITS.maxChecksPerSlot} checks per slot.</p>
                 ${curState?.status === "pass" ? `<p class="small">This slot has passed ${curState.checks} check${curState.checks === 1 ? "" : "s"} so far. Another check can still fail it.</p>` : ""}
                 <button class="btn primary" id="do-check" type="button">Check now</button>`
              : p.key === "running"
                ? `<p class="small">${blocked} ${cur + 1 < a.n_slots ? `The next slot starts ${kst(slotEnd)} (${relTime(slotEnd)}).` : `The term ends ${kst(slotEnd)} (${relTime(slotEnd)}); then it can be settled.`}</p>`
              : canSettle
                ? `<p class="small">The term ended ${relTime(endOf(a))}. Settling pays the market maker ${a.passed} / ${a.n_slots} of the retainer${pay.met ? "" : ` (but ${a.passed} / ${a.n_slots} is below the ${a.terms.min_uptime_pct}% minimum, so 0)`} and returns the rest to the project. Anyone can settle.</p>
                   <button class="btn primary" id="do-settle" type="button">Settle</button>`
                : p.key === "pending"
                  ? `<p class="small">The term starts ${kst(a.start)} (${relTime(a.start)}). Checks are possible from then on.</p>`
                  : `<p class="small">Settled. ${gen(a.paid_mm)} GEN went to the market maker and ${gen(a.retainer - a.paid_mm)} GEN back to the project.</p>`
          }
          <div id="check-result"></div>
        </section>
        <section class="card">
          <h3>Slots</h3>
          <div class="stats">
            <div><b class="ok-t">${a.passed}</b><span>passed</span></div>
            <div><b class="no-t">${a.failed}</b><span>failed</span></div>
            <div><b>${unchecked}</b><span>past, unchecked</span></div>
            <div><b>${Math.max(0, a.n_slots - elapsed)}</b><span>${p.key === "running" ? "current + future" : "future"}</span></div>
          </div>
          <p class="tiny muted">A past slot nobody checked counts as failed at settlement. A slot shown as passed can still turn to failed if a later check in the same slot fails.</p>
          <div class="timeline" id="timeline"></div>
          <div class="row gap mt" id="tl-nav"></div>
          <div id="slot-detail"></div>
        </section>
        <div id="preview-slot"></div>
      </div>
      <div class="col side">
        <section class="card">
          <h3>Terms</h3>
          <dl class="kv">
            <dt>Max spread</dt><dd>${a.terms.max_spread_bps} bps (${bpsPct(a.terms.max_spread_bps)})</dd>
            <dt>Depth band</dt><dd>±${a.terms.band_bps} bps (${bpsPct(a.terms.band_bps)}) around mid</dd>
            <dt>Min depth</dt><dd>${a.terms.min_depth_krw.toLocaleString("en-US")} won on each side</dd>
            <dt>Min uptime</dt><dd>${a.terms.min_uptime_pct}% of slots, else nothing is paid</dd>
            <dt>Slots</dt><dd>${a.n_slots} × ${duration(a.interval_s)}</dd>
            <dt>Start</dt><dd>${kst(a.start)}</dd>
            <dt>End</dt><dd>${kst(endOf(a))}</dd>
            <dt>Retainer</dt><dd><b>${gen(a.retainer, 4)}</b> GEN</dd>
            <dt>Project</dt><dd><a class="mono" href="${EXPLORER}/address/${a.project}" target="_blank" rel="noopener">${short(a.project)}</a></dd>
            <dt>Market maker</dt><dd><a class="mono" href="${EXPLORER}/address/${a.mm}" target="_blank" rel="noopener">${short(a.mm)}</a></dd>
          </dl>
        </section>
        <section class="card">
          <h3>${a.settled ? "Payout" : "Payout if settled with the current counts"}</h3>
          ${
            a.settled
              ? `<dl class="kv"><dt>To market maker</dt><dd><b>${gen(a.paid_mm, 4)}</b> GEN</dd><dt>Back to project</dt><dd><b>${gen(a.retainer - a.paid_mm, 4)}</b> GEN</dd><dt>Slots passed</dt><dd>${a.passed} / ${a.n_slots}</dd></dl>`
              : `<dl class="kv"><dt>To market maker</dt><dd><b>${gen(pay.toMm, 4)}</b> GEN</dd><dt>Back to project</dt><dd><b>${gen(pay.toProject, 4)}</b> GEN</dd></dl>
                 <p class="tiny muted">retainer × passed / ${a.n_slots}, or 0 if passed is under ${a.terms.min_uptime_pct}% of slots. Counts can still change until the term ends.</p>`
          }
        </section>
      </div>
    </div>`;

  // live preview only makes sense while checks are possible
  if (p.key === "running" || p.key === "pending") {
    $("#preview-slot").innerHTML = previewShell("pv");
    mountPreview($("#pv"), () => ({ venue: a.venue, market: a.market, terms: a.terms }));
  }

  if (lastCheck && lastCheck.id === id) paintCheckResult(a, lastCheck.slot, lastCheck.state);
  else if (curState?.obs) paintCheckResult(a, cur, curState);

  $("#do-check")?.addEventListener("click", async (ev) => {
    (ev.target as HTMLButtonElement).disabled = true;
    const slotBefore = await getCurrentSlot(id).catch(() => cur);
    const r = await runTx(`Check #${id} slot ${slotBefore + 1}`, "check", [id], 0n);
    if (!r) {
      (ev.target as HTMLButtonElement).disabled = false;
      return;
    }
    if (!r.ok) {
      $("#check-result").innerHTML = `<div class="callout bad mt">${esc(r.message)}</div>`;
      (ev.target as HTMLButtonElement).disabled = false;
      return;
    }
    // the slot the contract used is in its return value; fall back to the one read before sending
    const slot = slotFromReturn(r.returned) ?? slotBefore;
    const state = await getSlot(id, slot);
    slotCache.set(`${id}:${slot}`, state);
    lastCheck = { id, slot, state, tx: r };
    screenAgreement(id, true);
  });
  $("#do-settle")?.addEventListener("click", async (ev) => {
    (ev.target as HTMLButtonElement).disabled = true;
    const r = await runTx(`Settle #${id}`, "settle", [id], 0n);
    if (r?.ok) screenAgreement(id, true);
    else (ev.target as HTMLButtonElement).disabled = false;
  });

  paintTimeline(a, cur, Math.max(0, Math.min(cur, a.n_slots - 1) - SLOT_WINDOW + 1));
}

function slotFromReturn(readable?: string): number | null {
  const m = String(readable ?? "").match(/"slot"\s*:\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

function paintCheckResult(a: Agreement, slot: number, s: SlotState) {
  const el = $("#check-result");
  if (!el || !s.obs) return;
  el.innerHTML = `<div class="mt">${obsBlock(s.obs, a.terms, `Last recorded check, slot ${slot + 1} (slot is ${s.status})`, ` · ${s.checks} check${s.checks === 1 ? "" : "s"} in this slot`)}</div>`;
}

async function paintTimeline(a: Agreement, cur: number, from: number) {
  const tl = $("#timeline");
  if (!tl) return;
  const to = Math.min(a.n_slots, from + SLOT_WINDOW);
  const lastPast = Math.min(cur, a.n_slots - 1); // slots up to here may have state
  tl.innerHTML = Array.from({ length: to - from }, (_, k) => {
    const i = from + k;
    const future = i > lastPast || cur < 0;
    return `<button type="button" class="slot ${future ? "future" : "loading"}${i === cur ? " now" : ""}" data-slot="${i}" title="slot ${i + 1}: ${kst(a.start + i * a.interval_s)}">${i + 1}</button>`;
  }).join("");
  const nav = $("#tl-nav");
  nav.innerHTML = `<span class="tiny muted">Slots ${from + 1}-${to} of ${a.n_slots}</span>
    ${from > 0 ? `<button class="btn ghost sm" data-go="${Math.max(0, from - SLOT_WINDOW)}" type="button">Earlier</button>` : ""}
    ${to < a.n_slots ? `<button class="btn ghost sm" data-go="${to}" type="button">Later</button>` : ""}
    <span class="legend tiny"><i class="ok"></i>pass <i class="bad"></i>fail <i class="un"></i>unchecked <i class="fu"></i>future</span>`;
  $$("[data-go]", nav).forEach((b) => b.addEventListener("click", () => paintTimeline(a, cur, Number(b.dataset.go))));
  $$(".slot", tl).forEach((b) =>
    b.addEventListener("click", () => {
      $$(".slot.sel", tl).forEach((x) => x.classList.remove("sel"));
      b.classList.add("sel");
      showSlot(a, Number(b.dataset.slot), cur);
    }),
  );
  if (cur < 0) return;
  if (a.passed + a.failed === 0) {
    // no check has ever been recorded: every started slot is unchecked, no need to read them
    $$(".slot.loading", tl).forEach((el) => el.classList.replace("loading", "un"));
    return;
  }
  const need = Array.from({ length: Math.max(0, Math.min(to - 1, lastPast) - from + 1) }, (_, k) => from + k);
  for (let i = 0; i < need.length; i += 4) {
    await Promise.all(
      need.slice(i, i + 4).map(async (n) => {
        const key = `${a.id}:${n}`;
        let s = slotCache.get(key);
        if (!s || n >= cur) {
          try {
            s = await getSlot(a.id, n);
            slotCache.set(key, s);
          } catch {
            return;
          }
        }
        const el = $(`.slot[data-slot="${n}"]`, tl);
        if (el) {
          el.classList.remove("loading");
          el.classList.add(s.status === "pass" ? "ok" : s.status === "fail" ? "bad" : "un");
        }
      }),
    );
  }
}

async function showSlot(a: Agreement, n: number, cur: number) {
  const box = $("#slot-detail");
  const range = `${kst(a.start + n * a.interval_s)} to ${kst(a.start + (n + 1) * a.interval_s)}`;
  if (n > cur || cur < 0) {
    box.innerHTML = `<p class="small mt">Slot ${n + 1} (${range}) hasn't started.</p>`;
    return;
  }
  let s = slotCache.get(`${a.id}:${n}`);
  if (!s) {
    box.innerHTML = `<p class="small muted mt">Reading slot ${n + 1}…</p>`;
    s = await getSlot(a.id, n);
    slotCache.set(`${a.id}:${n}`, s);
  }
  box.innerHTML = s.obs
    ? `<div class="mt">${obsBlock(s.obs, a.terms, `Slot ${n + 1}: ${s.status.toUpperCase()}`, ` · ${s.checks} check${s.checks === 1 ? "" : "s"} · last by ${short(s.by ?? "")}`)}<p class="tiny muted">${range}. Shows the last check's observation.</p></div>`
    : `<p class="small mt">Slot ${n + 1} (${range}): no check recorded${n < cur ? ", so it counts as failed at settlement" : " yet"}.</p>`;
}

/* =====================================================================
   Screen: create
   ===================================================================== */

function screenCreate() {
  const v = view();
  const start = nowSec() + 300;
  v.innerHTML = `
    <h1>New agreement <small>you are the project; the retainer is locked until settlement</small></h1>
    <div class="cols">
      <form class="card col form" id="cf" novalidate>
        <fieldset><legend>Market</legend>
          <label>Exchange<select name="venue"><option value="upbit">Upbit</option><option value="bithumb">Bithumb</option></select></label>
          <label>Market<input name="market" value="KRW-XRP" autocomplete="off" spellcheck="false" placeholder="KRW-XRP"/></label>
        </fieldset>
        <fieldset><legend>What the MM must keep</legend>
          <label>Max spread (bps)<input name="max_spread_bps" type="number" min="1" max="2000" value="20"/><span class="hint">1 bps = 0.01%. Spread is (ask − bid) / mid, rounded up.</span></label>
          <label>Depth band (bps)<input name="band_bps" type="number" min="10" max="1000" value="100"/><span class="hint">Only orders within this distance of mid count as depth. 100 = ±1%.</span></label>
          <label>Min depth each side (won)<input name="min_depth_krw" type="number" min="1" value="300000000"/><span class="hint">Won value of bids in the band, and of asks in the band, each at least this.</span></label>
          <label>Min uptime (%)<input name="min_uptime_pct" type="number" min="0" max="100" value="75"/><span class="hint">Below this share of passed slots the MM gets nothing.</span></label>
        </fieldset>
        <fieldset><legend>Term</legend>
          <label>Start (KST)<input name="start" type="datetime-local" value="${toKstInput(start)}"/><span class="hint">From 10 minutes ago up to 30 days ahead.</span></label>
          <label>Slot length (minutes)<input name="interval_m" type="number" min="10" max="1440" value="60"/><span class="hint">10 minutes to 24 hours.</span></label>
          <label>Number of slots<input name="n_slots" type="number" min="1" max="744" value="24"/><span class="hint" id="term-hint"></span></label>
        </fieldset>
        <fieldset><legend>Money</legend>
          <label>Market maker address<input name="mm" placeholder="0x…" autocomplete="off" spellcheck="false"/>
            <span class="hint">Receives its share at settlement. <button type="button" class="link-btn" id="throwaway">Use a throwaway address</button> (for trying the app: its key is discarded, so its payout is unreachable).</span></label>
          <label>Retainer (GEN)<input name="retainer" value="10" inputmode="decimal"/><span class="hint" id="bal-hint"></span></label>
        </fieldset>
        <div class="callout" id="cf-err" hidden></div>
        <button class="btn primary" type="submit">Lock retainer and create</button>
      </form>
      <div class="col side">${previewShell("cpv")}
        <section class="card"><h3>Before you lock funds</h3>
          <ul class="small tight">
            <li>Terms can't be changed after creation. Pick a band the 30 visible price levels cover; if every level sits inside the band, depth counts only what is visible.</li>
            <li>A slot nobody checks counts as failed. Plan for the MM (or a bot) to press Check once per slot.</li>
            <li>A typo in the market isn't caught here: the contract only learns the market doesn't exist at the first check.</li>
          </ul>
        </section>
      </div>
    </div>`;
  const f = $("#cf") as HTMLFormElement;
  const val = (n: string) => (f.elements.namedItem(n) as HTMLInputElement).value.trim();
  const readTerms = (): Terms => ({
    max_spread_bps: Number(val("max_spread_bps")),
    band_bps: Number(val("band_bps")),
    min_depth_krw: Number(val("min_depth_krw")),
    min_uptime_pct: Number(val("min_uptime_pct")),
  });
  const termsErr = (t: Terms): string | null => {
    if (!Object.values(t).every(Number.isInteger)) return "Terms must be whole numbers.";
    if (t.max_spread_bps < 1 || t.max_spread_bps > 2000) return "Max spread must be 1-2000 bps.";
    if (t.band_bps < 10 || t.band_bps > 1000) return "Depth band must be 10-1000 bps.";
    if (t.min_depth_krw < 1 || t.min_depth_krw > 1e13) return "Min depth must be positive.";
    if (t.min_uptime_pct < 0 || t.min_uptime_pct > 100) return "Min uptime must be 0-100.";
    return null;
  };
  const pv = $("#cpv");
  const rerun = mountPreview(pv, () => {
    const market = val("market").toUpperCase();
    const t = readTerms();
    return MARKET_RE.test(market) && !termsErr(t) ? { venue: val("venue") as Venue, market, terms: t } : null;
  });
  let deb: number | undefined;
  f.addEventListener("input", (e) => {
    const name = (e.target as HTMLInputElement).name;
    paintTermHint();
    if (["venue", "market", "max_spread_bps", "band_bps", "min_depth_krw"].includes(name)) {
      clearTimeout(deb);
      deb = window.setTimeout(rerun, 600);
    }
  });
  const paintTermHint = () => {
    const s = fromKstInput(val("start"));
    const m = Number(val("interval_m"));
    const n = Number(val("n_slots"));
    $("#term-hint").textContent = s && m > 0 && n > 0 ? `Up to 744. Term ends ${kst(s + m * 60 * n)}.` : "Up to 744.";
    $("#bal-hint").textContent = balance === null ? "Your wallet's balance will show here." : `Wallet balance: ${gen(balance)} GEN.`;
  };
  paintTermHint();
  $("#throwaway").addEventListener("click", () => {
    (f.elements.namedItem("mm") as HTMLInputElement).value = throwawayAddress();
  });

  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#cf-err");
    const fail = (m: string) => {
      err.hidden = false;
      err.className = "callout bad";
      err.textContent = m;
    };
    err.hidden = true;
    const venue = val("venue") as Venue;
    const market = val("market").toUpperCase();
    const terms = readTerms();
    const start = fromKstInput(val("start"));
    const intervalS = Number(val("interval_m")) * 60;
    const nSlots = Number(val("n_slots"));
    const mm = val("mm");
    const retainer = parseGen(val("retainer"));
    const now = nowSec();
    if (!MARKET_RE.test(market)) return fail("Market looks like KRW-XRP.");
    const te = termsErr(terms);
    if (te) return fail(te);
    if (!start) return fail("Pick a start time.");
    if (start < now - LIMITS.startGrace + 60 || start > now + LIMITS.maxStartDelay) return fail("Start must be from 10 minutes ago up to 30 days ahead.");
    if (!Number.isInteger(intervalS) || intervalS < LIMITS.minInterval || intervalS > LIMITS.maxInterval) return fail("Slot length must be 10-1440 minutes.");
    if (!Number.isInteger(nSlots) || nSlots < 1 || nSlots > LIMITS.maxSlots) return fail("Number of slots must be 1-744.");
    if (!/^0x[0-9a-fA-F]{40}$/.test(mm)) return fail("Market maker address must be a 0x… address.");
    if (getAccount() && mm.toLowerCase() === getAccount()!.address.toLowerCase()) return fail("The market maker can't be your own wallet.");
    if (!retainer || retainer <= 0n) return fail("Retainer must be a positive GEN amount.");
    if (balance !== null && retainer > balance) return fail(`Retainer is more than your balance (${gen(balance)} GEN).`);
    let id: number;
    try {
      id = await getCount();
    } catch (e: any) {
      return fail(`Couldn't read the contract: ${e?.message ?? e}`);
    }
    const r = await runTx(`Create agreement (${VENUE_NAME[venue]} ${market})`, "create_agreement",
      [mm, venue, market, JSON.stringify(terms), start, intervalS, nSlots], retainer);
    if (!r) return;
    if (!r.ok) return fail(r.message);
    // the new id is the count read before sending, unless someone else created one in between
    const m = String(r.returned ?? "").match(/^\s*(\d+)\s*$/);
    location.hash = `#/a/${m ? Number(m[1]) : id}`;
  });
}

/* =====================================================================
   Screen: how it works
   ===================================================================== */

function screenHow() {
  view().innerHTML = `
    <article class="card prose">
      <h1>How it works</h1>
      <h3>The problem</h3>
      <p>When a token lists on a Korean won exchange, the project usually pays a market maker a monthly retainer to keep the spread tight and enough size on both sides. At the end of the month the project shows a 3 a.m. screenshot of an empty book, the MM shows its own uptime dashboard, and nobody can check the other's numbers.</p>
      <h3>What this app does</h3>
      <ol>
        <li><b>Create.</b> The project locks the retainer in the contract and fixes the terms as numbers: max spread, a band around mid, the won depth each side must have inside it, the slot length and count, and a minimum share of slots.</li>
        <li><b>Check.</b> During any slot, anyone presses Check. Validators each fetch the public order book (<code>api.upbit.com</code> or <code>api.bithumb.com</code>) and measure spread and depth in code. The slot is recorded as pass or fail.</li>
        <li><b>Settle.</b> After the term, anyone presses Settle. The MM gets retainer × passed slots / total slots (zero under the minimum), the project gets the rest.</li>
      </ol>
      <h3>Who you have to trust</h3>
      <ul>
        <li><b>Not the project, not the MM.</b> Neither side submits numbers. The book is read from the exchange at the moment of the check.</li>
        <li><b>Not one validator.</b> The leader fetches the book and proposes a result. Every other validator fetches its own copy and only accepts if it agrees. A leader that claims pass over failing numbers, replays an old book, or passes off another market's book is rejected.</li>
        <li><b>The exchange's public API.</b> If Upbit or Bithumb served wrong data to everyone, the check would measure wrong data.</li>
        <li><b>Your timing.</b> Each check is one snapshot. One failing check fails the slot for good, so the MM has to keep the book good all the time, not just when it checks. A slot nobody checked counts as failed.</li>
      </ul>
      <h3>Why validators don't compare exact numbers</h3>
      <p>Validators fetch seconds apart, and a thin book can change a lot in that time: two real Upbit snapshots of KRW-SOPH 20 seconds apart had 0.4M and 9.8M won on the ask side. So a validator rejects the leader only when its own book <i>clearly</i> contradicts the verdict (spread at least 2× the limit, or a side at most half the minimum, and the reverse for a fail). In between, the leader's snapshot decides. The live preview on each page tells you which zone the book is in right now.</p>
      <h3>What the app reads and writes</h3>
      <p>Reads: <code>get_count</code>, <code>get_agreement</code>, <code>get_slot</code>, <code>current_slot</code>. Writes: <code>create_agreement</code> (with the retainer as value), <code>check</code>, <code>settle</code>. The order book preview is fetched by your browser directly from the exchange and is never sent anywhere. Every number on screen comes from the contract or that live fetch.</p>
      <h3>Limits</h3>
      <ul>
        <li>Testnet only: Studionet GEN has no value, and the wallet is a throwaway key in this browser.</li>
        <li>The book shows orders, not who placed them. The contract measures whether the market was liquid, not whether this MM provided it.</li>
        <li>Orders placed and pulled around checks (spoofing) still count while they are there. Frequent unannounced checks are the defence.</li>
        <li>The exchanges return 30 price levels. If all of them sit inside the band, depth is a lower bound, which only counts against the MM.</li>
      </ul>
      <p class="small muted">Contract source: <code>contracts/mm_sla_escrow.py</code> · deployed at <a href="${EXPLORER}/address/${CONTRACT}" target="_blank" rel="noopener" class="mono">${CONTRACT}</a></p>
    </article>`;
}

/* =====================================================================
   Router
   ===================================================================== */

function route() {
  const h = location.hash.replace(/^#/, "") || "/";
  const tab = h.startsWith("/create") ? "create" : h.startsWith("/how") ? "how" : "list";
  $$(".tabs a").forEach((a) => a.classList.toggle("on", a.dataset.tab === tab));
  window.scrollTo(0, 0);
  const m = h.match(/^\/a\/(\d+)/);
  if (m) return screenAgreement(Number(m[1]));
  if (tab === "create") return screenCreate();
  if (tab === "how") return screenHow();
  return screenList();
}

window.addEventListener("hashchange", route);
paintWalletBtn();
refreshBalance();
route();
