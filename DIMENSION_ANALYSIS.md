# MSA Viewer Dimension Analysis & Minimum Height Plan

## Constants (from viewer-msa.js)

```javascript
SEQUENCE_ROW_HEIGHT = 20px
CHAR_WIDTH = 20px
NAME_COLUMN_WIDTH = 200px
TICK_ROW_HEIGHT = 15px
SCROLLBAR_WIDTH = 15px
SCROLLBAR_PADDING = 2px
NUM_AMINO_ACIDS = 20 (from Dayhoff groups)
DPI_MULTIPLIER = 200/96 ≈ 2.083
```

## CSS Dimensions (from msa.html)

```css
.container-box {
    padding: 12px;  /* All sides */
}

.sequence-header {
    margin-bottom: 8px;
    padding-bottom: 8px;
    /* Actual height depends on content, estimated ~40-50px */
}

.sequence-section-container {
    padding: 12px;  /* Inherited from container-box */
    border: 1px solid;  /* ~1px */
}
```

---

## Mode 1: MSA Mode

### Canvas Structure
```
┌─────────────────────────────────────────────┐
│ TICK_ROW_HEIGHT (15px)                      │
├─────────────────────────────────────────────┤
│ QUERY_ROW (20px)                            │
├─────────────────────────────────────────────┤
│                                             │
│ SCROLLABLE AREA (variable height)          │
│ - Sequence rows: 20px each                 │
│ - Virtual scrolling enabled                 │
│                                             │
├─────────────────────────────────────────────┤
│ HORIZONTAL_SCROLLBAR (15px)                 │
└─────────────────────────────────────────────┘
│ NAME_COLUMN (200px) │ SCROLLABLE │ V_SCROLL │
```

### Canvas Dimensions
- **Canvas Width**: `containerWidth` (dynamic, fills container)
- **Canvas Height**: `containerHeight - headerHeight` (dynamic)
- **Tick Row**: `15px`
- **Query Row**: `20px`
- **Scrollable Area Y Start**: `15 + 20 = 35px`
- **Scrollable Area Height**: `canvasHeight - 35 - 15 = canvasHeight - 50px`
- **Name Column Width**: `200px`
- **Scrollable Area X Start**: `200px`
- **Scrollable Area Width**: `canvasWidth - 200 - 15 = canvasWidth - 215px`
- **Vertical Scrollbar**: `15px` (right side)
- **Horizontal Scrollbar**: `15px` (bottom)

### Container Dimensions
- **Container Padding**: `12px` (all sides)
- **Container Border**: `1px` (all sides)
- **Header Height**: `~40-50px` (estimated, calculated dynamically)
- **Header Margin Bottom**: `8px`
- **Total Container Height**: `headerHeight + canvasHeight + padding`
- **Total Container Width**: `canvasWidth + padding`

### Minimum Container Height (MSA Mode)
- **Header**: `~48px` (40px + 8px margin)
- **Minimum Canvas**: `35px` (tick + query) + `1px` (at least 1 sequence visible) = `36px`
- **Padding**: `24px` (12px top + 12px bottom)
- **Border**: `2px` (1px top + 1px bottom)
- **Total Minimum**: `48 + 36 + 24 + 2 = 110px`

**Note**: MSA mode is flexible - it can shrink to show just the query row.

---

## Mode 2: PSSM Mode

### Canvas Structure
```
┌─────────────────────────────────────────────┐
│ TICK_ROW_HEIGHT (15px)                      │
├─────────────────────────────────────────────┤
│ QUERY_ROW (20px)                            │
├─────────────────────────────────────────────┤
│ LABEL_COLUMN │ HEATMAP (20 amino acids)    │
│ (20px)       │ (20 × 20 = 400px)           │
│              │                              │
│              │                              │
│              │                              │
├─────────────────────────────────────────────┤
│ HORIZONTAL_SCROLLBAR (15px)                 │
└─────────────────────────────────────────────┘
```

### Canvas Dimensions
- **Canvas Width**: `containerWidth` (dynamic)
- **Canvas Height**: **FIXED** = `15 + 20 + 400 + 15 = 450px`
- **Tick Row**: `15px`
- **Query Row**: `20px`
- **Logo/Heatmap Y Start**: `15 + 20 = 35px`
- **Logo/Heatmap Height**: `20 × 20 = 400px`
- **Label Column Width**: `20px` (PSSM only)
- **Scrollable Area X Start**: `20px`
- **Scrollable Area Width**: `canvasWidth - 20 - 15 = canvasWidth - 35px`
- **Horizontal Scrollbar**: `15px` (bottom)
- **No Vertical Scrollbar** (fixed height content)

### Container Dimensions
- **Container Padding**: `12px` (all sides)
- **Container Border**: `1px` (all sides)
- **Header Height**: `~40-50px` (estimated)
- **Header Margin Bottom**: `8px`
- **Canvas Height**: **450px** (FIXED)
- **Total Container Height**: `headerHeight + 450 + padding`
- **Total Container Width**: `canvasWidth + padding`

### Minimum Container Height (PSSM Mode)
- **Header**: `~48px` (40px + 8px margin)
- **Canvas**: `450px` (FIXED - cannot be smaller)
- **Padding**: `24px` (12px top + 12px bottom)
- **Border**: `2px` (1px top + 1px bottom)
- **Total Minimum**: `48 + 450 + 24 + 2 = 524px`

**Critical**: Canvas height is **FIXED at 450px** - container must accommodate this!

---

## Mode 3: Logo Mode

### Canvas Structure
```
┌─────────────────────────────────────────────┐
│ TICK_ROW_HEIGHT (15px)                      │
├─────────────────────────────────────────────┤
│ QUERY_ROW (20px)                            │
├─────────────────────────────────────────────┤
│ STACKED LOGO (20 amino acids)               │
│ (20 × 20 = 400px)                           │
│                                             │
│                                             │
├─────────────────────────────────────────────┤
│ HORIZONTAL_SCROLLBAR (15px)                 │
└─────────────────────────────────────────────┘
```

### Canvas Dimensions
- **Canvas Width**: `containerWidth` (dynamic)
- **Canvas Height**: **FIXED** = `15 + 20 + 400 + 15 = 450px`
- **Tick Row**: `15px`
- **Query Row**: `20px`
- **Logo Y Start**: `15 + 20 = 35px`
- **Logo Height**: `20 × 20 = 400px`
- **Label Column Width**: `0px` (Logo mode has no label column)
- **Scrollable Area X Start**: `0px`
- **Scrollable Area Width**: `canvasWidth - 15 = canvasWidth - 15px`
- **Horizontal Scrollbar**: `15px` (bottom)
- **No Vertical Scrollbar** (fixed height content)

### Container Dimensions
- **Container Padding**: `12px` (all sides)
- **Container Border**: `1px` (all sides)
- **Header Height**: `~40-50px` (estimated)
- **Header Margin Bottom**: `8px`
- **Canvas Height**: **450px** (FIXED)
- **Total Container Height**: `headerHeight + 450 + padding`
- **Total Container Width**: `canvasWidth + padding`

### Minimum Container Height (Logo Mode)
- **Header**: `~48px` (40px + 8px margin)
- **Canvas**: `450px` (FIXED - cannot be smaller)
- **Padding**: `24px` (12px top + 12px bottom)
- **Border**: `2px` (1px top + 1px bottom)
- **Total Minimum**: `48 + 450 + 24 + 2 = 524px`

**Critical**: Canvas height is **FIXED at 450px** - container must accommodate this!

---

## Summary Table

| Mode | Canvas Height | Header | Padding | Border | **Min Container Height** |
|------|---------------|--------|---------|--------|-------------------------|
| MSA  | Variable      | ~48px  | 24px    | 2px    | **~110px** (flexible)   |
| PSSM | **450px** (FIXED) | ~48px | 24px | 2px | **524px** (required) |
| Logo | **450px** (FIXED) | ~48px | 24px | 2px | **524px** (required) |

---

## Current CSS Issues

From `msa.html` line 37:
```css
min-height: 400px;  /* TOO SMALL for PSSM/Logo modes! */
```

**Problem**: PSSM and Logo modes require **524px minimum**, but CSS allows 400px.

---

## Implementation Plan: Dynamic Minimum Height

### Goal
Set `min-height` dynamically based on current mode to prevent resizing below the required canvas height.

### Approach 1: JavaScript-based Dynamic min-height (Recommended)

#### Step 1: Calculate Minimum Heights
```javascript
const MIN_HEIGHTS = {
    msa: 110,   // Flexible, can be smaller
    pssm: 524,  // Fixed canvas 450px + header + padding + border
    logo: 524   // Fixed canvas 450px + header + padding + border
};
```

#### Step 2: Update CSS on Mode Change
When `setMSAMode()` is called:
1. Get current mode
2. Calculate actual header height (measure `#msaHeader.offsetHeight`)
3. Calculate minimum: `headerHeight + canvasHeight + padding + border`
4. Update container `min-height` style

#### Step 3: Implementation Points

**In `viewer-msa.js` - `setMSAMode()` function:**
```javascript
setMSAMode: function(mode) {
    // ... existing code ...
    
    // Update minimum height constraint
    updateMinimumHeight(mode);
}

function updateMinimumHeight(mode) {
    const container = document.getElementById('msa-viewer-container');
    if (!container) return;
    
    const header = document.getElementById('msaHeader');
    const headerHeight = header ? header.offsetHeight + 8 : 48; // + margin-bottom
    
    let minHeight;
    if (mode === 'pssm' || mode === 'logo') {
        const CANVAS_HEIGHT = 450; // TICK_ROW_HEIGHT + queryRowHeight + logoHeight + SCROLLBAR_WIDTH
        const PADDING = 24; // 12px top + 12px bottom
        const BORDER = 2;   // 1px top + 1px bottom
        minHeight = headerHeight + CANVAS_HEIGHT + PADDING + BORDER;
    } else {
        // MSA mode: flexible, use reasonable minimum
        minHeight = headerHeight + 50 + 24 + 2; // ~124px minimum
    }
    
    container.style.minHeight = minHeight + 'px';
}
```

**In `msa.html` - Remove static min-height:**
```css
.sequence-section-container {
    /* Remove: min-height: 400px; */
    /* Will be set dynamically by JavaScript */
}
```

#### Step 4: Handle Resize Events
When container is resized, check if new height violates minimum:
- If resizing below minimum, clamp to minimum
- Use ResizeObserver to detect size changes

#### Step 5: Initial Setup
Call `updateMinimumHeight()` when:
- MSA data is first loaded
- Mode changes
- Window resizes (if needed)

### Approach 2: CSS-only with CSS Variables (Alternative)

Use CSS custom properties updated by JavaScript:

```css
.sequence-section-container {
    min-height: var(--msa-min-height, 400px);
}
```

```javascript
function updateMinimumHeight(mode) {
    const container = document.getElementById('msa-viewer-container');
    const header = document.getElementById('msaHeader');
    const headerHeight = header ? header.offsetHeight + 8 : 48;
    
    let minHeight;
    if (mode === 'pssm' || mode === 'logo') {
        minHeight = headerHeight + 450 + 24 + 2; // 524px
    } else {
        minHeight = headerHeight + 50 + 24 + 2; // ~124px
    }
    
    container.style.setProperty('--msa-min-height', minHeight + 'px');
}
```

---

## Implementation Checklist

- [ ] Add `updateMinimumHeight(mode)` function to `viewer-msa.js`
- [ ] Call `updateMinimumHeight()` in `setMSAMode()` after mode change
- [ ] Call `updateMinimumHeight()` in `setMSAData()` after data is loaded
- [ ] Remove static `min-height: 400px` from CSS in `msa.html`
- [ ] Add resize validation to prevent going below minimum
- [ ] Test all three modes with resize functionality
- [ ] Verify header height calculation is accurate
- [ ] Handle edge case: header height changes (e.g., font size changes)

---

## Edge Cases to Consider

1. **Header Height Variation**: Header height may vary based on:
   - Font size
   - Browser zoom
   - Content (bit-score checkbox visibility)
   - Solution: Measure dynamically each time

2. **Mode Switch During Resize**: If user is resizing and mode changes
   - Solution: Immediately update min-height and clamp current height

3. **Initial Load**: Before MSA data is loaded, no mode is set
   - Solution: Use default minimum (MSA mode minimum)

4. **Window Resize**: Container might be resized externally
   - Solution: ResizeObserver already handles this, but validate min-height

---

## Testing Plan

1. **MSA Mode**:
   - Resize to minimum (~110px) - should work
   - Resize below minimum - should clamp

2. **PSSM Mode**:
   - Resize to minimum (524px) - should work
   - Resize below 524px - should clamp
   - Verify canvas is fully visible

3. **Logo Mode**:
   - Resize to minimum (524px) - should work
   - Resize below 524px - should clamp
   - Verify canvas is fully visible

4. **Mode Switching**:
   - Switch from MSA to PSSM while at 200px height - should expand to 524px
   - Switch from PSSM to MSA while at 524px - should allow shrinking

5. **Header Height Changes**:
   - Test with different font sizes
   - Test with/without bit-score checkbox

