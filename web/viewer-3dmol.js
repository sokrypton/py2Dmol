// ============================================================================
// VIEWER-3DMOL.JS - 3Dmol.js wrapper for py2Dmol
// ============================================================================

(function(window) {
    'use strict';

    /**
     * Creates a new 3Dmol.js viewer instance.
     * @param {string} containerId - The ID of the HTML element to contain the viewer.
     * @returns {GLViewer} The 3Dmol.js viewer instance.
     */
    function create3DmolViewer(containerId) {
        const element = $(`#${containerId}`);
        const config = {
            defaultcolors: $3Dmol.rasmolElementColors
        };
        const viewer = $3Dmol.createViewer(element, config);
        viewer.setBackgroundColor(0xffffff);
        viewer.resize();
        return viewer;
    }

    /**
     * Destroys a 3Dmol.js viewer instance.
     * @param {GLViewer} viewer - The viewer instance to destroy.
     */
    function destroy3DmolViewer(viewer) {
        if (viewer) {
            viewer.clear();
        }
    }

    /**
     * Loads molecular data from a frame into the 3Dmol.js viewer.
     * @param {GLViewer} viewer - The 3Dmol.js viewer instance.
     * @param {object} frame - The frame data object.
     * @param {string} objectName - The name of the object.
     */
    function loadDataInto3Dmol(viewer, frame, objectName) {
        if (!viewer || !frame || !frame.coords) {
            return;
        }

        viewer.clear();

        let pdbData = "MODEL 1\n";
        for (let i = 0; i < frame.coords.length; i++) {
            const atom = 'CA';
            const resName = frame.position_names[i] || 'UNK';
            const chain = frame.chains[i] || 'A';
            const resi = frame.residue_numbers[i] || (i + 1);
            const x = frame.coords[i][0].toFixed(3);
            const y = frame.coords[i][1].toFixed(3);
            const z = frame.coords[i][2].toFixed(3);
            const plddt = frame.plddts ? frame.plddts[i] : 0.0;

            pdbData += `ATOM  ${String(i+1).padStart(5)}  ${atom.padEnd(4)}${resName.padEnd(3)} ${chain}${String(resi).padStart(4)}    ${x.padStart(8)}${y.padStart(8)}${z.padStart(8)}  1.00${String(plddt).padStart(6)}\n`;
        }
        pdbData += "ENDMDL\n";

        viewer.addModel(pdbData, "pdb");
        viewer.setStyle({}, { cartoon: { color: 'spectrum' } });
        viewer.zoomTo();
        viewer.render();
    }

    // Expose functions to the global window object
    window.create3DmolViewer = create3DmolViewer;
    window.destroy3DmolViewer = destroy3DmolViewer;
    window.loadDataInto3Dmol = loadDataInto3Dmol;

})(window);