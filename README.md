# FlipLedger

Multi-marketplace profit tracking and bookkeeping for Amazon, Walmart, and eBay
resellers. Self-hosted, single-user, runs on your own machine. Pulls live
financial data from the marketplaces' APIs, applies FIFO COGS, and gives you
an accurate cash-basis P&L per marketplace and across your whole business.

> **Status:** Active development. Used in production by the author for tax
> filing and daily operations. Stable but expect rough edges.

---

## What it does

- **Amazon** — Orders, financial events (sales / fees / refunds / reimbursements),
  FBA inventory, settlement reports, FBA reimbursements report.
- **Walmart** — Orders (WFS + Seller Fulfilled), returns, recon reports for
  exact fee data, WFS inventory + inbound shipments, dispute candidate
  detection.
- **eBay** — Orders + per-order marketplace fees via the Fulfillment API.
- **Multi-lot FIFO COGS** — track multiple buy lots per SKU at different costs;
  FIFO depletes oldest first.
- **P&L** — full income / expense breakdown by marketplace, with a cash/accrual
  toggle, date range, and CSV export.
- **Dashboard** — revenue, profit, ROI, top/worst products, expense breakdown.
- **Tax Report** — Form 1120-S layout with IRS line numbers, per-section CSV
  exports.
- **Reimbursement / dispute helpers** — surfaces FBA inventory losses Amazon
  hasn't reimbursed yet, Walmart returns you may be able to dispute, and Amazon
  reimbursements you may want to re-evaluate.
- **Listing tool** — multi-marketplace listing creation (Amazon + MFN), inbound
  plan creation, FNSKU / box label printing.
- **Walmart listing + WFS shipping** — scan a walmart.com link, item ID or UPC;
  restock an existing SKU, convert a seller-fulfilled SKU to WFS, or create a
  new WFS / seller-fulfilled SKU from Walmart's live item spec (validated
  against Walmart's own JSON schema before sending, optional Claude suggestions
  for empty fields); then create the WFS inbound order, enter boxes, print
  receiving labels, and book Walmart's FedEx rate or add your own tracking.
  How it works and the Walmart API quirks behind it:
  [`docs/WFS_LISTING_TOOL_GUIDE.md`](docs/WFS_LISTING_TOOL_GUIDE.md).

The numbers reconcile to within a few dollars per marketplace against Walmart
Seller Center, Amazon Seller Central, and Sellerboard — see [`CLAUDE.md`](CLAUDE.md)
for accuracy notes.

---

## Stack

- Next.js (App Router) + TypeScript
- SQLite via better-sqlite3
- TanStack Table, Recharts, Tailwind CSS
- Single-user, no auth — data lives on your machine

---

## Setup

### Prerequisites

- Node 20+
- npm
- Marketplace API credentials (see below)

### Install + run

```bash
git clone https://github.com/moge111/flipledger.git
cd flipledger
npm install

# (optional) seed with realistic sample data so the UI isn't empty
npx tsx src/lib/seed.ts

npm run dev
# → http://localhost:3000
```

### First-run configuration

1. Open [http://localhost:3000/settings](http://localhost:3000/settings).
2. Paste your marketplace credentials (Amazon / Walmart / eBay). Each section
   has a "Test Connection" button.
3. Click "Sync Now" — first sync may take 5-15 minutes depending on order
   volume.
4. Once data is in, fill in COGS for your SKUs on the Products page.
5. Optional: the **manual CSV imports** below fill gaps the APIs leave.
6. Optional: add an Anthropic API key under **Settings → Claude (AI
   suggestions)** to have Walmart item-setup fields suggested for you.

### If you're shipping to Amazon FBA

Fill in **Settings → Ship-From Address**. Amazon passes the business name,
phone, and email to the carrier as the pickup contact, so there is no default —
carrier booking refuses to run until they're set.

### Getting marketplace credentials

This is the hardest part of setup. Each marketplace has its own developer
flow — **you have to register your own developer app**; you can't reuse anyone
else's credentials.

- **Amazon SP-API**: register at [developer-docs.amazon.com/sp-api](https://developer-docs.amazon.com/sp-api).
  You'll need: Client ID, Client Secret, Refresh Token (from the LWA OAuth flow),
  Marketplace ID (e.g. `ATVPDKIKX0DER` for the US).
- **Walmart Marketplace API**: register at [developer.walmart.com](https://developer.walmart.com).
  You'll need: Client ID, Client Secret.
- **eBay Developer**: register at [developer.ebay.com](https://developer.ebay.com).
  You'll need: Client ID, Client Secret, Refresh Token.

### What's in `data/`

The SQLite DB lives at `data/flipledger.db`. The entire `data/` directory is
in `.gitignore`. Don't commit it — it has your sales, fees, and credentials.

```
data/
├── flipledger.db              # your books
├── walmart-service-fees/      # unzipped Seller Center CSV exports (see below)
└── backups/                   # automatic nightly snapshots
```

Automatic backups run nightly and are pruned on a tiered schedule (every
snapshot for 7 days, then weekly to 16 weeks). Point **Settings → Backups →
Backup folder** at a synced folder (iCloud Drive, Dropbox, etc.) to get
off-machine durability — your entire books are one file.

Backups are recommended before any major change. The author's preferred
pattern:

```bash
cp data/flipledger.db data/flipledger.db.bak-$(date +%Y%m%d-%H%M%S)
```

---

## Manual data imports

Not everything is available over an API.

### 1. Walmart WFS service fees — automatic now

Earlier versions needed a manual Seller Center "Services Fees" CSV import.
That's retired: the recon report sync now books WFS storage, inbound
transportation, removal and RTV fees, plus WFS Refund / LostInventory
reimbursements, straight from the API. (The rows were always in the recon
report; they have no Purchase Order #, and the old parser skipped them.)
The old import endpoint now returns 410 — don't re-enable it alongside the
recon path, or the fees are counted twice.

> **Reminder on lost/damaged inventory:** a reimbursement for stock lost
> *before it sold* is income, but that stock's cost never flowed through COGS
> (FIFO only releases cost on a sale). Book an offsetting expense for the lost
> units' cost, or you'll overstate profit. See `RECOVERY_PLAYBOOK.md`.

### 2. Amazon Unified Transaction Report — recommended

Amazon's Financial Events API returns pending service fees with a `PostedDate`
that **rolls forward to today on every sync**, so storage / subscription /
inbound fees land in the wrong month until they settle. The Date Range
Transaction Report has authoritative dates and corrects them.

1. Seller Central → **Payments → Reports Repository → Date Range Report**
   (type: Transaction), pick your range, download the CSV.
2. **Settings → Import Transaction Report** and upload it.

Deletions are bounded to the CSV's own date window, so importing a report that
covers January–June will not wipe fees from July.

**Cadence:** monthly is plenty.

---

## Testing

```bash
npm test
```

83 tests, ~15s, no external services. Covers a golden-dataset P&L regression
(hand-computed integer-cent figures run through the real route handlers),
Dashboard↔P&L parity, and pure-function locks on the profit math.

If `data/flipledger.db` exists, an extra layer of live-data invariant tests runs
against it (orphan rows, dedup index shape, duplicate detection). On a fresh
clone with no DB those skip automatically.

**Run `npm test` after any change to sync code, accounting queries, dedup logic,
or the P&L / Dashboard / tax routes.** Every historical accounting bug in this
project drifted silently for weeks before someone noticed a number looked odd —
that suite exists to catch exactly that.

---

## Architecture

```
src/
├── app/
│   ├── api/                         # Internal data + sync endpoints
│   │   ├── data/                    # Read endpoints (P&L, dashboard, lookup, etc.)
│   │   └── sync/                    # Triggered sync endpoints (manual + auto)
│   ├── analyze/                     # Profit & loss, ROI, etc.
│   ├── bookkeep/                    # Refunds, reimbursements, disputes
│   ├── inventory/                   # FBA / WFS / MFN stock
│   ├── list/                        # Listing tool
│   ├── lookup/[id]/                 # Unified order detail view
│   ├── products/                    # Products & COGS (multi-lot)
│   ├── settings/                    # Credential entry + sync controls
│   └── tax-report/                  # Form 1120-S layout
├── components/                      # UI components (tables, charts, ui)
├── lib/
│    ├── sp-api/                     # Amazon SP-API clients + sync orchestration
│   ├── walmart-api/                 # Walmart Marketplace API clients
│   ├── ebay-api/                    # eBay API clients
│   ├── db.ts                        # Schema + initialization
│   ├── fifo.ts                      # Multi-lot FIFO COGS engine
│   ├── calculations.ts              # Profit / ROI / margin (single source of truth)
│   └── recurring-expenses.ts        # Auto-generates monthly expense rows
└── data/
    └── flipledger.db                # Your DB. Gitignored.
```

---

## Architecture decisions worth knowing

### Cash basis by default
The P&L counts revenue / fees / refunds when the marketplace **actually
settles** the transaction (Amazon ShipmentEvent, Walmart recon report posted),
not when the customer places the order. This matches your bank deposits and
your tax-reportable income.

The Cash/Accrual toggle on the P&L page lets you switch to purchase-date basis
if you want to compare against tools that count earlier (like InventoryLab).

### Multi-lot FIFO
Each SKU can have multiple inventory lots at different costs. FIFO depletes
the oldest lot first. To retroactively lower COGS for a SKU you re-bought at
a clearance price, click "Lots" on the Products page and add a new lot dated
before the existing lot.

### Self-healing dedup
Several upstream APIs assign different IDs to the same logical event (e.g.
Amazon's Adjustment events vs. its FBA Reimbursements Report — same payment,
different IDs). FlipLedger runs a post-sync sweep that consolidates these
rather than relying on insert-time prevention. See `src/lib/sp-api/dedupReimbursements.ts`
and `src/lib/walmart-api/dedupRecon.ts`.

### Settlement-only Walmart refunds
Walmart's Returns API surfaces refunds at customer-initiation time, but the
seller debit lags 1-3 weeks. The P&L only counts Walmart refunds that have a
corresponding `WalmartRefundEvent` in the recon report (proof Walmart actually
debited you). Same pattern as cash-basis revenue.

---

## Limitations / known caveats

- **Walmart Orders API only returns ~6 months** of history. Recon (fees) goes
  back ~18 months. So months older than 6mo will have all the fees but no
  order revenue, making them look severely negative. File those via your
  prior tool / Sellerboard.
- **Walmart WFS shipments mid-receiving are invisible.**
  `/fulfillment/inbound-shipments` only returns `AWAITING_DELIVERY` and
  `CLOSED`. A shipment that has arrived but is still being checked in returns
  nothing, so those units show in neither inbound nor on-hand until receiving
  completes.
- **Walmart has no dispute API.** Reason-based dispute candidates and
  lost-in-pipeline claims are surfaced with pre-written templates, but you file
  them in Seller Center.
- **Amazon settlement timing** — orders shipped in the last 1-3 days may not
  have ShipmentEvents posted yet. They appear on cash-basis P&L once Amazon
  posts them.
- **Amazon SAFE-T claims, Walmart disputes, reimbursement re-evaluations** —
  FlipLedger surfaces candidates and provides templates, but does not file
  them. Marketplace dispute APIs are gated. You file in Seller Central and
  click "mark filed" in FlipLedger.
- **Listing tool** — the full FBA inbound flow (send → boxing → packing →
  placement → carrier booking → FNSKU / box / shipping labels) runs through
  SP-API and has been exercised end-to-end against real Amazon shipments. A
  "Sync from Amazon" button still exists to re-import state if you finish a
  step in Seller Central instead.
- **Amazon catalog defects block some ASINs.** Occasionally Amazon's shared
  catalog demands an attribute and then rejects the value you send for it
  (issue code 90244 / 90000900). The listing never gets an FNSKU and can't go
  inbound. This is not fixable from the API — it needs a Seller Support catalog
  case. FlipLedger detects it, flags the item, and ships the rest of the batch
  rather than failing the whole shipment.

---

## Contributing

The code is the way it is because of one user's needs. PRs welcome but
opinionated — read [`CLAUDE.md`](CLAUDE.md) first for design philosophy and
gotchas.

---

## License

MIT — see [`LICENSE`](LICENSE).

---

## Acknowledgments

Built for resellers, by a reseller. The marketplace API quirks documented in
this code base were earned the hard way (often at 2am during tax season).
