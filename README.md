# WAX Terminal

Pools, farms and liquidity across the WAX blockchain, in one page.

**There is no backend.** The browser reads `swap.alcor` and `swap.taco` straight
off chain and derives everything itself. That means the whole thing deploys as
static files — GitHub Pages is enough — and there is no database to run, no
indexer to babysit, and no server that could hold anyone's funds.

---

## Deploying

Push this repo and turn on GitHub Pages (Settings → Pages → deploy from branch,
root folder). That is the entire deployment. `.nojekyll` is already present so
the `js/` directory is served as-is.

It works from any static host, and locally with:

```sh
python3 -m http.server 8110
```

The public WAX nodes it talks to all send `Access-Control-Allow-Origin: *`,
which is what makes a serverless terminal possible at all.

---

## Rebranding

Two files. Nothing else needs touching.

| File | What it controls |
|---|---|
| `theme.css` | Every colour, radius and font, in both light and dark. No component declares a colour of its own. |
| `theme.json` | Name, favicon, links, featured pools, default view, fee account, compound fee rate, per-surface feature flags. |

---

## What it does

- **Pools** — all ~19,800 Alcor pools and TacoSwap pairs with live TVL, price and fee tier.
- **Farms** — grouped by pool, not by incentive, because a pool commonly runs several at once.
- **My liquidity** — every position a wallet holds across both DEXes, in range or not, with uncollected fees.
- **Compound** — the full harvest for each position and the exact transaction that redeposits it.
- **Overview** — the dashboard: where liquidity sits, who pays the most, where APRs actually fall, WAX candles, and the multi-year TVL series.
- **Activity** — the live swap feed: who traded what, through which pool, for how much.

Charts are hand-drawn SVG for categorical work (donut, bars, distribution) and
TradingView Lightweight Charts for price, where people expect candles, a real
time axis and a crosshair. Candles are built from pool state deltas: every swap
rewrites the pool row, so consecutive rows carry both the price path and the
volume that moved it — no trade index needed.

Filtering is in-memory. 19,820 objects filter in about a millisecond, which is
faster than any server round trip, so there is no database and none is wanted.

### Where the data comes from

Live state is read from chain on every visit. A GitHub Action (`.github/workflows/snapshot.yml`)
also commits a daily snapshot to `data/`, which does two things: the terminal paints
from it instantly instead of sweeping for 15 seconds, and `data/history/` accumulates
the APR and TVL series that neither the chain nor Hyperion keeps for us. Daily is
enough — APR does not move fast enough to want more, and it keeps the history at
roughly 6 MB a year rather than 140 MB. No database and no host: the indexer is a
cron job on GitHub and the database is a file in the repo.

---

## Things learned the hard way

Read these before changing the data layer.

**Alcor positions have no owner index.** The chain scopes `positions` by
`poolId` with the owner *inside* the row, so "what does this wallet hold" is not
a query the chain can answer. Sweeping 11,551 scopes from a browser is not an
option. Instead `walletPositions()` asks Hyperion which pools the account has
*acted* on — `addliquid`, `collect` and `subliquid` are signed by the user, so
they are indexed under their account, unlike the inline `logmint` which is
authorised by the contract and will return nothing.

**Fee fields are millionths.** Alcor's `fee` of `3000` means 0.30%, not 30%. A
wrong divisor here silently corrupts every fee, APR and volume figure.

**Prices must be allowed to be absent.** Live farms pay in GTAP, YEET, PURR and
dozens of other tokens with one thin pool each. `price.js` refuses to quote
anything whose deepest route is under $40, and the UI says "unpriceable" rather
than printing a confident fantasy. The WAX anchor is cross-checked: the six
deepest WAX/stable pools agree to within 1.1%.

**An APR needs a real denominator.** $230/day of rewards against $1.32 staked
computes to 6,372,786% and means nothing. Below $25 staked the terminal says
"too thin"; below $250 it shows the number without dressing it up.

**TVL is not doubled on Alcor.** A constant-product pair is balanced in value by
construction, so doubling one priced leg is exact for Taco. Concentrated
liquidity carries no such guarantee, so a half-priced Alcor pool reports only the
leg it can prove and marks itself with `*`.

**Public RPC bites.** Greymass answers `403` without a User-Agent and `420`
under load. `chain.js` rotates hosts and benches a hurt one.

**Hyperion gaps and lags.** Treat it as possibly partial. It is used for history
and per-account lookups, never as the source of truth for balances.

---

## Layout

```
index.html      shell and view markup
theme.css       ← rebrand here
theme.json      ← and here
app.css         structure; no colours
js/chain.js     RPC + Hyperion, host rotation, sharded table sweeps
js/math.js      Uniswap-V3 maths on X64 fixed point
js/price.js     routing to a stablecoin, with a depth floor
js/store.js     loads both DEXes, derives pools/farms/positions, IndexedDB cache
js/compound.js  harvest discovery and the N-asset rebalance planner
js/charts.js    hand-drawn SVG; no chart library
js/app.js       views and wiring
selftest.html   verifies the maths against live chain state
```

---

## Signing

WharfKit is wired (Anchor everywhere; WAX Cloud Wallet where the page is served
over HTTPS, since its popup needs a secure context). Compounding runs as **two
transactions on purpose**:

1. **Harvest and rebalance** — `collect`, one `getreward` per incentive, then the
   swaps that route foreign rewards into the ratio the band needs.
2. **Redeposit** — read what actually landed, `addliquid` that into the same
   ticks, and pay the service fee inline.

The split exists because `addliquid` takes concrete amounts while a swap's output
is only known once it executes. Predicting it means either leaving value behind
or reverting the whole transaction on a rounding error. Reading real balances
between the two removes the guess entirely.

Set `commercial.feeAccount` in `theme.json` to collect the fee; leave it empty
and no fee action is built at all.

**The action shapes are taken from the live ABI and a real on-chain swap, but no
compound has been executed yet.** Do the first one with a position holding a few
dollars before pointing anyone else at it.

## Not built yet

- TacoSwap history and its `exchangelog` feed.
- Premium gating, alerts and exports.
- Restaking after a compound is built (`buildRestake`) but not yet in the flow.

**Thin routes are marked, not hidden.** Only bridged dollars are declared worth
a dollar. Everything else is priced through the pool graph, and a price carries
the depth of the *thinnest* hop on its way to a real one — not the last hop,
which is a subtle and expensive difference. Measured 2026-08-29: 997,731 PARAUSD
sat in WAX pools whose entire exit to a bridged stablecoin was $590. Declaring it
$1 inflated headline TVL by half a million dollars of value nobody could realise.
$2.20M of the $2.90M the terminal reports stands on routes under $1,000; it says
so on the front page.

### Sharing an IP with trading bots

This terminal is client-side, so in production every visitor's browser calls the
public nodes from their own address and nothing is shared. The daily snapshot
runs on GitHub's runners, not yours.

The one case that does share an IP is developing locally on a machine that also
runs bots against the same public nodes. Append `?snapshot=1` to the URL while
working on the UI: the page renders entirely from `data/pools.json` and makes
zero chain calls. Use it instead of reloading a full sweep to check a layout.
