# Selection System Refactoring Plan

## Current Issues

1. **"Clear All" button doesn't work properly**
   - Clears `selectedResiduesSet` and unchecks chain pills
   - But the viewer might show nothing or behave unexpectedly
   - Need to define what "clear all" means: show nothing? show all? reset to default?

2. **Chain selection doesn't work**
   - Chain pill checkboxes have event listeners
   - But the selection logic might not be correctly computing which atoms to show
   - Need to verify the chain filtering logic

3. **PAE starts all yellow**
   - Default "select all" state causes all PAE positions to be highlighted
   - Need to distinguish between "explicit selection" vs "default/empty state"

4. **Selection logic is scattered**
   - Selection state lives in multiple places:
     - `selectedResiduesSet` (global in app.js)
     - `selectionModel` (in renderer)
     - Chain pill checkboxes (DOM state)
   - Logic for combining selections is complex and error-prone
   - No clear single source of truth

## Refactoring Goals

1. **Single Source of Truth**
   - All selection state should live in the renderer's `selectionModel`
   - UI components (sequence view, chain pills) should be derived from this state
   - No duplicate state between app.js and renderer

2. **Clear State Semantics**
   - Define what "empty selection" means (show all? show nothing?)
   - Distinguish between "no selection" (default) and "explicit empty selection"
   - Make the default state explicit and consistent

3. **Unified Selection API**
   - Single method to update selection: `setSelection({ residues, chains, paeBoxes })`
   - Clear rules for how different selection types combine (UNION, INTERSECTION, etc.)
   - Consistent event system for notifying UI of changes

4. **Simplified UI Logic**
   - UI components react to selection changes, don't drive them
   - Chain pills, sequence view, PAE plot all read from `selectionModel`
   - UI updates happen via event listeners, not direct manipulation

## Proposed Architecture

### 1. Selection Model (Renderer)

```javascript
selectionModel = {
  // Residue selection: Set of "chain:residueIndex" strings
  // Empty set = no explicit residue selection (use chain selection or show all)
  residues: Set<string>,
  
  // Chain selection: Set of chain IDs
  // Empty set = all chains allowed
  chains: Set<string>,
  
  // PAE box selections: Array of {i_start, i_end, j_start, j_end}
  paeBoxes: Array<Box>
}

// Selection mode: how to interpret empty selections
selectionMode: 'default' | 'explicit'
// 'default': empty selection means "show all" (initial state)
// 'explicit': empty selection means "show nothing" (user cleared)
```

### 2. Selection API

```javascript
// Set selection (replaces current selection)
renderer.setSelection({
  residues?: Set<string> | null,  // null = clear, undefined = keep current
  chains?: Set<string> | null,
  paeBoxes?: Array<Box> | null,
  mode?: 'default' | 'explicit'
})

// Get current selection
const selection = renderer.getSelection()

// Reset to default (show all)
renderer.resetToDefault()

// Clear all (show nothing if mode is 'explicit')
renderer.clearSelection()
```

### 3. Selection Combination Logic

```javascript
_composeAndApplyMask() {
  // 1. Get atoms from residue/chain selection
  let seqAtoms = this._getSequenceAtoms()
  
  // 2. Get atoms from PAE selection
  let paeAtoms = this._getPAEAtoms()
  
  // 3. Combine via UNION
  let combined = this._union(seqAtoms, paeAtoms)
  
  // 4. Apply based on mode
  if (this.selectionMode === 'default' && combined.size === 0) {
    // Default mode with no selection = show all
    this.visibilityMask = null
  } else {
    this.visibilityMask = combined
  }
  
  // 5. Notify UI
  this._notifySelectionChange()
}
```

### 4. UI Integration

```javascript
// app.js - React to selection changes
document.addEventListener('py2dmol-selection-change', (e) => {
  const { selectionModel, selectionMode } = e.detail
  
  // Update chain pills
  updateChainPills(selectionModel.chains)
  
  // Update sequence view
  updateSequenceView(selectionModel.residues)
  
  // PAE renderer updates automatically via its own listener
})

// UI actions update selection model
function onChainPillClick(chain, checked) {
  const current = viewerApi.renderer.getSelection()
  const newChains = new Set(current.chains)
  if (checked) {
    newChains.add(chain)
  } else {
    newChains.delete(chain)
  }
  viewerApi.renderer.setSelection({ chains: newChains })
}

function onClearAllClick() {
  viewerApi.renderer.setSelection({
    residues: new Set(),
    chains: new Set(),
    paeBoxes: [],
    mode: 'explicit'  // Explicit empty = show nothing
  })
}
```

## Implementation Steps

### Phase 1: Refactor Selection Model
1. Add `selectionMode` to `selectionModel`
2. Update `setSelection()` to handle mode
3. Update `_composeAndApplyMask()` to respect mode
4. Add `getSelection()` method
5. Add `resetToDefault()` and `clearSelection()` methods

### Phase 2: Fix UI Integration
1. Remove `selectedResiduesSet` from app.js
2. Update all UI functions to read from `selectionModel`
3. Update UI functions to call `setSelection()` instead of manipulating state
4. Add event listeners to sync UI with selection changes

### Phase 3: Fix Specific Issues
1. Fix "Clear All" to use `clearSelection()` with explicit mode
2. Fix chain selection to properly update `selectionModel.chains`
3. Fix PAE yellow lines to only show for explicit selections
4. Fix default state to not show yellow lines

### Phase 4: Testing & Cleanup
1. Test all selection scenarios
2. Remove dead code
3. Add comments and documentation
4. Ensure consistent behavior

## Comprehensive Edge Cases & Test Scenarios

### Selection Types & Combinations

#### 1. Residue Selection
- **Single residue**: Select one residue in sequence view
- **Multiple residues**: Select multiple non-contiguous residues
- **Range selection**: Drag to select range of residues
- **Shift+click**: Add/remove residues from selection
- **Clear residue selection**: Click selected residue to deselect
- **Select all residues**: Button selects all residues
- **Clear all residues**: Button clears all residue selections

#### 2. Chain Selection
- **Single chain**: Toggle one chain pill checkbox
- **Multiple chains**: Toggle multiple chain pills
- **All chains selected**: Default state (all checked)
- **No chains selected**: All unchecked (should show nothing if explicit mode)
- **Chain + residue**: Chain selected but some residues in that chain deselected
- **Chain deselected**: Should hide all residues in that chain

#### 3. Select All / Clear All
- **Select All button**:
  - Should select all residues in all visible chains
  - Should check all chain pills
  - Should set mode to 'default' (show all)
  - Should NOT clear PAE selections
  - Should NOT clear chain selections
- **Clear All button**:
  - Should clear all residue selections
  - Should uncheck all chain pills
  - Should clear all PAE boxes
  - Should set mode to 'explicit' (show nothing)
  - Should result in empty viewer (no atoms visible)

#### 4. PAE Selection - Diagonal
- **Single cell on diagonal**: Select (i, i) - single residue
- **Range on diagonal**: Select (i_start, i_start) to (i_end, i_end) - range of residues
- **Visual symmetry**: Should show symmetric visual highlight (dashed lines) but selection is NOT symmetric
- **Internal selection**: Only (i, j) where i and j are in the selected box, NOT (j, i)

#### 5. PAE Selection - Off-Diagonal (Two Ranges)
- **Rectangular box**: Select (i_start, j_start) to (i_end, j_end) where i ≠ j
- **Two separate ranges**: 
  - i_range: residues i_start to i_end
  - j_range: residues j_start to j_end
- **Atom selection**: Should select atoms from BOTH ranges (UNION)
- **Visual**: Should highlight the box region, plus symmetric visual (dashed)

#### 6. Multiple Shift Selections in PAE
- **First selection**: Normal click/drag creates first box
- **Shift+drag**: Adds second box to selection
- **Multiple boxes**: Can have 3+ boxes via multiple Shift+drags
- **Each box independent**: Each box selects its own i and j ranges
- **Combined atoms**: UNION of all atoms from all boxes
- **Visual**: All boxes should be visible, each with its own highlighting

#### 7. PAE Rendering Showing Selection
- **No selection**: Full brightness, no yellow lines
- **PAE box selected**: 
  - Selected cells at full brightness
  - Non-selected cells dimmed
  - Yellow border around selected box
  - Dashed yellow lines for symmetric visual (rendering only)
- **Sequence selection**: Yellow lines for selected rows/columns
- **Both PAE + sequence**: Both visual indicators visible
- **Default "all" state**: Should NOT show yellow lines (only explicit selections)

#### 8. Sequence Rendering Showing Selection
- **Selected residues**: Highlighted in sequence view
- **Unselected residues**: Dimmed or normal
- **Chain selection**: All residues in selected chains highlighted
- **Partial chain**: Some residues selected, some not (within same chain)
- **Live preview**: During drag, preview selection should be visible

#### 9. Chain Button Rendering Showing Selection
- **Checked**: Chain is selected (all residues in chain visible if no residue filter)
- **Unchecked**: Chain is deselected (all residues in chain hidden)
- **Partial**: Some residues in chain selected (checkbox state unclear - need to decide)
- **Sync with selection**: Checkbox state should reflect actual selection state

#### 10. Undo/Clear Interactions (Unified Selection)

Each selection type should be able to clear/undo others:

- **Clear residue selection**:
  - Should clear `residues` set
  - Should NOT clear chain selection
  - Should NOT clear PAE boxes
  - Result: Show atoms from chains + PAE selections

- **Clear chain selection**:
  - Should clear `chains` set (or set to all chains)
  - Should NOT clear residue selection
  - Should NOT clear PAE boxes
  - Result: Show only explicitly selected residues + PAE selections

- **Clear PAE selection**:
  - Should clear `paeBoxes` array
  - Should NOT clear residue selection
  - Should NOT clear chain selection
  - Result: Show atoms from sequence/chain selection only

- **Clear all (button)**:
  - Should clear everything: residues, chains, paeBoxes
  - Should set mode to 'explicit'
  - Result: Show nothing

- **Select all (button)**:
  - Should select all residues
  - Should select all chains
  - Should NOT clear PAE boxes (keep them)
  - Should set mode to 'default'
  - Result: Show all atoms + PAE selections

### Complex Scenarios

#### Scenario 1: Chain → Residue → PAE → Clear Residue
1. Select chain A (all residues in A visible)
2. Deselect some residues in chain A (partial selection)
3. Select PAE box (adds more atoms)
4. Clear residue selection
   - **Expected**: Show all residues in chain A + PAE selection

#### Scenario 2: PAE → Residue → Clear PAE
1. Select PAE box (residues 10-20, 30-40)
2. Select residues 50-60 in sequence view
3. Clear PAE selection
   - **Expected**: Show only residues 50-60

#### Scenario 3: Multiple PAE Boxes → Clear One
1. Select PAE box 1 (Shift+drag)
2. Select PAE box 2 (Shift+drag)
3. Select PAE box 3 (Shift+drag)
4. Click in PAE box 1 area (should clear all if no Shift)
   - **Expected**: Clear all PAE boxes, show only sequence selection

#### Scenario 4: Diagonal PAE → Off-Diagonal PAE
1. Select diagonal box (10-20, 10-20)
2. Shift+drag off-diagonal box (30-40, 50-60)
   - **Expected**: Both boxes active, atoms from both ranges selected

#### Scenario 5: Select All → Clear Residue → Clear PAE
1. Click "Select All" (all residues, all chains, mode='default')
2. Deselect some residues
3. Select PAE box
4. Clear residue selection
   - **Expected**: Show all residues (default) + PAE selection
5. Clear PAE selection
   - **Expected**: Show all residues (default mode)

#### Scenario 6: Clear All → Select Chain → Select Residue
1. Click "Clear All" (nothing visible, mode='explicit')
2. Select chain A
   - **Expected**: Show all residues in chain A
3. Deselect some residues in chain A
   - **Expected**: Show only selected residues in chain A

### Edge Cases

1. **Empty structure**: No atoms loaded - selection should be no-op
2. **Single chain**: Only one chain - chain selection should still work
3. **Single residue**: Only one residue - should still be selectable
4. **PAE without structure**: PAE data but no structure - PAE selection should work
5. **Structure without PAE**: Structure but no PAE - PAE selection should be disabled
6. **Rapid clicking**: Fast clicks on chain pills - should not cause race conditions
7. **Drag while PAE selected**: Sequence drag while PAE boxes active - should combine
8. **PAE drag while sequence selected**: PAE drag while residues selected - should combine
9. **Mode transitions**: Switching between 'default' and 'explicit' modes
10. **Event timing**: Multiple rapid selection changes - should batch or handle correctly

## Key Decisions

1. **Default State**: When no selection is made, show all atoms (current behavior)
2. **Empty Selection**: When user explicitly clears, show nothing (new behavior via 'explicit' mode)
3. **Selection Combination**: UNION (current behavior) - atoms selected by either sequence OR PAE
4. **PAE Highlighting**: Only show yellow lines for explicit sequence selections, not default "all"
5. **PAE Visual Symmetry**: Show symmetric visual highlight (dashed lines) but selection boxes are NOT symmetric internally
6. **Chain Checkbox State**: 
   - Checked = chain is in selection (all or some residues)
   - Unchecked = chain is not in selection
   - Partial selection within chain = checked (chain is selected, even if not all residues)
7. **Clear All Behavior**: Clears everything, sets mode to 'explicit', shows nothing
8. **Select All Behavior**: Selects all residues and chains, sets mode to 'default', keeps PAE boxes

## Files to Modify

1. `py2Dmol/resources/py2Dmol.js`
   - Update `selectionModel` structure (add `selectionMode`)
   - Refactor `setSelection()` to handle mode and partial updates
   - Update `_composeAndApplyMask()` to respect mode
   - Remove symmetric selection logic (keep visual symmetry only)
   - Add `getSelection()`, `resetToDefault()`, `clearSelection()` methods
   - Update PAE renderer to check for explicit selections only
   - Fix PAE visual rendering (symmetric visual, non-symmetric selection)

2. `web/app.js`
   - Remove `selectedResiduesSet` global
   - Update all UI functions to read from `selectionModel`
   - Update UI functions to call `setSelection()` instead of manipulating state
   - Add event listeners to sync UI with selection changes
   - Fix "Clear All" to use `clearSelection()` with explicit mode
   - Fix "Select All" to use `resetToDefault()` or appropriate mode
   - Fix chain pill logic to properly sync with selection model
   - Fix sequence view to show live preview during drag

3. Testing
   - Test all scenarios above
   - Test edge cases
   - Test rapid interactions
   - Test mode transitions
   - Verify visual consistency across all UI components

