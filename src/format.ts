import { GEN } from "./chain";

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const KST_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** "2026-11-04 09:00 KST" */
export function kst(unix: number, seconds = false): string {
  const p = Object.fromEntries(KST_FMT.formatToParts(new Date(unix * 1000)).map((x) => [x.type, x.value]));
  const h = p.hour === "24" ? "00" : p.hour;
  return `${p.year}-${p.month}-${p.day} ${h}:${p.minute}${seconds ? ":" + p.second : ""} KST`;
}

/** value of an <input type="datetime-local"> read as KST -> unix seconds */
export function fromKstInput(v: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return null;
  const t = Date.parse(v.slice(0, 16) + ":00+09:00");
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

/** unix seconds -> value for <input type="datetime-local"> in KST */
export function toKstInput(unix: number): string {
  return new Date((unix + 9 * 3600) * 1000).toISOString().slice(0, 16);
}

export function gen(wei: bigint, digits = 2): string {
  const neg = wei < 0n;
  const v = neg ? -wei : wei;
  const whole = v / GEN;
  const frac = ((v % GEN) * 10n ** BigInt(digits)) / GEN;
  const f = digits ? "." + frac.toString().padStart(digits, "0") : "";
  return (neg ? "-" : "") + whole.toLocaleString("en-US") + f.replace(/\.?0+$/, "");
}

export function parseGen(s: string): bigint | null {
  const m = String(s).trim().match(/^(\d+)(?:\.(\d{1,18}))?$/);
  if (!m) return null;
  return BigInt(m[1]) * GEN + BigInt((m[2] ?? "").padEnd(18, "0") || "0");
}

/** won amount, compact: 2.78B, 6.18M, 957 */
export function krw(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `${trim(n / 1e9)}B`;
  if (a >= 1e6) return `${trim(n / 1e6)}M`;
  if (a >= 1e4) return `${trim(n / 1e3)}K`;
  return Math.round(n).toLocaleString("en-US");
}
const trim = (x: number) => {
  const s = Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(2);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
};

export const bpsPct = (bps: number) => `${(bps / 100).toFixed(bps % 100 ? (bps % 10 ? 2 : 1) : 0)}%`;

export const short = (a: string, n = 6) => (a && a.length > 2 * n ? `${a.slice(0, n)}…${a.slice(-4)}` : a);

export function duration(s: number): string {
  if (s % 86400 === 0) return `${s / 86400} day${s === 86400 ? "" : "s"}`;
  if (s % 3600 === 0) return `${s / 3600} hour${s === 3600 ? "" : "s"}`;
  if (s % 60 === 0) return `${s / 60} min`;
  return `${s} s`;
}

export function relTime(unix: number): string {
  const d = unix - nowSec();
  const a = Math.abs(d);
  const unit = a < 60 ? `${a} s` : a < 3600 ? `${Math.round(a / 60)} min` : a < 86400 ? `${(a / 3600).toFixed(1).replace(/\.0$/, "")} h` : `${(a / 86400).toFixed(1).replace(/\.0$/, "")} days`;
  return d >= 0 ? `in ${unit}` : `${unit} ago`;
}

export const nowSec = () => Math.floor(Date.now() / 1000);
