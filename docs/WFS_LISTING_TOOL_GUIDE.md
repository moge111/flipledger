# How our Walmart WFS listing tool works

A build guide for someone who wants to make their own. It covers how ours is built, what each Walmart API call does, and the problems we only found by running it against a real seller account. Hand it to Claude (or any developer) as the spec.

Our tool is part of a larger reseller app ("FlipLedger": Next.js + SQLite, single user, runs locally). Only the Walmart listing and WFS-shipping part is described here. Every quirk below was hit live in October 2026. Walmart changes things, so re-check anything that looks off.

---

## 1. What it does, end to end

1. **Scan or paste** a walmart.com link, a Walmart item ID, or a UPC.
2. **Look up** the one Walmart catalog product it refers to, confirmed by barcode.
3. **Decide** what has to happen for that product:
   - you already sell it on WFS → plain restock
   - you sell it seller-fulfilled → convert the SKU to WFS
   - you don't sell it yet → create a new WFS SKU
4. **Set up the SKU** if needed. The tool builds a form from Walmart's *current* item spec, fills in everything it can (Walmart's page, Amazon's catalog, remembered answers, then an LLM for the rest), validates the feed against Walmart's own JSON schema, submits it, and polls until Walmart says SUCCESS or FAILED.
5. **Record the cost** of the units bought (a cost lot per batch line) for profit tracking.
6. **Send to WFS:** one inbound order per batch. Walmart splits it into one or more shipments (one per fulfillment center).
7. **Per shipment:** enter boxes, print WFS receiving labels, then either book Walmart's discounted FedEx (quote → book → carrier label) or enter your own carrier's tracking.
8. Show **expected revenue, fees, profit and ROI** per item and per batch.

There are also **seller-fulfilled batches** (same lookup, offer-only setup, then a Publish that sets the Walmart quantity) and a standing **"stock to send" holding list**: you create the SKU and record the cost the day you buy, then move the units into a real shipment later.

---

## 2. Walmart API basics

- Base URL: `https://marketplace.walmartapis.com/v3`
- **Token:** `POST /v3/token` with `Authorization: Basic base64(clientId:clientSecret)`, `grant_type=client_credentials`. The token lasts 15 minutes. Cache it and refresh about 60 seconds before it expires.
- **Every request** sends `WM_SEC.ACCESS_TOKEN`, `WM_SVC.NAME: Walmart Marketplace`, and a fresh UUID in `WM_QOS.CORRELATION_ID`.
- **Also send the Basic header** (`Authorization: Basic …`) on every request. Some endpoints (payment statement, for example) return 404 without it. It does no harm elsewhere.
- **⚠️ `WM_GLOBAL_VERSION: 3.1` + `WM_MARKET: US` go ONLY to the Preferred Carrier endpoints** (`inbound-shipments-quote`, `inbound-shipments-booking`, `generate-label`, `download-label`). The docs list them as required there. If you send them to `POST /fulfillment/inbound-shipments`, Walmart answers 400 "invalid martId,buId" / "tenant not found for buId,martId". We lost our first live send to this.
- **Retries:** on 429, wait until `X-Next-Replenishment-Time`; back off on 5xx; on 401, refresh the token once and retry. **Never auto-retry a request that creates something or spends money** (inbound order create, carrier booking). A retried POST can open a second order or book twice.
- Your HTTP helper must support PUT/DELETE, PDF responses (labels), empty bodies, and **202 = "not ready yet"** (carrier labels).
- Error bodies come in two shapes (RFC 9457 `detail/title`, or legacy `errors[].description`). Parse both into one readable message.

---

## 3. Product lookup (the hardest part to get right)

Input parsing: a URL → item ID from `/ip/<slug>/<id>`; 8/12/13/14 digits with a valid GTIN check digit → barcode; a check-digit failure → "typo?"; an 8–12 digit number that matches no barcode → try it as an item ID.

**Public catalog search, `GET /items/walmart/search`**
- It takes `upc`, `gtin`, `keyword` and a few others. **It has no item-ID parameter.**
- **Always pad barcodes to the 14-digit GTIN.** A 12-digit `gtin` returns junk.
- **About 1 in 4 calls returns a corrupted record** (an unrelated product with no `standardUpc`), even for a correct query. Keep a result **only if its `standardUpc` equals your GTIN-14 exactly**. Retry up to about 6 times with growing pauses, alternating the `gtin` and `upc` forms. A genuine miss then takes about 8 seconds.
- **Item ID → barcode trick:** a *keyword* search for the bare item ID (`?query=<itemId>`) returns that item with its `standardUpc`. This also sometimes comes back without `standardUpc`, so retry.

**Seller catalog search, `POST /items/catalog/search`** with body `{query:{field:'sku'|'gtin'|'upc'|'itemId', value}}`
- Finds only items **you** already have a SKU on, and accepts an item ID. Use it to detect "you already sell this" and to get your existing SKU, its status and its price.
- A 404 "No Items found" means "not yours". It is not an error.

**walmart.com product page** (fallback, and the source of the setup form's content)
- `https://www.walmart.com/ip/<itemId>`, with the data in the `__NEXT_DATA__` JSON at `props.pageProps.initialData.data` (`product.{usItemId, upc, name, brand, imageInfo}`, `idml.{longDescription, specifications, specificationsV2, productHighlights, warnings}`).
- **walmart.com blocks server-side requests** (PerimeterX "Robot or human?" redirect) for long stretches. Treat the page as best effort only. Never make the lookup depend on it, and if you take a UPC from the page, confirm it through the official barcode search before trusting it.
- Product images on `i5.walmartimages.com` are *not* blocked, which is useful for the LLM step.

Lookup returns: `{itemId, gtin14, upc, title, brand, productType, imageUrl, priceCents, url}` plus `existing: {sku, publishedStatus, lifecycleStatus, priceCents}` if you already have a SKU on it.

---

## 4. What each item needs

Walmart allows **one SKU per product per seller**, so a restock always reuses the SKU.

| Batch type | Your SKU on this product | Action | Feed |
|---|---|---|---|
| WFS | none | create a WFS item directly | `MP_WFS_ITEM` |
| WFS | seller-fulfilled | convert to WFS | `OMNI_WFS` |
| WFS | already on WFS | restock, no feed | — |
| Seller-fulfilled | none | offer on the existing page | `MP_ITEM_MATCH` v4.2 |
| Seller-fulfilled | seller-fulfilled | restock | — |
| Seller-fulfilled | on WFS | refuse ("use a WFS batch") | — |
| any | RETIRED | refuse ("reactivate in Seller Center") | — |

"Already on WFS" = `GET /fulfillment/inventory?sku=X` shows a ship node with `shipNodeType: WFSFulfilled`.

We also reuse a SKU we submitted ourselves that is still PENDING/READY but not yet in Walmart's catalog search. Without that check you'd send a second setup feed.

---

## 5. SKU setup: spec-driven, never hard-coded

Walmart's required fields depend on **feed type × spec version × product type**, and the versions change every few months. **Don't hard-code category fields.** Ours builds the form from the live spec:

1. **Get the current version.** Walmart's "Item spec: versioning" docs page (`developer.walmart.com/us-marketplace/docs/item-spec-versioning-and-diff-reporting.md`) has a table of recommended versions per feed type. Parse it daily and keep a hard-coded fallback.
   - ⚠️ **Don't use the version from Walmart's doc examples.** An `OMNI_WFS` feed on the old `5.0.20250121` spec failed with "Duplicate items found … consumableGtin". Seller Center converted the same SKU fine on `5.0.20260803-17_50_56-api`.
2. **Get the spec:** `POST /items/spec {feedType, version, productTypes:[productType]}` returns a JSON Schema. Cache it per (feed, version, product type) for 30 days.
3. **Find the parts:** header key `MPItemFeedHeader` (MP_WFS_ITEM) or `SupplierItemFeedHeader` (OMNI_WFS); items key `MPItem` / `SupplierItem`; each item has `Orderable`, `Visible.<productType>` and `TradeItem`.
4. **Turn every required `Visible` property into a form field** by its schema shape: string → text, long or "description" → textarea, string enum → dropdown, array of strings → list, array of enum → multi-select, integer/number, and `{number, enum-unit}` objects → "measure" (value + unit). Report any required shape you can't render so the user knows to use Seller Center.
5. **Fill fields in this order:**
   - fixed defaults: count per pack 1, Prop 65 "No", condition "New", written warranty "No", net content `1 Count`
   - walmart.com page: title, brand, description, `<li>` key features, main + secondary images, specs matched to the field's title or key, with aliases
   - Amazon catalog by UPC (if you have SP-API): unit box size and weight, battery info
   - the user's last answer for the same product type (store answers in a `field_memory` table: product_type, field_key, value)
   - an LLM for whatever is still empty (see 5b)
6. **Second pass for conditional fields.** The schema has if/then requirements (for example, Condition becomes required for some types). Build a draft feed with placeholder values, validate it, collect the `required` errors under `/Visible/`, and add those fields to the form.
7. **Validate the whole feed with ajv against Walmart's schema BEFORE sending.** Turn errors into "Material is required", "Color must be one of Walmart's listed values", and so on. A missing field becomes a form message instead of a rejected feed an hour later.
   - ⚠️ Set ajv `multipleOfPrecision: 8`. Without it, a weight of 1.15 fails "multiple of 0.0001" because of floating-point division.

**Core fields we always send** (Orderable / TradeItem): sku, `productIdentifiers {GTIN, gtin14}`, price, `stateRestrictions [{stateRestrictionsText:'None'}]`, `electronicsIndicator`, `batteryTechnologyType` (plus `hasBatteries` / `batterySize` when there is a battery), chemical / aerosol / pesticide flags (the newer spec splits them into `isChemical/isAerosol/isPesticide`; older ones use one `chemicalAerosolPesticide`), `ShippingWeight` if the spec has it, `countryOfOriginAssembly`, and `each {eachDepth, eachWidth, eachHeight, eachWeight}` (add `eachGTIN` / `orderableGTIN` only when the spec requires them). Header: `{businessUnit:'WALMART_US', locale:'en', version}`.

**The offer-only feed (`MP_ITEM_MATCH` 4.2) is small and fixed:**
```json
{ "MPItemFeedHeader": {"processMode":"REPLACE","subset":"EXTERNAL","locale":"en","sellingChannel":"mpsetupbymatch","version":"4.2"},
  "MPItem": [{ "Item": { "sku":"…", "productIdentifiers":{"productIdType":"GTIN","productId":"<gtin14>"},
                         "price": 0.00, "ShippingWeight": 0.00, "condition":"New" } }] }
```

### 5a. Battery and hazmat declarations: evidence only

- **Never default to "Does Not Contain a Battery".** Our tool once declared "no battery" on a camera with a built-in lithium-ion battery.
- Decide from evidence: battery mentions in the walmart.com page warnings or specs → contains one; else Amazon's battery attributes; else **ask the user**.
- **Fill in the battery *type* when it's stated:** use Walmart's "Battery Type" spec, else Amazon's `battery[].cell_composition`, else its lithium cell counts. Don't trust Amazon's `num_batteries` types for chemistry; they contain junk like "12v". Fill in the size only when exactly one Amazon size code matches Walmart's size list.
- If the user picks "no battery" against the evidence, refuse on the server and let them override with an explicit confirmation. Log the override.
- **Refuse (send to Seller Center):** lithium batteries (Walmart wants cell count, watt-hours and weight), chemicals, aerosols and pesticides (safety data sheet), and Prop 65 items (warning text).
- Run the battery check **on the server**, not only in the browser. A stale browser form is how the bad declaration got through.

### 5b. LLM fill (optional, but it saves a lot of typing)

- Ours uses Claude Haiku with **structured outputs**. The answer schema is built from the empty fields: enum fields can only return Walmart's listed values, and measures are `{measure, unit-enum}`.
- Send the product photo (from Walmart's image CDN, as base64) along with the title, brand, product type and whatever page text you have. The photo makes a big difference: read the box for the age range, the piece count and the choking warning.
- The prompt tells it to always write the description and key features from known facts (no invented specs), to give a best answer for everything else (estimates are fine), and to return null only when no sensible answer exists. Per-field hints (small-parts warning, material, color) keep answers stable between runs.
- Re-check every answer against the field type. Mark the fields as "suggested by AI — check it". **AI-filled forms never auto-submit.**
- **Never send battery, electronics or chemical declarations to the LLM.**

### 5c. After submitting

- `POST /feeds?feedType=X` returns a `feedId`. Store the setup state on the batch line: status `PENDING|READY|FAILED`, kind, feedType, feedId, sku, gtin14, **the full feed body** (so Retry can resend it unchanged), error, updatedAt.
- Poll `GET /feeds/{feedId}?includeDetails=true` → `itemDetails.itemIngestionStatus[]`: `SUCCESS` → READY; `INPROGRESS` → still pending (sometimes with `pendingStatusDescription`); anything else → FAILED with `ingestionErrors.ingestionError[].description`.
- Poll from the open page (every 30 s) **and** from a background job, so a closed tab doesn't stall it.
- **Compliance review:** some items sit `INPROGRESS` for up to 24–48 hours with no note in the API (Seller Center shows "under review"). We show "UNDER REVIEW AT WALMART" once a setup has been pending more than 15 minutes.
- ⚠️ **Don't resubmit an item that's under review.** A second feed fails "currently under compliance review from your previous submission", and a seller-fulfilled feed for the same SKU fails with a generic system error. Wait it out.
- Only offer **Retry** on FAILED. Block sending the shipment until every line is READY.
- An existing seller-fulfilled SKU whose form is completely known from data (no AI fields, size known, price = its current Walmart price, battery known to be none) can be converted **without showing the form**.

---

## 6. Data model (SQLite in ours)

- `listing_batches` — id, name, `channel` (`WFS` | `WMT_SF`), `marketplace='walmart'`, status (`draft → shipping`, back to `draft` on cancel; seller-fulfilled: `draft → ready`), ship-from address, `inbound_order_id`, `is_holding` (the standing "stock to send" list).
- `listing_batch_items` — sku, walmart_item_id, gtin, product name and image, quantity, buy price, list price, supplier, `walmart_setup_status` + `walmart_setup` (JSON state above), link to its cost lot, and `send_qty_to_amazon` (reused on seller-fulfilled batches as "Qty → Walmart on/off").
- `wfs_batch_shipments` — one row per Walmart shipment: shipment_id, inbound_order_id, ship-to FC address, items, boxes JSON, quotes JSON, booking, tracking, status `CREATED|BOOKED|TRACKING_SENT|CANCELLED`.
- `walmart_item_specs` (feed_type, version, product_type, spec JSON, fetched_at) and `walmart_field_memory` (product_type, field_key, value).
- **Cost lots** (`inventory_ledger`): each batch line owns its own lot (sku, qty, buy price, supplier, date) and FIFO costs sales from them. On a restock with a blank buy price, use the SKU's most recent non-zero lot cost and supplier, and say so in the UI ("your last cost, Walmart, 2026-06-26").

---

## 7. Sending stock to WFS

**Create the inbound order:** `POST /fulfillment/inbound-shipments`
```json
{ "inboundOrderId": "<your unique id, e.g. FL<batchId>-<ms>>",
  "returnAddress": {"addressLine1":"…","city":"…","stateCode":"..","countryCode":"US","postalCode":"…"},
  "orderItems": [{ "productId":"<gtin14>", "productType":"GTIN", "sku":"…", "itemDesc":"<≤200 chars>",
                   "itemQty": 12, "vendorPackQty": 12, "innerPackQty": 1,
                   "expectedDeliveryDate":"<today+7, Walmart adjusts it>" }] }
```
- **Merge lines by SKU first.** Walmart rejects duplicate SKU lines, so refuse if one SKU has two different barcodes.
- For loose units, `vendorPackQty = units`, `innerPackQty = 1`. That's what Seller Center sends for loose units.
- **No retry on this call.** The response `payload[]` holds one or more shipments: `shipmentId`, `shipToAddress` (FC name + address), `shipmentItems[]{vendorSku, itemQty}`, `expectedDeliveryDate`.
- If Walmart accepts but returns no shipments, tell the user to check Seller Center before trying again. Don't resend.
- **Cancel:** `DELETE /fulfillment/inbound-shipments/{inboundOrderId}`. This only works before receiving starts. Cancel any FedEx booking first. Leave the cost lots alone; the units were still bought.

**Per shipment:**
1. **Boxes:** length, width, height, weight, and `SINGLE SKU` or `MIXED SKUS`.
2. **Receiving labels (required):** `POST /fulfillment/shipment-label {shipmentId, labelSize:'X4_6', labelFormat:'PDF', loadTypes:[{loadType:'SINGLE SKU',count},{loadType:'MIXED SKUS',count}]}`, PDF response. WFS scans each unit's own UPC, so **there are no per-unit labels** (unlike Amazon FNSKUs).
3. **Carrier, option A: your own.** `POST /fulfillment/shipment-tracking {shipmentId, carrierName, trackingInfo:[…]}`.
4. **Carrier, option B: Walmart Preferred Carrier (FedEx parcel).**
   - Quote (free): `POST /fulfillment/inbound-shipments-quote` with `payload {shipmentId, quoteType:'Parcel', units:[{origin{…, phone digits, localName}, destination{locationType:'DC', …}, unitDetails{shipmentPackages:[{packageSequenceNumber, weight, weightUOM:'lb', length, width, height, lengthUOM:'in', packageType}]}}]}`.
   - ⚠️ **The live response doesn't match the docs.** The docs show `rateQuotes[]`. We got one `payload.rateQuote` with the shipment total in `payload.aggregates.totalCharge.measurementValue` (or `payload.netCharge`), plus per-box charges in `shipmentPackages[]`. Parse both shapes. If the POST only acknowledges, read the quotes back with `GET …-quote?quoteType=Parcel&shipmentId=`.
   - **Book (costs money):** `POST /fulfillment/inbound-shipments-booking {payload:{shipmentId, bookingDetails:{termsAcceptedTime, quoteType:'Parcel', quoteId, unitDetails:[{noOfSingleSkuBoxes, noOfMixedSkuBoxes}]}}}`. No retry. Our UI confirms the dollar amount, and the server requires the client to send back the exact quoted charge before it books.
   - Cancel booking: `DELETE …-booking?shipmentId=&mode=Parcel` (within 24 h for parcel, 1 h for LTL).
   - Carrier labels: `POST /fulfillment/generate-label {payload:{shipmentId, labelType:'Carrier', shipDate}}`, then `GET /fulfillment/download-label?shipmentId=&labelType=Carrier&labelSize=X4_6`. A **202** means not ready yet; poll again.
   - We built parcel only, not LTL/FTL.

**Tracking receipt afterwards:** `GET /fulfillment/inbound-shipments` only returns shipments in `AWAITING_DELIVERY` or `CLOSED`. Every in-between status (receiving, partially received…) comes back empty, so a shipment that's mid-receiving disappears from the API until it closes. Also, the inventory feed (`GET /fulfillment/inventory`) can show units on hand while the shipment record still says 0 received. Don't count them twice.

---

## 8. Seller-fulfilled batches

Lookup → `MP_ITEM_MATCH` offer (or restock) → **Publish** sets each SKU's Walmart quantity with `PUT /inventory?sku=…` to the stock you actually have. It *sets* the quantity, it doesn't add, so compute total stock across all lots and don't use only this batch's quantity. A per-item switch can turn "push quantity" off.

Price edits after setup: `PUT /price`. Refuse while a setup is pending.

---

## 9. Profit numbers on the batch page

Per unit: **referral fee** = the SKU's last settled commission rate from Walmart's reconciliation report, else 15%. **WFS fee** = the SKU's last settled WFS fee per unit, else Walmart's WFS rate card by the setup's `eachWeight`, else your 90-day average. Seller-fulfilled gets the referral fee only.

Show Units / Expected revenue / Cost + fees / Expected profit / ROI, and leave unpriced items out of the totals.

Actual fees only arrive with the biweekly reconciliation report (`/report/reconreport/reconFile`, a zipped CSV, dates in MMDDYYYY, so sort them properly). Until a sale settles, show estimates and label them as estimates.

---

## 10. Hard-won rules (read this list twice)

1. Pad barcodes to 14 digits, and keep a search hit only if its `standardUpc` matches exactly. Retry, because the search returns garbage about a quarter of the time.
2. Use Walmart's *current* recommended spec version. The docs examples are out of date and cause odd failures.
3. Validate feeds locally with ajv (`multipleOfPrecision: 8`) before submitting.
4. Battery and hazmat: decide from evidence, check on the server, never default to "no battery", never ask the LLM.
5. Carrier headers (`WM_GLOBAL_VERSION`, `WM_MARKET`) only on the carrier endpoints.
6. Never auto-retry an inbound-order create or a booking.
7. Don't resubmit an item that's under compliance review.
8. One SKU per product: restocks reuse it, and check for SKUs you've submitted that aren't in the catalog yet.
9. A seller-fulfilled inventory PUT sets the quantity; it doesn't add to it.
10. walmart.com scraping will get blocked. Keep it optional.
11. Keep each submitted feed body, so Retry resends exactly what failed.
12. Poll pending setups in the background, not only while the page is open.

---

## 11. Suggested build order

1. Auth and HTTP helper (token cache, headers, retry rules, PDF + 202 handling).
2. Product lookup with the barcode-confirmation rule, plus tests for the corrupted-result case.
3. Restock-only WFS batches: add items, record costs, create the inbound order, boxes, receiving labels, own-carrier tracking. This is enough to ship real stock.
4. Preferred Carrier quote / book / labels.
5. SKU setup: `MP_ITEM_MATCH` first (small, fixed), then the spec engine for `OMNI_WFS` and `MP_WFS_ITEM`.
6. Battery evidence, remembered answers, the LLM fill.
7. Fee estimates and profit view; the holding list; seller-fulfilled Publish.

Write unit tests against **saved real responses** (spec JSON, feed results, quote responses) for each step. The live responses differ from the docs often enough that tests built from the docs alone will pass while the real calls fail.
