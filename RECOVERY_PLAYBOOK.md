# Recovery Playbook — what Amazon & Walmart actually owe you

Researched July 7, 2026 against current policy (Amazon's Oct 2024 window overhaul,
Mar 2025 valuation change, Feb 2026 SAFE-T change; Walmart Marketplace Learn WFS
dispute docs). This is the reference behind the Recovery Hub's rules. When a
policy changes, update BOTH this file and the matching detector.

**The one-page answer:** money comes back when the loss happened while the
marketplace controlled your inventory (their warehouse, their carrier, their
returns pipeline) or when their automation short-paid you. Money does NOT come
back for customer-fault outcomes (changed mind, customer-damaged, "poor
quality"), anything past the filing window, or losses you contractually
accepted (returnless refunds, unprepped shipments). **Windows are now short
(30–60 days). Speed matters more than anything else.**

---

## AMAZON

### ✅ Recoverable

| Scenario | Window | Paid at | How |
|---|---|---|---|
| **Lost/damaged in FC** (warehouse adjustment, no reimbursement) | **60 days** from the loss/damage being recorded | Sourcing/manufacturing cost | Get Support → "Inventory lost in FBA warehouse". Hub source: *Warehouse loss* |
| **Lost/damaged inbound to FBA** (shipped units never received) | ~60 days from delivery; check shipment reconciliation first | Sourcing cost | Shipment reconciliation, then case. Shows up as ledger adjustment → *Warehouse loss* |
| **Refunded, never returned** (FBA) | **Days 60–120 after the refund** — cannot file before 60, forfeited after 120 | Sourcing cost | Get Support case. Amazon auto-reimburses many since Nov 2024 — the Hub only surfaces the missed ones |
| **Reimbursement underpaid** | **60 days** from the reimbursement | Up to documented sourcing cost | "Submit a reimbursement claim dispute" + the reimbursement ID + invoice. Hub source: *Underpaid reimbursement* |
| **FBA fee overcharge** (wrong size tier after remeasure) | ~90 days of fees recoverable | Fee delta | Get Support → request cubiscan remeasure. Hub source: *FBA fee overcharge* |
| **MFN refund at Amazon's hands** (RFS auto-refund, CSBA/SFP refunds, prepaid-label returns) where it wasn't your fault | **30 days** (was 60 — cut Feb 16, 2026) from return scan at your warehouse or refund, whichever later | Refund amount (capped) | SAFE-T claim. Hub source: *SAFE-T dispute* |
| **Removal/disposal errors** (wrong units removed, removal lost in transit) | ~60 days from the removal event | Sourcing cost | Get Support case |

### ❌ NOT recoverable — don't waste time filing

- **FBA refunds where the returned item came back sellable** — you got the unit back; the cost flows to the resale.
- **Customer-damaged returns (FBA)** — "customer damaged" disposition is the seller's loss by policy. (If the FC or carrier damaged it, that IS claimable — the disposition tells you which.)
- **Returnless-refund items** — if you enrolled the SKU in returnless resolutions, you agreed to the loss.
- **FBA orders via SAFE-T** — SAFE-T is MFN/SFP only; FBA has no "Amazon refunded unfairly" path. If Amazon's auto-reimbursement rules didn't trigger, the loss is generally absorbed.
- **Anything past the window** — 120 days (returns) / 60 days (most else) / 30 days (SAFE-T) are hard cutoffs. The Giganotosaurus re-eval denial ("outside eligibility window") is our own proof.
- **From Jan 1, 2026:** items in shipments that arrived **without required prep/labeling** are ineligible for lost/damage reimbursement entirely.
- **MFN returns generally** — outside the SAFE-T triggers above, merchant-fulfilled returns are between you and the buyer.

### Valuation reality (the part that costs the most)

Since **March 31, 2025**, anything lost *before a customer order* is reimbursed
at **manufacturing/sourcing cost**, not sale price — sellers report recoveries
dropping 50–75%. Two defenses:
1. **Keep sourcing costs approved in "Manage Your Sourcing Cost"** (an approved
   cost auto-applies to all future losses of that item — worth doing for
   anything with real FBA stock; our checklist: `~/Downloads/sourcing-cost-doc-checklist.csv`).
2. **Dispute underpaid reimbursements within 60 days with the invoice.** The
   Hub's *Underpaid reimbursement* rows are exactly these.

---

## WALMART (WFS)

### ✅ Recoverable

| Scenario | Window | Paid at | How |
|---|---|---|---|
| **Return with a "Walmart fault" reason** — damaged in transit, lost in transit, **late arrival**, incorrect item, unable to deliver, damaged shipping box, lost after delivery | Dispute within **45 days** of the window opening (opening varies: RTS delivery scan, settlement date, etc.) | Refund amount | Seller Center → Returns & Reimbursements dispute. Hub source: *WFS dispute* |
| **Return initiated, never processed / unit vanished in the returns pipeline** | Window **opens 90 days** after the return, then 45 days to file (days 90–135) | Avg sale price (restocked-and-sold basis) | Seller Support "Initiate claim" (the Dispute button is blocked for WFS returns). Hub source: *WFS lost return*. Walmart also auto-pays `LostReturnAdjustment` for lost-in-transit returns — check settlements first |
| **Inbound shipment shortages** (WFS received fewer than shipped) | **Days 10–50 after delivery** to the FC | Avg sale price | Seller Center → Shipping plans → Track items → "Investigate shipment". Parcel via Walmart carrier: no docs; otherwise POD/signed BOL |
| **Lost/damaged inventory in WFS custody** | Same investigation flow | Avg sale price | e.g. our 141-unit shipment: $1,931 paid via InboundQuantityDispute |
| **Fee errors / funded incentives / dispute settlements** | Recon-driven | Exact | Land automatically in recon; FlipLedger books them |

Note Walmart's *valuation is better than Amazon's* (avg sale price vs sourcing
cost) but its evidence bar is higher and **"no appeals will be accepted"** —
one case per order, so make the first filing complete.

### ❌ NOT recoverable

- **Seller/customer-fault return reasons** — Walmart's policy names them: wrong size, **poor quality, missing parts, not as described, defective**, customer refusals, changed mind, lower price elsewhere. Reason-based disputes on these lose. (*Exception:* if the UNIT then vanishes in the pipeline, the lost-return claim above still applies — the claim is about the missing unit, not the reason.)
- **Damaged/unsellable returns you had set to "return to me"**, items unsafe to return, fraud-locked devices, keep-it-rule items, missing non-essential accessories.
- **Inbound loss using your own carrier** — seller's carrier, seller's problem.
- **Anything filed outside 10–50 days (inbound) or the 45-day dispute span.**
- **Inconclusive investigations** — Walmart decides "in its sole discretion," no appeal.

---

## How this maps to FlipLedger (Recovery Hub)

| Hub source | Detector | Window encoded |
|---|---|---|
| Warehouse loss | `reimbursementCandidates` (ledger adjustments − reimbursements) | 60d from adjustment |
| Underpaid reimbursement | `reimbursementReevaluations` (paid < documented cost, pre-order reasons) | 60d from reimbursement |
| Refund, no return | `recovery/discrepancies` refund_no_return | days 60–120 after refund *(corrected July 7, 2026 — was 45–105)* |
| FBA fee overcharge | `recovery/discrepancies` fee_overcharge | no hard deadline; ~90d of fees recoverable |
| SAFE-T dispute | `amazonDisputeCandidates` (MFN only) | 30d from refund *(corrected July 7, 2026 — was 90; policy cut to 30 eff. Feb 16, 2026)* |
| WFS dispute | `walmartDisputeCandidates` reason-based | 45d *(corrected — was 30; DEFECTIVE/NOT_AS_DESCRIBED/MISSING_PARTS moved to not-eligible per policy; ARRIVED_LATE moved to eligible)* |
| WFS lost return | `walmartDisputeCandidates` lost-in-pipeline | days 90–135 *(corrected — was 60–180)* |

**Operating rhythm:** the windows are short enough that recovery is a weekly
habit, not a quarterly cleanup. Open Recovery Hub → "File These Now" → work top
(nearest deadline) down. Keep sourcing costs approved for anything with FBA
stock so Amazon's cost-basis payouts don't lowball you.

---

### Sources
- [Amazon: FBA inventory reimbursement policy](https://sellercentral.amazon.com/help/hub/reference/external/G200213130) · [Customer return claims](https://sellercentral.amazon.com/gp/help/external/G9N934L7Y4SFWPJ4) (login-gated; verified via trackers below)
- [Refunzo: missing-return reimbursement guide](https://www.refunzo.com/blog/amazon-missing-return-reimbursement-guide/) — 60–120 day window, Nov 2024 auto-reimbursement, Mar 31 2025 cost-basis
- [MyAmazonGuy: SAFE-T window cut to 30 days](https://myamazonguy.com/news/amazon-safe-t-claim-filing-window/) — eff. Feb 16, 2026
- [NovaData](https://novadata.io/resources/blog/amazon-reimbursement-guide) / [SalesDuo](https://salesduo.com/blog/amazon-fba-reimbursement-claim-guide/) — Oct 2024 60-day windows, 2026 prep/labeling eligibility change
- [Walmart Marketplace Learn: WFS returns, reimbursement & disputes](https://marketplacelearn.walmart.com/guides/Walmart%20Fulfillment%20Services%20(WFS)/Troubleshooting/wfs-customer-returns-reimbursement-and-dispute-processes) — fault lists, 45-day dispute span, per-scenario window openings, non-reimbursable list
- [Walmart Marketplace Learn: WFS inbound disputes](https://marketplacelearn.walmart.com/guides/Walmart%20Fulfillment%20Services%20(WFS)/Troubleshooting/Troubleshoot-WFS-receiving-issues:-open-a-dispute-claim) — 10–50 day window, evidence table, avg-sale-price valuation
