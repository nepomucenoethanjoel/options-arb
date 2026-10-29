# Live-fill checklist (lifting `single_maker` / `indicative_quote`)

Hypercall quotes carry `single_maker` and Callput quotes carry
`indicative_quote`. Both flags are headline-blocking because nobody has yet
proven that a fill matches the quote the app shows. **No code removes either
flag until one real minimum-size round trip on that venue is recorded in
`DATA_SOURCES.md`** (AGENTS.md rules 2 and 3).

## Before the trade
- [ ] Note the app's quote for the contract: `/api/pair?pairKey=…` → the
      venue leg's `bid`/`ask`, its sizes, `ts`, and the signal's `costsUsdc`.
- [ ] Screenshot the venue's own UI quote at the same moment.
- [ ] Use the venue's minimum size. This is evidence, not a position.

## Record from the fill
| Field | Why |
|---|---|
| Fill price vs. the app's quoted price (and the UI quote) | Is the quote firm? Callput: does the keeper fill near `mark × (1 ± riskPremium)`? |
| Time from submit to fill | Callput keeper queue (docs say ≤180 s); Hypercall RFQ expiry |
| Size accepted vs. the size the app showed | Hypercall `max_bid_size` / `max_ask_size` units (DATA_SOURCES row 38: two fields differ by 1e6) |
| Every fee charged, itemised (trade, settlement, keeper/execution) | Check the fee model in `signals/fees.ts`; Callput's execution fee is unpublished |
| The transaction hash / order id | Evidence link for the DATA_SOURCES row |

## After expiry (if held)
- [ ] Settlement price used vs. the venue's documented method.
- [ ] Settlement fee charged.
- [ ] Settlement asset received (Callput calls settle in WBTC/WETH).

## Then
1. Add a DATA_SOURCES.md row, status **VERIFIED-LIVE**, with the numbers above and the tx/order id.
2. Only if the fill matched the quote within the app's tolerance: remove the
   flag for that venue in its adapter, fix any fee or size units the fill
   contradicted, and adjust the adapter's fixture test, all in the same commit.
3. If the fill did **not** match: keep the flag and record why. That is the
   correct outcome too.
