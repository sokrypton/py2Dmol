# MSA Viewer - Quick Dimension Reference

## Key Constants
```
SEQUENCE_ROW_HEIGHT = 20px
CHAR_WIDTH = 20px
NAME_COLUMN_WIDTH = 200px
TICK_ROW_HEIGHT = 15px
SCROLLBAR_WIDTH = 15px
NUM_AMINO_ACIDS = 20
```

## Canvas Height Formula by Mode

### MSA Mode
```
canvasHeight = containerHeight - headerHeight
```
- **Variable height** - adapts to container
- Minimum: ~36px (tick + query row)

### PSSM Mode
```
canvasHeight = TICK_ROW_HEIGHT + queryRowHeight + logoHeight + SCROLLBAR_WIDTH
canvasHeight = 15 + 20 + (20 × 20) + 15
canvasHeight = 450px (FIXED)
```

### Logo Mode
```
canvasHeight = TICK_ROW_HEIGHT + queryRowHeight + logoHeight + SCROLLBAR_WIDTH
canvasHeight = 15 + 20 + (20 × 20) + 15
canvasHeight = 450px (FIXED)
```

## Container Minimum Height Formula

```
minContainerHeight = headerHeight + canvasHeight + padding + border
```

Where:
- `headerHeight` = `#msaHeader.offsetHeight + 8px` (margin-bottom)
- `canvasHeight` = mode-dependent (see above)
- `padding` = `24px` (12px top + 12px bottom)
- `border` = `2px` (1px top + 1px bottom)

## Quick Reference Table

| Component | MSA | PSSM | Logo |
|-----------|-----|------|------|
| **Canvas Height** | Variable | 450px | 450px |
| **Tick Row** | 15px | 15px | 15px |
| **Query Row** | 20px | 20px | 20px |
| **Content Area** | Variable | 400px | 400px |
| **Scrollbar (H)** | 15px | 15px | 15px |
| **Scrollbar (V)** | 15px | None | None |
| **Name Column** | 200px | N/A | N/A |
| **Label Column** | N/A | 20px | 0px |
| **Min Container** | ~110px | **524px** | **524px** |

## Current CSS Issue

```css
/* msa.html line 37 */
min-height: 400px;  /* ❌ TOO SMALL for PSSM/Logo! */
```

**Required**: Dynamic `min-height` based on mode:
- MSA: ~110px (flexible)
- PSSM: **524px** (required)
- Logo: **524px** (required)

## Implementation

Add to `viewer-msa.js`:
```javascript
function updateMinimumHeight(mode) {
    const container = document.getElementById('msa-viewer-container');
    if (!container) return;
    
    const header = document.getElementById('msaHeader');
    const headerHeight = header ? header.offsetHeight + 8 : 48;
    
    let minHeight;
    if (mode === 'pssm' || mode === 'logo') {
        minHeight = headerHeight + 450 + 24 + 2; // 524px minimum
    } else {
        minHeight = headerHeight + 50 + 24 + 2; // ~124px minimum
    }
    
    container.style.minHeight = minHeight + 'px';
}
```

Call in:
- `setMSAMode()` - after mode change
- `setMSAData()` - after data load

