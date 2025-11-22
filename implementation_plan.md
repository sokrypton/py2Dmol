# Overlay Mode Implementation Plan

## Goal Description
Implement a new "overlay mode" in the py2Dmol viewer that allows multiple frames to be merged and displayed simultaneously. This includes UI button, data loading, rendering adjustments, depth sorting, shadow isolation, and UI updates.

## Proposed Changes
### Viewer UI
- Add overlay toggle button (`#overlayButton`) next to play button (already added).

### Renderer State
- `this.overlayMode` (boolean) and `this.overlayFrameRange` (optional range).

### Data Loading
- New method `_loadMultiFrameData()` merges atoms, bonds, and other per-frame data across selected frames.
- Adjust `setFrame` to call `_loadMultiFrameData()` when overlay mode is active.

### Rendering Adjustments
- Modify `_renderToContext` to handle merged data, ensure unified Z-depth sorting, and compute shadows per original frame (shadow isolation).
- Ensure depth sorting across all merged segments.

### UI Controls
- Update `updateUIControls` to reflect overlay mode state, disable play button and frame slider when overlay is active, and change overlay button appearance.

## Verification Plan
- Manual testing: toggle overlay mode, verify multiple frames appear merged, shadows are isolated, slider disabled.
- Ensure play functionality works when overlay mode is off.
- Verify UI button states and icons.
