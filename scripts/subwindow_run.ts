// Milestone 2 live run of the sub-window rule through the app's own code (src/chain.ts).
//   npm run subwindow-run
// One Upbit KRW-XRP agreement, 2 slots x 10 minutes, so each slot has three 200 s sub-windows.
// Slot 1: the MM checks in sub-window 1, then tries again 45 s later in the same sub-window.
// Before that second send the script asks the app's guard (checkBlock) what it would tell a user,
// then sends anyway to show the contract refuses it. The project checks in sub-windows 2 and 3.
// Slot 2: one check, in sub-window 2 only. Then settle, and read everything back the way the app does.
// Keys are demo keys in .env (gitignored), generated on first run, never printed.
// Output: subwindow_run_result.json
import fs from "node:fs";
import { generatePrivateKey, createAccount } from "genlayer-js";
import {
  CONTRACT, GEN, checkBlock, fundAccount, getAgreement, getCount, getSlot, sendTx, subWindowAt, subWindowCells, useKey,
  type Terms,
} from "../src/chain";

const OUT = "subwindow_run_result.json";
const SLOT_S = 600;
const N_SLOTS = 2;
const RETAINER = 5n * GEN;
const TERMS: Terms = { max_spread_bps: 20, band_bps: 100, min_depth_krw: 300_000_000, min_uptime_pct: 50 };

function key(name: string): `0x${string}` {
  const env = fs.existsSync(".env") ? fs.readFileSync(".env", "utf8") : "";
  const m = env.match(new RegExp(`^${name}=(0x[0-9a-f]{64})`, "m"));
  if (m) return m[1] as `0x${string}`;
  const pk = generatePrivateKey();
  fs.appendFileSync(".env", `${name}=${pk}\n`);
  return pk;
}

const projectPk = key("DEMO_PROJECT_PK");
const mmPk = key("DEMO_MM_PK");
const projectAddr = createAccount(projectPk).address;
const mmAddr = createAccount(mmPk).address;
const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

const out: any = { contract: CONTRACT, network: "studionet", venue: "upbit", market: "KRW-XRP", terms: TERMS,
  slot_s: SLOT_S, n_slots: N_SLOTS, sub_windows: 3, project: projectAddr, mm: mmAddr, steps: [] };
const save = () => fs.writeFileSync(OUT, JSON.stringify(out, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));

log("funding demo project and MM addresses from the Studionet faucet");
await fundAccount(projectAddr, 100n);
await fundAccount(mmAddr, 10n);

useKey(projectPk);
const id = await getCount();
const start = now() + 120;
out.id = id;
out.start = start;
log(`create_agreement #${id}, start ${start}, ${N_SLOTS} x ${SLOT_S}s, retainer 5 GEN`);
out.create = await sendTx("create_agreement", [mmAddr, "upbit", "KRW-XRP", JSON.stringify(TERMS), start, SLOT_S, N_SLOTS], RETAINER,
  (ph, h) => ph === "pending" && log(`  tx ${h}`));
log(`  ${out.create.ok ? "ok" : "FAILED " + out.create.code + " " + out.create.message}`);
const a = await getAgreement(id);
if (a.project.toLowerCase() !== projectAddr.toLowerCase()) throw new Error(`agreement ${id} is not ours`);
save();

// [label, who, seconds after the term start]
const PLAN: [string, "mm" | "project", number][] = [
  ["slot 1, sub-window 1: MM", "mm", 15],
  ["slot 1, sub-window 1 again: MM", "mm", 60],
  ["slot 1, sub-window 2: project", "project", 215],
  ["slot 1, sub-window 3: project", "project", 415],
  ["slot 2, sub-window 2: project", "project", 815],
];
for (const [label, who, offset] of PLAN) {
  const at = start + offset;
  if (now() < at) await sleep((at - now()) * 1000);
  useKey(who === "mm" ? mmPk : projectPk);
  const pos = subWindowAt(a, now())!;
  const before = await getSlot(id, pos.slot);
  // what the app's Check button would say right now (it would not send)
  const guard = checkBlock(a, before, now());
  const sentOffset = now() - start;
  log(`${label}: app guard ${guard ? guard.kind : "none"}, sending at +${sentOffset}s (slot ${pos.slot}, window ${pos.window})`);
  const t0 = Date.now();
  const tx = await sendTx("check", [id], 0n, (ph, h) => ph === "pending" && log(`  tx ${h}`));
  const seconds = Math.round((Date.now() - t0) / 1000);
  const after = await getSlot(id, pos.slot);
  log(`  ${tx.ok ? "ok" : "REFUSED " + tx.code + " " + tx.message} in ${seconds}s -> slot ${after.status}, windows ${JSON.stringify(after.windows)}`);
  out.steps.push({ label, who, sent_offset_s: sentOffset, local_slot: pos.slot, local_window: pos.window, app_guard: guard, tx, seconds, slot_state: after });
  save();
}

const end = start + SLOT_S * N_SLOTS;
if (now() < end + 20) {
  log(`waiting ${end + 20 - now()}s for the term to end`);
  await sleep((end + 20 - now()) * 1000);
}
useKey(projectPk);
out.settle = await sendTx("settle", [id], 0n, (ph, h) => ph === "pending" && log(`  tx ${h}`));
const final = await getAgreement(id);
out.final = final;
log(`settle ${out.settle.ok ? "ok" : "FAILED " + out.settle.message}: passed ${final.passed}/${final.n_slots}, paid_mm ${final.paid_mm}`);

// read back the way the detail page does: get_slot per slot, then the sub-window marks
const t = now();
out.app_view = [];
for (let n = 0; n < N_SLOTS; n++) {
  const s = await getSlot(id, n);
  out.app_view.push({ slot: n, status: s.status, checks: s.checks, windows: s.windows, cells: subWindowCells(final, n, s, t) });
  log(`  app view slot ${n + 1}: ${s.status}, sub-windows ${subWindowCells(final, n, s, t).join(" / ")}`);
}
save();
log("done");
