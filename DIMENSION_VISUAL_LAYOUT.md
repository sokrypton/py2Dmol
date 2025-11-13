# MSA Viewer - Visual Layout Diagrams

## MSA Mode Layout

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ #msa-viewer-container (container-box)                                     │
│ padding: 12px all sides                                                    │
│ border: 1px                                                                │
├─────────────────────────────────────────────────────────────────────────────┤
│ #msaHeader (sequence-header)                                               │
│ height: ~40-50px (dynamic)                                                 │
│ margin-bottom: 8px                                                          │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ [Mode Select] [Bit-score]          [Filters: cov: [slider] qid: ...] │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────────────────┤
│ #msaView (sequence-content)                                                │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ Canvas (fills available height)                                         │ │
│ │ ┌──────────┬──────────────────────────────────────────────┬──────────┐ │ │
│ │ │          │ TICK_ROW_HEIGHT (15px)                      │          │ │ │
│ │ │          ├──────────────────────────────────────────────┤          │ │ │
│ │ │ NAME     │ QUERY_ROW (20px)                            │          │ │ │
│ │ │ COLUMN   ├──────────────────────────────────────────────┤ V_SCROLL │ │ │
│ │ │ (200px)  │                                              │ (15px)   │ │ │
│ │ │          │ SCROLLABLE AREA (variable height)            │          │ │ │
│ │ │          │ - Sequence rows: 20px each                   │          │ │ │
│ │ │          │ - Virtual scrolling                         │          │ │ │
│ │ │          │                                              │          │ │ │
│ │ │          ├──────────────────────────────────────────────┤          │ │ │
│ │ │          │ HORIZONTAL_SCROLLBAR (15px)                 │          │ │ │
│ │ └──────────┴──────────────────────────────────────────────┴──────────┘ │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘

Total Container Height = headerHeight + canvasHeight + 24px (padding) + 2px (border)
Minimum Container Height = ~48px (header) + ~36px (min canvas) + 24px + 2px = ~110px
```

## PSSM Mode Layout

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ #msa-viewer-container (container-box)                                     │
│ padding: 12px all sides                                                    │
│ border: 1px                                                                │
├─────────────────────────────────────────────────────────────────────────────┤
│ #msaHeader (sequence-header)                                               │
│ height: ~40-50px (dynamic)                                                 │
│ margin-bottom: 8px                                                          │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ [Mode Select] [Bit-score]          [Filters: cov: [slider] qid: ...] │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────────────────┤
│ #msaView (sequence-content)                                                │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ Canvas (FIXED HEIGHT: 450px)                                            │ │
│ │ ┌──────────┬──────────────────────────────────────────────┐             │ │
│ │ │          │ TICK_ROW_HEIGHT (15px)                      │             │ │
│ │ │          ├──────────────────────────────────────────────┤             │ │
│ │ │ LABEL    │ QUERY_ROW (20px)                            │             │ │
│ │ │ COLUMN   ├──────────────────────────────────────────────┤             │ │
│ │ │ (20px)   │                                              │             │ │
│ │ │          │ HEATMAP (400px = 20 amino acids × 20px)     │             │ │
│ │ │ A        │                                              │             │ │
│ │ │ R        │                                              │             │ │
│ │ │ N        │                                              │             │ │
│ │ │ D        │                                              │             │ │
│ │ │ ...      │                                              │             │ │
│ │ │ (20 AAs) │                                              │             │ │
│ │ │          ├──────────────────────────────────────────────┤             │ │
│ │ │          │ HORIZONTAL_SCROLLBAR (15px)                 │             │ │
│ │ └──────────┴──────────────────────────────────────────────┘             │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘

Canvas Height = 15 + 20 + 400 + 15 = 450px (FIXED)
Total Container Height = headerHeight + 450 + 24px (padding) + 2px (border)
Minimum Container Height = ~48px (header) + 450px (canvas) + 24px + 2px = 524px
```

## Logo Mode Layout

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ #msa-viewer-container (container-box)                                     │
│ padding: 12px all sides                                                    │
│ border: 1px                                                                │
├─────────────────────────────────────────────────────────────────────────────┤
│ #msaHeader (sequence-header)                                               │
│ height: ~40-50px (dynamic)                                                 │
│ margin-bottom: 8px                                                          │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ [Mode Select] [Bit-score ✓]        [Filters: cov: [slider] qid: ...] │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────────────────┤
│ #msaView (sequence-content)                                                │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ Canvas (FIXED HEIGHT: 450px)                                            │ │
│ │ ┌──────────────────────────────────────────────────────────────┐        │ │
│ │ │ TICK_ROW_HEIGHT (15px)                                      │        │ │
│ │ ├──────────────────────────────────────────────────────────────┤        │ │
│ │ │ QUERY_ROW (20px)                                             │        │ │
│ │ ├──────────────────────────────────────────────────────────────┤        │ │
│ │ │                                                              │        │ │
│ │ │ STACKED LOGO (400px = 20 amino acids × 20px)               │        │ │
│ │ │                                                              │        │ │
│ │ │  [Stacked letters showing frequency/bit-score]              │        │ │
│ │ │                                                              │        │ │
│ │ │                                                              │        │ │
│ │ ├──────────────────────────────────────────────────────────────┤        │ │
│ │ │ HORIZONTAL_SCROLLBAR (15px)                                 │        │ │
│ │ └──────────────────────────────────────────────────────────────┘        │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘

Canvas Height = 15 + 20 + 400 + 15 = 450px (FIXED)
Total Container Height = headerHeight + 450 + 24px (padding) + 2px (border)
Minimum Container Height = ~48px (header) + 450px (canvas) + 24px + 2px = 524px
```

## Dimension Breakdown

### Header Section
```
┌─────────────────────────────────────────────────────────────┐
│ Mode Select (min-width: 100px)                              │
│ Bit-score checkbox (when visible)                           │
│                                                             │
│ Filters box:                                                │
│   - "Filters:" label                                        │
│   - Coverage slider (100px) + label + value                │
│   - Identity slider (100px) + label + value                │
│   - Sequence count display                                 │
└─────────────────────────────────────────────────────────────┘
Estimated height: 40-50px (varies by content)
Margin-bottom: 8px
Total header space: ~48-58px
```

### Canvas Components (All Modes)

| Component | Height | Notes |
|-----------|--------|-------|
| Tick Row | 15px | Position numbers every 10 positions |
| Query Row | 20px | Query sequence display |
| Content Area | Variable/400px | MSA: variable, PSSM/Logo: 400px |
| Horizontal Scrollbar | 15px | Bottom of canvas |
| Vertical Scrollbar | 15px | Right side (MSA only) |

### Container Padding & Border

```
┌─────────────────────────────────────┐
│ Padding: 12px (top)                 │ ← 12px
├─────────────────────────────────────┤
│ Border: 1px                         │ ← 1px
│                                     │
│ Content Area                        │
│                                     │
│ Border: 1px                         │ ← 1px
├─────────────────────────────────────┤
│ Padding: 12px (bottom)              │ ← 12px
└─────────────────────────────────────┘

Total vertical padding: 24px
Total vertical border: 2px
```

## Critical Constraints

### PSSM/Logo Modes
- **Canvas height is FIXED at 450px** - cannot be smaller
- Container must be at least: `headerHeight + 450 + 24 + 2 = ~524px`
- Current CSS `min-height: 400px` is **insufficient**

### MSA Mode
- Canvas height is **flexible** - adapts to container
- Can shrink to show just query row: `15 + 20 = 35px` minimum
- Container minimum: `headerHeight + 35 + 24 + 2 = ~109px`

## Resize Behavior

### Current (Broken)
```
User resizes container to 400px
→ PSSM/Logo mode canvas (450px) exceeds container
→ Canvas gets clipped or overflows
→ ❌ Broken UI
```

### Fixed (Proposed)
```
User tries to resize container below 524px in PSSM/Logo mode
→ JavaScript detects violation
→ Container height clamped to 524px
→ Canvas (450px) fits perfectly
→ ✅ Correct UI
```

