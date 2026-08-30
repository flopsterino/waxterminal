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
- **Activity** — the live swap feed across all four venues: who traded what, through which pool, for how much, and the multi-hop routes those swaps add up to.
- **Token** — one page per token: price, supply, what is burned and what can still be minted, the transfer tax and whether a DEX actually pays it, every holder with what they hold inside pools, a bubble map of who moves it to whom, the liquidity providers, every pool it trades in, the farms touching it, transfer traffic, and its whole trade history.

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

**The live sweep must put back what the chain does not carry.** `loadCore`
builds fresh pool objects and assigns them over whatever painted first, so
anything derived rather than read is destroyed unless it is re-applied. Volume
is the obvious one — a pool row carries reserves, not the last 24 hours — and
for a long time it silently vanished a few seconds after the page painted:
tokens, most-traded, turnover and every 24h column went to a dash while the real
figure sat in `data/volume.json` on disk. Restoring it brings the total to
$30,512 against Alcor's own $30,514. The same applies to a pool's creation date
and to TacoSwap, Defibox and A-DEX volume, which those venues do not publish at
all and only the daily job counts. If you add a field the daily job computes,
add it to the restoration in `loadCore` in the same commit.

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

## The premium tier

There is no backend, so there is nowhere to keep a subscriber list and no
account to log into. The only fact both sides already agree on is what the chain
says a visitor holds, so entitlement is a token balance or an NFT, checked in the
browser against the same public nodes as everything else. Set it in
`theme.json`:

```json
"premium": {
  "enabled": true,
  "label": "Premium",
  "token": { "symbol": "HOLE", "contract": "hole.cheese", "min": 1000 }
}
```

or `"collection": "yourcollection"` for NFT-gating instead. The NFT check walks
the owner's `atomicassets` rows rather than reading the first page, because the
table is keyed by asset id with no index on the collection and a holder of
several thousand assets would otherwise be denied for sorting late.

**Premium never changes a number.** It does not hide a warning, gate a price, or
shorten a list of things the free view would have flagged as wrong. It lifts row
caps and adds convenience — the free tier is a complete and honest terminal, the
paid one is more of it at once. Gating the numbers themselves makes the free
tier a *worse answer* rather than a smaller one, which is precisely how a free
tier drives people away. Every cap lives in one table in `js/premium.js` so the
whole offer can be read at a glance, and any capped table says out loud that it
is capped and what lifts it — a visitor cannot otherwise tell whether a row is
missing because of the tier or because the data ends there.

With `enabled: false` nothing is gated and every cap stays where it is today.

## Reading a token's trades without a trade index

Hyperion cannot filter `logswap` by pool. The `poolId` query parameter is
accepted and silently ignored, and what comes back is the whole chain's swap
firehose — so asking it for one token's trades means reading every swap on WAX
and discarding almost all of it. The first token page did exactly that for three
pages and then printed "no trades in the last six hours", a claim it had no way
to make: three pages of a live firehose is about twenty minutes.

The pool row is the trade index. Every swap rewrites it, so two consecutive
states *are* a trade — the reserve that fell is what was sold, the one that rose
is what was bought, and `get_deltas` replays them filtered server-side by primary
key. Deposits and withdrawals rewrite the same row, so they are told apart by
sign: a swap moves the two sides in opposite directions and moves the price with
them, which a mint or a burn does not.

Measured on CHEESE/HOLE: six calls, 1,485 states, **1,224 real trades reaching
back forty-five days**. The same six calls also draw the candles, which is why
the page fetches them once and hands the rows to both.

All four venues keep such a table, so all four are replayable — `DELTA_SOURCE`
in `js/store.js` is the whole difference between them. TacoSwap keys its pairs
by symbol code rather than by number ("CHEPXJ", not 1305) and `get_deltas` wants
the number, which is the same uint64 seen differently: up to seven bytes, first
character in the lowest. Concentrated liquidity means Alcor's price comes from
`sqrtPriceX64` and not from the reserve ratio; for the constant-product venues
the ratio *is* the price.

Legs in the same block are one trade. A route crossing two of a token's own
pools writes two rows, and listing them separately says the trade happened twice
and doubles the volume with it — the same mistake as summing every hop of a
multi-hop swap. They fold into one, worth its largest leg, and a route that
nets out near zero is marked as passing through rather than buying or selling.

The one thing this cannot give is who traded: a pool row records the change, not
the account that caused it. The swap memo can. An Alcor swap arrives as a
transfer to `swap.alcor` whose memo names every pool the route will cross, so
the token page's transfer feed answers it without another fetch — after learning
that a contract re-notifying a transfer produces a second row for the same
movement, which doubles every count until you drop the rows that duplicate the
exact action that created them.

## Not built yet

- Alerts. CSV export is on pools, tokens, farms, a token's trade tape and the
  activity feed's routes and raw swaps.
- Per-token history starts the day the snapshot job first records it. The chart
  says so rather than drawing two points across a year of axis.

**Thin routes are marked, not hidden.** Only bridged dollars are declared worth
a dollar. Everything else is priced through the pool graph, and a price carries
the depth of the *thinnest* hop on its way to a real one — not the last hop,
which is a subtle and expensive difference. Measured 2026-08-29: 997,731 PARAUSD
sat in WAX pools whose entire exit to a bridged stablecoin was $590. Declaring it
$1 inflated headline TVL by half a million dollars of value nobody could realise.
$2.20M of the $2.90M the terminal reports stands on routes under $1,000; it says
so on the front page.

### Developing without hammering the public nodes

This terminal is client-side, so in production every visitor's browser calls the
public nodes from their own address and nothing is shared. The daily snapshot
runs on GitHub's runners.

Local development is the exception: reloading a full sweep every time you nudge
a stylesheet is thousands of requests to shared infrastructure for no reason, and
worse if the same machine runs anything else against those nodes. Append
`?snapshot=1` to the URL while working on the UI — the page renders entirely from
`data/pools.json` and makes zero chain calls.

### Real value versus face value

A token's price can be correct while its value is not realisable, and reporting
the first as the second is lying with arithmetic.

`parareserves` is a plain `eosio.token` contract — accounts, stat, issue,
transfer, and nothing else. No collateral, no redemption, no peg, despite the
name. It minted exactly 1,000,000 PARAUSD and placed 999,997.68 of them inside
`swap.alcor`, in positions it owns itself, at a price it chose. Read naively that
is $998,088 of liquidity. The entire exit to anything else is $1,186.
`TVL@hype.gm` is worse: $561,055 nominal against an $8 exit.

So `js/depth.js` computes, per token, how much *independently liquid* value
stands opposite it, and caps what that token can contribute. Bridged dollars seed
the solid set; WAX earns in through them; tokens paired with WAX earn in through
WAX. Tokens issued and pooled by the same hand never do.

The result: **$353,808 real against $2,899,667 nominal — 12%**. Alcor's own API
agrees independently, setting `safe_usd_price` to zero for the same tokens, and
that verdict is shown next to ours in the tables.

The same rule applies to farms. Of 127 pools with a computable APR only 69 have
both rewards that could be sold and capital that is really there. The nominal
leaderboard was topped by DNA/WAX at 1,983%, WAX/WHATIF at 665% and PUZZL/WAX at
463% — none of which have any real value at all.
