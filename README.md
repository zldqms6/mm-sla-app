# MM SLA Escrow (web app)

**Live app:** https://zldqms6.github.io/mm-sla-app/

A web app on top of the [`MarketMakerSLA`](contracts/mm_sla_escrow.py) Intelligent Contract. A token project locks a market maker's retainer, the term is cut into time slots, anyone can press **Check** during a slot, and GenLayer validators each read the live Upbit or Bithumb order book and record whether the agreed spread and depth were there. At the end, **Settle** pays the market maker the share of slots that passed and returns the rest to the project.

Live contract on Studionet: [`0x0D7367C51dBDf8De80d52A912BB7f067120eE93C`](https://explorer-studio.genlayer.com/address/0x0D7367C51dBDf8De80d52A912BB7f067120eE93C) (since milestone 2, with sub-windows; the milestone 1 contract was `0x34D32F1F3b1181bCEb99F1A7C13F585F6841Fda9`, v1 was `0xC148A44089a37209585e9Ef57c2cf3585133F680`)

## Milestone 2 (2026-11-17): sub-windows, so early checks can't lock in a pass

**What was wrong.** The milestone 1 contract allowed at most 3 checks per slot, counted from the start of the slot. A market maker could press Check three times in the first minutes of a slot, while its book was good, and use up the slot. Any later check by the project then reverted, so the pass stood even if the book was empty for the rest of the hour.

**What changed.**

- **Contract** (`contracts/mm_sla_escrow.py`, the same source as the public contract repo `zldqms6/mm-sla-escrow` at `1e366e8`). Each slot is split into 3 equal sub-windows, and each sub-window takes at most one recorded check. `check()` computes the sub-window as `(now - start - slot * interval) * 3 // interval`, refuses a second check in the same one with `[EXPECTED] slot S sub-window W already has a check`, keeps the list of used sub-windows in the slot state (`windows`), and returns `window` along with `slot`, `slot_status` and `checks`. Everything else is unchanged: one failing check still fails the slot for good, and a slot nobody checked still counts as failed. So checking early no longer closes the slot: every later sub-window still accepts a check that can fail it.
- **Redeployed for the app** at [`0x0D7367C51dBDf8De80d52A912BB7f067120eE93C`](https://explorer-studio.genlayer.com/address/0x0D7367C51dBDf8De80d52A912BB7f067120eE93C) (deploy tx [`0xe9d4…52d4`](https://explorer-studio.genlayer.com/tx/0xe9d460b1f2d8c8e5d754987d9900a41e934a869d5d033c1d6ca6686aaf5652d4)). `src/chain.ts` and `deployments.json` point to it, and glcheck confirms the deployed code matches `contracts/mm_sla_escrow.py` (`807fe54daca4ca18`). The milestone 1 contract `0x34D3…Fda9` keeps its old agreements.
- **App.**
  - The slot timeline shows three marks under each slot number, one per sub-window: a recorded check (pass or fail), open now, ended without a check, closed because the slot already failed, or not started. Clicking a slot lists its sub-windows with their times and results, followed by the last recorded observation. The contract stores only the last check's numbers, so earlier sub-windows show pass or fail without numbers. That is enough for the verdict: a slot's checks all passed except possibly the last, because a failing check ends checking in that slot.
  - The Check button is only offered when the contract would accept the call. If the current sub-window already has a check, the page says so and gives the time the next sub-window (or the next slot, or the end of the term) opens, and it repaints itself at that time. The button also re-reads the slot just before sending, so a page left open doesn't send a check that would revert.
  - The sub-window arithmetic in `src/chain.ts` (`subWindowAt`, `subWindowStart`, `subWindowCells`, `checkBlock`) mirrors the contract's integer formula. I compared `subWindowAt` with the contract's formula for every second of three slots at intervals of 600, 601, 602, 1,000, 3,600 and 86,400 s, with no mismatches.
- **Tests:** 17, all passing (`python -m pytest -q tests`). `test_early_repeated_checks_cannot_lock_in_a_pass` replaces the old 3-check cap test. In that test the MM checks in the first minute, two more checks in the same sub-window revert, and the project's check in the last sub-window, on a thin real Upbit KRW-SOPH snapshot, fails the slot. `test_one_recorded_check_per_sub_window` covers the boundaries (00:19:59 is sub-window 0, 00:20:00 is sub-window 1 in an hourly slot) and the reset at the next slot.

**Live on Studionet against the real Upbit KRW-XRP book, 2026-11-17 10:54–11:17 KST** (`npm run subwindow-run`, `scripts/subwindow_run.ts`, which goes through `src/chain.ts`. Full output with every receipt, vote list and slot state is in `subwindow_run_result.json`.) Agreement #0: ≤ 20 bps, ≥ 300M won each side within ±1%, 50% minimum uptime, 2 slots × 10 minutes (sub-windows of 200 s), 5 GEN, starting 10:56:49 KST. Every transaction was `ACCEPTED`. The contract numbers slots and sub-windows from 0 and the app from 1, so the error message below says "slot 0 sub-window 0" for the app's slot 1, sub-window 1.

| Step | Sent | Result | Slot state afterwards |
|---|---|---|---|
| MM checks, slot 1 sub-window 1 | +17 s | **pass**: 8 bps, 1.08B / 965M, 11 s ([`0xb8a7…b49f`](https://explorer-studio.genlayer.com/tx/0xb8a7fbeec522df6598628254e3a1f5c8f30153b0dd524530cfdd51356f6bb49f)) | pass, sub-windows [0] |
| MM checks again, same sub-window | +62 s | The app's `checkBlock` said "sub-window already has a check" and would not have sent it; the script sent it anyway. **Refused**: `[EXPECTED] slot 0 sub-window 0 already has a check`, validators agreed on the error (AGREE ×3), nothing recorded ([`0x4cce…a868`](https://explorer-studio.genlayer.com/tx/0x4cce5835e839a127c24a7266fc388aa25e4bfc0db543954f24498d73dff5a868)) | unchanged: pass, [0], 1 check |
| Project checks, sub-window 2 | +217 s | **pass**: 8 bps, 1.13B / 1.09B ([`0x2825…010a`](https://explorer-studio.genlayer.com/tx/0x282592178fb7ca75fbf2a06fa60745dcd120d1b5f6227ef13068e2cfc1fd010a)) | pass, [0, 1] |
| Project checks, sub-window 3 | +417 s | **pass**: 8 bps, 1.07B / 1.99B ([`0x3d78…eb1b`](https://explorer-studio.genlayer.com/tx/0x3d781328cfd79435ab13118e6d6483c7e4705ece550e46a281917c502b6eeb1b)) | pass, [0, 1, 2], 3 checks |
| Project checks, slot 2 sub-window 2 only | +816 s | **pass**: 8 bps, 1.15B / 1.98B ([`0x9c8d…8fd2`](https://explorer-studio.genlayer.com/tx/0x9c8d508e2ac955277036c31cc98c0da3011ae901876ca45f7c1c39f91d308fd2)) | pass, [1] |
| `settle()` | after the term | 2/2 passed → **5 GEN to the MM**, 0 back ([`0xe556…fe3a`](https://explorer-studio.genlayer.com/tx/0xe556ad1ff2bae94e8eef94af0a6e9732ff3f2628af761ca6b7268f23252bfe3a)) | settled |

Each check was accepted with 3 AGREE votes and 2 IDLE validators. Read back through `src/chain.ts` after settlement, the app's marks were pass / pass / pass for slot 1 and missed / pass / missed for slot 2. A headless browser on the built app (`npm run build && npm run preview`) showed the same marks and sub-window lists on `#/a/0`, with no console errors.

To check the page while a slot runs, I created agreement #1 (1 slot × 10 minutes, 1 GEN, [`0xd6ba…b03d`](https://explorer-studio.genlayer.com/tx/0xd6ba25af1797573c0dcabbb095163dd9fc1f9a51506f757c9f089affd17db03d)) and checked it once in sub-window 1 ([`0xc6d6…b205`](https://explorer-studio.genlayer.com/tx/0xc6d6132eb29a92fd4f98268acd7d0ae714b109e0ff99b4605d295b0d66f4b205), pass). On `#/a/1` the page showed no Check button and said "Sub-window 1 of 3 in slot 1 already has a check … The next sub-window opens 2026-11-17 11:22:09 KST". At 11:22:09 it repainted by itself and offered Check for sub-window 2. After the term, `settle()` paid the 1 GEN to the MM (1/1 passed, [`0x293d…0a21`](https://explorer-studio.genlayer.com/tx/0x293de3bfc2990903b77835b86a9f1720d36822f5c754854b163a2cc1d2e50a21)).

**Only covered by tests, not seen live:** a later sub-window failing a slot that passed earlier (the live XRP book passed every time), and a check with no consensus. The app's guard uses the browser's clock, and the contract uses the time the leader executes the transaction. A check sent in the last seconds of a sub-window can land in the next one, which the contract accepts. If the browser clock is off by more than that margin, the contract still refuses the check, and the app shows the refusal as "not applied".

## Milestone 1 (2026-11-11): strict verdict consensus

**What was wrong in v1.** The steward review of the contract found a real hole. In v1 a validator accepted the leader's verdict unless its own book *clearly* contradicted it (spread at least 2× the limit, or a side at most half the minimum, and the reverse for a fail). In between, the leader decided. So near the threshold a leader could submit pass or fail, and either would be accepted. That verdict moves slot state and the retainer, so the leader could choose the payout.

**What changed.**

- **Contract** (`contracts/mm_sla_escrow.py`). `_leader_ok` still checks that the leader's numbers add up, that its book is no more than 3 minutes from the validator's own, and that its mid is within 3% of the validator's mid. The 2× "clear contradiction" rule is gone. Now the last test is `leader["pass"] is mine["pass"]`: every validator computes pass or fail from its own fetch and votes for the leader only if it got the same answer. A check is recorded only when a majority of validators reproduced the verdict. If the book sits so close to a limit that too many snapshots land on the other side, the check gets no consensus and nothing changes. The slot stays as it was, and anyone can check again. Validators still don't compare exact numbers, because thin books move too fast for that (0.4M vs 9.8M won on one side, 20 s apart, in the fixtures).
- **Who that favours.** Nobody gets to pick. A market maker that keeps its book right at the limit can't count on a pass being recorded, because validators whose snapshots land under the limit vote against it, and a slot nobody proved still counts as failed at settlement. A project can't get a fail recorded on a book that passes either.
- **Tests** are now in this repo (`tests/`, real Upbit and Bithumb snapshots in `tests/fixtures`), with a GitHub Actions workflow that runs them on every push. There are 16 tests. Two are new and fail on the v1 contract:
  - `test_leader_cannot_pick_the_verdict_near_the_threshold` builds the steward's case. It sets the depth floor 1,000 won above what the book shows, then has the leader nudge both depths over the floor and claim pass, with numbers that are internally consistent, the same timestamp and the same mid. v1 accepts it; v2 rejects it.
  - `test_book_moves_between_fetches_a_split_records_nothing` covers two real snapshots 20 s apart that give different verdicts. v2 now rejects that leader in both directions, where v1 went along with it one way.
  - `test_same_verdict_from_different_numbers_still_agrees` shows that validators still agree when their numbers differ by hundreds of millions of won but the verdict is the same.
- **App.**
  - `sendTx` used to report any `ACCEPTED`-or-later receipt with a successful leader as success. But `waitForTransactionReceipt(ACCEPTED)` also returns on `UNDETERMINED` and the timeouts. A check where too few validators reproduce the verdict is exactly that case: the leader succeeded, but nothing was recorded. The app now reports it as "No consensus, nothing changed on chain" instead of showing a pass or fail that isn't on chain.
  - The live preview's three zones (clear pass, clear fail, borderline, which came from the 2× rule) are replaced by headroom. It shows how far the spread and the thinner side are from the limits, and warns when the book is within 20% of a limit, where a check may record nothing.
  - The "How it works" page now explains "same verdict, not the same numbers".
- **Redeployed.** The new contract is at [`0x34D32F1F3b1181bCEb99F1A7C13F585F6841Fda9`](https://explorer-studio.genlayer.com/address/0x34D32F1F3b1181bCEb99F1A7C13F585F6841Fda9), and `deployments.json` points to it. glcheck confirms that the deployed source matches `contracts/mm_sla_escrow.py` (`f662b30a…`). The v1 contract `0xC148A44089a37209585e9Ef57c2cf3585133F680` keeps its old agreements. An earlier v2 deployment from the same day, `0x7826B076CC17E33d5a6f3F86Ab7Af0cE9492c327`, has the same logic; I redeployed after correcting the docstring, which had said every validator must reproduce the verdict when consensus needs a majority.

**Live on Studionet against real books, v2 contract, 2026-11-11 (12:51–13:34 KST).** Every transaction below was `ACCEPTED`, with the leader's execution `SUCCESS` unless noted.

*Contract demo* (`scripts/contract_demo.mjs`, full output in `contract_demo_result.json`): four agreements, each 3 slots × 10 minutes with a 30 GEN retainer and a 75% minimum uptime, checked once per slot. Depths are bid / ask in won.

| Agreement | Terms | Slot 0 | Slot 1 | Slot 2 | `settle()` |
|---|---|---|---|---|---|
| #0 Upbit KRW-XRP | ≤ 20 bps, ≥ 300M won each side within ±1% | pass: 7 bps, 1.87B / 1.69B | pass: 7 bps, 1.85B / 1.15B | pass: 7 bps, 1.71B / 1.21B | 3/3 → **30 GEN to the MM** |
| #2 Upbit KRW-SOPH | ≤ 50 bps, ≥ 3M won each side | **pass**: 34 bps, **3.08M** / 7.36M ([`0x8502…db90`](https://explorer-studio.genlayer.com/tx/0x850280d1c8881f94ef0e9726abf88dc31937e5b5554546f2fb50f6c6247adb90)) | **fail**: 34 bps, **2.69M** / 8.27M ([`0x2377…5d9f`](https://explorer-studio.genlayer.com/tx/0x237772c02bb367c3f30cf677d48b18549b8b7463ccc3fddead2ff2ddfab05d9f)) | pass: 34 bps, 4.28M / 7.08M | 2/3 = 67%, under the 75% minimum → **0 to the MM**, 30 back ([`0x2e08…2e0e`](https://explorer-studio.genlayer.com/tx/0x2e084ae9e15f44b108bc8706d72b89daa29a028a8808b863ee78823981cb2e0e)) |
| #3 Bithumb KRW-SOPH | same | fail: 118 bps, 3.77M / 0.99M | fail: 123 bps, 3.76M / 2.10M | fail: 113 bps, 2.67M / 1.06M | 0/3 → **0 to the MM**, 30 back |
| #4 Bithumb KRW-NOPE (no such market) | same | `[EXTERNAL] bithumb has no market KRW-NOPE`; validators agreed on the error and nothing was recorded | | | 0/3 → 30 back |

Every check had 3 AGREE votes and 2 IDLE validators that didn't vote in the round; there were no DISAGREE votes.

The Upbit SOPH agreement is the case this milestone is about. In slot 0 the bid side was 3.08M won against a 3M floor, 2.7% over the line, and in slot 1 it was 2.69M, 10% under. Under v1 a validator would have accepted either verdict from the leader in both slots, because neither book was 2× away from the limit. Under v2 each validator that voted had to compute the same pass bit from its own fetch of the book, and they did: pass in slot 0, fail in slot 1.

*Through the app's own code* (`npm run live-run`, `scripts/live_run.ts`, output in `live_run_result.json`; the v1 run is kept as `live_run_result_v1.json`): two one-slot agreements with 5 GEN each.

| | #5 Upbit KRW-XRP | #6 Bithumb KRW-SOPH |
|---|---|---|
| Preview (`book.ts`, a few seconds before) | 8 bps, bid 3.04B / ask 598M, pass | 154 bps, bid 2.60M / ask 2.21M, fail |
| `check()` on chain | **pass**: 8 bps, 3.04B / 602M, 9 s ([`0x2af7…14c4`](https://explorer-studio.genlayer.com/tx/0x2af7fe7cfd21cdc18519ebe512e36c356076063b92dce2e1f96b1c23af0414c4)) | **fail**: 150 bps, 2.60M / 1.81M, 17 s ([`0xf06d…2d97`](https://explorer-studio.genlayer.com/tx/0xf06d153cc44dcaf0dbada6a8056030a0739bba441d91167a1def8464f5c22d97)) |
| `settle()` | 1/1 → **5 GEN to the MM** ([`0x0bbc…cc12`](https://explorer-studio.genlayer.com/tx/0x0bbc0d5f8a03925ca04c9b8eae424bc16a01185c04a2454f2f46d3277fc3cc12)) | 0/1 → **0 to the MM** ([`0x7774…a33d`](https://explorer-studio.genlayer.com/tx/0x777428ee9c07966ca73ffb0bf62b1d782f9e0134513b579d46c595d93336a33d)) |

Agreement #1 on this contract comes from a first attempt at the app run. I started it at the same moment as the contract demo, the two scripts' agreement ids crossed, and the app script stopped itself ("agreement 0 is not ours"). Nobody checked #1, so its one slot counted as failed and `settle()` returned the 5 GEN to the project ([`0x5421…1356`](https://explorer-studio.genlayer.com/tx/0x5421f493e4db784da7caab394d30c13d65ce439b3701157ad130555ba70d1356)).

A check that ends without consensus did not occur in these runs. The validator-side behaviour is covered by the tests above, which replay real snapshots; the app's handling of that receipt status is not covered by a test.

## Run the tests

```bash
python -m venv .venv && .venv/bin/pip install -r requirements-test.txt   # Windows: .venv\Scripts\pip
python -m pytest -q tests        # 17 passed; no node needed. The first run downloads genvm v0.2.16 (pinned in the tests)
```


## Why

Almost every new listing on Upbit or Bithumb comes with a market maker on a monthly retainer, and the promise is always the same: tight spread, some amount of won on each side. When the month ends, the project has a screenshot of an empty book at 3 a.m. and the market maker has its own uptime report. Neither can check the other.

None of it is a matter of opinion. The terms are numbers and the exchange publishes the book to everyone. The contract already solved the hard part: several validators look at the book independently and write the verdict down where neither side can edit it. What was missing was a way for someone who is not a developer to use it: set up an agreement, see whether the book would pass right now, press Check, and see the payout. That is this app.

## What it does

| Screen | What you see and do | Contract calls |
|---|---|---|
| **Agreements** | Every agreement, newest first: market and venue, retainer, phase (not started, slot k of n, ended, settled), passed and failed slots as a bar, unchecked past slots, terms in one line, and the amount paid to the MM once settled | `get_count`, `get_agreement` |
| **Agreement detail** | Terms, start and end in KST, project and MM addresses. **Check now** while a slot is running, with the recorded observation afterwards (spread in bps, bid and ask depth against the minimum, pass or fail, book timestamp). If the current slot already failed or its current sub-window already has a check, the button is replaced by the reason the contract would refuse it and the time the next sub-window or slot opens. **Settle** once the term is over. A slot timeline (pass, fail, unchecked, future, with three marks per slot for its sub-windows; click a slot for its sub-windows and its last observation). Payout under `settle()`'s formula with the current counts, or the real payout after settlement. A live order book preview for this market and these terms | `get_agreement`, `current_slot`, `get_slot`, `check`, `settle` |
| **New agreement** | Venue, market, max spread, depth band, min depth per side, min uptime, start (KST), slot length, number of slots, MM address, retainer. Validation mirrors the contract's limits. The live order book preview updates as you type, so you can see whether today's book would meet the terms you are about to lock | `create_agreement` (payable) |
| **How it works** | The trust model in plain words: who decides, what you still trust (the exchange's public API, the timing of checks), why validators don't compare exact numbers, and the limits | none |

### Live order book preview

The browser fetches `https://api.upbit.com/v1/orderbook?markets=…` or `https://api.bithumb.com/v1/orderbook?markets=…`, the same URLs the validators use, and runs `src/book.ts`, a line-by-line port of the contract's `_measure()` (including skipping Bithumb's size-0 levels). It shows the result as "if a check ran on this snapshot", how much headroom the book has against each limit (with a warning within 20% of a limit, where validators fetching seconds apart may split and the check would record nothing), and the top 10 levels with the ones outside the band greyed out.

CORS, checked with real requests on 2026-11-04: both APIs answer `Access-Control-Allow-Origin: *`, including Upbit's 404 for an unknown market, so the preview works from any origin. If a venue ever stops allowing it, the preview says the browser could not read the book and that `check()` is unaffected, because validators fetch server-side. It never fills in numbers it didn't get.

### Wallet

Testnet only. The app makes a key in the browser (`generatePrivateKey` / `createAccount` from genlayer-js), keeps it in `localStorage`, and funds it with Studionet's `sim_fundAccount` from the browser. The wallet sheet can show the key or delete it. For trying the app without a real counterparty, the create form can fill in a throwaway MM address whose key is discarded on the spot; its payout is unreachable, which on a testnet is fine.

## How it talks to GenLayer

- `src/chain.ts` holds everything chain-related: a `genlayer-js` client on the `studionet` chain, the burner wallet, the faucet call, typed reads, and `sendTx`.
- **Reads** use `transactionHashVariant: "latest-nonfinal"`, so a check shows up as soon as consensus accepts it instead of after the appeal window.
- **Writes** wait for `ACCEPTED` and then look at the leader receipt. A contract `UserError` such as `slot 0 has already failed` still reaches `ACCEPTED` (validators agree it failed) with no state change, so the app reports "not applied" with the contract's message instead of success.
- **After a check**, the app takes the slot number from the call's return value and reads `get_slot` for it, so the observation on screen is the one stored on chain, not a local copy.
- **Rate limit.** Studionet allows each IP 30 `gen_call` reads a minute (`X-RateLimit-Bucket: standard`), and its 429 has no CORS header, so a browser only sees "Failed to fetch". The app reads in batches of 4, caches agreements for 20 s (settled ones for good), skips slot reads when no check was ever recorded, pages the timeline 12 slots at a time, and retries a refused read after 8, 15 and 25 s with a banner saying why.

## Run it

Requires Node 18+.

```bash
npm i
npm run dev        # http://localhost:5173/mm-sla-app/
npm run build      # type-checks with tsc, writes dist/
npm run preview    # serves dist/ at http://localhost:4173/mm-sla-app/
```

`vite.config.ts` sets `base: "/mm-sla-app/"` for GitHub Pages at `https://zldqms6.github.io/mm-sla-app/`. Routing is hash-based (`#/a/8`), so no server rewrites are needed. To publish, push `dist/` to a `gh-pages` branch, or copy it to `docs/` on `main`, and select that in Settings → Pages.

## Live run on Studionet (2026-11-04, v1 contract)

Two runs, both through the app's own code. All numbers below are what the contract recorded or what the exchange API returned; every transaction reached `ACCEPTED` with the leader's execution `SUCCESS`. IDLE means that validator didn't vote in that round.

**1. Node script, `npm run live-run`** (`scripts/live_run.ts`, output in `live_run_result.json`). It imports `src/chain.ts` and `src/book.ts` unchanged, uses two demo keys from a gitignored `.env`, funds them with `sim_fundAccount`, creates two one-slot agreements (10 minutes, 5 GEN each, starting at 15:08 KST), takes the browser-style preview, calls `check()`, waits for the term to end, and calls `settle()`.

| | #8 Upbit KRW-XRP | #9 Bithumb KRW-SOPH |
|---|---|---|
| Terms | ≤ 20 bps, ≥ 300M won each side within ±1% | ≤ 50 bps, ≥ 3M won each side within ±1% |
| `create_agreement` | `0x04e1…a0ed`, votes AGREE ×3, IDLE ×2 | `0xd327…3027`, AGREE ×5 |
| Preview (`book.ts`, a few seconds before) | 6 bps, bid 1.22B / ask 1.70B, pass | 150 bps, bid 1.07M / ask 327K, fail |
| `check()` recorded on chain | **pass**: 6 bps, bid 1.23B / ask 1.69B, in 11 s, AGREE ×3 | **fail**: 150 bps, bid 1.07M / ask 327K, in 36 s, AGREE ×3 |
| `settle()` | 1/1 → **5 GEN to the MM** (`0x2d59…84ae`, AGREE ×5) | 0/1 → **0 to the MM**, 5 GEN back (`0xf890…6bde`) |

The preview and the validators' measurement agree: same spread, depths within about 1% on the deep XRP book, and identical on the SOPH book, whose top levels did not move between the two fetches.

**2. In the browser** (`npm run preview`, burner wallet made and funded through the wallet sheet). I filled the New agreement form with Upbit KRW-XRP, ≤ 20 bps, ≥ 300M won within ±1%, 2 slots × 10 minutes from 15:16 KST, 5 GEN, and a throwaway MM address, then pressed the buttons:

- `create_agreement` → agreement **#10**, accepted in 9 s (`0xad2a…986c`); the app read the new id from the call's return value and opened its page.
- **Check now** in slot 1 → **pass**: 6 bps, bid 1.34B / ask 1.31B, accepted in 12 s (`0xb2f7…ad4c`).
- **Check now** in slot 2 → **pass**: 6 bps, bid 1.44B / ask 1.31B, accepted in 12 s ([`0x2be6…b528`](https://explorer-studio.genlayer.com/tx/0x2be6365f60d48bc9fe25462c2c797d0055503d3919827e2c961df41af256b528)).
- **Settle**, 50 s after the term ended → 2/2 passed, **5 GEN to the market maker**, 0 back, accepted in 8 s with AGREE ×5 ([`0x25c6…31d5`](https://explorer-studio.genlayer.com/tx/0x25c6338739571d8ca2638fb35cf1ba6a81efed968865f0b9e933f504af4731d5)). The page switched to "Settled" with the real payout.

The browser's console was clean on a fresh load. The only console entries in the whole session were the expected 404 from previewing a non-existent market, and the rate-limit errors described below.

Found and fixed during the run: a won formatter bug showed 300M as "3M" next to a correct 300,000,000 in the terms table; the Studionet read limit, which first showed up as bare "Failed to fetch" CORS errors in the console while the node run and the browser shared an IP, led to the retry and caching described above; and the Check button was offered on a slot that had already failed, which the contract would refuse, so the app now reads the current slot first.

## Files

```
.
  index.html            shell
  vite.config.ts        base /mm-sla-app/
  src/chain.ts          genlayer-js client, burner wallet, faucet, typed reads with retry, write+wait with leader-error check
  src/book.ts           browser order book fetch and the port of the contract's _measure()
  src/main.ts           router, the four screens, tx dock, wallet sheet
  src/format.ts         KST times, GEN and won formatting
  src/style.css         app styles (base.css: colour tokens, header, buttons), light and dark
  scripts/live_run.ts   the live runs above, through src/chain.ts and src/book.ts
  live_run_result.json  its output on the v2 contract (live_run_result_v1.json: the 2026-11-04 v1 run)
  scripts/contract_demo.mjs  milestone 1 contract demo: 4 agreements x 3 slots, checks, settle
  scripts/subwindow_run.ts   milestone 2 live run of the sub-window rule, through src/chain.ts
  subwindow_run_result.json  its output: tx hashes, votes, slot state after every check, the app's view
  contract_demo_result.json  its output: every tx hash, vote list and recorded observation
  contracts/mm_sla_escrow.py the Intelligent Contract (with sub-windows since milestone 2), deployed address in deployments.json
  tests/                gltest direct-mode tests with real order book fixtures (17)
```

The only runtime dependency is `genlayer-js`. There's no UI framework.

## Limits

- **Testnet only.** The key sits unencrypted in `localStorage`, there is no MetaMask flow, and Studionet GEN has no value.
- **The preview is one browser snapshot.** Validators fetch their own copies seconds later. Near a limit their verdicts can differ, and then the check records nothing and has to be repeated; the preview warns when a book is that close.
- **Nobody checks automatically.** A slot nobody checked counts as failed. In real use the market maker would run a small bot that calls `check()` once per slot; the app only gives the button.
- **Reads are rate-limited** to about 30 a minute per IP. A long agreement's timeline loads 12 slots per page, and on a busy minute the app waits and retries.
- **Reads use `latest-nonfinal`**, the state consensus accepted. It could still change on appeal.
- **The contract's own limits apply:** snapshots, not a time average; 30 visible levels per side; the book shows orders, not who placed them; orders pulled around checks still count while they are there. The docstring at the top of `contracts/mm_sla_escrow.py` describes them.
