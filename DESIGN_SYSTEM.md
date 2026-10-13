# DESIGN_SYSTEM.md — FlipLedger UI: "Paper"

This is the design bible. Read it before writing any CSS or JSX. Every color, radius, shadow and type decision below is already implemented as tokens and component classes in `src/app/globals.css` and as React primitives in `src/components/ui/Paper.tsx`. Use those; don't eyeball values.

FlipLedger shares its look with Parker's Order Tracker (the reference implementation lives in `~/order tracker/templates/base.html`). Parker chose this direction, **Paper**, on Sept 23, 2026, over a soft rounded "Slate" option, a "Navy" option, and a first draft on a kraft-brown page. It replaced the old "premium dark / indigo / Linear-style glow" direction, which is retired. Don't reintroduce anything from it.

---

## 1. The look

A **printed shipping label**. White label stock on a neutral gray table, black print, black label-bar headers, crisp outlines. It's flat and high-contrast.

1. **Ink is the brand color.** Primary buttons, active tabs, selected rows in menus, chart bars and progress fills are near-black (`#111213`), flipping to near-white in dark mode. There is no indigo and no second brand hue.
2. **Cobalt blue is for links, focus rings and "in transit / in progress".** Nothing else (not buttons, not decoration).
3. **Semantic color only means something.** Green = delivered / profit / eligible / done. Red = cancelled / loss / error. Highlighter yellow = "needs your attention". Yellow is the one loud color and appears **only** where Parker has to act (missing COGS, a claim to file, an approval to request, a required setting that's empty).
4. **Panels are labels.** White, a 1.5px ink outline, a 4px radius and a hard 2px offset shadow (`0 2px 0`), never a blur. A card with a title gets a solid black **label bar** header with condensed uppercase white text.
5. **No gradients, glows, blurs, soft drop shadows or pastel fills.** Everything is flat print. (The skeleton shimmer is the only gradient, and it's a loading state.)
6. **Three type voices, one variable family** (Archivo, `wdth` 62–125):
   - **Archivo** for all UI text.
   - **Condensed caps** (Archivo `wdth` 75, weight 700, uppercase, letter-spacing .06em, ~11px) for every label: table headers, label bars, field labels, tags, eyebrows. It's the print on a carton.
   - **Expanded heavy** (Archivo `wdth` 112–125, weight 800–850) for big numbers and page titles. Hero money shows the cents at half size, raised: `$16,789` + small `.63`.
   - **JetBrains Mono** only for identifiers: order #, ASIN, SKU, MSKU, FNSKU, tracking numbers, reimbursement/shipment/plan IDs, bin locations, file paths, reason codes. Money, quantities, percentages and dates stay in Archivo with `font-variant-numeric: tabular-nums` (the `.tabular-nums` class does exactly that and nothing else).
7. **Small radii everywhere:** 2px tags, 3px inputs/buttons, 4px panels. `rounded-full` is for dots and round icon buttons only.
8. **Density stays.** Compact 13px tables, 10–12px cell padding. Paper is not an excuse for fat padding.

---

## 2. Light and dark

Both modes are first-class. The mode follows the OS; the **◐** button (sidebar footer on desktop, top bar on mobile) pins a choice in `localStorage` under `fl-theme`. A script in `src/app/layout.tsx` sets `data-mode` on `<html>` **before first paint**, so there is no flash.

Dark mode is a near-black neutral, not an inversion: label bars go charcoal (`#2A2C30`), the sidebar goes black, the panel shadow disappears, ink becomes near-white, and the yellow highlight becomes a tint with yellow text.

---

## 3. Tokens

All tokens are CSS variables on `:root` (light) and `:root[data-mode="dark"]`, exposed to Tailwind through `@theme inline` in `globals.css`. Component code only uses the Tailwind names.

| Role | Tailwind name | Light | Dark |
|---|---|---|---|
| Page (the table) | `bg-bg-root` | `#ECEDEE` | `#0B0C0D` |
| Panel / label stock | `bg-bg-surface` | `#FFFFFF` | `#17181A` |
| Popover / modal | `bg-bg-elevated` | `#FFFFFF` | `#1F2023` |
| Hover / active | `bg-bg-hover`, `bg-bg-active` | `#F4F5F6`, `#E6E7E9` | `#1F2023`, `#28292D` |
| Input | `bg-bg-input` | `#FFFFFF` | `#17181A` |
| Rules in a panel | `border-border-subtle` | `#E6E7E9` | `#28292D` |
| Input borders | `border-border-default` | `#CDD0D5` | `#3A3C41` |
| Panel outline, table-header rule | `border-border-strong` | `#111213` | `#3A3C41` |
| Text | `text-text-primary / -secondary / -tertiary` | `#111213 / #43464B / #6E737A` | `#EDEEEF / #C4C7CC / #8C9199` |
| Text on ink | `text-text-inverse` | `#FFFFFF` | `#111213` |
| **Ink** (brand, primary actions, active) | `bg-accent`, `hover:bg-accent-hover`, `bg-accent-muted` | `#111213` | `#EDEEEF` |
| **Cobalt** (links, focus, in transit) | `text-link`, `bg-link-muted` | `#2446D8` | `#8FA7FF` |
| Profit / eligible / done | `text-positive`, `bg-positive-muted` | `#1E7A46` | `#5DC98C` |
| Loss / error | `text-negative`, `bg-negative-muted` | `#BF3A2B` | `#F07C6C` |
| Warning text (text-safe amber) | `text-warning`, `bg-warning-muted` | `#9A6B00` | `#F2CE6B` |
| Needs attention (fill) | `bg-highlight`, `text-highlight-fg` | `#F4C21B` / `#17140F` | tint / `#F2CE6B` |
| Label bar | `bg-bar-bg`, `text-bar-fg` | `#111213` / white | `#2A2C30` / `#EDEEEF` |
| Sidebar / top bar | `bg-top-bg`, `text-top-fg` | `#111213` / white | `#000000` / `#EDEEEF` |
| Chart series | `chart-1` … `chart-7` | ink, cobalt, gray, green, amber, violet, red | lightened equivalents |
| Marketplaces | `amazon`, `walmart`, `ebay`, `paypal` | `#FF9900`, `#0071DC`, `#E53238`, `#009CDE` | same |

Shadows: `shadow-sm` = the hard panel shadow (`0 2px 0`, none in dark). `shadow-md/lg/xl/2xl` = the popover shadow (`0 12px 30px`), for dropdowns and modals only. `shadow-glow` is `none`.

Radii: `rounded-sm` 2px, `rounded-md` 3px, `rounded-lg`/`xl`/`2xl` 4px.

Fonts: `font-sans` = Archivo (`--font-archivo`), `font-mono` = JetBrains Mono (`--font-jbmono`), both loaded with `next/font/google` in `layout.tsx`. Archivo is variable, so it's loaded without a `weight` option.

**Never** use Tailwind's raw palette (`green-500`, `amber-400`, `slate-800`, `blue-600`…) or hex values in TSX. If a meaning isn't covered by the table, it probably shouldn't be colored.

---

## 4. Components

Class recipes live in `globals.css` under `@layer components`; the React wrappers are in `src/components/ui/Paper.tsx`.

### Panel and label bar
```tsx
<section className="panel">                         {/* white, 1.5px ink outline, 4px radius, hard shadow */}
  <div className="panel-bar">                       {/* black bar, condensed caps */}
    <span>Revenue &amp; profit</span>
    <span className="panel-bar-caption">per day</span>   {/* right side at 70% */}
  </div>
  <div className="p-4">…</div>
</section>
```
Or `<Panel title="Revenue & profit" caption="per day">…</Panel>`.
- Any card with a title gets a label bar. Small stat tiles use an eyebrow (`label-caps text-text-tertiary`) instead.
- The bar is a dark surface in both modes, so it re-scopes the text and semantic tokens inside it: `text-text-primary`, `text-positive`, `text-link` etc. stay readable there. Controls in a bar are outlined (`border-[1.5px] border-bar-fg/40`), never white stickers.
- Modals are panels with `shadow-xl`, a `bg-black/60` scrim (no blur), and either a label bar (simple title) or a header row separated by a strong 1.5px rule (title + subtitle).

### Type
- `page-title`: every page `<h1>` (26px, 800, `wdth` 112). `PageHeader` renders it.
- `label-caps`: every label, eyebrow, field label.
- `section-title`: a caps heading between panels.
- `hero-num` / `stat-num`: big numbers (expanded heavy, tabular). Wrap money in `<Money cents={…} />` to get the half-size raised cents.

### Buttons
- **Solid (primary)**: `bg-accent text-text-inverse font-bold hover:bg-accent-hover rounded-md` (or `.btn`). One per area. **Always `text-text-inverse` on `bg-accent`**, never `text-white`: ink turns near-white in dark mode.
- **Ghost (secondary)**: `bg-bg-surface border-[1.5px] border-border-strong text-text-primary font-semibold hover:bg-bg-hover` (or `.btn .btn-ghost`).
- **Quiet**: text only, `hover:bg-bg-hover` (or `.btn-quiet`).
- Never a colored (green/blue/amber) button.

### Inputs
White (`bg-bg-input`), `border border-border-default` (rendered 1.5px), 3px radius, 34px tall. Focus is cobalt: border `--link` plus a 3px `--link-muted` ring. `globals.css` applies the 1.5px width and the focus treatment to every `input/select/textarea` that has a `border` class, so pages don't repeat it.

### Segmented toggle
Date basis, marketplace filters, location/status/channel tabs, month windows: `<Seg options value onChange />` or `.seg` with `aria-current="true"` on the active child. Outlined label with the hard shadow; the active option prints in solid ink.

### Tags (badges, statuses)
`<span className="tag …">` = an outlined condensed-caps stamp, 2px radius, border in `currentColor`. The color class sets the variant:
- neutral (default), `tag-green` / `text-positive`, `tag-red` / `text-negative`, `tag-blue` / `text-link` (in transit, processing, registering), `text-warning` (caution),
- `tag-attn`: solid yellow, **only** for things that need action (MISSING COGS, NEEDS APPROVAL, CATALOG ISSUE, CLAIM DUE, No COGS).
- Marketplace: `mkt mkt-amazon | mkt-walmart | mkt-ebay | mkt-paypal`: a neutral stamp with a small brand-colored square. Marketplace colors never fill anything larger than that square.

### Status rail (signature)
Three sequential stages next to a bold status word; use it only where the stages really are sequential. Listing batches use it: Draft → sent to Amazon (sending/ready/boxing/placement/shipping, cobalt) → Shipped/Closed (green); failed batches are struck through in red.
```tsx
<Rail step={1} label="Boxing" />      {/* step 0/1/2, failed */}
```
Detail pages can use the large version (`.journey` with three `.step` columns: 6px top bar, caps label, date).

### Banners
- `attn-banner`: the yellow "you need to do something" banner (missing COGS, required ship-from fields, unassigned box items, claims to file, runway when burning cash). Text inside reads in the highlight ink automatically.
- `flash`: a sticker for information and results (a 6px ink left edge). `flash-bad` for errors (red edge); add `border-l-positive` for success, `border-l-link` for in-progress.

### Tables
- Header row on the panel stock; `th` is condensed caps (10.5px, tertiary) over a **1.5px ink rule**. Both come from the base styles in `globals.css`, so a plain `<th>` is already right.
- Rows: 1px `border-border-subtle` dividers, `hover:bg-bg-hover`. No zebra stripes.
- Totals row: a 1.5px `border-border-strong` top rule, bold, tabular.
- Money and quantities right-aligned and `tabular-nums`; identifiers in `font-mono`.
- `DataTable` (TanStack) already implements all of this plus the search box and the pager.

### Charts (Recharts)
- Pass colors as CSS variables so they follow the mode: `fill="var(--color-chart-1)"`, grid `stroke="var(--color-border-subtle)"`.
- **Monochrome first**: one series = ink. Two = ink + cobalt. Use `--color-positive` / `--color-negative` for profit/loss (per-bar `Cell` when a value can go negative). `chart-3…7` only for real categorical splits.
- Bars: square tops (`radius={[1, 1, 0, 0]}`), no gradients, a solid 1.5px baseline in `--color-border-strong`, horizontal gridlines only.
- Tooltips are panels: `content={<ChartTooltip format={…} />}` from `src/components/charts/ChartTooltip.tsx`.
- Prefer a **ranked meter list** (name + amount + % over a 4px `.meter` bar) to a pie or donut. The Dashboard's expense breakdown is the example.

### Sidebar and mobile bar
The sidebar is the app's header, on `bg-top-bg` / `text-top-fg` in both modes: the brand in expanded 900-weight caps next to a small carton mark, section titles in caps at 45%, nav links at 62% opacity going to 100% when active with a gray pill behind the active one. Under 1024px a 52px black top bar shows the menu button, the brand and ◐.

### Loading
Skeletons use `.skeleton` inside panels, matching the loaded layout.

---

## 5. Guardrails

- Don't add warm, cream, kraft or brown backgrounds (rejected).
- Don't soften Paper into rounded (8–16px) cards, blurred shadows or pastel fills (that was "Slate").
- Don't bring back indigo, glows, gradients or a second brand hue. Ink is the brand.
- Keep yellow rare: it means "act here" and nothing else.
- Cobalt is not a button color.
- Keep FlipLedger's density.
- Printed labels are not UI: `/api/labels/print`, the FNSKU/box/shipping label PDFs and bwip-js barcodes keep their own output format.

## 6. Checklist for a new or changed page

1. `PageHeader` (or a `page-title` h1) and `StatCard`s for the headline numbers.
2. Every titled card is a `panel` with a `panel-bar`.
3. Tables use `DataTable` or plain `<th>`s (base styles do the rest), identifiers in mono, numbers tabular.
4. Status = `tag` (or `Rail` for a real sequence); only needs-action states are `tag-attn` / `attn-banner`.
5. No raw palette classes, no hex, no `text-white` on ink, no `shadow-lg` on cards, no blur.
6. Look at it in light **and** dark, at desktop width and at 375px.
