// Live run through the app's own code path: src/chain.ts (client, faucet, sendTx
// with leader-error check, typed reads) and src/book.ts (the browser preview).
//   npm run live-run            create, preview, check, wait for the term, settle
//   npm run live-run -- resume  continue from live_run_result.json
// Keys are demo keys in .env (gitignored), generated on first run, never printed.
import fs from "node:fs";
import { generatePrivateKey, createAccount } from "genlayer-js";
import {
  CONTRACT, fundAccount, getAgreement, getCount, getCurrentSlot, getSlot, sendTx, useKey, GEN, type Terms, type Venue,
} from "../src/chain";
import { snapshot } from "../src/book";

const OUT = "live_run_result.json";
const SLOT_S = 600;
const N_SLOTS = 1;
const RETAINER = 5n * GEN;

function key(name: string): `0x${string}` {
  const env = fs.existsSync(".env") ? fs.readFileSync(".env", "utf8") : "";
  const m = env.match(new RegExp(`^${name}=(0x[0-9a-f]{64})`, "m"));
  if (m) return m[1] as `0x${string}`;
  const pk = generatePrivateKey();
  fs.appendFileSync(".env", `${name}=${pk}\n`);
  return pk;
}

const projectPk = key("DEMO_PROJECT_PK");
const mmAddr = createAccount(key("DEMO_MM_PK")).address;
const project = useKey(projectPk);
const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

const PLAN: { label: string; venue: Venue; market: string; terms: Terms }[] = [
  { label: "xrp-upbit", venue: "upbit", market: "KRW-XRP",
    terms: { max_spread_bps: 20, band_bps: 100, min_depth_krw: 300_000_000, min_uptime_pct: 75 } },
  { label: "soph-bithumb", venue: "bithumb", market: "KRW-SOPH",
    terms: { max_spread_bps: 50, band_bps: 100, min_depth_krw: 3_000_000, min_uptime_pct: 75 } },
];

const resume = process.argv[2] === "resume";
const out: any = resume
  ? JSON.parse(fs.readFileSync(OUT, "utf8"))
  : { contract: CONTRACT, network: "studionet", project: project.address, mm: mmAddr, slot_s: SLOT_S, n_slots: N_SLOTS, agreements: [] };
const save = () => fs.writeFileSync(OUT, JSON.stringify(out, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));

if (!resume) {
  log("funding demo project and MM addresses from the Studionet faucet");
  await fundAccount(project.address, 100n);
  await fundAccount(mmAddr, 10n);
  for (const p of PLAN) {
    const id = await getCount();
    const start = now();
    log(`create_agreement #${id} ${p.venue} ${p.market}, start ${start}, ${N_SLOTS} x ${SLOT_S}s, retainer 5 GEN`);
    const tx = await sendTx("create_agreement", [mmAddr, p.venue, p.market, JSON.stringify(p.terms), start, SLOT_S, N_SLOTS], RETAINER,
      (ph, h) => ph === "pending" && log(`  tx ${h}`));
    log(`  ${tx.ok ? "ok" : "FAILED " + tx.code + " " + tx.message} votes=${tx.votes.join(",")}`);
    const a = await getAgreement(id);
    if (a.project.toLowerCase() !== project.address.toLowerCase()) throw new Error(`agreement ${id} is not ours`);
    out.agreements.push({ ...p, id, start, create: tx, checks: [] });
    save();
  }
}

for (const ag of out.agreements) {
  if (ag.checks.length) continue;
  const pre = await snapshot(ag.venue, ag.market, ag.terms);
  log(`#${ag.id} browser preview: ${JSON.stringify(pre.obs)}`);
  const slot = await getCurrentSlot(ag.id);
  log(`#${ag.id} check() in slot ${slot}`);
  const t0 = Date.now();
  const tx = await sendTx("check", [ag.id], 0n, (ph, h) => ph === "pending" && log(`  tx ${h}`));
  const secs = Math.round((Date.now() - t0) / 1000);
  log(`  ${tx.ok ? "ok" : "FAILED " + tx.code + " " + tx.message} in ${secs}s votes=${tx.votes.join(",")}`);
  const s = await getSlot(ag.id, slot);
  log(`  slot ${slot}: ${s.status} ${JSON.stringify(s.obs)}`);
  ag.checks.push({ slot, preview: { fetchedAt: pre.fetchedAt, levels: pre.levels, obs: pre.obs }, tx, seconds: secs, slot_state: s });
  save();
}

const end = Math.max(...out.agreements.map((a: any) => a.start + SLOT_S * N_SLOTS));
if (now() < end + 20) {
  log(`waiting ${end + 20 - now()}s for the term to end`);
  await sleep((end + 20 - now()) * 1000);
}
for (const ag of out.agreements) {
  if (ag.settle?.ok) continue;
  log(`#${ag.id} settle()`);
  ag.settle = await sendTx("settle", [ag.id], 0n, (ph, h) => ph === "pending" && log(`  tx ${h}`));
  ag.final = await getAgreement(ag.id);
  log(`  ${ag.settle.ok ? "ok" : "FAILED " + ag.settle.message} passed ${ag.final.passed}/${ag.final.n_slots}, paid_mm ${ag.final.paid_mm}, settled ${ag.final.settled}`);
  save();
}
log("done");
