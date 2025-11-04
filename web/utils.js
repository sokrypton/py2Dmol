// --- GLOBAL STATE FOR ALIGNMENT ---
let referenceChainACoords = null; // preserved baseline for alignment (append mode)

document.addEventListener('DOMContentLoaded', () => {

    let objectsWithPAE = new Set();
    let viewerApi = null;
    let statusElement = document.getElementById('status-message');
    let paeContainer = document.getElementById('paeContainer');
    let objectSelect = document.getElementById('objectSelect');
    let colorSelect = document.getElementById('colorSelect');
    let frameSlider = document.getElementById('frameSlider');
    const viewerContainer = document.getElementById('viewer-container');
    const canvasContainer = document.getElementById('canvasContainer');
    const canvas = document.getElementById('canvas');
    const viewerColumn = document.getElementById('viewerColumn');

    // NEW UI ELEMENTS
    const loadAsFramesCheckbox = document.getElementById('loadAsFramesCheckbox');
    const alignFramesCheckbox = document.getElementById('alignFramesCheckbox');

    const fileUploadInput = document.getElementById('file-upload');
    const uploadButton = document.getElementById('upload-button');
    const globalDropOverlay = document.getElementById('global-drop-overlay');

    // --- GLOBAL BATCH STORAGE ---
    let batchedObjects = [];

    // Constants:
    const FIXED_WIDTH = 600;
    const FIXED_HEIGHT = 600;
    const PAE_PLOT_SIZE = 300;

    // --- KABSCH ALIGNMENT ---

    function calculateMean(coords) {
        let sum = [0, 0, 0];
        for (const c of coords) {
            sum[0] += c[0]; sum[1] += c[1]; sum[2] += c[2];
        }
        return [sum[0] / coords.length, sum[1] / coords.length, sum[2] / coords.length];
    }

    function kabsch(A, B) {
        const H = numeric.dot(numeric.transpose(A), B);
        const svd = numeric.svd(H);
        const U = svd.U;
        const V = svd.V;
        const Vt = numeric.transpose(V);
        let D = [[1,0,0],[0,1,0],[0,0,1]];
        const det = numeric.det(numeric.dot(U, Vt));
        if (det < 0) D[2][2] = -1;
        return numeric.dot(U, numeric.dot(D, Vt));
    }

    // --- Helpers used by best-view logic ---

    function mean3(coords){
      const m = [0,0,0];
      for (const c of coords){ m[0]+=c[0]; m[1]+=c[1]; m[2]+=c[2]; }
      m[0]/=coords.length; m[1]/=coords.length; m[2]/=coords.length;
      return m;
    }

    function covarianceXXT(coords){
      const mu = mean3(coords);
      const X = coords.map(c => [c[0]-mu[0], c[1]-mu[1], c[2]-mu[2]]);
      return numeric.dot(numeric.transpose(X), X); // 3x3 SPD
    }

    function ensureRightHand(V){
      const det = numeric.det(V);
      if (det < 0){
        V = V.map(r => [r[0], r[1], -r[2]]); // flip third column
      }
      return V;
    }

    function multCols(V, s){ // s in {±1}^3
      return [
        [V[0][0]*s[0], V[0][1]*s[1], V[0][2]*s[2]],
        [V[1][0]*s[0], V[1][1]*s[1], V[1][2]*s[2]],
        [V[2][0]*s[0], V[2][1]*s[1], V[2][2]*s[2]]
      ];
    }

    function trace(M){ return M[0][0] + M[1][1] + M[2][2]; }

    // 2×2 polar rotation with nuclear norm score (for optimal yaw)
    function polar2x2_withScore(A){
      const svd = numeric.svd(A); // A = U S V^T
      const U = [[svd.U[0][0], svd.U[0][1]], [svd.U[1][0], svd.U[1][1]]];
      const V = [[svd.V[0][0], svd.V[0][1]], [svd.V[1][0], svd.V[1][1]]];
      let R2 = numeric.dot(V, numeric.transpose(U));
      const det = R2[0][0]*R2[1][1]-R2[0][1]*R2[1][0];
      if (det < 0){
        V[0][1]*=-1; V[1][1]*=-1;
        R2 = numeric.dot(V, numeric.transpose(U));
      }
      const nuclear = (svd.S[0]||0) + (svd.S[1]||0);
      return { R2, nuclear };
    }

    // ---------------------------------------------------------
    // RELAXED best view (AUTO convention):
    //  - lock z to min-variance axis (v3)
    //  - allow x/y yaw to match current view as closely as possible
    //  - try both POST-YAW (VS*Qz) and PRE-YAW (Qz*VS), pick smaller angle
    //  - test the 4 right-handed sign patterns; keep the best
    // ---------------------------------------------------------
    function bestViewTargetRotation_relaxed_AUTO(coords, currentRotation){
      // PCA
      const H = covarianceXXT(coords);
      const svd = numeric.svd(H);
      let V = [
        [svd.V[0][0], svd.V[0][1], svd.V[0][2]],
        [svd.V[1][0], svd.V[1][1], svd.V[1][2]],
        [svd.V[2][0], svd.V[2][1], svd.V[2][2]]
      ];
      V = ensureRightHand(V);

      const signCombos = [
        [ 1,  1,  1],
        [ 1, -1, -1],
        [-1,  1, -1],
        [-1, -1,  1]
      ];

      const Rcur  = currentRotation;
      const RcurT = numeric.transpose(currentRotation);
      const candidates = [];

      for (const s of signCombos){
        const VS = multCols(V, s);

        // (A) POST-YAW: R = VS * Qz, choose Qz to maximize trace(Rcur^T * VS * Qz)
        {
          const M  = numeric.dot(RcurT, VS);
          const A  = [[M[0][0], M[0][1]], [M[1][0], M[1][1]]];
          const { R2 } = polar2x2_withScore(A);
          const Qa = [[R2[0][0], R2[0][1], 0],
                      [R2[1][0], R2[1][1], 0],
                      [0,        0,        1]];
          const Ra = numeric.dot(VS, Qa);
          const angleA = rotationAngleBetweenMatrices(Rcur, Ra);
          candidates.push({ R: Ra, angle: angleA, mode: 'post' });
        }

        // (B) PRE-YAW: R = Qz * VS, choose Qz to maximize trace(Rcur^T * (Qz * VS))
        // Equivalent to maximizing trace(Qz * (VS * Rcur^T)) over the 2×2 block.
        {
          const B  = numeric.dot(VS, RcurT);
          const B2 = [[B[0][0], B[0][1]], [B[1][0], B[1][1]]];
          const { R2 } = polar2x2_withScore(B2);
          const Qb = [[R2[0][0], R2[0][1], 0],
                      [R2[1][0], R2[1][1], 0],
                      [0,        0,        1]];
          const Rb = numeric.dot(Qb, VS);
          const angleB = rotationAngleBetweenMatrices(Rcur, Rb);
          candidates.push({ R: Rb, angle: angleB, mode: 'pre' });
        }
      }

      candidates.sort((a,b)=>a.angle-b.angle);
      // Uncomment for debug:
      // console.log('AUTO picked:', candidates[0].mode, 'angle(deg)=', candidates[0].angle*180/Math.PI);
      return candidates[0].R;
    }

    // Optional: tiny axis logger for debugging in console
    function logAxes(R){
      const rowsAsAxes = {
        x: [ R[0][0], R[0][1], R[0][2] ],
        y: [ R[1][0], R[1][1], R[1][2] ],
        z: [ R[2][0], R[2][1], R[2][2] ],
      };
      const colsAsAxes = {
        x: [ R[0][0], R[1][0], R[2][0] ],
        y: [ R[0][1], R[1][1], R[2][1] ],
        z: [ R[0][2], R[1][2], R[2][2] ],
      };
      console.log('Rows-as-axes:', rowsAsAxes);
      console.log('Cols-as-axes:', colsAsAxes);
      console.log('det(R)=', numeric.det(R));
    }
    // window.logAxes = logAxes; // expose if you want

    // --- BEST VIEW ROTATION ANIMATION STATE ---

    let rotationAnimation = {
        active: false,
        startMatrix: null,
        targetMatrix: null,
        startTime: 0,
        duration: 1000
    };

    function lerpRotationMatrix(M1, M2, t) {
        const result = [[0,0,0],[0,0,0],[0,0,0]];
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
                result[i][j] = M1[i][j] * (1 - t) + M2[i][j] * t;
            }
        }
        // Gram-Schmidt columns
        let c0 = [result[0][0], result[1][0], result[2][0]];
        let n0 = Math.hypot(c0[0], c0[1], c0[2]); c0 = [c0[0]/n0, c0[1]/n0, c0[2]/n0];
        let c1 = [result[0][1], result[1][1], result[2][1]];
        let dot01 = c0[0]*c1[0] + c0[1]*c1[1] + c0[2]*c1[2];
        c1 = [c1[0]-dot01*c0[0], c1[1]-dot01*c0[1], c1[2]-dot01*c0[2]];
        let n1 = Math.hypot(c1[0], c1[1], c1[2]); c1 = [c1[0]/n1, c1[1]/n1, c1[2]/n1];
        let c2 = [
            c0[1]*c1[2] - c0[2]*c1[1],
            c0[2]*c1[0] - c0[0]*c1[2],
            c0[0]*c1[1] - c0[1]*c1[0]
        ];
        return [[c0[0], c1[0], c2[0]],
                [c0[1], c1[1], c2[1]],
                [c0[2], c1[2], c2[2]]];
    }

    function animateRotation() {
        if (!rotationAnimation.active) return;
        if (!viewerApi || !viewerApi.renderer) { rotationAnimation.active = false; return; }

        const renderer = viewerApi.renderer;
        const now = performance.now();
        const elapsed = now - rotationAnimation.startTime;
        let progress = elapsed / rotationAnimation.duration;

        if (progress >= 1.0) {
            renderer.rotationMatrix = rotationAnimation.targetMatrix;
            renderer.render();
            rotationAnimation.active = false;
            return;
        }

        const eased = progress < 0.5 ? 4 * progress * progress * progress
                                     : 1 - Math.pow(-2 * progress + 2, 3) / 2;

        renderer.rotationMatrix = lerpRotationMatrix(
            rotationAnimation.startMatrix,
            rotationAnimation.targetMatrix,
            eased
        );
        renderer.render();
        requestAnimationFrame(animateRotation);
    }

    function rotationAngleBetweenMatrices(M1, M2) {
        const M1T = numeric.transpose(M1);
        const R = numeric.dot(M1T, M2);
        const tr = R[0][0] + R[1][1] + R[2][2];
        const cosTheta = (tr - 1) / 2;
        const clamped = Math.max(-1, Math.min(1, cosTheta));
        return Math.acos(clamped);
    }

    // --- UI helpers ---

    function gotoPreviousObject() {
        const objectSelect = document.getElementById('objectSelect');
        if (!objectSelect || objectSelect.options.length === 0) return;
        const currentIndex = objectSelect.selectedIndex;
        const newIndex = currentIndex > 0 ? currentIndex - 1 : objectSelect.options.length - 1;
        objectSelect.selectedIndex = newIndex;
        objectSelect.dispatchEvent(new Event('change'));
    }

    function gotoNextObject() {
        const objectSelect = document.getElementById('objectSelect');
        if (!objectSelect || objectSelect.options.length === 0) return;
        const currentIndex = objectSelect.selectedIndex;
        const newIndex = currentIndex < objectSelect.options.length - 1 ? currentIndex + 1 : 0;
        objectSelect.selectedIndex = newIndex;
        objectSelect.dispatchEvent(new Event('change'));
    }

    function toggleAutoRotate() {
        if (!viewerApi || !viewerApi.renderer) return;
        const renderer = viewerApi.renderer;
        renderer.autoRotate = !renderer.autoRotate;
        if (renderer.rotationCheckbox) renderer.rotationCheckbox.checked = renderer.autoRotate;
        const rotateButton = document.getElementById('rotateButton');
        if (rotateButton) {
            rotateButton.classList.toggle('active', renderer.autoRotate);
        }
    }

    function updateObjectNavigationButtons() {
        const objectSelect = document.getElementById('objectSelect');
        const prevButton = document.getElementById('prevObjectButton');
        const nextButton = document.getElementById('nextObjectButton');
        if (!objectSelect || !prevButton || !nextButton) return;
        const shouldDisable = objectSelect.options.length <= 1;
        prevButton.disabled = shouldDisable;
        nextButton.disabled = shouldDisable;
    }

    // --- ORIENT handler: now uses AUTO best-view ---
    function applyBestViewRotation() {
      if (!viewerApi || !viewerApi.renderer) return;
      const renderer = viewerApi.renderer;

      const objectSelect = document.getElementById('objectSelect');
      const objectName = objectSelect ? objectSelect.value : null;
      if (!objectName) return;
      const object = renderer.objectsData[objectName];
      if (!object || !object.frames || object.frames.length === 0) return;

      const currentFrame = renderer.currentFrame || 0;
      const frame = object.frames[currentFrame];
      if (!frame || !frame.coords) return;

      const Rcur = renderer.rotationMatrix;

      // AUTO: lock z to min variance; choose in-plane yaw; try both conventions
      const Rtarget = bestViewTargetRotation_relaxed_AUTO(frame.coords, Rcur);

      const angle = rotationAngleBetweenMatrices(Rcur, Rtarget);
      const deg = angle * 180 / Math.PI;
      const duration = Math.max(300, Math.min(2000, deg * 10));

      rotationAnimation.active = true;
      rotationAnimation.startMatrix = Rcur.map(row => [...row]);
      rotationAnimation.targetMatrix = Rtarget;
      rotationAnimation.duration = duration;
      rotationAnimation.startTime = performance.now();

      if (renderer.autoRotate) {
        renderer.autoRotate = false;
        if (renderer.rotationCheckbox) {
          renderer.rotationCheckbox.checked = false;
          renderer.rotationCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      renderer.spinVelocityX = 0;
      renderer.spinVelocityY = 0;

      requestAnimationFrame(animateRotation);
    }

    // --- Alignment & parsing & app plumbing (unchanged except minor comments) ---

    function align_a_to_b(fullCoordsA, alignCoordsA, alignCoordsB) {
        const meanAlignA = calculateMean(alignCoordsA);
        const meanAlignB = calculateMean(alignCoordsB);
        const centAlignA = alignCoordsA.map(c => [c[0] - meanAlignA[0], c[1] - meanAlignA[1], c[2] - meanAlignA[2]]);
        const centAlignB = alignCoordsB.map(c => [c[0] - meanAlignB[0], c[1] - meanAlignB[1], c[2] - meanAlignB[2]]);
        const R = kabsch(centAlignA, centAlignB);
        const centFullA = fullCoordsA.map(c => [c[0] - meanAlignA[0], c[1] - meanAlignA[1], c[2] - meanAlignA[2]]);
        const rotatedFullA = numeric.dot(centFullA, R);
        return rotatedFullA.map(c => [c[0] + meanAlignB[0], c[1] + meanAlignB[1], c[2] + meanAlignB[2]]);
    }

    function parsePDB(text) {
        const models = [];
        let currentModelAtoms = [];
        const lines = text.split('\n');
        for (const line of lines) {
            if (line.startsWith('MODEL')) {
                if (currentModelAtoms.length > 0) { models.push(currentModelAtoms); }
                currentModelAtoms = [];
            }
            if (line.startsWith('ATOM') || line.startsWith('HETATM')) {
                currentModelAtoms.push({
                    record: line.substring(0, 6).trim(), atomName: line.substring(12, 16).trim(),
                    resName: line.substring(17, 20).trim(), chain: line.substring(21, 22).trim(),
                    resSeq: parseInt(line.substring(22, 26)),
                    x: parseFloat(line.substring(30, 38)),
                    y: parseFloat(line.substring(38, 46)),
                    z: parseFloat(line.substring(46, 54)),
                    b: parseFloat(line.substring(60, 66)), element: line.substring(76, 78).trim()
                });
            }
            if (line.startsWith('ENDMDL')) {
                if (currentModelAtoms.length > 0) { models.push(currentModelAtoms); currentModelAtoms = []; }
            }
        }
        if (currentModelAtoms.length > 0) { models.push(currentModelAtoms); }
        if (models.length === 0 && currentModelAtoms.length > 0) { models.push(currentModelAtoms); }
        return models;
    }

    function parseCIF(text) {
        const modelMap = new Map();
        const lines = text.split('\n');
        let atomSiteLoop = false;
        const headers = [];
        const headerMap = {};
        let modelIDKey = null;
        let modelID = 1;

        for (const line of lines) {
            if (line.startsWith('_atom_site.')) {
                const header = line.trim();
                headerMap[header] = headers.length;
                headers.push(header);
                if (header.includes('model_no') || header.includes('pdbx_PDB_model_num')) { modelIDKey = header; }
            } else if (headers.length > 0 && (line.startsWith('loop_') || line.startsWith('#'))) { break; }
        }

        for (const line of lines) {
            if (line.startsWith('_atom_site.')) { atomSiteLoop = true; }
            else if (atomSiteLoop && line.startsWith('#')) { atomSiteLoop = false; }
            else if (atomSiteLoop && !line.startsWith(';')) {
                const values = line.match(/(?:[^\s"']+|"([^"]*)"|'([^']*)')+/g);
                if (!values || values.length < headers.length) continue;

                const getString = (key) => values[headerMap[key]] || '?';
                const getFloat  = (key) => parseFloat(values[headerMap[key]]) || 0.0;
                const getInt    = (key) => parseInt(values[headerMap[key]]) || 0;

                const atomNameRaw = getString('_atom_site.label_atom_id');
                let atomName = atomNameRaw;
                if (atomName.length > 1 && atomName.startsWith("'") && atomName.endsWith("'")) { atomName = atomName.substring(1, atomName.length - 1); }
                else if (atomName.length > 1 && atomName.startsWith('"') && atomName.endsWith('"')) { atomName = atomName.substring(1, atomName.length - 1); }

                const atom = {
                    record: getString('_atom_site.group_PDB'), atomName: atomName,
                    resName: getString('_atom_site.label_comp_id'), chain: getString('_atom_site.auth_asym_id'),
                    resSeq: getInt('_atom_site.auth_seq_id'), x: getFloat('_atom_site.Cartn_x'),
                    y: getFloat('_atom_site.Cartn_y'), z: getFloat('_atom_site.Cartn_z'),
                    b: getFloat('_atom_site.B_iso_or_equiv'), element: getString('_atom_site.type_symbol')
                };

                if (modelIDKey) { modelID = getInt(modelIDKey); }

                if (!modelMap.has(modelID)) { modelMap.set(modelID, []); }
                modelMap.get(modelID).push(atom);
            }
        }

        return Array.from(modelMap.keys()).sort((a, b) => a - b).map(id => modelMap.get(id));
    }

    function convertParsedToFrameData(atoms) {
        const coords = []; const plddts = []; const atom_chains = []; const atom_types = [];
        const rna_bases = ['A', 'C','G', 'U', 'RA', 'RC', 'RG', 'RU'];
        const proteinResidues = new Set(["ALA","ARG","ASN","ASP","CYS","GLU","GLN","GLY","HIS","ILE","LEU","LYS","MET","PHE","PRO","SER","THR","TRP","TYR","VAL"]);
        const nucleicResidues = new Set(["A","C","G","U","T","DA","DC","DG","DT","RA","RC","RG","RU"]);
        const residues = new Map();
        for (const atom of atoms) {
            if (atom.resName === 'HOH') continue;
            const resKey = `${atom.chain}:${atom.resSeq}:${atom.resName}`;
            if (!residues.has(resKey)) residues.set(resKey, { atoms: [], resName: atom.resName, chain: atom.chain, record: atom.record });
            residues.get(resKey).atoms.push(atom);
        }
        for (const [, residue] of residues.entries()) {
            const is_protein = proteinResidues.has(residue.resName);
            const is_nucleic = nucleicResidues.has(residue.resName);
            if (is_protein) {
                const ca = residue.atoms.find(a => a.atomName === 'CA');
                if (ca) { coords.push([ca.x, ca.y, ca.z]); plddts.push(ca.b); atom_chains.push(ca.chain); atom_types.push('P'); }
            } else if (is_nucleic) {
                let c4_atom = residue.atoms.find(a => a.atomName === "C4'" || a.atomName === "C4*");
                if (c4_atom) {
                    coords.push([c4_atom.x, c4_atom.y, c4_atom.z]); plddts.push(c4_atom.b); atom_chains.push(c4_atom.chain);
                    atom_types.push(rna_bases.includes(residue.resName) || residue.resName.startsWith('R') ? 'R' : 'D');
                }
            } else if (residue.record === 'HETATM') {
                for (const atom of residue.atoms) {
                    if (atom.element !== 'H' && atom.element !== 'D') {
                        coords.push([atom.x, atom.y, atom.z]); plddts.push(atom.b); atom_chains.push(atom.chain); atom_types.push('L');
                    }
                }
            }
        }
        return { coords, plddts, chains: atom_chains, atom_types };
    }

    // --- App main logic / UI plumbing ---

    function setStatus(message, isError = false) {
        statusElement.textContent = message;
        statusElement.className = `mt-4 text-sm font-medium ${isError ? 'text-red-700 bg-red-100 border-red-200' : 'text-blue-700 bg-blue-50 border-blue-200'} p-2 rounded-lg border`;
        statusElement.classList.remove('hidden');
    }

    function cleanObjectName(name) {
        return name.replace(/\.(cif|pdb|ent|zip)$/i, '');
    }

    function extractPaeFromJSON(paeJson) {
        if (!paeJson) return null;
        if (paeJson.pae && Array.isArray(paeJson.pae)) return paeJson.pae;
        if (paeJson.predicted_aligned_error && Array.isArray(paeJson.predicted_aligned_error)) return paeJson.predicted_aligned_error;
        if (Array.isArray(paeJson) && paeJson.length > 0 && paeJson[0].predicted_aligned_error) return paeJson[0].predicted_aligned_error;
        console.warn("Could not find any *known* PAE matrix (pae, predicted_aligned_error) in the JSON file.");
        return null;
    }
// ---- Lightweight Biological Assembly (BU1) helpers ----
function tokenizeCIFLine_light(s) {
    const out = []; let i=0, n=s.length;
    while (i<n) {
        while (i<n && /\s/.test(s[i])) i++;
        if (i>=n) break;
        if (s[i]==="'") { let j=++i; while (j<n && s[j]!=="'") j++; out.push(s.slice(i,j)); i=Math.min(j+1,n); }
        else if (s[i]==='"') { let j=++i; while (j<n && s[j]!=='"') j++; out.push(s.slice(i,j)); i=Math.min(j+1,n); }
        else { let j=i; while (j<n && !/\s/.test(s[j])) j++; const tok=s.slice(i,j); out.push(tok==='.'||tok==='?'?'':tok); i=j; }
    }
    return out;
}
function parseMinimalCIF_light(text){
    const lines = text.split(/\r?\n/);
    const loops = [];
    let i=0;
    while (i<lines.length){
        let L = lines[i].trim();
        if (!L || L[0]==='#'){ i++; continue; }
        if (/^loop_/i.test(L)){
            i++;
            const cols=[]; const rows=[];
            while (i<lines.length && /^\s*_/.test(lines[i])) { cols.push(lines[i].trim()); i++; }
            while (i<lines.length){
                const raw = lines[i];
                if (!raw || /^\s*#/.test(raw) || /^\s*loop_/i.test(raw) || /^\s*data_/i.test(raw) || /^\s*_/.test(raw)) break;
                let vals = tokenizeCIFLine_light(raw);
                while (vals.length < cols.length && i+1<lines.length){
                    const more = tokenizeCIFLine_light(lines[++i]);
                    vals = vals.concat(more);
                }
                if (vals.length>=cols.length) rows.push(vals.slice(0, cols.length));
                i++;
            }
            loops.push([cols, rows]);
            continue;
        }
        i++;
    }
    return loops;
}
function expandOperExpr_light(expr){
    if (!expr) return [];
    expr = expr.replace(/\s+/g,'');
    function splitTop(s, sep){
        const out=[]; let depth=0; let last=0;
        for (let i=0;i<s.length;i++){
            const c=s[i]; if (c==='(') depth++; else if (c===')') depth--;
            else if (depth===0 && c===sep) { out.push(s.slice(last,i)); last=i+1; }
        }
        out.push(s.slice(last)); return out.filter(Boolean);
    }
    const parts = splitTop(expr, ',');
    const seqs=[];
    for (const p of parts){
        const groups = splitTop(p, 'x');
        let expanded = groups.map(term=>{
            if (term.startsWith('(') && term.endsWith(')')) term = term.slice(1,-1);
            const m = term.match(/^(\d+)-(\d+)$/);
            if (/^\d+$/.test(term)) return [term];
            if (m){ const a=+m[1], b=+m[2]; const out=[]; const step=a<=b?1:-1; for (let k=a; step>0?k<=b:k>=b; k+=step) out.push(String(k)); return out; }
            return term.split(',').filter(Boolean);
        });
        let acc = expanded[0].map(x=>[x]);
        for (let i=1;i<expanded.length;i++){
            const next=[]; for (const a of acc) for (const x of expanded[i]) next.push(a.concat([x])); acc=next;
        }
        seqs.push(...acc);
    }
    return seqs;
}
function applyOp_light(atom, R, t){
    return {
       ...atom,
       x: R[0]*atom.x + R[1]*atom.y + R[2]*atom.z + t[0],
       y: R[3]*atom.x + R[4]*atom.y + R[5]*atom.z + t[1],
       z: R[6]*atom.x + R[7]*atom.y + R[8]*atom.z + t[2]
    };
}
function parseFirstBioAssembly(text){
    const isCIF = /^\s*data_/i.test(text) || /_atom_site\./i.test(text);
    return isCIF ? buildBioFromCIF(text) : buildBioFromPDB(text);
}
function buildBioFromPDB(text){
    // Parse atoms from the first MODEL (asymmetric unit)
    const models = parsePDB(text);
    const atoms = (models && models[0]) ? models[0] : [];
    const lines = text.split(/\r?\n/);

    let inTargetBio = false;
    const targetBioId = 1;
    const chains = new Set();
    const opRows = {};

    for (const L of lines) {
        if (!L.startsWith('REMARK 350')) continue;
        if (/REMARK 350\s+BIOMOLECULE:\s*(\d+)/.test(L)) {
            const id = parseInt(L.match(/REMARK 350\s+BIOMOLECULE:\s*(\d+)/)[1], 10);
            inTargetBio = (id === targetBioId);
            continue;
        }
        if (!inTargetBio) continue;
        if (/:/.test(L) && /(APPLY THE FOLLOWING TO|AND|ALSO)\s+CHAIN[S]?:/i.test(L)) {
            const after = L.split(':')[1] || '';
            after.split(/[, ]+/).map(s=>s.replace(/[^A-Za-z0-9]/g,'').trim()).filter(Boolean).forEach(c=>chains.add(c));
            continue;
        }
        if (/REMARK 350\s+BIOMT[123]/.test(L)) {
            const rowChar = L.substring(18,19);
            const rowNum = parseInt(rowChar, 10);
            const opIdx  = parseInt(L.substring(19,24), 10);
            if (!(rowNum >= 1 && rowNum <= 3) || isNaN(opIdx)) continue;
            const a1 = parseFloat(L.substring(23,33));
            const a2 = parseFloat(L.substring(33,43));
            const a3 = parseFloat(L.substring(43,53));
            const t  = parseFloat(L.substring(53,68));
            if ([a1,a2,a3,t].some(v => Number.isNaN(v))) continue;
            const row = [a1,a2,a3,t];
            opRows[opIdx] = opRows[opIdx] || [null, null, null];
            opRows[opIdx][rowNum - 1] = row;
        }
    }
    const ops = [];
    Object.keys(opRows).forEach(k => {
        const r = opRows[k];
        if (r[0] && r[1] && r[2]) {
            const R = [ r[0][0], r[0][1], r[0][2], r[1][0], r[1][1], r[1][2], r[2][0], r[2][1], r[2][2] ];
            const t = [ r[0][3], r[1][3], r[2][3] ];
            ops.push({ id: String(k), R, t });
        }
    });
    if (ops.length === 0) return { atoms, meta: { source: 'pdb', assembly: 'asymmetric_unit' } };
    if (chains.size === 0) { for (const a of atoms) if (a.chain) chains.add(a.chain); }
    const out = [];
    for (const op of ops) {
        for (const a of atoms) {
            if (!chains.size || chains.has(a.chain)) {
                const ax = applyOp_light(a, op.R, op.t);
                ax.chain = (op.id === '1') ? String(a.chain || '') : (String(a.chain || '') + '|' + op.id);
                out.push(ax);
            }
        }
    }
    return { atoms: out, meta: { source: 'pdb', assembly: String(targetBioId), ops: ops.length, chains: [...chains] } };
}
function buildBioFromCIF(text){
    const loops = parseMinimalCIF_light(text);
    const getLoop = (name) => loops.find(([cols]) => cols.includes(name));

    // Atom table (asymmetric unit)
    const atomL = loops.find(([cols]) => cols.some(c => c.startsWith('_atom_site.')));
    if (!atomL) return { atoms: [], meta: { source: 'mmcif', assembly: 'empty' } };

    const atomCols = atomL[0], atomRows = atomL[1];
    const acol = (n) => atomCols.indexOf(n);

    const ixX   = acol('_atom_site.Cartn_x');
    const ixY   = acol('_atom_site.Cartn_y');
    const ixZ   = acol('_atom_site.Cartn_z');
    const ixEl  = acol('_atom_site.type_symbol');
    const ixLA  = acol('_atom_site.label_asym_id');
    const ixAA  = acol('_atom_site.auth_asym_id');
    const ixRes = (acol('_atom_site.label_comp_id') >= 0 ? acol('_atom_site.label_comp_id') : acol('_atom_site.auth_comp_id'));
    const ixSeq = (acol('_atom_site.label_seq_id')  >= 0 ? acol('_atom_site.label_seq_id')  : acol('_atom_site.auth_seq_id'));
    const ixNm  = acol('_atom_site.label_atom_id');
    const ixGrp = acol('_atom_site.group_PDB');
    const ixB   = acol('_atom_site.B_iso_or_equiv');

    const baseAtoms = atomRows.map(r => ({
        record:   r[ixGrp] || 'ATOM',
        atomName: r[ixNm]  || '',
        resName:  r[ixRes] || '',
        // Prefer label_asym_id for assembly logic and display
        lchain:   (ixLA >= 0 ? r[ixLA] : (ixAA >= 0 ? r[ixAA] : '')) || '',
        chain:    (ixLA >= 0 ? r[ixLA] : (ixAA >= 0 ? r[ixAA] : '')) || '',
        authChain:(ixAA >= 0 ? r[ixAA] : ''),
        resSeq:   r[ixSeq] ? parseInt(r[ixSeq], 10) : 0,
        x:        parseFloat(r[ixX]),
        y:        parseFloat(r[ixY]),
        z:        parseFloat(r[ixZ]),
        b:        ixB >= 0 ? (parseFloat(r[ixB]) || 0.0) : 0.0,
        element:  (r[ixEl] || '').toUpperCase()
    }));

    // Assembly generator
    const asmL = getLoop('_pdbx_struct_assembly_gen.assembly_id');
    if (!asmL) return { atoms: baseAtoms, meta: { source: 'mmcif', assembly: 'asymmetric_unit' } };

    // Operator list (may be missing; identity if so)
    const operL = getLoop('_pdbx_struct_oper_list.id');
    const opCols = operL ? operL[0] : [];
    const opRows = operL ? operL[1] : [];
    const o = (n) => opCols.indexOf(n);

    const opMap = new Map();
    for (const r of opRows) {
        const id = (r[o('_pdbx_struct_oper_list.id')] || '').toString();
        const R = [
            parseFloat(r[o('_pdbx_struct_oper_list.matrix[1][1]')]),
            parseFloat(r[o('_pdbx_struct_oper_list.matrix[1][2]')]),
            parseFloat(r[o('_pdbx_struct_oper_list.matrix[1][3]')]),
            parseFloat(r[o('_pdbx_struct_oper_list.matrix[2][1]')]),
            parseFloat(r[o('_pdbx_struct_oper_list.matrix[2][2]')]),
            parseFloat(r[o('_pdbx_struct_oper_list.matrix[2][3]')]),
            parseFloat(r[o('_pdbx_struct_oper_list.matrix[3][1]')]),
            parseFloat(r[o('_pdbx_struct_oper_list.matrix[3][2]')]),
            parseFloat(r[o('_pdbx_struct_oper_list.matrix[3][3]')])
        ];
        const t = [
            parseFloat(r[o('_pdbx_struct_oper_list.vector[1]')]),
            parseFloat(r[o('_pdbx_struct_oper_list.vector[2]')]),
            parseFloat(r[o('_pdbx_struct_oper_list.vector[3]')])
        ];
        if (Number.isFinite(R[0])) opMap.set(id, { R, t });
    }
    if (!operL || opMap.size === 0) {
        opMap.set('1', { R: [1,0,0, 0,1,0, 0,0,1], t: [0,0,0] });
    }

    // Choose assembly 1 (fallback to first row if no explicit "1")
    const a = (n) => asmL[0].indexOf(n);
    let candidates = asmL[1].filter(r => (r[a('_pdbx_struct_assembly_gen.assembly_id')] || '') === '1');
    if (candidates.length === 0 && asmL[1].length > 0) candidates = [asmL[1][0]];
    if (candidates.length === 0) return { atoms: baseAtoms, meta: { source: 'mmcif', assembly: 'asymmetric_unit' } };

    // Assemble
    const out = [];
    const seen = new Set();
    for (const r of candidates) {
        const asymList =
            (r[a('_pdbx_struct_assembly_gen.asym_id_list')] ||
             r[a('_pdbx_struct_assembly_gen.oper_asym_id_list')] || '').toString();
        const asymIds = asymList.split(',').map(s => s.trim()).filter(Boolean);
        asymIds.forEach(c => seen.add(c));

        const expr = (r[a('_pdbx_struct_assembly_gen.oper_expression')] || '1').toString();
        const seqs = expandOperExpr_light(expr);
        const seqsUse = (seqs && seqs.length) ? seqs : [['1']];

        for (const seq of seqsUse) {
            const seqLabel = seq.join('x');
            // Compose left-multiplied: opN * ... * op1
            let R = [1,0,0, 0,1,0, 0,0,1];
            let t = [0,0,0];
            for (const id of seq) {
                const op = opMap.get(id); if (!op) continue;
                t = [ op.R[0]*t[0]+op.R[1]*t[1]+op.R[2]*t[2]+op.t[0],
                      op.R[3]*t[0]+op.R[4]*t[1]+op.R[5]*t[2]+op.t[1],
                      op.R[6]*t[0]+op.R[7]*t[1]+op.R[8]*t[2]+op.t[2] ];
                R = [ op.R[0]*R[0]+op.R[1]*R[3]+op.R[2]*R[6],
                      op.R[0]*R[1]+op.R[1]*R[4]+op.R[2]*R[7],
                      op.R[0]*R[2]+op.R[1]*R[5]+op.R[2]*R[8],
                      op.R[3]*R[0]+op.R[4]*R[3]+op.R[5]*R[6],
                      op.R[3]*R[1]+op.R[4]*R[4]+op.R[5]*R[7],
                      op.R[3]*R[2]+op.R[4]*R[5]+op.R[5]*R[8],
                      op.R[6]*R[0]+op.R[7]*R[3]+op.R[8]*R[6],
                      op.R[6]*R[1]+op.R[7]*R[4]+op.R[8]*R[7],
                      op.R[6]*R[2]+op.R[7]*R[5]+op.R[8]*R[8] ];
            }
            for (const aAtom of baseAtoms) {
                // Only label_asym_id participates in asym_id_list
                if (!asymIds.includes(aAtom.lchain)) continue;
                const ax = applyOp_light(aAtom, R, t);
                ax.chain = (seqLabel === '1') ? String(aAtom.lchain || aAtom.chain || '') : (String(aAtom.lchain || aAtom.chain || '') + '|' + seqLabel);
                out.push(ax);
            }
        }
    }
    // Optional debug
    try { console.debug('[BU1 mmCIF] asym=', [...seen]); } catch {}

    return { atoms: out, meta: { source: 'mmcif', assembly: '1', chains: [...seen] } };
}



    function processStructureToTempBatch(text, name, paeData, targetObjectName, tempBatch) {
        let models;
        try {
            const wantBU = !!(window.viewerConfig && window.viewerConfig.biounit);
            if (wantBU) {
                const assembled = parseFirstBioAssembly(text);
                if (assembled && assembled.atoms && assembled.atoms.length) {
                    models = [assembled.atoms];
                }
            }
            if (!models) { const isCIF = text.substring(0, 1000).includes('data_'); models = isCIF ? parseCIF(text) : parsePDB(text); }
            if (!models || models.length === 0 || models.every(m => m.length === 0)) {
                throw new Error(`Could not parse any models or atoms from ${name}.`);
            }
        } catch (e) {
            console.error("Parsing failed:", e);
            setStatus(`Error: ${e.message}`, true);
            return 0;
        }

        let framesAdded = 0;

        let targetObject = tempBatch.find(obj => obj.name === targetObjectName) || null;
        if (!targetObject) {
            targetObject = { name: targetObjectName, frames: [] };
            tempBatch.push(targetObject);
        }

        const isTrajectory = (loadAsFramesCheckbox.checked || targetObject.frames.length > 0 || models.length > 1);
        const shouldAlign = alignFramesCheckbox.checked;

        function maybeFilterLigands(atoms) {
            const ignore = !!(window.viewerConfig && window.viewerConfig.ignoreLigands);
            if (!ignore) return atoms;
            const proteinResidues = new Set(["ALA","ARG","ASN","ASP","CYS","GLU","GLN","GLY","HIS","ILE","LEU","LYS","MET","PHE","PRO","SER","THR","TRP","TYR","VAL","SEC","PYL"]);
            const nucleicResidues = new Set(["A","C","G","U","T","DA","DC","DG","DT","RA","RC","RG","RU"]);
            return atoms.filter(a => a && (
                a.record !== 'HETATM' || proteinResidues.has(a.resName) || nucleicResidues.has(a.resName)
            ));
        }

        for (let i = 0; i < models.length; i++) {
            if (!loadAsFramesCheckbox.checked && i > 0) {
                const modelObjectName = `${targetObjectName}_model_${i+1}`;
                targetObject = tempBatch.find(obj => obj.name === modelObjectName) || null;
                if (!targetObject) {
                    targetObject = { name: modelObjectName, frames: [] };
                    tempBatch.push(targetObject);
                }
            }

            const model = maybeFilterLigands(models[i]);
            let frameData = convertParsedToFrameData(model);
            if (frameData.coords.length === 0) continue;

            if (isTrajectory && shouldAlign) {
                const sourceChainACoords = [];
                for(let j = 0; j < frameData.coords.length; j++) {
                    if (frameData.chains[j] === 'A') sourceChainACoords.push(frameData.coords[j]);
                }

                if (targetObject.frames.length === 0 && i === 0) {
                    referenceChainACoords = sourceChainACoords;
                } else if (referenceChainACoords && sourceChainACoords.length > 0 && sourceChainACoords.length === referenceChainACoords.length) {
                    try {
                        frameData.coords = align_a_to_b(frameData.coords, sourceChainACoords, referenceChainACoords);
                    } catch (e) {
                        console.error(`Alignment failed for frame ${i} of ${targetObjectName}:`, e);
                        setStatus(`Warning: Alignment failed for a frame in ${targetObjectName}. See console.`, true);
                    }
                }
            }

            if (paeData) {
                frameData.pae = paeData.map(row => [...row]);
                targetObject.hasPAE = true;
            } else {
                frameData.pae = null;
            }

            targetObject.frames.push(frameData);
            framesAdded++;
        }

        if (framesAdded === 0) setStatus(`Warning: Found models, but no backbone atoms in ${name}.`, true);

        return framesAdded;
    }

    function updateViewerFromGlobalBatch() {
         viewerApi.handlePythonClearAll();
         objectsWithPAE = new Set();
         objectSelect.innerHTML = '';

         if (!viewerApi || batchedObjects.length === 0) {
             viewerContainer.style.display = 'none';
             setStatus("Ready. Upload a file or fetch an ID.");
             return;
         }

         let totalFrames = 0;
         let lastObjectName = null;

         for (const obj of batchedObjects) {
             if (obj.frames.length > 0) {
                 viewerApi.handlePythonNewObject(obj.name);
                 lastObjectName = obj.name;
                 for (const frame of obj.frames) {
                     viewerApi.handlePythonUpdate(JSON.stringify(frame), obj.name);
                     totalFrames++;
                 }
                 if (obj.hasPAE) objectsWithPAE.add(obj.name);
             }
         }

         if (totalFrames > 0) {
             viewerContainer.style.display = 'flex';
             if (lastObjectName) {
                setTimeout(() => {
                    objectSelect.value = lastObjectName;
                    handleObjectChange();
                    updateObjectNavigationButtons();
                }, 50);
             }
         } else {
             setStatus("Error: No valid structures were loaded to display.", true);
             viewerContainer.style.display = 'none';
         }
    }

    // --- Fetch logic (append mode) ---

    async function handleFetch() {
        const tempBatch = [];
        const fetchId = document.getElementById('fetch-id').value.trim().toUpperCase();
        if (!fetchId) { setStatus("Please enter a PDB or UniProt ID.", true); return; }

        setStatus(`Fetching ${fetchId} data...`);

        const isPDB = fetchId.length === 4;
        const isAFDB = !isPDB;

        let structUrl, paeUrl, name, paeEnabled;

        if (isAFDB) {
            name = `${fetchId}.cif`;
            structUrl = `https://alphafold.ebi.ac.uk/files/AF-${fetchId}-F1-model_v6.cif`;
            paeUrl = `https://alphafold.ebi.ac.uk/files/AF-${fetchId}-F1-predicted_aligned_error_v6.json`;
            paeEnabled = window.viewerConfig.pae;
        } else {
            name = `${fetchId}.cif`;
            structUrl = `https://files.rcsb.org/download/${fetchId}.cif`;
            paeUrl = null; paeEnabled = false;
        }

        try {
            const structResponse = await fetch(structUrl);
            if (!structResponse.ok) throw new Error(`Failed to fetch structure (HTTP ${structResponse.status})`);
            const structText = await structResponse.text();

            let paeData = null;
            if (paeEnabled && paeUrl) {
                try {
                    const paeResponse = await fetch(paeUrl);
                    if (paeResponse.ok) {
                        const paeJson = await paeResponse.json();
                        paeData = extractPaeFromJSON(paeJson);
                    } else {
                        console.warn(`PAE data not found (HTTP ${paeResponse.status}).`);
                    }
                } catch (e) {
                    console.warn("Could not fetch PAE data:", e.message);
                }
            }

            const framesAdded = processStructureToTempBatch(structText, name, paeData, cleanObjectName(name), tempBatch);
            batchedObjects.push(...tempBatch);
            updateViewerFromGlobalBatch();
            setStatus(`Successfully fetched and loaded ${tempBatch.length} object(s) (${framesAdded} total frame${framesAdded !== 1 ? 's' : ''}).`);

        } catch (e) {
            console.error("Fetch failed:", e);
            setStatus(`Error: Fetch failed for ${fetchId}. ${e.message}.`, true);
        }
    }

    // --- Batch processing / uploads ---

    async function processFiles(files, loadAsFrames, groupName = null) {
        const tempBatch = [];
        let overallTotalFramesAdded = 0;
        let paePairedCount = 0;

        const structureFiles = [];
        const jsonFiles = [];

        for (const file of files) {
            const nameLower = file.name.toLowerCase();
            if (file.name.startsWith('__MACOSX/') || file.name.startsWith('._')) continue;
            if (nameLower.match(/\.(cif|pdb|ent)$/)) structureFiles.push(file);
            else if (nameLower.endsWith('.json')) jsonFiles.push(file);
        }

        if (structureFiles.length === 0) throw new Error(`No structural files (*.cif, *.pdb, *.ent) found.`);

        const jsonContentsMap = new Map();
        const jsonLoadPromises = jsonFiles.map(jsonFile => new Promise(async (resolve) => {
            try {
                const jsonText = await jsonFile.readAsync("text");
                const jsonObject = JSON.parse(jsonText);
                const jsonBaseName = jsonFile.name.replace(/\.json$/i, '');
                jsonContentsMap.set(jsonBaseName, jsonObject);
            } catch (e) {
                console.warn(`Failed to parse JSON file ${jsonFile.name}:`, e);
            }
            resolve();
        }));

        function extractPaeFromJSON(paeJson) {
            if (!paeJson) return null;
            if (paeJson.pae && Array.isArray(paeJson.pae)) return paeJson.pae;
            if (paeJson.predicted_aligned_error && Array.isArray(paeJson.predicted_aligned_error)) return paeJson.predicted_aligned_error;
            if (Array.isArray(paeJson) && paeJson.length > 0 && paeJson[0].predicted_aligned_error) return paeJson[0].predicted_aligned_error;
            return null;
        }

        function getBestJsonMatch(structBaseName, jsonMap) {
            let bestMatch = null;
            let bestScore = 0;

            const partsA = structBaseName.split(/[-_]/);

            for (const [jsonBaseName, paeJson] of jsonMap.entries()) {
                const partsB = jsonBaseName.split(/[-_]/);
                let score = 0;
                while(score < partsA.length && score < partsB.length && partsA[score] === partsB[score]) score++;

                const nameHintScore = (jsonBaseName.includes("pae") || jsonBaseName.includes("full_data") || jsonBaseName.includes("scores") || jsonBaseName.includes("aligned_error")) ? 1 : 0;

                const structModelMatch = structBaseName.match(/_model_(\d+)$/i);
                const structModelNum = structModelMatch ? structModelMatch[1] : null;

                let modelNumBonus = 0;
                if (structModelNum !== null) {
                    const jsonModelMatch = jsonBaseName.match(/_(?:full_data|data|model|pae)_(\d+)$/i);
                    if (jsonModelMatch && jsonModelMatch[1] === structModelNum) modelNumBonus = 100;
                }

                const structRankMatch = structBaseName.match(/_rank_(\d+)_/i);
                const jsonRankMatch = jsonBaseName.match(/_rank_(\d+)_/i);

                let rankBonus = 0;
                if (structRankMatch && jsonRankMatch && structRankMatch[1] === jsonRankMatch[1]) {
                    rankBonus = 100;
                    const structInternalModel = structBaseName.match(/_model_(\d+)_/i);
                    const jsonInternalModel = jsonBaseName.match(/_model_(\d+)_/i);
                    if (structInternalModel && jsonInternalModel && structInternalModel[1] === jsonInternalModel[1]) rankBonus += 50;
                    const structSeed = structBaseName.match(/_seed_(\d+)/i);
                    const jsonSeed = jsonBaseName.match(/_seed_(\d+)/i);
                    if (structSeed && jsonSeed && structSeed[1] === jsonSeed[1]) rankBonus += 25;
                }

                const finalScore = score + nameHintScore + modelNumBonus + rankBonus;

                if (finalScore > bestScore) {
                    const paeMatrix = extractPaeFromJSON(paeJson);
                    if (paeMatrix) { bestScore = finalScore; bestMatch = paeJson; }
                }
            }
            return bestScore > 0 ? bestMatch : null;
        }

        await Promise.all(jsonLoadPromises);

        for (const structFile of structureFiles) {
            let paeData = null;
            const structBaseName = structFile.name.replace(/\.(cif|pdb|ent)$/i, '');
            const bestMatchJson = getBestJsonMatch(structBaseName, jsonContentsMap);
            if (bestMatchJson) {
                paeData = extractPaeFromJSON(bestMatchJson);
                if (paeData) paePairedCount++;
            }

            const text = await structFile.readAsync("text");

            const trajectoryObjectName = loadAsFrames && structureFiles.length > 1
                ? (groupName || cleanObjectName(structureFiles[0].name))
                : structBaseName;

            const framesAdded = processStructureToTempBatch(text, structFile.name, paeData, trajectoryObjectName, tempBatch);
            overallTotalFramesAdded += framesAdded;
        }

        if (tempBatch.length > 0) batchedObjects.push(...tempBatch);

        updateViewerFromGlobalBatch();

        return {
            objectsLoaded: tempBatch.length,
            framesAdded: overallTotalFramesAdded,
            paePairedCount,
            structureCount: structureFiles.length,
            isTrajectory: loadAsFrames && structureFiles.length > 1
        };
    }

    async function handleZipUpload(file, loadAsFrames) {
        setStatus(`Unzipping ${file.name} and collecting data...`);
        try {
            const zip = new JSZip();
            const content = await zip.loadAsync(file);

            const fileList = [];
            content.forEach((relativePath, zipEntry) => {
                if (relativePath.startsWith('__MACOSX/') || relativePath.startsWith('._') || zipEntry.dir) return;
                fileList.push({ name: relativePath, readAsync: (type) => zipEntry.async(type) });
            });

            const stats = await processFiles(fileList, loadAsFrames, cleanObjectName(file.name));

            const objectsLoaded = stats.isTrajectory ? 1 : stats.objectsLoaded;
            const paeMessage = stats.paePairedCount > 0 ? ` (${stats.paePairedCount}/${stats.structureCount} PAE matrices paired)` : '';

            setStatus(`Successfully loaded ${objectsLoaded} new object(s) from ${file.name} (${stats.framesAdded} total frame${stats.framesAdded !== 1 ? 's' : ''}${paeMessage}).`);
        } catch (e) {
            console.error("ZIP processing failed:", e);
            setStatus(`Error processing ZIP file: ${file.name}. ${e.message}`, true);
        }
    }

    function handleFileUpload(event) {
        const files = event.target.files || (event.dataTransfer ? event.dataTransfer.files : null);
        if (!files || files.length === 0) return;

        const loadAsFrames = loadAsFramesCheckbox.checked;

        const zipFiles = [];
        const looseFiles = [];

        for (const file of files) {
            if (file.name.toLowerCase().endsWith('.zip')) zipFiles.push(file);
            else looseFiles.push({ name: file.name, readAsync: (type) => file.text() });
        }

        setStatus(`Processing ${files.length} selected files...`);

        if (zipFiles.length > 0) {
            handleZipUpload(zipFiles[0], loadAsFrames);
            if (zipFiles.length > 1) {
                setStatus(`Loaded ${zipFiles[0].name}. Please upload one ZIP at a time.`, true);
            }
            return;
        }

        (async () => {
            if (looseFiles.length > 0) {
                try {
                    const stats = await processFiles(looseFiles, loadAsFrames);
                    const objectsLoaded = stats.isTrajectory ? 1 : stats.objectsLoaded;
                    const sourceName = looseFiles.length > 1 ? `${looseFiles.length} files` : looseFiles[0].name;
                    const paeMessage = stats.paePairedCount > 0 ? ` (${stats.paePairedCount}/${stats.structureCount} PAE matrices paired)` : '';
                    setStatus(`Successfully loaded ${objectsLoaded} new object(s) from ${sourceName} (${stats.framesAdded} total frame${stats.framesAdded !== 1 ? 's' : ''}${paeMessage}).`);
                } catch (e) {
                    console.error("Loose file processing failed:", e);
                    setStatus(`Error processing loose files: ${e.message}`, true);
                }
            }
        })();
    }

    function updateColorMode() { /* placeholder for future use */ }

    function handleObjectChange() {
         const selectedObject = objectSelect.value;
         if (!selectedObject) return;
         const hasPAE = objectsWithPAE.has(selectedObject);
         paeContainer.style.display = hasPAE ? 'block' : 'none';
         updateColorMode();
    }

    // --- Init ---

    function initDragAndDrop() {
        const dropArea = document.getElementById('drop-area');

        uploadButton.addEventListener('click', () => fileUploadInput.click());
        fileUploadInput.addEventListener('change', handleFileUpload);

        let dragCounter = 0;

        document.body.addEventListener('dragenter', (e) => {
            preventDefaults(e);
            if (dragCounter === 0) globalDropOverlay.style.display = 'flex';
            dragCounter++;
        }, false);

        document.body.addEventListener('dragleave', (e) => {
            preventDefaults(e);
            dragCounter--;
            if (dragCounter === 0 || e.relatedTarget === null) globalDropOverlay.style.display = 'none';
        }, false);

        document.body.addEventListener('drop', (e) => {
            preventDefaults(e);
            dragCounter = 0;
            globalDropOverlay.style.display = 'none';
            const dt = e.dataTransfer;
            if (dt.files.length > 0) handleFileUpload({ target: { files: dt.files } });
        }, false);

        document.body.addEventListener('dragover', preventDefaults, false);
    }

    function preventDefaults (e) {
      e.preventDefault();
      e.stopPropagation();
    }

    function initApp() {
        console.log("DOM is ready. Initializing app...");

        window.viewerConfig = {
            size: [FIXED_WIDTH, FIXED_HEIGHT],
            pae_size: [PAE_PLOT_SIZE, PAE_PLOT_SIZE],
            color: "auto", shadow: true, outline: true, width: 3.0,
            rotate: false, controls: true, autoplay: false, box: true,
            pastel: 0.25, pae: true, colorblind: false, viewer_id: "standalone-viewer-1",
            // when true, load first biological assembly (BU1)
            biounit: true,
            // ignore non-polymer ligands/ions (HETATM)
            ignoreLigands: true
        };

        canvasContainer.style.width = `${FIXED_WIDTH}px`;
        canvasContainer.style.height = `${FIXED_HEIGHT}px`;
        canvas.width = FIXED_WIDTH;
        canvas.height = FIXED_HEIGHT;
        viewerColumn.style.minWidth = `${FIXED_WIDTH}px`;

        try {
            initializePy2DmolViewer(viewerContainer);
        } catch (e) {
            console.error("Failed to initialize viewer:", e);
            setStatus("Error: Failed to initialize viewer. See console.", true);
            return;
        }

        viewerApi = window.py2dmol_viewers[window.viewerConfig.viewer_id];

        document.getElementById('fetch-btn').addEventListener('click', handleFetch);

        const orientButton = document.getElementById('orientButton');
        if (orientButton) orientButton.addEventListener('click', applyBestViewRotation);

        const prevObjectButton = document.getElementById('prevObjectButton');
        if (prevObjectButton) prevObjectButton.addEventListener('click', gotoPreviousObject);

        const nextObjectButton = document.getElementById('nextObjectButton');
        if (nextObjectButton) nextObjectButton.addEventListener('click', gotoNextObject);

        updateObjectNavigationButtons();

        objectSelect.addEventListener('change', handleObjectChange);
        colorSelect.addEventListener('change', updateColorMode);

        initDragAndDrop();

        paeContainer.style.display = 'none';
        setStatus("Ready. Upload a file or fetch an ID.");
    }

    const rendererScript = document.getElementById('py2dmol-renderer');
    if (rendererScript && typeof initializePy2DmolViewer === 'function') {
        initApp();
    } else if (rendererScript) {
         rendererScript.onload = initApp;
    }

});