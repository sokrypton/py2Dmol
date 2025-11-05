// ============================================================================
// UTILS.JS - Pure utility functions (parsing, alignment, best-view)
// ============================================================================

// ============================================================================
// KABSCH ALIGNMENT UTILITIES
// ============================================================================

/**
 * Calculate the mean (centroid) of a set of 3D coordinates
 * @param {Array<Array<number>>} coords - Array of [x, y, z] coordinates
 * @returns {Array<number>} - Mean [x, y, z]
 */
function calculateMean(coords) {
    let sum = [0, 0, 0];
    for (const c of coords) {
        sum[0] += c[0];
        sum[1] += c[1];
        sum[2] += c[2];
    }
    return [
        sum[0] / coords.length,
        sum[1] / coords.length,
        sum[2] / coords.length
    ];
}

/**
 * Perform Kabsch algorithm to find optimal rotation matrix
 * @param {Array<Array<number>>} A - Source coordinates (centered)
 * @param {Array<Array<number>>} B - Target coordinates (centered)
 * @returns {Array<Array<number>>} - 3x3 rotation matrix
 */
function kabsch(A, B) {
    const H = numeric.dot(numeric.transpose(A), B);
    const svd = numeric.svd(H);
    const U = svd.U;
    const V = svd.V;
    const Vt = numeric.transpose(V);
    let D = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const det = numeric.det(numeric.dot(U, Vt));
    if (det < 0) D[2][2] = -1;
    return numeric.dot(U, numeric.dot(D, Vt));
}

/**
 * Align structure A to structure B using Kabsch algorithm
 * @param {Array<Array<number>>} fullCoordsA - All coordinates of structure A
 * @param {Array<Array<number>>} alignCoordsA - Alignment subset of A
 * @param {Array<Array<number>>} alignCoordsB - Alignment subset of B
 * @returns {Array<Array<number>>} - Aligned coordinates of fullCoordsA
 */
function align_a_to_b(fullCoordsA, alignCoordsA, alignCoordsB) {
    const meanAlignA = calculateMean(alignCoordsA);
    const meanAlignB = calculateMean(alignCoordsB);
    
    const centAlignA = alignCoordsA.map(c => [
        c[0] - meanAlignA[0],
        c[1] - meanAlignA[1],
        c[2] - meanAlignA[2]
    ]);
    
    const centAlignB = alignCoordsB.map(c => [
        c[0] - meanAlignB[0],
        c[1] - meanAlignB[1],
        c[2] - meanAlignB[2]
    ]);
    
    const R = kabsch(centAlignA, centAlignB);
    
    const centFullA = fullCoordsA.map(c => [
        c[0] - meanAlignA[0],
        c[1] - meanAlignA[1],
        c[2] - meanAlignA[2]
    ]);
    
    const rotatedFullA = numeric.dot(centFullA, R);
    
    return rotatedFullA.map(c => [
        c[0] + meanAlignB[0],
        c[1] + meanAlignB[1],
        c[2] + meanAlignB[2]
    ]);
}

// ============================================================================
// BEST VIEW ROTATION UTILITIES
// ============================================================================

function mean3(coords) {
    const m = [0, 0, 0];
    for (const c of coords) {
        m[0] += c[0];
        m[1] += c[1];
        m[2] += c[2];
    }
    m[0] /= coords.length;
    m[1] /= coords.length;
    m[2] /= coords.length;
    return m;
}

function covarianceXXT(coords) {
    const mu = mean3(coords);
    const X = coords.map(c => [
        c[0] - mu[0],
        c[1] - mu[1],
        c[2] - mu[2]
    ]);
    return numeric.dot(numeric.transpose(X), X);
}

function ensureRightHand(V) {
    const det = numeric.det(V);
    if (det < 0) {
        V = V.map(r => [r[0], r[1], -r[2]]);
    }
    return V;
}

function multCols(V, s) {
    return [
        [V[0][0] * s[0], V[0][1] * s[1], V[0][2] * s[2]],
        [V[1][0] * s[0], V[1][1] * s[1], V[1][2] * s[2]],
        [V[2][0] * s[0], V[2][1] * s[1], V[2][2] * s[2]]
    ];
}

function trace(M) {
    return M[0][0] + M[1][1] + M[2][2];
}

function polar2x2_withScore(A) {
    const svd = numeric.svd(A);
    const U = [[svd.U[0][0], svd.U[0][1]], [svd.U[1][0], svd.U[1][1]]];
    const V = [[svd.V[0][0], svd.V[0][1]], [svd.V[1][0], svd.V[1][1]]];
    let R2 = numeric.dot(V, numeric.transpose(U));
    const det = R2[0][0] * R2[1][1] - R2[0][1] * R2[1][0];
    if (det < 0) {
        V[0][1] *= -1;
        V[1][1] *= -1;
        R2 = numeric.dot(V, numeric.transpose(U));
    }
    const nuclear = (svd.S[0] || 0) + (svd.S[1] || 0);
    return { R2, nuclear };
}

/**
 * Calculate best view rotation matrix (AUTO convention)
 * Locks z-axis to min-variance, allows x/y yaw to match current view
 * @param {Array<Array<number>>} coords - Structure coordinates
 * @param {Array<Array<number>>} currentRotation - Current rotation matrix
 * @returns {Array<Array<number>>} - Target rotation matrix
 */
function bestViewTargetRotation_relaxed_AUTO(coords, currentRotation) {
    const H = covarianceXXT(coords);
    const svd = numeric.svd(H);
    let V = [
        [svd.V[0][0], svd.V[0][1], svd.V[0][2]],
        [svd.V[1][0], svd.V[1][1], svd.V[1][2]],
        [svd.V[2][0], svd.V[2][1], svd.V[2][2]]
    ];
    V = ensureRightHand(V);

    const signCombos = [
        [1, 1, 1],
        [1, -1, -1],
        [-1, 1, -1],
        [-1, -1, 1]
    ];

    const Rcur = currentRotation;
    const RcurT = numeric.transpose(currentRotation);
    const candidates = [];

    for (const s of signCombos) {
        const VS = multCols(V, s);

        // POST-YAW: R = VS * Qz
        {
            const M = numeric.dot(RcurT, VS);
            const A = [[M[0][0], M[0][1]], [M[1][0], M[1][1]]];
            const { R2 } = polar2x2_withScore(A);
            const Qa = [
                [R2[0][0], R2[0][1], 0],
                [R2[1][0], R2[1][1], 0],
                [0, 0, 1]
            ];
            const Ra = numeric.dot(VS, Qa);
            const angleA = rotationAngleBetweenMatrices(Rcur, Ra);
            candidates.push({ R: Ra, angle: angleA, mode: 'post' });
        }

        // PRE-YAW: R = Qz * VS
        {
            const B = numeric.dot(VS, RcurT);
            const B2 = [[B[0][0], B[0][1]], [B[1][0], B[1][1]]];
            const { R2 } = polar2x2_withScore(B2);
            const Qb = [
                [R2[0][0], R2[0][1], 0],
                [R2[1][0], R2[1][1], 0],
                [0, 0, 1]
            ];
            const Rb = numeric.dot(Qb, VS);
            const angleB = rotationAngleBetweenMatrices(Rcur, Rb);
            candidates.push({ R: Rb, angle: angleB, mode: 'pre' });
        }
    }

    candidates.sort((a, b) => a.angle - b.angle);
    return candidates[0].R;
}

/**
 * Calculate angle between two rotation matrices
 * @param {Array<Array<number>>} M1 - First rotation matrix
 * @param {Array<Array<number>>} M2 - Second rotation matrix
 * @returns {number} - Angle in radians
 */
function rotationAngleBetweenMatrices(M1, M2) {
    const M1T = numeric.transpose(M1);
    const R = numeric.dot(M1T, M2);
    const tr = R[0][0] + R[1][1] + R[2][2];
    const cosTheta = (tr - 1) / 2;
    const clamped = Math.max(-1, Math.min(1, cosTheta));
    return Math.acos(clamped);
}

/**
 * Linearly interpolate between two rotation matrices with orthonormalization
 * @param {Array<Array<number>>} M1 - Start rotation matrix
 * @param {Array<Array<number>>} M2 - End rotation matrix
 * @param {number} t - Interpolation parameter (0 to 1)
 * @returns {Array<Array<number>>} - Interpolated rotation matrix
 */
function lerpRotationMatrix(M1, M2, t) {
    const result = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            result[i][j] = M1[i][j] * (1 - t) + M2[i][j] * t;
        }
    }
    
    // Gram-Schmidt orthonormalization
    let c0 = [result[0][0], result[1][0], result[2][0]];
    let n0 = Math.hypot(c0[0], c0[1], c0[2]);
    c0 = [c0[0] / n0, c0[1] / n0, c0[2] / n0];
    
    let c1 = [result[0][1], result[1][1], result[2][1]];
    let dot01 = c0[0] * c1[0] + c0[1] * c1[1] + c0[2] * c1[2];
    c1 = [c1[0] - dot01 * c0[0], c1[1] - dot01 * c0[1], c1[2] - dot01 * c0[2]];
    let n1 = Math.hypot(c1[0], c1[1], c1[2]);
    c1 = [c1[0] / n1, c1[1] / n1, c1[2] / n1];
    
    let c2 = [
        c0[1] * c1[2] - c0[2] * c1[1],
        c0[2] * c1[0] - c0[0] * c1[2],
        c0[0] * c1[1] - c0[1] * c1[0]
    ];
    
    return [
        [c0[0], c1[0], c2[0]],
        [c0[1], c1[1], c2[1]],
        [c0[2], c1[2], c2[2]]
    ];
}

// ============================================================================
// PDB/CIF PARSING UTILITIES
// ============================================================================

/**
 * Parse PDB file into models
 * @param {string} text - PDB file content
 * @returns {Array<Array<object>>} - Array of models, each containing atoms
 */
function parsePDB(text) {
    const models = [];
    let currentModelAtoms = [];
    const lines = text.split('\n');
    
    for (const line of lines) {
        if (line.startsWith('MODEL')) {
            if (currentModelAtoms.length > 0) {
                models.push(currentModelAtoms);
            }
            currentModelAtoms = [];
        }
        
        if (line.startsWith('ATOM') || line.startsWith('HETATM')) {
            currentModelAtoms.push({
                record: line.substring(0, 6).trim(),
                atomName: line.substring(12, 16).trim(),
                resName: line.substring(17, 20).trim(),
                chain: line.substring(21, 22).trim(),
                resSeq: parseInt(line.substring(22, 26)),
                x: parseFloat(line.substring(30, 38)),
                y: parseFloat(line.substring(38, 46)),
                z: parseFloat(line.substring(46, 54)),
                b: parseFloat(line.substring(60, 66)),
                element: line.substring(76, 78).trim(),
                res_name: line.substring(17, 20).trim(),
                res_seq: parseInt(line.substring(22, 26))
            });
        }
        
        if (line.startsWith('ENDMDL')) {
            if (currentModelAtoms.length > 0) {
                models.push(currentModelAtoms);
                currentModelAtoms = [];
            }
        }
    }
    
    if (currentModelAtoms.length > 0) {
        models.push(currentModelAtoms);
    }
    
    if (models.length === 0 && currentModelAtoms.length > 0) {
        models.push(currentModelAtoms);
    }
    
    return models;
}

/**
 * Parse CIF (mmCIF) file into models
 * @param {string} text - CIF file content
 * @returns {Array<Array<object>>} - Array of models, each containing atoms
 */
function parseCIF(text) {
    const modelMap = new Map();
    const lines = text.split('\n');
    let atomSiteLoop = false;
    const headers = [];
    const headerMap = {};
    let modelIDKey = null;
    let modelID = 1;

    // Find headers
    for (const line of lines) {
        if (line.startsWith('_atom_site.')) {
            const header = line.trim();
            headerMap[header] = headers.length;
            headers.push(header);
            if (header.includes('model_no') || header.includes('pdbx_PDB_model_num')) {
                modelIDKey = header;
            }
        } else if (headers.length > 0 && (line.startsWith('loop_') || line.startsWith('#'))) {
            break;
        }
    }

    // Parse data
    for (const line of lines) {
        if (line.startsWith('_atom_site.')) {
            atomSiteLoop = true;
        } else if (atomSiteLoop && line.startsWith('#')) {
            atomSiteLoop = false;
        } else if (atomSiteLoop && !line.startsWith(';')) {
            const values = line.match(/(?:[^\s"']+|"([^"]*)"|'([^']*)')+/g);
            if (!values || values.length < headers.length) continue;

            const getString = (key) => values[headerMap[key]];
            const getFloat = (key) => parseFloat(values[headerMap[key]]);
            const getInt = (key) => parseInt(values[headerMap[key]]);

            const atomNameRaw = getString('_atom_site.label_atom_id');
            let atomName = atomNameRaw;
            if (atomName && atomName.length > 1 && atomName.startsWith("'") && atomName.endsWith("'")) {
                atomName = atomName.substring(1, atomName.length - 1);
            } else if (atomName && atomName.length > 1 && atomName.startsWith('"') && atomName.endsWith('"')) {
                atomName = atomName.substring(1, atomName.length - 1);
            }

            const atom = {
                record: getString('_atom_site.group_PDB'),
                atomName: atomName,
                resName: getString('_atom_site.label_comp_id'),
                chain: getString('_atom_site.auth_asym_id'),
                resSeq: getInt('_atom_site.auth_seq_id'),
                x: getFloat('_atom_site.Cartn_x'),
                y: getFloat('_atom_site.Cartn_y'),
                z: getFloat('_atom_site.Cartn_z'),
                b: getFloat('_atom_site.B_iso_or_equiv'),
                element: getString('_atom_site.type_symbol'),
                res_name: getString('_atom_site.label_comp_id'),
                res_seq: getInt('_atom_site.auth_seq_id')
            };

            if (modelIDKey) {
                modelID = getInt(modelIDKey);
            }

            if (!modelMap.has(modelID)) {
                modelMap.set(modelID, []);
            }
            modelMap.get(modelID).push(atom);
        }
    }

    return Array.from(modelMap.keys())
        .sort((a, b) => a - b)
        .map(id => modelMap.get(id));
}

/**
 * Convert parsed atoms to frame data format, omitting keys for data that is not present.
 * @param {Array<object>} atoms - Parsed atoms
 * @returns {object} - Frame data with coords, and optional plddts, chains, atom_types
 */
function convertParsedToFrameData(atoms) {
    const coords = [];
    const plddts = [];
    const atom_chains = [];
    const atom_types = [];
    const residues = [];
    const residue_index = [];
    const rna_bases = ['A', 'C', 'G', 'U', 'RA', 'RC', 'RG', 'RU'];
    const proteinResidues = new Set([
        "ALA", "ARG", "ASN", "ASP", "CYS", "GLU", "GLN", "GLY", "HIS", "ILE",
        "LEU", "LYS", "MET", "PHE", "PRO", "SER", "THR", "TRP", "TYR", "VAL"
    ]);
    const nucleicResidues = new Set([
        "A", "C", "G", "U", "T", "DA", "DC", "DG", "DT", "RA", "RC", "RG", "RU"
    ]);

    const residueMap = new Map();
    for (const atom of atoms) {
        if (atom.resName === 'HOH') continue;
        const resKey = `${atom.chain}:${atom.resSeq}:${atom.resName}`;
        if (!residueMap.has(resKey)) {
            residueMap.set(resKey, {
                atoms: [],
                resName: atom.resName,
                chain: atom.chain,
                record: atom.record,
                resSeq: atom.resSeq
            });
        }
        residueMap.get(resKey).atoms.push(atom);
    }

    for (const [, residue] of residueMap.entries()) {
        const is_protein = proteinResidues.has(residue.resName);
        const is_nucleic = nucleicResidues.has(residue.resName);

        if (is_protein) {
            const ca = residue.atoms.find(a => a.atomName === 'CA');
            if (ca) {
                coords.push([ca.x, ca.y, ca.z]);
                plddts.push(ca.b);
                atom_chains.push(ca.chain);
                atom_types.push('P');
                residues.push(ca.res_name);
                residue_index.push(ca.res_seq);
            }
        } else if (is_nucleic) {
            let c4_atom = residue.atoms.find(a => a.atomName === "C4'" || a.atomName === "C4*");
            if (c4_atom) {
                coords.push([c4_atom.x, c4_atom.y, c4_atom.z]);
                plddts.push(c4_atom.b);
                atom_chains.push(c4_atom.chain);
                atom_types.push(
                    rna_bases.includes(residue.resName) || residue.resName.startsWith('R') ? 'R' : 'D'
                );
                residues.push(c4_atom.res_name);
                residue_index.push(c4_atom.res_seq);
            }
        } else if (residue.record === 'HETATM') {
            for (const atom of residue.atoms) {
                if (atom.element !== 'H' && atom.element !== 'D') {
                    coords.push([atom.x, atom.y, atom.z]);
                    plddts.push(atom.b);
                    atom_chains.push(atom.chain);
                    atom_types.push('L');
                    residues.push(atom.res_name);
                    residue_index.push(atom.res_seq);
                }
            }
        }
    }

    const result = { coords };

    if (atom_types.length > 0) {
        result.atom_types = atom_types;
    }
    if (plddts.some(p => !isNaN(p))) {
        result.plddts = plddts;
    }
    if (atom_chains.some(c => c && c.trim())) {
        result.chains = atom_chains;
    }
    if (residues.some(r => r && r.trim())) {
        result.residues = residues;
    }
    if (residue_index.some(i => !isNaN(i))) {
        result.residue_index = residue_index;
    }
    
    return result;
}

/**
 * Extract PAE matrix from JSON object
 * @param {object} paeJson - PAE JSON data
 * @returns {Array<Array<number>>|null} - PAE matrix or null
 */
function extractPaeFromJSON(paeJson) {
    if (!paeJson) return null;
    if (paeJson.pae && Array.isArray(paeJson.pae)) return paeJson.pae;
    if (paeJson.predicted_aligned_error && Array.isArray(paeJson.predicted_aligned_error)) {
        return paeJson.predicted_aligned_error;
    }
    if (Array.isArray(paeJson) && paeJson.length > 0 && paeJson[0].predicted_aligned_error) {
        return paeJson[0].predicted_aligned_error;
    }
    console.warn("Could not find PAE matrix in JSON.");
    return null;
}

/**
 * Clean object name by removing file extensions
 * @param {string} name - Original name
 * @returns {string} - Cleaned name
 */
function cleanObjectName(name) {
    return name.replace(/\.(cif|pdb|ent|zip)$/i, '');
}

// ============================================================================
// BIOLOGICAL ASSEMBLY PARSING
// ============================================================================

// Lightweight CIF tokenizer
function tokenizeCIFLine_light(s) {
    const out = [];
    let i = 0;
    const n = s.length;
    
    while (i < n) {
        while (i < n && /\s/.test(s[i])) i++;
        if (i >= n) break;
        
        if (s[i] === "'") {
            let j = ++i;
            while (j < n && s[j] !== "'") j++;
            out.push(s.slice(i, j));
            i = Math.min(j + 1, n);
        } else if (s[i] === '"') {
            let j = ++i;
            while (j < n && s[j] !== '"') j++;
            out.push(s.slice(i, j));
            i = Math.min(j + 1, n);
        } else {
            let j = i;
            while (j < n && !/\s/.test(s[j])) j++;
            const tok = s.slice(i, j);
            out.push(tok === '.' || tok === '?' ? '' : tok);
            i = j;
        }
    }
    return out;
}

function parseMinimalCIF_light(text) {
    const lines = text.split(/\r?\n/);
    const loops = [];
    let i = 0;
    
    while (i < lines.length) {
        let L = lines[i].trim();
        if (!L || L[0] === '#') {
            i++;
            continue;
        }
        
        if (/^loop_/i.test(L)) {
            i++;
            const cols = [];
            const rows = [];
            
            while (i < lines.length && /^\s*_/.test(lines[i])) {
                cols.push(lines[i].trim());
                i++;
            }
            
            while (i < lines.length) {
                const raw = lines[i];
                if (!raw || /^\s*#/.test(raw) || /^\s*loop_/i.test(raw) ||
                    /^\s*data_/i.test(raw) || /^\s*_/.test(raw)) break;
                
                let vals = tokenizeCIFLine_light(raw);
                while (vals.length < cols.length && i + 1 < lines.length) {
                    const more = tokenizeCIFLine_light(lines[++i]);
                    vals = vals.concat(more);
                }
                
                if (vals.length >= cols.length) {
                    rows.push(vals.slice(0, cols.length));
                }
                i++;
            }
            loops.push([cols, rows]);
            continue;
        }
        i++;
    }
    return loops;
}

function expandOperExpr_light(expr) {
    if (!expr) return [];
    expr = expr.replace(/\s+/g, '');
    
    function splitTop(s, sep) {
        const out = [];
        let depth = 0;
        let last = 0;
        for (let i = 0; i < s.length; i++) {
            const c = s[i];
            if (c === '(') depth++;
            else if (c === ')') depth--;
            else if (depth === 0 && c === sep) {
                out.push(s.slice(last, i));
                last = i + 1;
            }
        }
        out.push(s.slice(last));
        return out.filter(Boolean);
    }
    
    const parts = splitTop(expr, ',');
    const seqs = [];
    
    for (const p of parts) {
        const groups = splitTop(p, 'x');
        let expanded = groups.map(term => {
            if (term.startsWith('(') && term.endsWith(')')) {
                term = term.slice(1, -1);
            }
            const m = term.match(/^(\d+)-(\d+)$/);
            if (/^\d+$/.test(term)) return [term];
            if (m) {
                const a = +m[1], b = +m[2];
                const out = [];
                const step = a <= b ? 1 : -1;
                for (let k = a; step > 0 ? k <= b : k >= b; k += step) {
                    out.push(String(k));
                }
                return out;
            }
            return term.split(',').filter(Boolean);
        });
        
        let acc = expanded[0].map(x => [x]);
        for (let i = 1; i < expanded.length; i++) {
            const next = [];
            for (const a of acc) {
                for (const x of expanded[i]) {
                    next.push(a.concat([x]));
                }
            }
            acc = next;
        }
        seqs.push(...acc);
    }
    return seqs;
}

function applyOp_light(atom, R, t) {
    return {
        ...atom,
        x: R[0] * atom.x + R[1] * atom.y + R[2] * atom.z + t[0],
        y: R[3] * atom.x + R[4] * atom.y + R[5] * atom.z + t[1],
        z: R[6] * atom.x + R[7] * atom.y + R[8] * atom.z + t[2]
    };
}

/**
 * Parse first biological assembly from PDB/CIF text
 * @param {string} text - Structure file content
 * @returns {object} - {atoms, meta}
 */
function parseFirstBioAssembly(text) {
    const isCIF = /^\s*data_/i.test(text) || /_atom_site\./i.test(text);
    return isCIF ? buildBioFromCIF(text) : buildBioFromPDB(text);
}

function buildBioFromPDB(text) {
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
            after.split(/[, ]+/)
                .map(s => s.replace(/[^A-Za-z0-9]/g, '').trim())
                .filter(Boolean)
                .forEach(c => chains.add(c));
            continue;
        }
        
        if (/REMARK 350\s+BIOMT[123]/.test(L)) {
            const rowChar = L.substring(18, 19);
            const rowNum = parseInt(rowChar, 10);
            const opIdx = parseInt(L.substring(19, 24), 10);
            if (!(rowNum >= 1 && rowNum <= 3) || isNaN(opIdx)) continue;
            
            const a1 = parseFloat(L.substring(23, 33));
            const a2 = parseFloat(L.substring(33, 43));
            const a3 = parseFloat(L.substring(43, 53));
            const t = parseFloat(L.substring(53, 68));
            if ([a1, a2, a3, t].some(v => Number.isNaN(v))) continue;
            
            const row = [a1, a2, a3, t];
            opRows[opIdx] = opRows[opIdx] || [null, null, null];
            opRows[opIdx][rowNum - 1] = row;
        }
    }
    
    const ops = [];
    Object.keys(opRows).forEach(k => {
        const r = opRows[k];
        if (r[0] && r[1] && r[2]) {
            const R = [
                r[0][0], r[0][1], r[0][2],
                r[1][0], r[1][1], r[1][2],
                r[2][0], r[2][1], r[2][2]
            ];
            const t = [r[0][3], r[1][3], r[2][3]];
            ops.push({ id: String(k), R, t });
        }
    });
    
    if (ops.length === 0) {
        return { atoms, meta: { source: 'pdb', assembly: 'asymmetric_unit' } };
    }
    
    if (chains.size === 0) {
        for (const a of atoms) {
            if (a.chain) chains.add(a.chain);
        }
    }
    
    const out = [];
    for (const op of ops) {
        for (const a of atoms) {
            if (!chains.size || chains.has(a.chain)) {
                const ax = applyOp_light(a, op.R, op.t);
                ax.chain = (op.id === '1') ?
                    String(a.chain || '') :
                    (String(a.chain || '') + '|' + op.id);
                out.push(ax);
            }
        }
    }
    
    return {
        atoms: out,
        meta: {
            source: 'pdb',
            assembly: String(targetBioId),
            ops: ops.length,
            chains: [...chains]
        }
    };
}

function buildBioFromCIF(text) {
    const loops = parseMinimalCIF_light(text);
    const getLoop = (name) => loops.find(([cols]) => cols.includes(name));

    // Atom table
    const atomL = loops.find(([cols]) => cols.some(c => c.startsWith('_atom_site.')));
    if (!atomL) return { atoms: [], meta: { source: 'mmcif', assembly: 'empty' } };

    const atomCols = atomL[0], atomRows = atomL[1];
    const acol = (n) => atomCols.indexOf(n);

    const ixX = acol('_atom_site.Cartn_x');
    const ixY = acol('_atom_site.Cartn_y');
    const ixZ = acol('_atom_site.Cartn_z');
    const ixEl = acol('_atom_site.type_symbol');
    const ixLA = acol('_atom_site.label_asym_id');
    const ixAA = acol('_atom_site.auth_asym_id');
    const ixRes = (acol('_atom_site.label_comp_id') >= 0 ?
        acol('_atom_site.label_comp_id') : acol('_atom_site.auth_comp_id'));
    const ixSeq = (acol('_atom_site.label_seq_id') >= 0 ?
        acol('_atom_site.label_seq_id') : acol('_atom_site.auth_seq_id'));
    const ixNm = acol('_atom_site.label_atom_id');
    const ixGrp = acol('_atom_site.group_PDB');
    const ixB = acol('_atom_site.B_iso_or_equiv');

    const baseAtoms = atomRows.map(r => ({
        record: r[ixGrp] || 'ATOM',
        atomName: r[ixNm] || '',
        resName: r[ixRes] || '',
        lchain: (ixLA >= 0 ? r[ixLA] : (ixAA >= 0 ? r[ixAA] : '')) || '',
        chain: (ixLA >= 0 ? r[ixLA] : (ixAA >= 0 ? r[ixAA] : '')) || '',
        authChain: (ixAA >= 0 ? r[ixAA] : ''),
        resSeq: r[ixSeq] ? parseInt(r[ixSeq], 10) : 0,
        x: parseFloat(r[ixX]),
        y: parseFloat(r[ixY]),
        z: parseFloat(r[ixZ]),
        b: ixB >= 0 ? (parseFloat(r[ixB]) || 0.0) : 0.0,
        element: (r[ixEl] || '').toUpperCase()
    }));

    // Assembly generator
    const asmL = getLoop('_pdbx_struct_assembly_gen.assembly_id');
    if (!asmL) {
        return { atoms: baseAtoms, meta: { source: 'mmcif', assembly: 'asymmetric_unit' } };
    }

    // Operator list
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
        if (Number.isFinite(R[0])) {
            opMap.set(id, { R, t });
        }
    }
    
    if (!operL || opMap.size === 0) {
        opMap.set('1', { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] });
    }

    // Choose assembly 1
    const a = (n) => asmL[0].indexOf(n);
    let candidates = asmL[1].filter(r =>
        (r[a('_pdbx_struct_assembly_gen.assembly_id')] || '') === '1');
    if (candidates.length === 0 && asmL[1].length > 0) {
        candidates = [asmL[1][0]];
    }
    if (candidates.length === 0) {
        return { atoms: baseAtoms, meta: { source: 'mmcif', assembly: 'asymmetric_unit' } };
    }

    // Assemble
    const out = [];
    const seen = new Set();
    for (const r of candidates) {
        const asymList = (r[a('_pdbx_struct_assembly_gen.asym_id_list')] ||
            r[a('_pdbx_struct_assembly_gen.oper_asym_id_list')] || '').toString();
        const asymIds = asymList.split(',').map(s => s.trim()).filter(Boolean);
        asymIds.forEach(c => seen.add(c));

        const expr = (r[a('_pdbx_struct_assembly_gen.oper_expression')] || '1').toString();
        const seqs = expandOperExpr_light(expr);
        const seqsUse = (seqs && seqs.length) ? seqs : [['1']];

        for (const seq of seqsUse) {
            const seqLabel = seq.join('x');
            let R = [1, 0, 0, 0, 1, 0, 0, 0, 1];
            let t = [0, 0, 0];
            
            for (const id of seq) {
                const op = opMap.get(id);
                if (!op) continue;
                t = [
                    op.R[0] * t[0] + op.R[1] * t[1] + op.R[2] * t[2] + op.t[0],
                    op.R[3] * t[0] + op.R[4] * t[1] + op.R[5] * t[2] + op.t[1],
                    op.R[6] * t[0] + op.R[7] * t[1] + op.R[8] * t[2] + op.t[2]
                ];
                R = [
                    op.R[0] * R[0] + op.R[1] * R[3] + op.R[2] * R[6],
                    op.R[0] * R[1] + op.R[1] * R[4] + op.R[2] * R[7],
                    op.R[0] * R[2] + op.R[1] * R[5] + op.R[2] * R[8],
                    op.R[3] * R[0] + op.R[4] * R[3] + op.R[5] * R[6],
                    op.R[3] * R[1] + op.R[4] * R[4] + op.R[5] * R[7],
                    op.R[3] * R[2] + op.R[4] * R[5] + op.R[5] * R[8],
                    op.R[6] * R[0] + op.R[7] * R[3] + op.R[8] * R[6],
                    op.R[6] * R[1] + op.R[7] * R[4] + op.R[8] * R[7],
                    op.R[6] * R[2] + op.R[7] * R[5] + op.R[8] * R[8]
                ];
            }
            
            for (const aAtom of baseAtoms) {
                if (!asymIds.includes(aAtom.lchain)) continue;
                const ax = applyOp_light(aAtom, R, t);
                ax.chain = (seqLabel === '1') ?
                    String(aAtom.lchain || aAtom.chain || '') :
                    (String(aAtom.lchain || aAtom.chain || '') + '|' + seqLabel);
                out.push(ax);
            }
        }
    }

    return {
        atoms: out,
        meta: {
            source: 'mmcif',
            assembly: '1',
            chains: [...seen]
        }
    };
}