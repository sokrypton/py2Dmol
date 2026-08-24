// ============================================================================
// src/io/parse.js
// ------------
// AI Context: TEXT TO A FRAME (parsePDB, parseCIF, convertParsedToFrameData)
// - PDB and mmCIF parsing, the residue and bond tables, side-chain capture,
//   ligand grouping, PAE extraction, and biological-assembly expansion.
// - No DOM and no dependencies: this is the half an embedded viewer needs, and
//   it calls nothing in src/io/math.js.
// ============================================================================
// ============================================================================
// PDB/CIF PARSING UTILITIES
// ============================================================================

/**
 * Parse PDB file into models and MODRES records
 * @param {string} text - PDB file content
 * @returns {object} - {models: Array<Array<object>>, modresMap: Map<string, string>}
 */
function parsePDB(text) {
    const models = [];
    let currentModelAtoms = [];
    const lines = text.split('\n');

    // Parse MODRES records: MODRES resName chainID resSeq stdResName comment
    // Columns: 12-15 (resName), 17 (chainID), 19-22 (resSeq), 25-27 (stdResName)
    const modresMap = new Map(); // resName -> stdResName

    // Parse CONECT records for explicit bonds
    const conectMap = new Map(); // atom serial -> [bonded atom serials]

    let atomCount = 0;
    let modresCount = 0;

    for (const line of lines) {
        if (line.startsWith('MODRES')) {
            // MODRES format: columns 12-15 (resName), 17 (chainID), 19-22 (resSeq), 25-27 (stdResName)
            const resName = line.substring(11, 15).trim();
            const stdResName = line.substring(24, 27).trim();
            if (resName && stdResName) {
                // Store mapping: modified residue name -> standard residue name
                modresMap.set(resName, stdResName);
                modresCount++;
            }
        }

        if (line.startsWith('CONECT')) {
            // CONECT format: serial (columns 6-11), bonded atoms (columns 12-16, 17-21, 22-26, 27-31, etc.)
            const serial = parseInt(line.substring(6, 11).trim());
            const bonded = [];
            for (let i = 0; i < 4; i++) {
                const startCol = 12 + (i * 5);
                const bondedSerial = parseInt(line.substring(startCol, startCol + 5).trim());
                if (!isNaN(bondedSerial)) {
                    bonded.push(bondedSerial);
                }
            }
            if (bonded.length > 0) {
                if (!conectMap.has(serial)) {
                    conectMap.set(serial, []);
                }
                conectMap.get(serial).push(...bonded);
            }
        }

        if (line.startsWith('MODEL')) {
            if (currentModelAtoms.length > 0) {
                models.push(currentModelAtoms);
            }
            currentModelAtoms = [];
        }

        if (line.startsWith('ATOM') || line.startsWith('HETATM')) {
            const serial = parseInt(line.substring(6, 11).trim());
            currentModelAtoms.push({
                record: line.substring(0, 6).trim(),
                serial: serial,
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
            atomCount++;
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

    return { models, modresMap, conectMap };
}

/**
 * Parse CIF (mmCIF) file into models
 * @param {string} text - CIF file content
 * @returns {Array<Array<object>>} - Array of models, each containing atoms
 */
// The only loops any consumer of parseCIF's `loops` looks at. Adding a reader
// for another one means naming it here; the symptom of forgetting is that loop
// arriving with no rows rather than absent, which is what `skipped` marks.
const CIF_LOOPS_READ = [
    '_struct_conn.',
    '_chem_comp.',
    '_chem_comp_bond.',
    '_pdbx_struct_assembly_gen.',
    '_pdbx_struct_oper_list.',
];

// PARSING, IN SLICES YOU CAN STOP BETWEEN.
//
// The body below is a generator so the same code can be drained two ways: all
// at once by parseCIF, which is what the tests and any synchronous caller
// want, or a slice at a time by parseCIFAsync, which hands control back to the
// browser between slices so the tab stays alive and the progress line can move
// on something real - the cursor's position in the file, not a timer.
//
// It yields a number in [0,1]: how much of the text the atom walk has passed.
// A slice is a fixed number of BYTES rather than of rows, since that is what
// the fraction is measured in and what makes each slice take about the same
// time.
// HOW OFTEN THE BAR CAN MOVE, which is the same question as how much the
// smoothness costs. Every yield lets the browser produce a frame, and a frame
// on this page is not free. Measured end to end on a 242 MB capsid through the
// real fetch button, counting the DISTINCT values the bar actually showed at
// frame time:
//
//   3 MB slices, timer yield    47 steps   3,650 ms
//   12 MB slices, timer yield   34 steps   3,225 ms
//   8 MB slices, scheduler.yield 17 steps  3,125 ms
//
// 12 MB is a step roughly every 90 ms - plainly moving - for about 100 ms over
// the cheapest option that still yields at all.
const PARSE_SLICE_BYTES = 12 << 20;

function* parseCIFSteps(text) {

    // THE FIVE LOOPS ANYONE ACTUALLY READS.
    //
    // Three are read below - struct_conn for explicit bonds, chem_comp for
    // modified-residue detection, chem_comp_bond for ligand connectivity - and
    // two more by extractCIFBiounitOperations, which is handed these same loops
    // as `cachedLoops` rather than re-walking the file. Nothing else consumes
    // parseCIF's `loops` (cachedLoops in src/app/main.js is its only reader).
    const loops = parseMinimalCIF_light(text, CIF_LOOPS_READ);

    const getLoop = (name) => loops.find(([cols]) => cols.includes(name));

    // Parse _struct_conn for explicit bonds
    const structConn = [];
    const structConnL = getLoop('_struct_conn.id');
    if (structConnL) {
        const scCols = structConnL[0], scRows = structConnL[1];
        const ccol_ptnr1_label_asym_id = scCols.indexOf('_struct_conn.ptnr1_label_asym_id');
        const ccol_ptnr1_auth_asym_id = scCols.indexOf('_struct_conn.ptnr1_auth_asym_id');
        const ccol_ptnr1_label_seq_id = scCols.indexOf('_struct_conn.ptnr1_label_seq_id');
        const ccol_ptnr1_auth_seq_id = scCols.indexOf('_struct_conn.ptnr1_auth_seq_id');
        const ccol_ptnr1_label_atom_id = scCols.indexOf('_struct_conn.ptnr1_label_atom_id');

        const ccol_ptnr2_label_asym_id = scCols.indexOf('_struct_conn.ptnr2_label_asym_id');
        const ccol_ptnr2_auth_asym_id = scCols.indexOf('_struct_conn.ptnr2_auth_asym_id');
        const ccol_ptnr2_label_seq_id = scCols.indexOf('_struct_conn.ptnr2_label_seq_id');
        const ccol_ptnr2_auth_seq_id = scCols.indexOf('_struct_conn.ptnr2_auth_seq_id');
        const ccol_ptnr2_label_atom_id = scCols.indexOf('_struct_conn.ptnr2_label_atom_id');

        const ccol_conn_type_id = scCols.indexOf('_struct_conn.conn_type_id');

        // Prefer label IDs but fallback to auth IDs
        const getCol = (row, labelIdx, authIdx) => {
            if (labelIdx >= 0 && row[labelIdx] && row[labelIdx] !== '?' && row[labelIdx] !== '.') return row[labelIdx];
            if (authIdx >= 0 && row[authIdx] && row[authIdx] !== '?' && row[authIdx] !== '.') return row[authIdx];
            return null;
        };

        for (const row of scRows) {
            // COVALENT CONNECTIVITY ONLY - covale and disulf. Not hydrog,
            // and NOT metalc.
            //
            // A metal coordination record is not a bond and drawing it as one
            // invents rings. 7P1E declares Ca 506 coordinated by both
            // carboxylate oxygens of the ligand K99, at 2.46 and 2.53 A; drawn
            // as sticks, those two plus the carboxylate's own C1-O1A and
            // C1-O1B close a four-membered ring that reads as a solid triangle
            // hanging off the sugar. Nothing is wrong with the ligand and
            // nothing is wrong with the distances - a chelating carboxylate
            // simply is that shape, and it should not be drawn as covalent.
            //
            // It was also only ever half-drawn. Four of that file's seven
            // metalc records name PROTEIN atoms (ASP OD1, ASN OD1, GLY O), and
            // a protein residue contributes one position - its CA - so those
            // ends resolve to nothing and the bond silently does not appear.
            // Only metal-to-LIGAND coordination ever showed, which is a rule
            // nobody chose.
            //
            // Bringing it back means drawing it as coordination - a dashed or
            // thin line, on its own layer - not as another stick.
            const type = ccol_conn_type_id >= 0 ? row[ccol_conn_type_id] : 'covale';
            if (type && (type === 'covale' || type === 'disulf')) {
                const chain1 = getCol(row, ccol_ptnr1_label_asym_id, ccol_ptnr1_auth_asym_id);
                const seq1 = getCol(row, ccol_ptnr1_label_seq_id, ccol_ptnr1_auth_seq_id);
                const atom1 = row[ccol_ptnr1_label_atom_id];

                const chain2 = getCol(row, ccol_ptnr2_label_asym_id, ccol_ptnr2_auth_asym_id);
                const seq2 = getCol(row, ccol_ptnr2_label_seq_id, ccol_ptnr2_auth_seq_id);
                const atom2 = row[ccol_ptnr2_label_atom_id];

                if (chain1 && atom1 && chain2 && atom2) {
                    structConn.push({
                        chain1, seq1: parseInt(seq1), atom1,
                        chain2, seq2: parseInt(seq2), atom2,
                        type
                    });
                }
            }
        }
    }

    // Parse _chem_comp_bond for component-level explicit bonds
    const chemCompBondMap = new Map(); // compId -> [{atom1, atom2, order}]
    const chemCompBondL = getLoop('_chem_comp_bond.comp_id');
    if (chemCompBondL) {
        const ccbCols = chemCompBondL[0], ccbRows = chemCompBondL[1];
        const ccol_comp_id = ccbCols.indexOf('_chem_comp_bond.comp_id');
        const ccol_atom_id_1 = ccbCols.indexOf('_chem_comp_bond.atom_id_1');
        const ccol_atom_id_2 = ccbCols.indexOf('_chem_comp_bond.atom_id_2');
        const ccol_value_order = ccbCols.indexOf('_chem_comp_bond.value_order');
        const ccol_pdbx_value_order = ccbCols.indexOf('_chem_comp_bond.pdbx_value_order');

        for (const row of ccbRows) {
            const compId = row[ccol_comp_id];
            const atom1 = row[ccol_atom_id_1];
            const atom2 = row[ccol_atom_id_2];

            // Get order, preferring pdbx_value_order if available
            let orderStr = (ccol_pdbx_value_order >= 0 && row[ccol_pdbx_value_order] && row[ccol_pdbx_value_order] !== '?')
                ? row[ccol_pdbx_value_order]
                : (ccol_value_order >= 0 ? row[ccol_value_order] : 'SING');

            if (compId && atom1 && atom2) {
                if (!chemCompBondMap.has(compId)) {
                    chemCompBondMap.set(compId, []);
                }

                // Normalize order string to integer if possible, or keep as string for renderer to handle
                // core/mol.js usually expects 1, 2, 3 or 'aromatic'
                let order = 1;
                const orderUpper = String(orderStr).toUpperCase();
                if (orderUpper.includes('DOUB')) order = 2;
                else if (orderUpper.includes('TRIP')) order = 3;
                else if (orderUpper.includes('AROM')) order = 1; // Treat aromatic as single for now, or handle specifically

                chemCompBondMap.get(compId).push({
                    atom1,
                    atom2,
                    order
                });
            }
        }
    }

    const chemCompMap = new Map();
    const chemCompL = getLoop('_chem_comp.id');
    if (chemCompL) {
        const chemCompCols = chemCompL[0], chemCompRows = chemCompL[1];
        const ccol_id = chemCompCols.indexOf('_chem_comp.id');
        const ccol_type = chemCompCols.indexOf('_chem_comp.type');
        const ccol_mon_nstd = chemCompCols.indexOf('_chem_comp.mon_nstd_flag');

        if (ccol_id >= 0 && ccol_type >= 0) {
            for (const row of chemCompRows) {
                const resName = row[ccol_id]?.trim();
                const type = row[ccol_type]?.trim();
                const mon_nstd = ccol_mon_nstd >= 0 ? row[ccol_mon_nstd]?.trim() : null;

                if (resName && type) {
                    // Map residue type: 'RNA linking' -> 'R', 'DNA linking' -> 'D', 'L-peptide linking' -> 'P'
                    let mappedType = null;
                    if (type.includes('RNA linking')) {
                        mappedType = 'R';
                    } else if (type.includes('DNA linking')) {
                        mappedType = 'D';
                    } else if (type.includes('peptide linking') || type.includes('L-peptide linking')) {
                        mappedType = 'P';
                    }

                    const isModified = mon_nstd === 'n' || mon_nstd === 'y' || mon_nstd === 'Y';
                    chemCompMap.set(resName, { type: mappedType, isModified, originalType: type });
                }
            }
        }
    }

    const modelMap = new Map();
    const lines = text.split('\n');

    let atomSiteLoop = false;
    const headers = [];
    const headerMap = {};
    let modelIDKey = null;
    let modelID = 1;
    let atomCount = 0;

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

    // Pre-compute header indices once to avoid repeated map lookups
    // Use label_asym_id consistently (required for biounit operations per mmCIF spec)
    const idxRecord = headerMap['_atom_site.group_PDB'];
    const idxAtomName = headerMap['_atom_site.label_atom_id'];
    const idxResName = headerMap['_atom_site.label_comp_id'];
    const idxChain = headerMap['_atom_site.label_asym_id'] >= 0
        ? headerMap['_atom_site.label_asym_id']
        : headerMap['_atom_site.auth_asym_id']; // Fallback only if label_asym_id not present
    // Prefer label_seq_id (PDB numbering) over auth_seq_id (author numbering) for SIFTS mapping
    const idxResSeq = (headerMap['_atom_site.label_seq_id'] >= 0)
        ? headerMap['_atom_site.label_seq_id']
        : headerMap['_atom_site.auth_seq_id'];
    const idxX = headerMap['_atom_site.Cartn_x'];
    const idxY = headerMap['_atom_site.Cartn_y'];
    const idxZ = headerMap['_atom_site.Cartn_z'];
    const idxB = headerMap['_atom_site.B_iso_or_equiv'];
    const idxElement = headerMap['_atom_site.type_symbol'];
    const idxModelID = modelIDKey ? headerMap[modelIDKey] : -1;

    // Parse data - optimized for performance
    // A row only has to reach the columns we actually read. Requiring the full
    // declared header width dropped every short row, and integrative-model
    // files write ragged ones: 9a9o omits pdbx_PDB_model_num and ihm_model_id
    // on ~2000 of its 16740 atoms, all of them past the last column we need.
    const minReqLen = Math.max(idxX, idxY, idxZ, idxChain, idxResSeq, idxResName, idxAtomName) + 1;
    // ONLY THE COLUMNS THAT ARE READ. _atom_site has 21 of them in a PDB-issued
    // file and this loop looks at ten; tokenising the rest built 4.6 million
    // substrings on 4UG0 and dropped them all. The mask says which column
    // indices matter, and readCIFCols slices those and counts past the others.
    const wantIdx = [idxRecord, idxAtomName, idxResName, idxChain, idxResSeq,
        headerMap['_atom_site.auth_seq_id'], idxX, idxY, idxZ, idxB, idxElement, idxModelID];
    let maxWanted = -1;
    for (const w of wantIdx) if (w >= 0 && w > maxWanted) maxWanted = w;
    // A STANDARD RESIDUE'S N, C AND O ARE READ BY NOTHING, so they are never
    // built - and the scanner is told early enough that it can stop reading the
    // row at all (see readCIFCols). The condition is what makes it safe:
    //
    //   - isRealAminoAcid only falls back to looking for N/CA/C atoms for a
    //     residue NOT in STANDARD_AMINO_ACIDS. For a standard one it returns at
    //     the name test and never reads an atom. Dropping these unconditionally
    //     makes any unrecognised residue VANISH - measured, five renamed
    //     residues of 4HHB took it from 748 positions to 743.
    //   - buildSidechainTable already drops every backbone atom but CA.
    //   - only the CA of a standard residue reaches `coords`, so nothing
    //     addressed by atom index could resolve to one of these anyway.
    //
    // The cartoon rebuilding C, N and O from the C-alpha trace is a different
    // fact and does not license it: reconstruction says where a KNOWN residue's
    // backbone is; the classifier asks whether an unknown residue is one.
    const dropAfter = (idxAtomName >= 0 && idxResName >= 0)
        ? Math.max(idxAtomName, idxResName) + 1 : -1;
    //   - ...EXCEPT PROLINE'S N, which its side chain closes a ring through.
    //     Dropped with the rest, a proline draws as a three-atom arm hanging
    //     off the CA rather than as the pyrrolidine it is. One atom per
    //     proline, and prolines are about a twentieth of a structure.
    const dropTest = (out) => DROPPABLE_BACKBONE.has(out[idxAtomName])
        && STANDARD_AMINO_ACIDS.has(out[idxResName])
        && SIDECHAIN_KEEP_BACKBONE[out[idxResName]] !== out[idxAtomName];
    const wantMask = new Uint8Array(maxWanted + 1);
    for (const w of wantIdx) if (w >= 0) wantMask[w] = 1;
    // reused across rows; a column is only read when it is < nCols, and every
    // column below that count was written on this row, so nothing goes stale
    const values = [];
    let currentModelArray = null;

    // OVER THE TEXT ITSELF, NOT OVER `lines`.
    //
    // text.split('\n') hands back SLICED strings - views carrying a pointer to
    // the parent and an offset - and every character read through one pays that
    // indirection. Measured on 4UG0: scanning the same 21.9 million characters
    // costs 885 ms across the 218,776 line strings and 250 ms across the flat
    // text. Same characters, same test, 3.5x, purely because of how the string
    // is represented.
    //
    // So this walks `text` with a cursor and hands readCIFCols a RANGE. No line
    // is ever materialised: startsWith takes a position, and the row tests read
    // a character code straight out of the parent.
    const textLen = text.length;
    let sliceMark = PARSE_SLICE_BYTES;
    for (let pos = 0; pos < textLen; ) {
        if (pos >= sliceMark) {
            sliceMark = pos + PARSE_SLICE_BYTES;
            yield pos / textLen;
        }
        let eol = text.indexOf('\n', pos);
        if (eol < 0) eol = textLen;
        // a trailing \r belongs to the line ending, not to the last column
        const end = (eol > pos && text.charCodeAt(eol - 1) === 13) ? eol - 1 : eol;
        const lineLen = end - pos;
        const lineStart = pos;
        pos = eol + 1;

        // Check for atom_site header
        if (text.startsWith('_atom_site.', lineStart)) {
            atomSiteLoop = true;
            continue;
        }

        if (!atomSiteLoop) continue;

        // Fast check for comment or end marker
        if (lineLen > 0 && text.charCodeAt(lineStart) === 35 /* # */) {
            atomSiteLoop = false;
            continue;
        }

        // Skip semicolon lines
        if (lineLen > 0 && text.charCodeAt(lineStart) === 59 /* ; */) continue;

        const nCols = readCIFCols(text, lineStart, end, wantMask, values,
            dropAfter, dropTest);
        if (nCols === -1) continue;      // a standard residue's N, C or O
        if (nCols < minReqLen) continue;


        // Direct array access - much faster than function calls
        // Update modelID if needed
        if (idxModelID >= 0 && idxModelID < nCols) {
            const newModelID = +values[idxModelID] || modelID; // Unary + is faster than parseInt
            if (newModelID !== modelID) {
                modelID = newModelID;
                currentModelArray = modelMap.get(modelID);
                if (!currentModelArray) {
                    currentModelArray = [];
                    modelMap.set(modelID, currentModelArray);
                }
            }
        }

        // Ensure currentModelArray is initialized (for case when idxModelID < 0 or first atom)
        if (!currentModelArray) {
            currentModelArray = modelMap.get(modelID);
            if (!currentModelArray) {
                currentModelArray = [];
                modelMap.set(modelID, currentModelArray);
            }
        }

        // Create atom object with direct array access and optimized number parsing
        // Use unary + operator for numbers (faster than parseFloat/parseInt)
        const resNameVal = (idxResName >= 0 && idxResName < nCols) ? values[idxResName] : '';
        // Parse residue sequence number, handling missing values ("?") by falling back to auth_seq_id
        // Use label_seq_id (PDB numbering) for SIFTS mapping compatibility
        let resSeqVal = 0;
        if (idxResSeq >= 0 && idxResSeq < nCols) {
            const labelSeqStr = values[idxResSeq];
            // Check if label_seq_id is missing ("?" or empty), fall back to auth_seq_id
            if (labelSeqStr === '?' || labelSeqStr === '' || labelSeqStr === null || labelSeqStr === undefined) {
                const idxAuthSeq = headerMap['_atom_site.auth_seq_id'];
                if (idxAuthSeq >= 0 && idxAuthSeq < nCols) {
                    const authSeqStr = values[idxAuthSeq];
                    resSeqVal = (authSeqStr === '?' || authSeqStr === '' || authSeqStr === null) ? 0 : (+authSeqStr || 0);
                }
            } else {
                // Parse label_seq_id (can be a number string or "?")
                resSeqVal = (+labelSeqStr || 0);
            }
        }

        const atom = {
            record: (idxRecord >= 0 && idxRecord < nCols) ? values[idxRecord] : 'ATOM',
            atomName: (idxAtomName >= 0 && idxAtomName < nCols) ? values[idxAtomName] : '',
            resName: resNameVal,
            chain: (idxChain >= 0 && idxChain < nCols) ? values[idxChain] : '',
            resSeq: resSeqVal,
            x: (idxX >= 0 && idxX < nCols) ? (+values[idxX] || 0) : 0,
            y: (idxY >= 0 && idxY < nCols) ? (+values[idxY] || 0) : 0,
            z: (idxZ >= 0 && idxZ < nCols) ? (+values[idxZ] || 0) : 0,
            b: (idxB >= 0 && idxB < nCols) ? (+values[idxB] || 0) : 0,
            element: (idxElement >= 0 && idxElement < nCols) ? values[idxElement] : '',
            res_name: resNameVal, // Duplicate for compatibility
            res_seq: resSeqVal // Duplicate for compatibility
        };

        currentModelArray.push(atom);
        atomCount++;
    }


    const models = Array.from(modelMap.keys())
        .sort((a, b) => a - b)
        .map(id => modelMap.get(id));
    return { models, loops, chemCompMap, structConn, chemCompBondMap };
}

// Drained in one go. Nothing observes the slices, so this is exactly the old
// parseCIF.
function parseCIF(text) {
    const it = parseCIFSteps(text);
    let r = it.next();
    while (!r.done) r = it.next();
    return r.value;
}

// Hand the browser a turn, so the bar it was just told about can actually be
// painted before the next slice of work begins.
//
// A PLAIN TIMER, and the two cleverer options were both tried and rejected.
// Measured on a capsid, sampling the bar inside requestAnimationFrame - which
// is what the screen actually got, rather than what style.width was set to:
//
//   MessageChannel   the usual trick for dodging the ~4 ms timer clamp. A
//                    stream of postMessage tasks gets serviced ahead of both
//                    timers and rendering, so the load yields and the frame
//                    still never comes: the last 700 ms painted nothing and
//                    the bar's final visible value was 81%.
//   scheduler.yield  continues at high priority, which throttles rendering to
//                    about 18 fps however fine the slices are - 17 visible
//                    steps over the load.
//   setTimeout       36 fps, 37 visible steps. Costs the 4 ms clamp per yield,
//                    which is why the slices above are megabytes and not
//                    kilobytes: at 8 MB that is 30 yields, ~120 ms.
//
// The bar exists to be watched. The one that lets the browser draw wins.
function yieldToBrowser() {
    return new Promise((s) => setTimeout(s, 0));
}

// HOW OFTEN A LOAD LETS THE BROWSER IN. A yield is a setTimeout, which the
// browser clamps to about 4 ms whatever you ask for, so yielding is only free
// next to work that takes longer than that.
//
// It was yielded UNCONDITIONALLY: once per parse slice, once per convert slice,
// and twice per model in the loader. That is right for one huge structure,
// where a slice is 100 ms of work, and ruinous for a simulation, where a model
// is 0.1 ms: a 275-model trajectory paid about 30 ms of clamped timers PER
// MODEL and took 8.3 seconds to load 39 positions.
//
// So the rule is time, not steps: hand the frame back only when this load has
// been holding the thread for longer than a frame's worth. A capsid still
// yields on every slice; the trajectory yields a handful of times in total.
const YIELD_EVERY_MS = 25;
let _lastYieldAt = 0;
function yieldIfBusy() {
    const now = (typeof performance !== 'undefined' && performance.now)
        ? performance.now() : Date.now();
    if (now - _lastYieldAt < YIELD_EVERY_MS) return Promise.resolve();
    _lastYieldAt = now;
    return yieldToBrowser().then(() => {
        // ...measured from when the browser gave the thread BACK, or the time
        // spent waiting counts as time spent working
        _lastYieldAt = (typeof performance !== 'undefined' && performance.now)
            ? performance.now() : Date.now();
    });
}

// Drained a slice at a time, giving the browser a turn in between - see
// yieldIfBusy for how often that actually is. The steps used to carry the
// fraction of the file they had reached, for a percentage that no longer
// exists; the loader names the STEP it is on instead, so nothing reads them.
async function parseCIFAsync(text) {
    const it = parseCIFSteps(text);
    for (;;) {
        const r = it.next();
        if (r.done) return r.value;
        await yieldIfBusy();
    }
}

/**
 * Standard amino acid codes (20 standard)
 */
const STANDARD_AMINO_ACIDS = new Set([
    "ALA", "ARG", "ASN", "ASP", "CYS", "GLU", "GLN", "GLY", "HIS", "ILE",
    "LEU", "LYS", "MET", "PHE", "PRO", "SER", "THR", "TRP", "TYR", "VAL"
]);

/**
 * Standard nucleic acid codes
 * Includes standard RNA (A, C, G, U) and DNA (DA, DC, DG, DT, T) codes
 * Also includes alternative notation (RA, RC, RG, RU for RNA)
 */
const STANDARD_NUCLEIC_ACIDS = new Set([
    // RNA codes
    "A", "C", "G", "U",
    "RA", "RC", "RG", "RU",  // Alternative RNA notation
    // DNA codes
    "DA", "DC", "DG", "DT", "T",  // T is DNA-specific (thymine)
    // Additional common codes
    "I",   // Inosine (can be RNA or DNA, but more common in RNA)
    "DI"   // Deoxyinosine (DNA)
]);

// NUCLEOTIDE_LIGANDS set removed - no longer needed with simplified classification
// Ligands are now identified by not being connected to chains, not by name exclusion

/**
 * Check if a residue is connected to neighboring residues in the same chain
 * Uses the same distance cutoffs as core/mol.js for consistency
 * @param {object} residue - Residue object with resName, record, atoms, chain, resSeq
 * @param {Array} allResidues - Array of all residue objects (for finding neighbors)
 * @param {string} type - 'P' for protein, 'D' for DNA, 'R' for RNA
 * @returns {boolean} - True if residue is connected to at least one neighbor
 */
// WHERE THE NEIGHBOURS ARE, so nobody has to look through everything to find
// four of them.
//
// isResidueConnected wants the residues in the same chain whose number is
// within two of its own - at most four candidates - and used to find them by
// walking the whole residue list. That is fine when a handful of residues ask.
// 7Y7A asks 8,830 times of a list 309,602 long, twice over, which is billions
// of comparisons and a browser that never comes back. 3J3Q never showed it
// because a capsid is standard residues nearly all the way down, and standard
// residues answer without asking.
//
// The index is cached on the array itself. Both callers build the list, sort
// it and then only read it, so it cannot go stale underneath us; the length
// check catches the case where someone starts.
function residuesByChainSeq(allResidues) {
    const cached = allResidues.__neighborIndex;
    if (cached && cached.n === allResidues.length) return cached.map;
    const map = new Map();
    for (const r of allResidues) {
        if (!r) continue;
        const key = r.chain + '\u0000' + r.resSeq;
        const at = map.get(key);
        if (at) at.push(r); else map.set(key, [r]);
    }
    try {
        Object.defineProperty(allResidues, '__neighborIndex',
            { value: { n: allResidues.length, map }, configurable: true, writable: true });
    } catch (e) { /* frozen array: just pay for the rebuild */ }
    return map;
}

function isResidueConnected(residue, allResidues, type) {
    if (!residue || !residue.atoms || !allResidues) {
        return false;
    }

    // Distance cutoffs (from core/mol.js)
    const PROTEIN_CHAINBREAK = 5.0;  // CA-CA distance
    const NUCLEIC_CHAINBREAK = 7.5;  // C4'-C4' distance
    const cutoff = (type === 'P') ? PROTEIN_CHAINBREAK : NUCLEIC_CHAINBREAK;
    const cutoffSq = cutoff * cutoff;

    // Get backbone atom for distance calculation
    let backboneAtom = null;
    if (type === 'P') {
        backboneAtom = residue.atoms.find(a => a.atomName === 'CA');
    } else {
        backboneAtom = residue.atoms.find(a => a.atomName === "C4'" || a.atomName === "C4*");
    }

    if (!backboneAtom) {
        return false;  // No backbone atom found
    }

    const backbonePos = [backboneAtom.x, backboneAtom.y, backboneAtom.z];
    const residueNum = residue.resSeq;  // Use residue number directly
    const chain = residue.chain;

    // Neighbours in the same chain within +/-2 of this residue's number. Looked
    // up rather than searched for - see residuesByChainSeq. A number that is
    // not a whole one cannot be reached by stepping, so that case keeps the
    // original walk and the original answer.
    let candidates;
    if (Number.isInteger(residueNum)) {
        const index = residuesByChainSeq(allResidues);
        candidates = [];
        for (const d of [-2, -1, 1, 2]) {
            const at = index.get(chain + '\u0000' + (residueNum + d));
            if (at) for (const r of at) candidates.push(r);
        }
    } else {
        candidates = allResidues;
    }

    for (const neighbor of candidates) {
        if (!neighbor || neighbor.chain !== chain) continue;

        // Check if neighbor is within ±2 residue numbers
        const resSeqDiff = Math.abs(neighbor.resSeq - residueNum);
        if (resSeqDiff > 2 || resSeqDiff === 0) continue;  // Skip if too far or same residue

        // Get neighbor's backbone atom
        let neighborBackboneAtom = null;
        if (type === 'P') {
            neighborBackboneAtom = neighbor.atoms.find(a => a.atomName === 'CA');
        } else {
            neighborBackboneAtom = neighbor.atoms.find(a => a.atomName === "C4'" || a.atomName === "C4*");
        }

        if (!neighborBackboneAtom) continue;

        // Calculate squared distance
        const dx = neighborBackboneAtom.x - backbonePos[0];
        const dy = neighborBackboneAtom.y - backbonePos[1];
        const dz = neighborBackboneAtom.z - backbonePos[2];
        const distSq = dx * dx + dy * dy + dz * dz;

        if (distSq < cutoffSq) {
            return true;  // Found a connected neighbor
        }
    }

    return false;  // No connected neighbors found
}

/**
 * Check if a residue is a real amino acid (standard or modified)
 * Simplified: only canonical amino acids + common modifications (MSE, etc.) + MODRES/CIF-defined if connected
 * @param {object} residue - Residue object with resName, record, atoms
 * @param {Map} modresMap - MODRES mapping (from PDB)
 * @param {Map} chemCompMap - Chemical component map (from CIF)
 * @param {Array} allResidues - Array of all residue objects (for connectivity check)
 * @returns {boolean} - True if residue is a real amino acid
 */
function isRealAminoAcid(residue, modresMap = null, chemCompMap = null, allResidues = null) {
    const resName = residue.resName;

    // 1. Check if it's a standard amino acid (always allowed, no connectivity check needed)
    if (STANDARD_AMINO_ACIDS.has(resName)) {
        return true;
    }

    // 2. Check common modifications dictionary (e.g., MSE->MET)
    const modifiedType = getModifiedResidueType(resName);
    if (modifiedType && modifiedType.type === 'P') {
        // Common modifications require connectivity check
        if (allResidues) {
            return isResidueConnected(residue, allResidues, 'P');
        }
        // If no allResidues provided, allow it (backward compatibility, but less strict)
        return true;
    }

    // 3. Check MODRES map (from PDB) - requires connectivity
    if (modresMap && modresMap.has(resName)) {
        const stdResName = modresMap.get(resName);
        if (STANDARD_AMINO_ACIDS.has(stdResName)) {
            // MODRES-defined modifications require connectivity check
            if (allResidues) {
                return isResidueConnected(residue, allResidues, 'P');
            }
            // If no allResidues provided, allow it (backward compatibility)
            return true;
        }
    }

    // 4. Check CIF chemical component map - requires connectivity
    if (chemCompMap && chemCompMap.has(resName)) {
        const compInfo = chemCompMap.get(resName);
        if (compInfo.type === 'P') {
            // Check if it maps to a standard amino acid
            const stdResName = compInfo.stdResName || compInfo.parent;
            if (stdResName && STANDARD_AMINO_ACIDS.has(stdResName)) {
                // CIF-defined modifications require connectivity check
                if (allResidues) {
                    return isResidueConnected(residue, allResidues, 'P');
                }
                // If no allResidues provided, allow it (backward compatibility)
                return true;
            }
        }
    }

    // 5. STRUCTURAL fallback: a residue carrying an N-CA-C backbone is an amino
    // acid whatever it is called, mirroring the ribose test in
    // isRealNucleicAcid. The dictionary above cannot list every non-standard
    // residue, and anything it misses does not merely render wrong - it is
    // dropped from the chain, so the backbone breaks and the gap reads as an
    // over-length bond rather than the missing residue it is. This also matches
    // the Python path, where gemmi's is_amino_acid() already accepts them.
    // Connectivity is still required, so free amino-acid ligands are not swept
    // in - it takes a CA within 5 A of an adjacent residue number in the chain.
    if (residue.atoms
        && residue.atoms.some(a => a.atomName === 'N')
        && residue.atoms.some(a => a.atomName === 'CA')
        && residue.atoms.some(a => a.atomName === 'C')) {
        if (allResidues) {
            return isResidueConnected(residue, allResidues, 'P');
        }
        return true;
    }

    // No other cases - return false (removed all "last resort" checks)
    return false;
}

// The 2' position, which is the only thing that tells DNA from RNA. Ribose
// carries a hydroxyl there (O2', plus its proton HO2'); deoxyribose carries a
// second hydrogen instead (H2''). Old files spell the prime as * and put the
// count first, so both conventions are listed.
const RIBOSE_2OH_ATOMS = new Set(["O2'", 'O2*', "HO2'", 'HO2*', "2HO'", '2HO*']);
const DEOXY_2H_ATOMS = new Set(["H2''", "H2'*", 'H2**', "2H2'", '2H2*']);

/**
 * DNA or RNA for one STANDARD nucleotide, or null when the file does not say.
 *
 * The base name alone cannot answer this. "A", "C", "G" and "I" are used for
 * both sugars - fibre models and older files write a whole B-DNA duplex as
 * "A C G T" - and taking the name at face value split one duplex into RNA
 * (A/C/G) plus DNA (T), so the renderer fed the A-form prediction to three
 * quarters of a B-form helix and the B-form one to its thymines.
 *
 * Only POSITIVE evidence counts. Concluding deoxy from a missing O2' looks
 * equivalent and is not: 1P79 models the 2'-hydroxyl's proton but omits the
 * oxygen itself, and that one absence turned a G in the middle of an RNA
 * chain into DNA. An unmodelled atom means the file is quiet, not that the
 * atom is absent - hence null, which the caller resolves per chain.
 *
 * T and U are decided by the base: thymine is DNA and uracil is RNA whatever
 * the sugar looks like, and a D or R prefix is the author saying so outright.
 */
function nucleicSugarVote(resName, residue) {
    if (resName === 'T' || resName === 'DI' || resName.startsWith('D')) return 'D';
    if (resName === 'U' || resName.startsWith('R')) return 'R';
    // bare A, C, G, I - ask the sugar
    const atoms = residue && residue.atoms;
    if (!atoms) return null;
    for (const a of atoms) {
        if (RIBOSE_2OH_ATOMS.has(a.atomName)) return 'R';
        if (DEOXY_2H_ATOMS.has(a.atomName)) return 'D';
    }
    return null;
}

/**
 * Same, but always answering. Used where there is no chain to consult; the
 * fallback is the historical one, so a bare name with no sugar reads as RNA.
 */
function standardNucleicType(resName, residue) {
    return nucleicSugarVote(resName, residue) || 'R';
}

/**
 * ONE SUGAR PER CHAIN. A duplex is one molecule and must get one answer: the
 * renderer picks its base-direction prediction and its helix geometry from
 * this letter, so a chain split between D and R is drawn as two different
 * kinds of helix interleaved. Residues that voted decide it for the residues
 * that could not.
 *
 * @param {Array<object>} allResidues - residues, each with .chain and .atoms
 * @returns {Map<string,string>} chain -> 'D' | 'R', only for chains that voted
 */
function resolveChainNucleicTypes(allResidues) {
    const tally = new Map();
    for (const residue of allResidues) {
        if (!STANDARD_NUCLEIC_ACIDS.has(residue.resName)) continue;
        const vote = nucleicSugarVote(residue.resName, residue);
        if (!vote) continue;
        let t = tally.get(residue.chain);
        if (!t) { t = { D: 0, R: 0 }; tally.set(residue.chain, t); }
        t[vote]++;
    }
    const out = new Map();
    for (const [chain, t] of tally) out.set(chain, t.D > t.R ? 'D' : 'R');
    return out;
}

// Backbone. Everything else heavy is side chain - "CB and up". OXT is the
// terminal carboxylate oxygen, backbone by any reading.
const PROTEIN_BACKBONE_ATOMS = new Set(['N', 'CA', 'C', 'O', 'OXT']);
// The backbone atoms of a STANDARD residue that no consumer reads - the same
// set without CA. See the filter in parseCIF for why the qualifier matters.
const DROPPABLE_BACKBONE = new Set(['N', 'C', 'O', 'OXT']);
// WHAT IS ACTUALLY BONDED TO WHAT, per residue type.
//
// A side chain's connectivity is a property of the amino acid, not of the
// coordinates, so it does not have to be guessed from distances at all. The
// distance rule below is kept as a FALLBACK for residues not in this table -
// modified and non-standard ones - but wherever the residue is recognised its
// real bonds are used, and then a bond is right however stretched the geometry
// is. That is what the distance rule could not do: 4HHB has real bonds out at
// 2.2 A while non-bonded pairs in the same residue start at 2.41 A, so no
// single threshold separates them.
//
// Backbone bonds are omitted - only CA outwards is drawn. PRO's CD-N ring
// closure is a backbone bond and so is left out; the ring reads as open at the
// N, which is where the drawn side chain genuinely stops.
const PROTEIN_SIDECHAIN_BONDS = {
    ALA: [['CA', 'CB']],
    ARG: [['CA', 'CB'], ['CB', 'CG'], ['CG', 'CD'], ['CD', 'NE'], ['NE', 'CZ'],
        ['CZ', 'NH1'], ['CZ', 'NH2']],
    ASN: [['CA', 'CB'], ['CB', 'CG'], ['CG', 'OD1'], ['CG', 'ND2']],
    ASP: [['CA', 'CB'], ['CB', 'CG'], ['CG', 'OD1'], ['CG', 'OD2']],
    CYS: [['CA', 'CB'], ['CB', 'SG']],
    GLN: [['CA', 'CB'], ['CB', 'CG'], ['CG', 'CD'], ['CD', 'OE1'], ['CD', 'NE2']],
    GLU: [['CA', 'CB'], ['CB', 'CG'], ['CG', 'CD'], ['CD', 'OE1'], ['CD', 'OE2']],
    GLY: [],
    HIS: [['CA', 'CB'], ['CB', 'CG'], ['CG', 'ND1'], ['CG', 'CD2'],
        ['ND1', 'CE1'], ['CD2', 'NE2'], ['CE1', 'NE2']],
    ILE: [['CA', 'CB'], ['CB', 'CG1'], ['CB', 'CG2'], ['CG1', 'CD1']],
    LEU: [['CA', 'CB'], ['CB', 'CG'], ['CG', 'CD1'], ['CG', 'CD2']],
    LYS: [['CA', 'CB'], ['CB', 'CG'], ['CG', 'CD'], ['CD', 'CE'], ['CE', 'NZ']],
    MET: [['CA', 'CB'], ['CB', 'CG'], ['CG', 'SD'], ['SD', 'CE']],
    MSE: [['CA', 'CB'], ['CB', 'CG'], ['CG', 'SE'], ['SE', 'CE']],
    PHE: [['CA', 'CB'], ['CB', 'CG'], ['CG', 'CD1'], ['CG', 'CD2'],
        ['CD1', 'CE1'], ['CD2', 'CE2'], ['CE1', 'CZ'], ['CE2', 'CZ']],
    // PROLINE IS A RING, and the atom that closes it is a BACKBONE nitrogen.
    // Dropped with the rest of the backbone the side chain draws as an open
    // three-atom arm hanging off the CA, which is not what a proline looks
    // like anywhere else. N is kept for this residue only (see
    // SIDECHAIN_KEEP_BACKBONE) and the two bonds that make the pyrrolidine -
    // CD-N and N-CA - come with it. N-CA touches the anchor, so it is recorded
    // as a bond to the OWNING POSITION rather than between two table rows.
    PRO: [['CA', 'CB'], ['CB', 'CG'], ['CG', 'CD'], ['CD', 'N'], ['N', 'CA']],
    HYP: [['CA', 'CB'], ['CB', 'CG'], ['CG', 'CD'], ['CD', 'N'], ['N', 'CA'],
        ['CG', 'OD1']],
    SER: [['CA', 'CB'], ['CB', 'OG']],
    THR: [['CA', 'CB'], ['CB', 'OG1'], ['CB', 'CG2']],
    TRP: [['CA', 'CB'], ['CB', 'CG'], ['CG', 'CD1'], ['CG', 'CD2'],
        ['CD1', 'NE1'], ['NE1', 'CE2'], ['CD2', 'CE2'], ['CD2', 'CE3'],
        ['CE2', 'CZ2'], ['CE3', 'CZ3'], ['CZ2', 'CH2'], ['CZ3', 'CH2']],
    TYR: [['CA', 'CB'], ['CB', 'CG'], ['CG', 'CD1'], ['CG', 'CD2'],
        ['CD1', 'CE1'], ['CD2', 'CE2'], ['CE1', 'CZ'], ['CE2', 'CZ'],
        ['CZ', 'OH']],
    VAL: [['CA', 'CB'], ['CB', 'CG1'], ['CB', 'CG2']],
};

// NAMES THAT MEAN THE SAME ATOM. The table is written in PDB v3 names, and
// older files use v2 for a handful of heavy atoms - isoleucine's terminal
// carbon is CD1 in v3 and CD in v2, and selenomethionine's selenium is written
// both SE and SED. Without this an ILE from a v2 file loses its CD1 bond and
// the tip comes away. Symmetric pairs that merely swap between files - ASP's
// OD1/OD2, PHE's CD1/CD2 - need nothing here: both bond to the same parent, so
// which is which does not change the connectivity.
// ...AND THE SAME FOR A BASE, from the chemistry rather than from distances.
//
// The anchor is C4' (the trace atom the position was taken from), and the two
// sugar atoms that carry the base come with it: C4'-O4'-C1' are real bonds and
// they are what puts the ring where it belongs. Everything after C1' is the
// base itself.
//
// Written out for the same reason the protein table is: a distance rule has to
// be tuned between the shortest bond and the shortest non-bond, and it gets
// both wrong on refined-but-scattered geometry - a ring that misses one bond
// draws as an open chain, and a base with an unmodelled atom draws a bond
// across the hole. Purines and pyrimidines here, DNA and RNA both; anything
// else (a modified base) still falls to the distance rule.
const NUCLEIC_SIDECHAIN_BONDS = (() => {
    const sugar = [["C4'", "O4'"], ["O4'", "C1'"]];
    const purine = (n9) => [...sugar, ["C1'", n9]];
    const A = [...purine('N9'), ['N9', 'C8'], ['C8', 'N7'], ['N7', 'C5'],
        ['C5', 'C4'], ['C4', 'N9'], ['C4', 'N3'], ['N3', 'C2'], ['C2', 'N1'],
        ['N1', 'C6'], ['C6', 'C5'], ['C6', 'N6']];
    const G = [...purine('N9'), ['N9', 'C8'], ['C8', 'N7'], ['N7', 'C5'],
        ['C5', 'C4'], ['C4', 'N9'], ['C4', 'N3'], ['N3', 'C2'], ['C2', 'N1'],
        ['N1', 'C6'], ['C6', 'C5'], ['C6', 'O6'], ['C2', 'N2']];
    const C = [...sugar, ["C1'", 'N1'], ['N1', 'C2'], ['C2', 'N3'], ['N3', 'C4'],
        ['C4', 'C5'], ['C5', 'C6'], ['C6', 'N1'], ['C2', 'O2'], ['C4', 'N4']];
    const T = [...sugar, ["C1'", 'N1'], ['N1', 'C2'], ['C2', 'N3'], ['N3', 'C4'],
        ['C4', 'C5'], ['C5', 'C6'], ['C6', 'N1'], ['C2', 'O2'], ['C4', 'O4'],
        ['C5', 'C7']];
    const U = [...sugar, ["C1'", 'N1'], ['N1', 'C2'], ['C2', 'N3'], ['N3', 'C4'],
        ['C4', 'C5'], ['C5', 'C6'], ['C6', 'N1'], ['C2', 'O2'], ['C4', 'O4']];
    const out = {};
    // every spelling a file might use for the same residue
    for (const [names, bonds] of [[['A', 'DA', 'ADE', 'RA'], A],
        [['G', 'DG', 'GUA', 'RG'], G], [['C', 'DC', 'CYT', 'RC'], C],
        [['T', 'DT', 'THY', 'RT'], T], [['U', 'DU', 'URA', 'RU'], U]]) {
        for (const nm of names) out[nm] = bonds;
    }
    return out;
})();
// THY's methyl is C7 in the modern dictionary and C5M in older files.
const NUCLEIC_ATOM_ALIASES = { C5M: 'C7' };

// WHICH BACKBONE ATOMS A RESIDUE KEEPS. Only proline and its hydroxylated
// form, and only their N: the side chain closes a ring through it, and without
// it the ring is an arm.
const SIDECHAIN_KEEP_BACKBONE = { PRO: 'N', HYP: 'N' };

const SIDECHAIN_ATOM_ALIASES = {
    ILE: { CD: 'CD1' },
    MSE: { SED: 'SE' },
};

// WHERE A BOND STOPS BEING A BOND.
//
// Ideal side-chain bonds run 1.43 (C-O) to 1.81 (C-S), so a 1.9 cutoff looks
// generous - and is not. Refined geometry scatters, and older structures
// scatter further: on 4HHB, 69 atoms came out with no bond at all, their
// nearest neighbour sitting at 1.90-1.94 A. CA-CB, CD-CE, CE-NZ - real bonds,
// just long. Each drew as an isolated sphere beside a gap.
//
// The ceiling is the shortest NON-bonded distance in a residue: two atoms one
// bond apart from a common neighbour. Tetrahedral that is 2*1.53*sin(54.75) =
// 2.50 A, aromatic 2*1.39*sin(60) = 2.41 A. Measured over 25,946 side-chain
// atoms, atoms with an impossible number of neighbours stay flat to 2.10 and
// then break sharply - 3 at 1.90, 6 at 2.10, 109 at 2.20, 3004 at 2.40 - so a
// single threshold cannot both catch a 2.2 A bond and avoid inventing them.
//
// So there are TWO numbers. The threshold below is deliberately tight, tight
// enough that it never bonds a 1,3 pair; what it misses is repaired afterwards
// by joining each detached fragment to the rest through its single SHORTEST
// link (see the reachability pass). One shortest link per fragment cannot
// over-coordinate anything, which is what lets the repair reach further than
// the threshold safely.
//
// The repair also makes this threshold uncritical: 1.9, 2.0 and 2.1 all give
// the identical table on 4HHB, because whatever the threshold misses the
// repair puts back. It is the repair's reach below that decides the answer,
// which is where the tests are pointed.
// A NUCLEOTIDE'S BACKBONE, for the same job: everything the table must NOT
// carry. What is left is the base ring plus the two sugar atoms that hold it -
// O4' and C1' - so the drawn chain runs C4'(the trace position) - O4' - C1' -
// N9/N1 - ring, and every stick in it is a real bond. Dropping O4' as well
// would leave the base to be anchored straight to C4', which is 3.9 A of
// nothing through the middle of the sugar.
//
// Both spellings: PDB v2 wrote the primes as asterisks (C1*, O4*) and plenty
// of files still do.
const NUCLEIC_BACKBONE_ATOMS = new Set([
    'P', 'OP1', 'OP2', 'OP3', 'O1P', 'O2P', 'O3P',
    "O5'", "C5'", "C4'", "C3'", "O3'", "C2'", "O2'",
    'O5*', 'C5*', 'C4*', 'C3*', 'O3*', 'C2*', 'O2*',
]);
// The primes normalised, so one name answers for either spelling.
const primed = (nm) => (nm ? nm.replace(/\*/g, "'") : nm);

const SIDECHAIN_BOND_MAX = 2.0;
const SIDECHAIN_BOND_MAX_SQ = SIDECHAIN_BOND_MAX * SIDECHAIN_BOND_MAX;
// The repair's reach. Below the 2.41 A aromatic 1,3 distance, so a fragment
// separated by a genuinely UNMODELLED atom - a residue whose CG was never
// built while its CD was - stays detached and is dropped rather than joined by
// a bond that does not exist.
const SIDECHAIN_LINK_MAX_SQ = 2.35 * 2.35;

/**
 * Side chains, stored so they FOLLOW THE BACKBONE WHEREVER IT GOES.
 *
 * py2Dmol keeps one position per residue, and the cartoon renderer then moves
 * that position: it is re-centred at load, rotated to face the viewer, and -
 * in the richardson preset - projected onto its sheet plane and flattened
 * (see sheetProject / sheetFlat in cartoon/geom.js). A side chain held as a
 * world coordinate would be right only in the raw file's frame and would tear
 * away from its own CA everywhere else.
 *
 * So nothing here is stored in world space. Each atom is three coefficients in
 * its residue's own backbone frame - the frame built from the CA trace by
 * localFrame() - which is invariant under translation and rotation alike. At
 * draw time the renderer rebuilds the same frame from the FINAL positions and
 * reads the coefficients back out, so the side chain arrives wherever the CA
 * ended up, at the right orientation, with no transform to keep in step.
 *
 * That frame is deliberately the renderer's own function rather than a copy of
 * it: capture and reconstruction have to agree exactly, and two
 * implementations of the same 20 lines is how they stop agreeing.
 *
 * Terminal residues have no frame of their own (localFrame needs a neighbour
 * on each side), so they borrow the nearest one that does and are stored in
 * that. It is a rigid frame either way; all it costs is that a terminus
 * follows its neighbour's flattening rather than its own, and flattening does
 * not move chain ends.
 *
 * THE CA IS NOT IN THE TABLE. It is already a drawn position - the backbone
 * runs through it - so carrying a copy would put two coincident positions on
 * top of each other, a fifth of the table (534 of 2618 atoms on 4HHB) spent
 * duplicating something the renderer had already placed, with the CA-CB bond
 * drawn to the copy rather than to the backbone. Instead the atoms that bond
 * to it are listed in `toBackbone`, and the renderer joins them to the owning
 * position itself, so the side chain hangs off the backbone that is really
 * there. The CA still takes part in the graph while the table is being built,
 * as the root everything must reach; it is simply not emitted.
 *
 * @param {Array<Array<number>>} coords - final position coordinates
 * @param {Array<object>} entries - {pos, residue} per emitted protein position
 * @returns {object|null} - the side-chain table, or null if there is nothing
 */
function buildSidechainTable(coords, entries) {
    const C = (typeof window !== 'undefined') ? window.py2dmolCartoon : null;
    const localFrame = C ? C.localFrame : null;
    if (!localFrame || !entries.length) return null;
    // A nucleic trace steps 5.5-6.5 A, not the peptide's 3.8 - see localFrame.
    const stepMin = C ? C.NUCLEIC_STEP_MIN : 4.5;
    const stepMax = C ? C.NUCLEIC_STEP_MAX : 7.5;
    const frameArgs = (isNucleic) => (isNucleic ? [stepMin, stepMax] : [undefined, undefined]);

    const n = coords.length;
    const at = (i) => ({ x: coords[i][0], y: coords[i][1], z: coords[i][2] });
    // which residues can carry a frame at all
    const fr = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    const hasFrame = new Uint8Array(n);
    for (const e of entries) {
        const [lo, hi] = frameArgs(e.nucleic);
        if (localFrame(at, n, e.pos, fr, null, lo, hi)) hasFrame[e.pos] = 1;
    }
    // nearest framed position, searching outward - only used at chain ends
    const framedNear = (pos) => {
        if (hasFrame[pos]) return pos;
        for (let d = 1; d <= 3; d++) {
            if (pos - d >= 0 && hasFrame[pos - d]) return pos - d;
            if (pos + d < n && hasFrame[pos + d]) return pos + d;
        }
        return -1;
    };

    const pos = []; const frameOf = []; const coef = [];
    const names = []; const elements = []; const bonds = [];
    // WHICH ROWS ARE BACKBONE ATOMS KEPT ON PURPOSE - proline's ring-closing N,
    // and nothing else today. The drawing needs to know: that atom is inside
    // the ribbon, which draws the backbone as a solid, so the arm that closes
    // the ring has to meet the SURFACE rather than disappear into it.
    const onBackbone = [];
    // table rows bonded to their residue's own backbone position, not to
    // another row - the CA end of the side chain
    const toBackbone = [];

    // SCRATCH, REUSED BY EVERY RESIDUE. A side chain is at most a couple of
    // dozen heavy atoms, and the loop below used to allocate ten containers to
    // hold them - two Sets, a Map, an array per atom for the adjacency, and a
    // stack per walk - once per residue. A 313,000-residue capsid pays for
    // three million short-lived objects to describe side chains that never
    // exceed fourteen atoms. These grow to the largest residue seen and are
    // then cleared, not rebuilt; `cap` tracks how much of each is live.
    let cap = 32;
    let group = new Array(cap);
    let adjN = new Uint8Array(cap);            // degree of each group index
    let adj = new Int16Array(cap * cap);       // neighbours, row-major by cap
    let reach = new Uint8Array(cap);           // 1 once walked to from the CA
    let stack = new Int16Array(cap);
    let rowOf = new Int32Array(cap);
    const growScratch = (need) => {
        while (cap < need) cap *= 2;
        group = new Array(cap);
        adjN = new Uint8Array(cap);
        adj = new Int16Array(cap * cap);
        reach = new Uint8Array(cap);
        stack = new Int16Array(cap);
        rowOf = new Int32Array(cap);
    };

    for (const e of entries) {
        // WHICH ATOM THE GROUP HANGS OFF, and what counts as backbone around
        // it. A protein's is the CA; a nucleotide's is the C4' its position
        // was taken from. Everything else in here is generic.
        const anchorName = e.nucleic ? "C4'" : 'CA';
        const backboneOf = e.nucleic ? NUCLEIC_BACKBONE_ATOMS : PROTEIN_BACKBONE_ATOMS;
        // ...and the cache is a convenience, not a guarantee: c4Atom is only
        // set where the parser saw the name it was looking for
        const ca = e.nucleic
            ? (e.residue.c4Atom
                || e.residue.atoms.find((a) => primed(a.atomName) === "C4'"))
            : e.residue.caAtom;
        if (!ca) continue;
        const anchor = framedNear(e.pos);
        if (anchor < 0) continue;                 // too short to frame: skip
        const [flo, fhi] = frameArgs(e.nucleic);
        if (!localFrame(at, n, anchor, fr, null, flo, fhi)) continue;
        const o = at(anchor);

        // ONE CONFORMER, THE FIRST. A residue modelled in two positions writes
        // each of its atoms twice - alt A and alt B - and taking both gives a
        // side chain with two of every atom, bonded to each other by the
        // distance rule below into a tangle that is not any real conformer.
        // First-wins by atom NAME rather than by reading the alt-loc column:
        // it needs nothing from the parser, and it matches what the BACKBONE
        // already does - residue.caAtom is the first CA seen - so the side
        // chain comes from the same conformer as the position it hangs off
        // rather than mixing alt B's CB onto alt A's CA.
        // HYDROGEN, EVEN WITHOUT AN ELEMENT COLUMN. Columns 77-78 of a PDB
        // ATOM record are optional and older files leave them blank, so the
        // element test alone lets hydrogens through. A residue in the
        // connectivity table shrugs that off - the table never names a
        // hydrogen, so it attaches to nothing and the reachability pass drops
        // it - but the distance FALLBACK bonds it to its parent and draws it.
        // Measured on a hydrogen-bearing file with no element column: standard
        // residues came out clean, a non-standard one kept HB2, HG and 1HB.
        //
        // So the name decides it when the column is silent: PDB names
        // hydrogens H..., and v2 puts the count first (1HB, 2HB). Only
        // consulted when `element` is empty, so a ligand atom that really is
        // mercury keeps its element, and only inside a residue already
        // classified as protein, where an H-name cannot be anything else.
        const isHydrogen = (a) => (a.element
            ? (a.element === 'H' || a.element === 'D')
            : /^[0-9]?[HD]/.test(a.atomName || ''));
        const atoms = e.residue.atoms;
        if (atoms.length > cap) growScratch(atoms.length);
        let gn = 0;
        for (let ai = 0; ai < atoms.length; ai++) {
            const a = atoms[ai];
            if (isHydrogen(a)) continue;
            const nm0 = primed(a.atomName);
            const keepBB = SIDECHAIN_KEEP_BACKBONE[e.residue.resName];
            if (nm0 !== anchorName && nm0 !== keepBB && backboneOf.has(a.atomName)) continue;
            // first-wins by name, over a handful of entries - a linear scan
            // beats hashing at this size, and there is nothing to allocate
            let dup = false;
            for (let k = 0; k < gn; k++) {
                if (group[k].atomName === a.atomName) { dup = true; break; }
            }
            if (dup) continue;
            group[gn++] = a;
        }
        // CA first, so index 0 of every group is the anchor. Moved rather than
        // swapped: the rows are emitted in group order, so the atoms after it
        // have to keep the order the file gave them.
        for (let k = 1; k < gn; k++) {
            if (primed(group[k].atomName) !== anchorName) continue;
            const ca0 = group[k];
            for (let m = k; m > 0; m--) group[m] = group[m - 1];
            group[0] = ca0;
            break;
        }
        if (gn < 2) continue;                     // glycine: nothing to draw
        const base = pos.length;
        // CONNECTIVITY. From the residue's chemistry where we recognise it,
        // and only otherwise from distances.
        const link = [];
        for (let k = 0; k < gn; k++) adjN[k] = 0;
        const join = (i, j) => {
            link.push(i, j);
            adj[i * cap + adjN[i]++] = j;
            adj[j * cap + adjN[j]++] = i;
        };
        // ...from the right table. A base has its own, and a modified one that
        // is in neither falls to the distance rule.
        const rn = (e.residue.resName || '').trim().toUpperCase();
        const known = e.nucleic
            ? NUCLEIC_SIDECHAIN_BONDS[rn]
            : PROTEIN_SIDECHAIN_BONDS[e.residue.resName];
        if (known) {
            const alias = e.nucleic
                ? NUCLEIC_ATOM_ALIASES : SIDECHAIN_ATOM_ALIASES[e.residue.resName];
            const rowName = [];
            for (let i = 0; i < gn; i++) {
                // primes normalised for a base, so a file written with
                // asterisks matches the table's C1'
                const n0 = e.nucleic ? primed(group[i].atomName) : group[i].atomName;
                rowName.push((alias && alias[n0]) || n0);
            }
            const rowIdx = (nm) => {
                // last match wins, as Map.set did when two atoms alias to one name
                for (let i = gn - 1; i >= 0; i--) if (rowName[i] === nm) return i;
                return undefined;
            };
            for (const [n1, n2] of known) {
                const i = rowIdx(n1); const j = rowIdx(n2);
                // an atom the file never modelled simply has no bond to make
                if (i !== undefined && j !== undefined) join(i, j);
            }
        } else {
            for (let i = 0; i < gn; i++) {
                for (let j = i + 1; j < gn; j++) {
                    const a = group[i], b = group[j];
                    const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
                    if (dx * dx + dy * dy + dz * dz < SIDECHAIN_BOND_MAX_SQ) {
                        join(i, j);
                    }
                }
            }
        }
        // ONLY WHAT HANGS OFF THE CA. A side chain is a tree rooted at its CA,
        // so an atom the cutoff could not reach from there is not attached to
        // anything we are drawing - it is a fragment left by missing density,
        // a residue whose CG was never modelled while its CD was. Drawn anyway
        // it appears as a sphere floating beside a gap, which reads as a broken
        // bond rather than as the absent atom it really is. Dropping it says
        // the honest thing: nothing is drawn where nothing was measured.
        for (let k = 0; k < gn; k++) reach[k] = 0;
        reach[0] = 1;                        // index 0 is the CA anchor
        let reachN = 1;
        const grow = (from) => {
            let sp = 0;
            stack[sp++] = from;
            while (sp) {
                const at0 = stack[--sp];
                const deg = adjN[at0]; const row = at0 * cap;
                for (let k = 0; k < deg; k++) {
                    const nb = adj[row + k];
                    if (reach[nb]) continue;
                    reach[nb] = 1; reachN++; stack[sp++] = nb;
                }
            }
        };
        grow(0);
        // REPAIR, FALLBACK RESIDUES ONLY. Where the chemistry is known a
        // detached fragment means an atom the file never modelled, and guessing
        // a bond across the hole would draw one that does not exist. Only the
        // distance rule needs rescuing from itself: there a fragment is either
        // a bond the tight threshold missed or an atom whose neighbour was
        // never modelled, and the two look completely different - the first
        // sits a little past the threshold, the second past any bond length at
        // all. So each detached fragment is offered ONE link, its shortest, and
        // joined if that link is short enough to be a bond. A single link per
        // fragment cannot over-coordinate anything, which is why it may reach
        // further than the threshold does.
        while (!known) {
            let bd = SIDECHAIN_LINK_MAX_SQ; let bi = -1; let bj = -1;
            for (let i = 0; i < gn; i++) {
                if (!reach[i]) continue;
                for (let j = 0; j < gn; j++) {
                    if (reach[j]) continue;
                    const a = group[i], b = group[j];
                    const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
                    const d2 = dx * dx + dy * dy + dz * dz;
                    if (d2 < bd) { bd = d2; bi = i; bj = j; }
                }
            }
            if (bi < 0) break;
            link.push(bi, bj);
            adj[bi * cap + adjN[bi]++] = bj;
            adj[bj * cap + adjN[bj]++] = bi;
            reach[bj] = 1; reachN++;
            grow(bj);
        }
        // Whatever is STILL detached is dropped, for the reason above.
        if (reachN < 2) continue;            // nothing reached the CA at all
        // renumber the survivors, since the rows are written in group order.
        // The CA (group index 0) is the backbone position, so it is not emitted.
        let emitN = 0;
        for (let i = 1; i < gn; i++) if (reach[i]) rowOf[i] = base + emitN++;
        for (let i = 1; i < gn; i++) {
            if (!reach[i]) continue;
            const a = group[i];
            const dx = a.x - o.x, dy = a.y - o.y, dz = a.z - o.z;
            pos.push(e.pos);
            frameOf.push(anchor);
            coef.push(dx * fr[0] + dy * fr[1] + dz * fr[2]);
            coef.push(dx * fr[3] + dy * fr[4] + dz * fr[5]);
            coef.push(dx * fr[6] + dy * fr[7] + dz * fr[8]);
            names.push(a.atomName);
            elements.push(a.element || '');
            onBackbone.push(primed(a.atomName) === SIDECHAIN_KEEP_BACKBONE[e.residue.resName]
                ? 1 : 0);
        }
        for (let k = 0; k + 1 < link.length; k += 2) {
            const p1 = link[k]; const p2 = link[k + 1];
            // a bond touching the CA becomes a bond to the OWNING POSITION,
            // recorded separately because it crosses out of the table
            if (p1 === 0 || p2 === 0) {
                // rowOf holds stale entries from earlier residues, so a row
                // number only counts when this residue actually reached it
                const o = p1 === 0 ? p2 : p1;
                if (o !== 0 && reach[o]) toBackbone.push(rowOf[o]);
                continue;
            }
            if (reach[p1] && reach[p2]) bonds.push(rowOf[p1], rowOf[p2]);
        }
    }
    if (!pos.length) return null;
    return {
        pos: new Int32Array(pos),
        frameOf: new Int32Array(frameOf),
        coef: new Float32Array(coef),
        bonds: new Int32Array(bonds),
        toBackbone: new Int32Array(toBackbone),
        names,
        elements,
        onBackbone: new Uint8Array(onBackbone),
    };
}

/**
 * A side-chain table trimmed for SAVING - every residue kept, nothing that the
 * drawing does not need.
 *
 * The whole table goes in, not just the residues that were showing. Storing
 * only those made a smaller file and a session you could not change your mind
 * in: reload it and the side chains you had are there, but no others can ever
 * be turned on, because their atoms were never written down and the file they
 * came from is long gone. Being able to enable a residue later is most of the
 * point of the control.
 *
 * What is dropped is `names` and `elements`. Nothing reads them to draw - they
 * exist so the connectivity table can be applied at capture, which has already
 * happened by now - and they are a third of the bytes. Coefficients round to
 * 0.01 A, which is far finer than a side chain drawn a few pixels wide.
 *
 * Cost on 1TIM: 56 KB against 11 KB of coordinates, per frame. That ratio is
 * the price of the feature; it was 145 KB before this trimming.
 *
 * @param {object} sc - the full table
 * @returns {object|null}
 */
function trimSidechainTable(sc) {
    if (!sc || !sc.pos || !sc.pos.length) return null;
    const coef = new Array(sc.coef.length);
    for (let i = 0; i < sc.coef.length; i++) {
        coef[i] = Math.round(sc.coef[i] * 100) / 100;
    }
    return {
        pos: Array.from(sc.pos),
        frameOf: Array.from(sc.frameOf),
        coef,
        bonds: Array.from(sc.bonds),
        toBackbone: Array.from(sc.toBackbone || []),
        // dropped here once and proline's ring went back to diving into the
        // ribbon: this IS the table the renderer reads
        onBackbone: Array.from(sc.onBackbone || []),
    };
}

/**
 * Rebuild a table read back from a saved session. JSON has no typed arrays, so
 * the numeric columns come back as plain ones and are put back into the shapes
 * the renderer indexes.
 */
function reviveSidechainTable(raw) {
    if (!raw || !raw.pos || !raw.pos.length) return null;
    return {
        pos: new Int32Array(raw.pos),
        frameOf: new Int32Array(raw.frameOf),
        coef: new Float32Array(raw.coef),
        bonds: new Int32Array(raw.bonds || []),
        toBackbone: new Int32Array(raw.toBackbone || []),
        // absent in a saved table: nothing reads them to draw, and they were
        // dropped to save the bytes - see trimSidechainTable
        names: raw.names || [],
        elements: raw.elements || [],
        onBackbone: new Uint8Array(raw.onBackbone || []),
    };
}

/**
 * Check if a residue is a real nucleic acid (standard or modified)
 * Simplified: only canonical DNA/RNA + common modifications + MODRES/CIF-defined if connected
 * @param {object} residue - Residue object with resName, record, atoms
 * @param {Map} modresMap - MODRES mapping (from PDB)
 * @param {Map} chemCompMap - Chemical component map (from CIF)
 * @param {Array} allResidues - Array of all residue objects (for connectivity check)
 * @returns {string|null} - 'D' for DNA, 'R' for RNA, or null if not a real nucleic acid
 */
function isRealNucleicAcid(residue, modresMap = null, chemCompMap = null, allResidues = null) {
    const resName = residue.resName;

    // 1. Check if it's a standard nucleic acid (always allowed, no connectivity check needed)
    if (STANDARD_NUCLEIC_ACIDS.has(resName)) {
        return standardNucleicType(resName, residue);
    }

    // 2. Check common modifications dictionary - requires connectivity
    const modifiedType = getModifiedResidueType(resName);
    if (modifiedType && (modifiedType.type === 'D' || modifiedType.type === 'R')) {
        // Common modifications require connectivity check
        if (allResidues) {
            if (isResidueConnected(residue, allResidues, modifiedType.type)) {
                return modifiedType.type;
            }
            return null;  // Not connected
        }
        // If no allResidues provided, allow it (backward compatibility, but less strict)
        return modifiedType.type;
    }

    // 3. Check MODRES map (from PDB) - requires connectivity
    if (modresMap && modresMap.has(resName)) {
        const stdResName = modresMap.get(resName);
        if (STANDARD_NUCLEIC_ACIDS.has(stdResName)) {
            // the modified residue carries its own sugar, so read it there
            const nucleicType = standardNucleicType(stdResName, residue);
            // MODRES-defined modifications require connectivity check
            if (allResidues) {
                if (isResidueConnected(residue, allResidues, nucleicType)) {
                    return nucleicType;
                }
                return null;  // Not connected
            }
            // If no allResidues provided, allow it (backward compatibility)
            return nucleicType;
        }
    }

    // 4. Check CIF chemical component map - requires connectivity
    if (chemCompMap && chemCompMap.has(resName)) {
        const compInfo = chemCompMap.get(resName);
        if (compInfo.type === 'D' || compInfo.type === 'R') {
            // Check if it maps to a standard nucleic acid
            const stdResName = compInfo.stdResName || compInfo.parent;
            if (stdResName && STANDARD_NUCLEIC_ACIDS.has(stdResName)) {
                // CIF-defined modifications require connectivity check
                if (allResidues) {
                    if (isResidueConnected(residue, allResidues, compInfo.type)) {
                        return compInfo.type;
                    }
                    return null;  // Not connected
                }
                // If no allResidues provided, allow it (backward compatibility)
                return compInfo.type;
            }
        }
    }

    // 5. STRUCTURAL fallback: a residue carrying a ribose/deoxyribose ring is a
    // nucleotide whatever it is called. The dictionary above only lists PSU, so
    // tRNA modifications (YYG, 5MC, 1MA, 2MG, 7MG, OMC, OMG, 4SU, H2U ...) fell
    // through and were dropped from the chain - 1EHZ lost 3 residues and the
    // backbone broke at each one, which then looked like an over-length bond
    // rather than the missing residue it was. Mirrors the same fix in
    // viewer.py. Connectivity is still required, so free nucleotide ligands
    // (ATP, GTP) are not swept in.
    const atomNamed = (...names) => residue.atoms
        && residue.atoms.some(a => names.indexOf(a.atomName) !== -1);
    if (atomNamed("C4'", "C4*") && atomNamed("O4'", "O4*") && atomNamed("C1'", "C1*")) {
        // the 2'-OH is what separates ribose from deoxyribose, and it survives
        // any modification of the base itself
        const nucleicType = atomNamed("O2'", "O2*") ? 'R' : 'D';
        if (allResidues) {
            if (isResidueConnected(residue, allResidues, nucleicType)) {
                return nucleicType;
            }
            return null;
        }
        return nucleicType;
    }

    // No other cases - return null (removed all "last resort" checks and NUCLEOTIDE_LIGANDS exclusion)
    return null;
}

/**
 * Map modified residue codes to their parent types
 * Returns 'P' for protein, 'D' for DNA, 'R' for RNA, or null if not a modified standard residue
 */
function getModifiedResidueType(resName) {
    // Simplified mapping of common modified residues to their parent types
    // Only includes the most common modifications (e.g., MSE->MET)
    // Format: modified_code -> {type: 'P'|'D'|'R', parent: standard_code}
    const modifiedResidueMap = {
        // Common modified amino acids (protein)
        'MSE': { type: 'P', parent: 'MET' }, // Selenomethionine (most common)
        'PTR': { type: 'P', parent: 'TYR' }, // Phosphotyrosine
        'SEP': { type: 'P', parent: 'SER' }, // Phosphoserine
        'TPO': { type: 'P', parent: 'THR' }, // Phosphothreonine
        'FME': { type: 'P', parent: 'MET' }, // N-formylmethionine
        'HYP': { type: 'P', parent: 'PRO' }, // 4-hydroxyproline
        'PCA': { type: 'P', parent: 'GLU' }, // Pyroglutamic acid
        'ALY': { type: 'P', parent: 'LYS' }, // N-acetyllysine
        // D-AMINO ACIDS. Deposited as HETATM with no MODRES record (5KX0), so
        // nothing above matched and they were dropped from the chain - that
        // structure lost 11 of its 26 residues and the backbone broke at each
        // one. gemmi tabulates all of these as amino acids, so the Python path
        // already handled them; this is what the web parser was missing.
        // GLY is achiral and has no D form.
        'DAL': { type: 'P', parent: 'ALA' }, // D-alanine
        'DAR': { type: 'P', parent: 'ARG' }, // D-arginine
        'DSG': { type: 'P', parent: 'ASN' }, // D-asparagine
        'DAS': { type: 'P', parent: 'ASP' }, // D-aspartic acid
        'DCY': { type: 'P', parent: 'CYS' }, // D-cysteine
        'DGN': { type: 'P', parent: 'GLN' }, // D-glutamine
        'DGL': { type: 'P', parent: 'GLU' }, // D-glutamic acid
        'DHI': { type: 'P', parent: 'HIS' }, // D-histidine
        'DIL': { type: 'P', parent: 'ILE' }, // D-isoleucine
        'DLE': { type: 'P', parent: 'LEU' }, // D-leucine
        'DLY': { type: 'P', parent: 'LYS' }, // D-lysine
        'MED': { type: 'P', parent: 'MET' }, // D-methionine
        'DPN': { type: 'P', parent: 'PHE' }, // D-phenylalanine
        'DPR': { type: 'P', parent: 'PRO' }, // D-proline
        'DSN': { type: 'P', parent: 'SER' }, // D-serine
        'DTH': { type: 'P', parent: 'THR' }, // D-threonine
        'DTR': { type: 'P', parent: 'TRP' }, // D-tryptophan
        'DTY': { type: 'P', parent: 'TYR' }, // D-tyrosine
        'DVA': { type: 'P', parent: 'VAL' }, // D-valine
        // Common modified nucleotides (DNA)
        '5MDA': { type: 'D', parent: 'DA' }, // 5-methyldeoxyadenosine
        '5MDC': { type: 'D', parent: 'DC' }, // 5-methyldeoxycytidine
        '5MDG': { type: 'D', parent: 'DG' }, // 5-methyldeoxyguanosine
        // Common modified nucleotides (RNA)
        'M6A': { type: 'R', parent: 'A' }, // N6-methyladenosine
        'M5C': { type: 'R', parent: 'C' }, // 5-methylcytidine
        'M7G': { type: 'R', parent: 'G' }, // 7-methylguanosine
        'PSU': { type: 'R', parent: 'U' }  // Pseudouridine
    };

    return modifiedResidueMap[resName] || null;
}

/**
 * Get the standard (unmodified) residue name for a given residue
 * Maps modified residues (e.g., MSE) to their standard equivalents (e.g., MET)
 * @param {string} resName - Residue name (may be modified)
 * @returns {string} - Standard residue name, or original if not a known modification
 */
function getStandardResidueName(resName) {
    if (!resName) return resName;

    // Check if it's a standard residue (no modification needed)
    if (STANDARD_AMINO_ACIDS.has(resName) || STANDARD_NUCLEIC_ACIDS.has(resName)) {
        return resName;
    }

    // Check if it's a known modification
    const modifiedType = getModifiedResidueType(resName);
    if (modifiedType && modifiedType.parent) {
        return modifiedType.parent;
    }

    // Check MODRES map (from PDB)
    if (typeof window !== 'undefined' && window._lastModresMap) {
        const modresMap = window._lastModresMap;
        if (modresMap.has(resName)) {
            const stdResName = modresMap.get(resName);
            if (STANDARD_AMINO_ACIDS.has(stdResName) || STANDARD_NUCLEIC_ACIDS.has(stdResName)) {
                return stdResName;
            }
        }
    }

    // Check CIF chemical component map
    if (typeof window !== 'undefined' && window._lastChemCompMap) {
        const chemCompMap = window._lastChemCompMap;
        if (chemCompMap.has(resName)) {
            const compInfo = chemCompMap.get(resName);
            const stdResName = compInfo.stdResName || compInfo.parent;
            if (stdResName && (STANDARD_AMINO_ACIDS.has(stdResName) || STANDARD_NUCLEIC_ACIDS.has(stdResName))) {
                return stdResName;
            }
        }
    }

    // Not a known modification, return original
    return resName;
}

// ============================================================================
// LIGAND GROUPING UTILITIES
// ============================================================================

/**
 * Create a unique key for a ligand group
 * @param {string} chain - Chain ID
 * @param {number} resSeq - Position index (residue sequence number)
 * @param {string} resName - Position name (residue name, optional)
 * @param {number} atomIndex - Position index (fallback)
 * @returns {string} - Ligand group key
 */
function createLigandGroupKey(chain, resSeq, resName, atomIndex) {
    if (resName) {
        // Primary: chain + resSeq + resName (most specific)
        return `${chain}:${resSeq}:${resName}`;
    } else if (resSeq !== undefined && resSeq !== null) {
        // Secondary: chain + resSeq
        return `${chain}:${resSeq}`;
    } else {
        // Fallback: chain + atomIndex (for consecutive atoms)
        return `${chain}:${atomIndex}`;
    }
}

/**
 * Group ligand atoms into ligand groups based on chain, residue_numbers, and position_names
 * @param {Array<string>} chains - Array of chain IDs for each position
 * @param {Array<string>} positionTypes - Array of position types ('P', 'D', 'R', 'L')
 * @param {Array<number>} residueNumbers - Array of PDB residue sequence numbers (optional)
 * @param {Array<string>} positionNames - Array of position names (optional)
 * @returns {Map<string, Array<number>>} - Map of ligand group keys to arrays of position indices
 * 
 * Grouping priority:
 * 1. If position_name available: "chain:resSeq:resName"
 * 2. If only residue_numbers available: "chain:resSeq"
 * 3. If neither available: "chain:firstPositionIdx" (groups consecutive atoms)
 */
function groupLigandAtoms(chains, positionTypes, residueNumbers, positionNames) {
    const ligandGroups = new Map();

    if (!chains || !positionTypes || chains.length !== positionTypes.length) {
        return ligandGroups; // Return empty map if invalid data
    }

    const hasResidueNumbers = residueNumbers && residueNumbers.length === chains.length;
    const hasPositionNames = positionNames && positionNames.length === chains.length;

    // Detect if residue_numbers appears to be default sequential values (1, 2, 3, ...)
    // This happens when residue_numbers was missing and defaults were created
    let isDefaultSequential = false;
    if (hasResidueNumbers) {
        // Check if all values are strictly sequential starting from 1
        isDefaultSequential = residueNumbers.every((val, idx) => val === idx + 1);
    }

    // For ligands, if residue_numbers is default sequential AND positionNames are missing or all 'UNK',
    // treat it as if residue_numbers is missing (use fallback grouping)
    const useFallbackGrouping = !hasResidueNumbers ||
        (isDefaultSequential && (!hasPositionNames || positionNames.every(r => !r || r === 'UNK')));

    // If using fallback grouping, group ALL ligand atoms in each chain as one ligand
    if (useFallbackGrouping) {
        // Group by chain: all ligand atoms in same chain = one ligand group
        const chainLigandGroups = new Map(); // chain -> array of position indices

        for (let i = 0; i < positionTypes.length; i++) {
            if (positionTypes[i] === 'L') {
                const chain = chains[i];
                if (!chainLigandGroups.has(chain)) {
                    chainLigandGroups.set(chain, []);
                }
                chainLigandGroups.get(chain).push(i);
            }
        }

        // Create group keys for each chain's ligand atoms
        for (const [chain, positionIndices] of chainLigandGroups) {
            if (positionIndices.length > 0) {
                // Use first position index as the group key identifier
                const groupKey = createLigandGroupKey(chain, null, null, positionIndices[0]);
                ligandGroups.set(groupKey, positionIndices);
            }
        }
    } else {
        // Normal grouping: use residue_numbers and position names when available
        for (let i = 0; i < positionTypes.length; i++) {
            if (positionTypes[i] === 'L') {
                const chain = chains[i];
                const residueNum = hasResidueNumbers ? residueNumbers[i] : null;
                const positionName = hasPositionNames ? positionNames[i] : null;

                // Create group key based on available data
                let groupKey;
                if (positionName && positionName !== 'UNK') {
                    // Primary: use chain + residueNum + positionName
                    groupKey = createLigandGroupKey(chain, residueNum, positionName, i);
                } else if (residueNum !== undefined && residueNum !== null) {
                    // Secondary: use chain + residueNum
                    groupKey = createLigandGroupKey(chain, residueNum, null, i);
                } else {
                    // Should not happen if useFallbackGrouping is false, but handle gracefully
                    groupKey = createLigandGroupKey(chain, null, null, i);
                }

                // Add position to ligand group
                if (!ligandGroups.has(groupKey)) {
                    ligandGroups.set(groupKey, []);
                }
                ligandGroups.get(groupKey).push(i);
            }
        }
    }

    return ligandGroups;
}

/**
 * Expand position selection to include all positions in any ligand groups that contain selected positions
 * @param {Set<number>|Array<number>} positionIndices - Selected position indices
 * @param {Map<string, Array<number>>} ligandGroups - Ligand groups from groupLigandAtoms()
 * @returns {Set<number>} - Expanded set of position indices
 */
function expandLigandSelection(positionIndices, ligandGroups) {
    const expandedPositions = new Set(positionIndices);

    if (!ligandGroups || ligandGroups.size === 0) {
        return expandedPositions; // No ligand groups, return original selection
    }

    // Create reverse map: position index -> ligand group key
    const positionToGroup = new Map();
    for (const [groupKey, positionIndicesInGroup] of ligandGroups) {
        for (const positionIdx of positionIndicesInGroup) {
            positionToGroup.set(positionIdx, groupKey);
        }
    }

    // Find all ligand groups that contain selected positions
    const selectedGroups = new Set();
    for (const positionIdx of positionIndices) {
        if (positionToGroup.has(positionIdx)) {
            selectedGroups.add(positionToGroup.get(positionIdx));
        }
    }

    // Add all positions from selected ligand groups
    for (const groupKey of selectedGroups) {
        const positionsInGroup = ligandGroups.get(groupKey);
        if (positionsInGroup) {
            for (const positionIdx of positionsInGroup) {
                expandedPositions.add(positionIdx);
            }
        }
    }

    return expandedPositions;
}

/**
 * Convert parsed atoms to frame data format, omitting keys for data that is not present.
 * @param {Array<object>} atoms - Parsed atoms
 * @param {Map} modresMap - Optional MODRES mapping from PDB (resName -> stdResName)
 * @param {Map} chemCompMap - Optional chemical component map from CIF
 * @param {boolean} includeAllResidues - If true, include all residues (even unconnected) for PAE mapping. If false, filter based on connectivity.
 * @param {Map} conectMap - Optional CONECT mapping from PDB (atom serial -> [bonded atom serials])
 * @param {Array} structConn - Optional _struct_conn array from CIF
 * @param {Map} chemCompBondMap - Optional chemical component bond map (resName -> {atom1, atom2, order}[])
 * @returns {object} - Frame data with coords, and optional plddts, chains, position_types, bonds
 */
function normalizePlddt(value) {
    // If plddt is in 0-1 range, multiply by 100 to get 0-100 range
    if (typeof value === 'number' && !isNaN(value) && value >= 0 && value <= 1) {
        return value * 100;
    }
    return value;
}

/**
 * The element symbol for one parsed atom.
 *
 * THE COLUMN FIRST, ALWAYS. A PDB file names it in columns 77-78 and an mmCIF
 * in type_symbol, and that is the only place the two-letter elements can be
 * read reliably: a ligand atom called CL is chlorine in one file and a carbon
 * in another (haem names its four nitrogens NA, NB, NC, ND), and no rule over
 * names alone tells them apart.
 *
 * So when the column is silent - old PDB files leave it blank - this takes the
 * FIRST LETTER and stops. That reads chlorine as carbon, which is exactly what
 * the drawing did before any of this existed, and never invents a sodium out
 * of a nitrogen. The colour table only names N, O, S and SE, so a first-letter
 * guess is either right or uncoloured; a two-letter guess could be wrong AND
 * coloured.
 *
 * @param {object} atom - a parsed atom, with .element and .atomName
 * @returns {string} an uppercase symbol, or '' if there is nothing to go on
 */
function elementOfAtom(atom) {
    const col = (atom.element || '').trim().toUpperCase();
    if (col) return col;
    const m = /[A-Za-z]/.exec(atom.atomName || '');
    return m ? m[0].toUpperCase() : '';
}

// CONVERSION, ALSO IN SLICES. Same reason as parseCIFSteps: this is half a
// second on a capsid, made of five passes of 20-200 ms each, and run as one
// block it is half a second in which the browser produces no frames and the
// progress line is a still picture. Yielding a fraction between the passes -
// and inside the long one - is what lets it keep moving.
function* convertParsedToFrameDataSteps(atoms, modresMap = null, chemCompMap = null, includeAllResidues = false, conectMap = null, structConn = null, chemCompBondMap = null) {
    const coords = [];
    const plddts = [];
    const position_chains = [];
    const position_types = [];
    const residues = [];
    const residue_numbers = [];
    // ONE ENTRY PER POSITION, and empty for everything that is not a ligand
    // atom. A backbone position stands for a whole residue - "the atom" there
    // is the alpha carbon or the C4', which is a fact about the model rather
    // than about the file - so only the ligand branch, where a position IS an
    // atom, has a name and an element to record.
    const position_atoms = [];
    const position_elements = [];

    // Map atom serial/ID to new index in coords array
    const atomSerialToIndex = new Map();
    // Also map chain:seq:atomName to index for CIF struct_conn resolution
    const atomIdToIndex = new Map();
    // the residues that contribute more than one position - see the ligand
    // branch below, and the chem_comp_bond pass that consumes this
    const multiAtomResidues = [];

    const residueMap = new Map();
    // ATOMS ARRIVE IN RESIDUE ORDER. Building the key costs a string
    // concatenation and a hash per atom, and a 2.4 M-atom file spends it
    // 1.5 M times to name the same few hundred thousand residues. Almost
    // every atom belongs to the same residue as the one before it, and
    // three field compares settle that without touching the map. The map
    // is still there for the atoms that don't - a residue interrupted and
    // resumed later in the file lands back in its own group, exactly as
    // before.
    let runChain = null, runSeq = null, runName = null, runResidue = null;
    for (const atom of atoms) {
        if (atom.resName === 'HOH') continue;
        let residue;
        if (runResidue !== null && atom.chain === runChain
            && atom.resSeq === runSeq && atom.resName === runName) {
            residue = runResidue;
        } else {
        const resKey = atom.chain + ':' + atom.resSeq + ':' + atom.resName;
        residue = residueMap.get(resKey);
        if (!residue) {
            residue = {
                atoms: [],
                resName: atom.resName,
                chain: atom.chain,
                record: atom.record,
                resSeq: atom.resSeq,
                caAtom: null, // Cache CA atom for proteins
                c4Atom: null  // Cache C4' atom for nucleic acids
            };
            residueMap.set(resKey, residue);
        }
        runChain = atom.chain; runSeq = atom.resSeq; runName = atom.resName;
        runResidue = residue;
        }
        residue.atoms.push(atom);

        // Cache CA and C4' atoms during building to avoid .find() later
        if (!residue.caAtom && atom.atomName === 'CA') {
            residue.caAtom = atom;
        }
        if (!residue.c4Atom && (atom.atomName === "C4'" || atom.atomName === "C4*")) {
            residue.c4Atom = atom;
        }
    }

    yield 0.25;
    // Convert residueMap to array for connectivity checks
    const allResidues = Array.from(residueMap.values());

    // Sort residues by chain and resSeq for proper neighbor checking
    allResidues.sort((a, b) => {
        if (a.chain !== b.chain) {
            return a.chain.localeCompare(b.chain);
        }
        return a.resSeq - b.resSeq;
    });

    yield 0.4;
    // One DNA/RNA answer per chain - see resolveChainNucleicTypes.
    const chainNucleic = resolveChainNucleicTypes(allResidues);

    // Side-chain capture. Recorded here because this is the only moment the
    // atoms exist: the loop below keeps one CA per residue and everything else
    // is dropped, and the file text is not retained, so an atom not taken now
    // cannot be recovered later. The table it builds is never read by the
    // draw path unless a residue is actually selected - see buildSidechainTable.
    yield 0.45;
    const sidechainEntries = [];
    const CONVERT_SLICE_RESIDUES = 60000;
    for (let idx = 0; idx < allResidues.length; idx++) {
        if (idx > 0 && idx % CONVERT_SLICE_RESIDUES === 0) {
            yield 0.45 + 0.30 * (idx / allResidues.length);
        }
        const residue = allResidues[idx];

        // Use unified classification functions
        // If includeAllResidues is true, skip connectivity checks (for PAE mapping)
        // Otherwise, use connectivity checks (for normal filtering)
        let is_protein, nucleicType;
        if (includeAllResidues) {
            // For PAE mapping: include all residues, skip connectivity checks
            is_protein = isRealAminoAcid(residue, modresMap, chemCompMap, null, -1);
            nucleicType = isRealNucleicAcid(residue, modresMap, chemCompMap, null, -1);
        } else {
            // Normal mode: use connectivity checks
            is_protein = isRealAminoAcid(residue, modresMap, chemCompMap, allResidues, idx);
            nucleicType = isRealNucleicAcid(residue, modresMap, chemCompMap, allResidues, idx);
        }
        // Whether it IS a nucleotide is per residue; which KIND it is falls
        // back to the chain when the residue itself gave no evidence. A
        // residue that did keep its own answer, so a genuine chimera - the
        // deoxyadenosine in 1VQ8's CCdA-p-Puro inhibitor - survives intact.
        if (nucleicType && !nucleicSugarVote(residue.resName, residue)
            && chainNucleic.has(residue.chain)) {
            nucleicType = chainNucleic.get(residue.chain);
        }

        if (is_protein) {
            // Use cached CA atom instead of .find()
            const ca = residue.caAtom || residue.atoms.find(a => a.atomName === 'CA');
            if (ca) {
                const newIndex = coords.length;
                coords.push([ca.x, ca.y, ca.z]);
                plddts.push(normalizePlddt(ca.b));
                position_chains.push(ca.chain);
                position_types.push('P');
                residues.push(ca.res_name || ca.resName || residue.resName);
                residue_numbers.push(ca.res_seq || ca.resSeq || residue.resSeq);
                sidechainEntries.push({ pos: newIndex, residue });

                // Map serial/ID to new index
                if (ca.serial !== undefined) atomSerialToIndex.set(ca.serial, newIndex);
                // Map ID for CIF resolution
                const idKey = `${ca.chain}:${ca.resSeq}:${ca.atomName}`;
                atomIdToIndex.set(idKey, newIndex);
            }
        } else if (nucleicType) {
            // Use cached C4' atom instead of .find()
            const c4_atom = residue.c4Atom || residue.atoms.find(a => a.atomName === "C4'" || a.atomName === "C4*");
            if (c4_atom) {
                const newIndex = coords.length;
                coords.push([c4_atom.x, c4_atom.y, c4_atom.z]);
                plddts.push(normalizePlddt(c4_atom.b));
                position_chains.push(c4_atom.chain);
                position_types.push(nucleicType);
                residues.push(c4_atom.res_name || c4_atom.resName || residue.resName);
                residue_numbers.push(c4_atom.res_seq || c4_atom.resSeq || residue.resSeq);

                // A BASE IS A SIDE CHAIN. Same machinery as a protein's:
                // coefficients in the residue's local frame, materialised as
                // positions when the user asks for them. The plate stays what
                // it always was - a schematic - and this is the real thing
                // beside it.
                sidechainEntries.push({ pos: newIndex, residue, nucleic: true });

                // Map serial/ID to new index
                if (c4_atom.serial !== undefined) atomSerialToIndex.set(c4_atom.serial, newIndex);
                // Map ID for CIF resolution
                const idKey = `${c4_atom.chain}:${c4_atom.resSeq}:${c4_atom.atomName}`;
                atomIdToIndex.set(idKey, newIndex);
            }
        } else if (includeAllResidues || residue.record === 'HETATM') {
            // If includeAllResidues is true, include everything (even unclassified residues)
            // Otherwise, only include HETATM records as ligands
            // For ligands or unclassified residues, use all non-H atoms (like Python code)
            // A LIGAND IS THE ONLY RESIDUE THAT PUTS MORE THAN ONE ATOM IN
            // coords, and therefore the only one that can carry an
            // intra-residue bond. Noted here so the chem_comp_bond pass below
            // does not have to walk every residue in the structure to find out.
            multiAtomResidues.push(residue);
            for (const atom of residue.atoms) {
                if (atom.element !== 'H' && atom.element !== 'D') {
                    const newIndex = coords.length;
                    coords.push([atom.x, atom.y, atom.z]);
                    plddts.push(normalizePlddt(atom.b));
                    position_chains.push(atom.chain);
                    position_types.push('L');
                    // Written by index rather than pushed: the other branches
                    // have no atom to name, and padding them with a blank at
                    // every push is three more places to get the alignment
                    // wrong. Filled in below.
                    position_atoms[newIndex] = atom.atomName || '';
                    position_elements[newIndex] = elementOfAtom(atom);
                            residues.push(atom.res_name || atom.resName || residue.resName);
                    residue_numbers.push(atom.res_seq || atom.resSeq || residue.resSeq);

                    // Map serial/ID to new index
                    if (atom.serial !== undefined) atomSerialToIndex.set(atom.serial, newIndex);
                    // Map ID for CIF resolution
                    const idKey = `${atom.chain}:${atom.resSeq}:${atom.atomName}`;
                    atomIdToIndex.set(idKey, newIndex);
                }
            }
        }
    }

    // Resolve explicit bonds
    const bonds = [];

    // 1. Process PDB CONECT records
    if (conectMap && conectMap.size > 0) {
        const processedBonds = new Set(); // Track processed pairs to avoid duplicates

        for (const [serial1, bondedSerials] of conectMap.entries()) {
            const idx1 = atomSerialToIndex.get(serial1);
            if (idx1 === undefined) continue;

            for (const serial2 of bondedSerials) {
                const idx2 = atomSerialToIndex.get(serial2);
                if (idx2 === undefined) continue;

                // Sort indices to ensure unique key for undirected bond
                const minIdx = Math.min(idx1, idx2);
                const maxIdx = Math.max(idx1, idx2);
                const bondKey = `${minIdx}-${maxIdx}`;

                if (!processedBonds.has(bondKey)) {
                    bonds.push([minIdx, maxIdx]);
                    processedBonds.add(bondKey);
                }
            }
        }
    }

    // 2. Process CIF _struct_conn records
    if (structConn && structConn.length > 0) {
        const processedBonds = new Set();

        for (const conn of structConn) {
            const key1 = `${conn.chain1}:${conn.seq1}:${conn.atom1}`;
            const key2 = `${conn.chain2}:${conn.seq2}:${conn.atom2}`;

            const idx1 = atomIdToIndex.get(key1);
            const idx2 = atomIdToIndex.get(key2);

            if (idx1 !== undefined && idx2 !== undefined) {
                const minIdx = Math.min(idx1, idx2);
                const maxIdx = Math.max(idx1, idx2);
                const bondKey = `${minIdx}-${maxIdx}`;
                if (!processedBonds.has(bondKey)) {
                    bonds.push([minIdx, maxIdx]);
                    processedBonds.add(bondKey);
                }
            }
        }
    }

    // 3. Process explicit bonds from _chem_comp_bond (CIF component bonds)
    if (chemCompBondMap && chemCompBondMap.size > 0) {
        // Group atoms by residue unique ID (chain:resSeq:resName)
        // WHICH POSITION EACH NAMED ATOM BECAME. The component table names its
        // bonds by ATOM NAME within a residue, and coords is indexed by
        // position - so the lookup goes through atomIdToIndex, which is keyed
        // chain:resSeq:atomName and holds only the atoms that made it in.

        const processedBonds = new Set(); // To avoid duplicate bonds from this source

        // ONLY THE RESIDUES THAT CAN HAVE ONE.
        //
        // This walked every residue in the structure and, for each bond its
        // component defines, built three template literals to look two atoms up
        // by name. A protein residue contributes exactly ONE position - its CA -
        // so both ends of an intra-residue bond can never be found and the work
        // is spent proving that. On 3J3Q it was 313,236 residues x ~15 bonds =
        // 4.7 million lookups and 14 million strings, 2.06 s of a 3.3 s
        // conversion, to produce nothing at all.
        //
        // Only a ligand puts more than one atom in coords, so only a ligand can
        // carry one of these bonds. Same bonds out, over the handful of
        // residues that can actually have them.
        for (const residue of multiAtomResidues) {
            const resName = residue.resName;
            if (chemCompBondMap.has(resName)) {
                const bondsInComp = chemCompBondMap.get(resName);
                for (const bondDef of bondsInComp) {
                    const atomName1 = bondDef.atom1;
                    const atomName2 = bondDef.atom2;

                    // Find the indices in `coords` for these two atoms within this residue
                    const idKey1 = `${residue.chain}:${residue.resSeq}:${atomName1}`;
                    const idKey2 = `${residue.chain}:${residue.resSeq}:${atomName2}`;

                    const idx1 = atomIdToIndex.get(idKey1);
                    const idx2 = atomIdToIndex.get(idKey2);

                    if (idx1 !== undefined && idx2 !== undefined) {
                        const minIdx = Math.min(idx1, idx2);
                        const maxIdx = Math.max(idx1, idx2);
                        const bondKey = `${minIdx}-${maxIdx}`;

                        if (!processedBonds.has(bondKey)) {
                            bonds.push([minIdx, maxIdx]);
                            processedBonds.add(bondKey);
                        }
                    }
                }
            }
        }
    }
    // The holes left by the by-index writes above become blanks, so the arrays
    // are as long as the coordinates and every consumer can index them
    // directly. Attached only when something actually filled one: a structure
    // with no ligand would otherwise carry two arrays of nothing per frame.
    let anyAtomNames = false;
    for (let i = 0; i < coords.length; i++) {
        if (position_atoms[i]) anyAtomNames = true; else position_atoms[i] = '';
        if (!position_elements[i]) position_elements[i] = '';
    }

    const result = { coords, atomIdToIndex };
    if (anyAtomNames) {
        result.position_atoms = position_atoms;
        result.position_elements = position_elements;
    }

    if (bonds.length > 0) {
        result.bonds = bonds;
    }

    if (position_types.length > 0) {
        result.position_types = position_types;
    }
    // Include plddts if at least one value is not NaN
    // Note: 0 is a valid pLDDT value, so we only exclude if all are NaN
    // Assume pLDDT values are always in 0-100 range
    if (plddts.length > 0 && plddts.some(v => !isNaN(v))) {
        result.plddts = plddts;
    } else if (plddts.length > 0) {
        // If we have plddts array but all are NaN, still include it
        // (might be useful for debugging or default values)
        // But only if we actually tried to extract plddts (array is not empty)
        console.warn('All pLDDT values are NaN - B-factor column may be empty in PDB file');
    }

    if (position_chains.length > 0) {
        result.chains = position_chains;
    }
    if (residues.some(r => r && r.trim())) {
        result.position_names = residues;
    }
    if (residue_numbers.some(i => !isNaN(i))) {
        result.residue_numbers = residue_numbers;
    }

    yield 0.75;
    const sidechains = buildSidechainTable(coords, sidechainEntries);
    if (sidechains) {
        result.sidechains = sidechains;
    }

    return result;
}

// Drained in one go - exactly the old convertParsedToFrameData.
function convertParsedToFrameData(...args) {
    const it = convertParsedToFrameDataSteps(...args);
    let r = it.next();
    while (!r.done) r = it.next();
    return r.value;
}

// Drained a slice at a time, reporting how far through it is.
// ...and the same for the converter: sliced so the browser can have a turn,
// with nothing to report but the step it is on, which the loader names.
async function convertParsedToFrameDataAsync(...args) {
    const it = convertParsedToFrameDataSteps(...args);
    for (;;) {
        const r = it.next();
        if (r.done) return r.value;
        await yieldIfBusy();
    }
}

/**
 * Filter PAE matrix to remove ligand positions
 * @param {Array<Array<number>>} paeData - Original PAE matrix
 * @param {Array<boolean>} isLigandPosition - Boolean array indicating ligand positions
 * @returns {Array<Array<number>>} - Filtered PAE matrix
 */
function filterPAEForLigands(paeData, isLigandPosition) {
    if (!paeData || !isLigandPosition || isLigandPosition.length === 0) {
        // If TypedArray, return copy
        if (paeData && paeData.slice) return paeData.slice();
        return paeData ? paeData.map(row => [...row]) : null;
    }

    // Handle TypedArray (flat)
    if (paeData.buffer) {
        const n = Math.sqrt(paeData.length);
        // Calculate new size
        let newN = 0;
        for (let i = 0; i < isLigandPosition.length; i++) {
            if (!isLigandPosition[i]) newN++;
        }

        // If no ligands to filter, return copy
        if (newN === n) return paeData.slice();

        const filtered = new paeData.constructor(newN * newN);
        let r = 0;
        for (let i = 0; i < n; i++) {
            if (!isLigandPosition[i]) {
                let c = 0;
                for (let j = 0; j < n; j++) {
                    if (!isLigandPosition[j]) {
                        filtered[r * newN + c] = paeData[i * n + j];
                        c++;
                    }
                }
                r++;
            }
        }
        return filtered;
    }

    // Handle Array of Arrays (legacy)
    const filteredPae = [];
    for (let rowIdx = 0; rowIdx < paeData.length; rowIdx++) {
        if (!isLigandPosition[rowIdx]) {
            const filteredRow = [];
            for (let colIdx = 0; colIdx < paeData[rowIdx].length; colIdx++) {
                if (!isLigandPosition[colIdx]) {
                    filteredRow.push(paeData[rowIdx][colIdx]);
                }
            }
            filteredPae.push(filteredRow);
        }
    }
    return filteredPae;
}

/**
 * Fast extraction of PAE data from JSON text without full parsing.
 * Looks for "predicted_aligned_error": [[...]] pattern.
 * @param {string} text - JSON text
 * @returns {Uint8Array|null} - Flattened PAE matrix as Uint8Array or null
 */
function fastExtractPaeFromText(text) {
    if (!text) return null;

    // Find start of predicted_aligned_error
    // We look for "predicted_aligned_error" followed by optional whitespace and colon and [[
    const match = /"predicted_aligned_error"\s*:\s*\[\s*\[/.exec(text);
    if (!match) return null;

    const startIdx = match.index + match[0].length - 1; // Point to the first [ of [[

    // We need to parse the array of arrays.
    // Since we want to avoid full JSON parse, we can try to extract just this section.
    // However, counting brackets is safer.

    let bracketCount = 0;
    let endIdx = -1;
    let inString = false;
    let escape = false;

    for (let i = startIdx; i < text.length; i++) {
        const char = text[i];

        if (escape) {
            escape = false;
            continue;
        }

        if (char === '\\') {
            escape = true;
            continue;
        }

        if (char === '"') {
            inString = !inString;
            continue;
        }

        if (!inString) {
            if (char === '[') {
                bracketCount++;
            } else if (char === ']') {
                bracketCount--;
                if (bracketCount === 0) {
                    endIdx = i + 1;
                    break;
                }
            }
        }
    }

    if (endIdx === -1) return null;

    const paeJson = text.substring(startIdx, endIdx);

    try {
        // Parse just the matrix part
        const paeMatrix = JSON.parse(paeJson);
        return flattenPaeToArray(paeMatrix);
    } catch (e) {
        console.warn("Fast PAE parse failed, falling back", e);
        return null;
    }
}

/**
 * Helper to flatten and scale PAE matrix to Uint8Array
 */
function flattenPaeToArray(paeMatrix) {
    if (!Array.isArray(paeMatrix) || paeMatrix.length === 0) return null;

    const n = paeMatrix.length;
    const totalSize = n * n;
    const flattened = new Uint8Array(totalSize);

    for (let i = 0; i < n; i++) {
        const row = paeMatrix[i];
        if (!Array.isArray(row)) return null; // Should be square matrix

        const rowLen = row.length;
        const len = Math.min(n, rowLen);

        for (let j = 0; j < len; j++) {
            // Scale: val * 8 (max 31.75 * 8 = 254)
            // Clamp to 0-255
            let val = Math.round(row[j] * 8);
            if (val > 255) val = 255;
            if (val < 0) val = 0;
            flattened[i * n + j] = val;
        }
    }
    return flattened;
}

/**
 * Extract PAE matrix from JSON object and flatten it to Uint8Array
 * @param {object} json - PAE JSON data
 * @returns {Uint8Array|null} - Flattened PAE matrix or null
 */
function extractPaeFromJSON(json) {
    try {
        // 1. Check for pre-extracted format (our optimization)
        if (json.is_pae_extracted && json.data) {
            if (json.data instanceof Uint8Array) {
                return json.data;
            }
            return new Uint8Array(json.data);
        }

        let paeMatrix = null;

        // 2. Standard AlphaFold format: [{ "predicted_aligned_error": [[...]] }]
        if (Array.isArray(json) && json.length > 0 && json[0].predicted_aligned_error) {
            paeMatrix = json[0].predicted_aligned_error;
        }
        // 3. Object format: { "predicted_aligned_error": [[...]] }
        else if (json.predicted_aligned_error) {
            paeMatrix = json.predicted_aligned_error;
        }
        // 4. "pae" key format (some variations)
        else if (json.pae) {
            paeMatrix = json.pae;
        }

        if (!paeMatrix) {
            // It might be that 'json' IS the matrix (array of arrays)
            if (Array.isArray(json) && json.length > 0 && Array.isArray(json[0])) {
                // Heuristic: check if it looks like a square matrix of numbers
                if (json.length === json[0].length && typeof json[0][0] === 'number') {
                    paeMatrix = json;
                }
            }
        }

        if (!paeMatrix) {
            // console.warn("Could not find PAE matrix in JSON.");
            return null;
        }

        return flattenPaeToArray(paeMatrix);

    } catch (e) {
        console.error("Error extracting PAE matrix:", e);
        return null;
    }
}
/**
 * Clean object name by removing file extensions
 * @param {string} name - Original name
 * @returns {string} - Cleaned name
 */
function cleanObjectName(name) {
    return name.replace(/\.(cif|pdb|ent|zip)$/i, '');
}

/**
 * Extract ligand bonds using distance-based method
 * Uses atomic coordinates to determine which atoms are bonded
 * @param {Array<object>} atoms - Parsed atoms (filtered, matching frameData)
 * @param {object} frameData - Frame data with position_types, coords
 * @returns {Array<Array>} - Array of bonds [[idx1, idx2], ...]
 */
function extractLigandBondsFromAtoms(atoms, frameData) {
    const bonds = [];

    if (!frameData || !frameData.position_types || !frameData.coords || atoms.length === 0) {
        return bonds;
    }

    const { position_types, coords, atomIdToIndex } = frameData;

    // Build a map: residue -> list of (atom, posIndex) for atoms in that residue
    const residueMap = new Map();

    // If we don't have atomIdToIndex, we can't reliably map atoms to frame data
    if (!atomIdToIndex) {
        return bonds;
    }


    for (const atom of atoms) {
        if (atom.resName === 'HOH') continue;

        // Find the index of this atom in the frame data
        const idKey = `${atom.chain}:${atom.resSeq}:${atom.atomName}`;
        const posIndex = atomIdToIndex.get(idKey);

        if (posIndex === undefined) {
            // Atom was filtered out (e.g. protein sidechain atom not in CA-only model)
            continue;
        }


        const resKey = atom.chain + ':' + atom.resSeq + ':' + atom.resName;
        if (!residueMap.has(resKey)) {
            residueMap.set(resKey, []);
        }
        residueMap.get(resKey).push({ atom, posIndex: posIndex });
    }


    // Extract bonds for each residue using distance-based method
    const processedBonds = new Set(); // Prevent duplicates


    // Element-specific bond distance thresholds (in Å)
    // Based on typical covalent bond lengths + tolerance
    const getBondDistanceThreshold = (elem1, elem2) => {
        // Normalize element names to uppercase
        const e1 = (elem1 || '').toUpperCase();
        const e2 = (elem2 || '').toUpperCase();

        // Sort elements alphabetically for consistent lookup
        const [elemA, elemB] = e1 < e2 ? [e1, e2] : [e2, e1];
        const pair = `${elemA}-${elemB}`;

        // Common bond type maxima (with ~15% tolerance)
        const bondThresholds = {
            'C-C': 1.8,   // Single: 1.54, Double: 1.34, Triple: 1.20
            'C-N': 1.7,   // Single: 1.47, Double: 1.27, Triple: 1.16
            'C-O': 1.65,  // Single: 1.43, Double: 1.20
            'C-S': 2.1,   // Single: 1.82
            'C-P': 2.1,   // Single: 1.84
            'N-N': 1.7,   // Single: 1.45, Double: 1.25
            'N-O': 1.6,   // Single: 1.40
            'N-S': 2.0,   // Single: 1.68
            'O-O': 1.7,   // Single: 1.48
            'O-S': 2.0,   // Single: 1.70
            'O-P': 1.9,   // Single: 1.63
            'S-S': 2.4,   // Single: 2.05 (disulfide bonds!)
            'P-P': 2.5,   // Single: 2.21
            // Metal-ligand bonds (typically longer)
            'C-FE': 2.5, 'C-ZN': 2.5, 'C-MG': 2.5, 'C-CA': 2.8,
            'N-FE': 2.5, 'N-ZN': 2.5, 'N-MG': 2.5, 'N-CA': 2.8,
            'O-FE': 2.5, 'O-ZN': 2.5, 'O-MG': 2.5, 'O-CA': 2.8,
            'S-FE': 2.8, 'S-ZN': 2.8, 'S-MG': 2.8, 'S-CA': 3.0,
        };

        // Return specific threshold if found, otherwise use conservative default
        return bondThresholds[pair] || 2.0;
    };

    for (const [resKey, atomsInResidue] of residueMap) {
        // Only process ligand atoms
        const ligandAtoms = atomsInResidue.filter(a =>
            position_types[a.posIndex] === 'L' &&
            a.atom.element !== 'H' && a.atom.element !== 'D'
        );

        if (ligandAtoms.length > 1) {
            for (let i = 0; i < ligandAtoms.length; i++) {
                for (let j = i + 1; j < ligandAtoms.length; j++) {
                    const atom1 = ligandAtoms[i].atom;
                    const atom2 = ligandAtoms[j].atom;
                    const idx1 = ligandAtoms[i].posIndex;
                    const idx2 = ligandAtoms[j].posIndex;

                    // Calculate distance between atoms
                    const dx = atom1.x - atom2.x;
                    const dy = atom1.y - atom2.y;
                    const dz = atom1.z - atom2.z;
                    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

                    // Get element-specific bond distance threshold
                    const threshold = getBondDistanceThreshold(atom1.element, atom2.element);

                    // Check if distance is within bonding range (min 0.9 Å to avoid overlapping atoms)
                    if (0.9 < dist && dist < threshold) {
                        const minIdx = Math.min(idx1, idx2);
                        const maxIdx = Math.max(idx1, idx2);
                        const bondKey = minIdx + ',' + maxIdx;

                        if (!processedBonds.has(bondKey)) {
                            bonds.push([minIdx, maxIdx]);
                            processedBonds.add(bondKey);
                        }
                    }
                }
            }
        }
    }
    return bonds;
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
        // Faster whitespace skipping - avoid regex test
        while (i < n && (s[i] === ' ' || s[i] === '\t' || s[i] === '\r' || s[i] === '\n')) i++;
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
            // Faster non-whitespace check - avoid regex test
            while (j < n && s[j] !== ' ' && s[j] !== '\t' && s[j] !== '\r' && s[j] !== '\n') j++;
            const tok = s.slice(i, j);
            out.push(tok === '.' || tok === '?' ? '' : tok);
            i = j;
        }
    }
    return out;
}

/* Every loop_ in the file, as [columns, rows].
 *
 * `keepPrefixes`, when given, names the only loops whose ROWS the caller will
 * read. Every other loop is still found, and still delimits correctly - only
 * its contents are not tokenised or kept.
 *
 * A PDB-issued mmCIF has around 40 loops and parseCIF reads five of them. The
 * rest are metadata nobody here asks for - and one of them, _atom_site, IS the
 * structure: on 4UG0 that is 218,776 rows of 21 columns, 4.6 million
 * substrings, each row copied again with slice(), all retained, and then
 * dropped, because parseCIF has its own atom reader a few lines later.
 *
 * Measured cold on 4UG0: walking every loop was 2,698 ms of a 5,342 ms parse.
 * Naming only the loops that are read takes it to a fraction of that.
 *
 * parseCIF is now the only caller, and it always names its loops. Omitting the
 * list still means "every loop", which is what the biounit reader that used to
 * call it that way needed.
 */
/* tokenizeCIFLine_light, but it only KEEPS the columns asked for.
 *
 * Same rules - single and double quotes (nucleic atom names arrive as "O5'"),
 * and an unquoted . or ? means absent. The difference is that an unwanted
 * column is walked past rather than sliced out, which is the whole point: the
 * atom table is the one loop where the unwanted columns outnumber the wanted
 * ones and there are hundreds of thousands of rows.
 *
 * Writes into `out` and returns HOW MANY columns the row had - the caller needs
 * that, not out.length, because ragged rows are legal and are relied on (see
 * minReqLen).
 */
const CC_SPACE = 32;
const CC_TAB = 9;
const CC_LF = 10;
const CC_CR = 13;
const CC_HASH = 35;        // #
const CC_UNDERSCORE = 95;  // _
const CC_QUOTE = 39;      // '
const CC_DQUOTE = 34;     // "
const CC_DOT = 46;        // .
const CC_QMARK = 63;      // ?

function readCIFCols(s, from, n, wantMask, out, dropAfter, dropTest) {
    const maxCol = wantMask.length;
    let i = from;
    let col = 0;
    while (i < n) {
        // ABORT AS SOON AS THE ROW IS KNOWN TO BE UNWANTED.
        //
        // The atom loop drops a standard residue's N, C and O, and decides that
        // from two columns - the atom name and the residue name - that sit near
        // the front of the row. Deciding it after the scan means reading all 21
        // columns of _atom_site to throw the row away; deciding it here means
        // reading six. That is 38.6% of the rows in a capsid.
        //
        // -1 says "dropped", which no honest column count can be.
        if (col === dropAfter && dropTest(out)) return -1;
        // Char codes rather than s[i]. NOT because single-character strings
        // are expensive - V8 caches them, and measured on sliced line strings
        // the two were within 2% of each other. It is because this now scans a
        // RANGE of the parent text, where charCodeAt is the natural read and
        // s[i] would be comparing against a one-character string for every
        // character of a 24 MB file.
        let c = s.charCodeAt(i);
        while (i < n && (c === CC_SPACE || c === CC_TAB || c === CC_CR || c === CC_LF)) {
            c = s.charCodeAt(++i);
        }
        if (i >= n) break;
        const want = col < maxCol && wantMask[col] === 1;
        if (c === CC_QUOTE || c === CC_DQUOTE) {
            let j = ++i;
            while (j < n && s.charCodeAt(j) !== c) j++;
            if (want) out[col] = s.slice(i, j);
            i = j < n ? j + 1 : n;
        } else {
            let j = i;
            for (;;) {
                if (j >= n) break;
                const d = s.charCodeAt(j);
                if (d === CC_SPACE || d === CC_TAB || d === CC_CR || d === CC_LF) break;
                j++;
            }
            if (want) {
                // an unquoted single . or ? is CIF for "no value"
                out[col] = (j - i === 1 && (s.charCodeAt(i) === CC_DOT || s.charCodeAt(i) === CC_QMARK))
                    ? '' : s.slice(i, j);
            }
            i = j;
        }
        col++;
    }
    return col;
}


function parseMinimalCIF_light(text, keepPrefixes) {
    // SOUGHT, NOT WALKED.
    //
    // This is the pre-scan that finds the small metadata loops - struct_conn,
    // chem_comp, chem_comp_bond, the assembly operators. It used to read the
    // file from front to back, and on a capsid essentially all of that was
    // spent on the one loop it does not want: 2.4 million _atom_site rows,
    // each one tokenised just to learn how many tokens it had, so the walk
    // would still be in step when the loop ended.
    //
    // It does not need to be in step with a loop it is not reading. The tags
    // it wants can be found directly, and String.indexOf over the flat text is
    // a different order of thing from a per-line walk: 242 MB in 30-70 ms per
    // tag. So each wanted category is sought, the header block around the hit
    // is recovered by walking BACKWARDS over the tag lines above it, and only
    // the rows of loops actually being read are ever tokenised. The 2.4 M rows
    // are not visited at all.
    //
    // Consequence worth stating: the returned list now holds ONLY the loops
    // asked for. It used to carry a header-only entry for every other loop in
    // the file too, and nothing ever read them - `skipped` marked those and
    // had no consumer either.
    const n = text.length;
    const loops = [];
    if (!keepPrefixes || !keepPrefixes.length) return loops;
    const unread = (col) => !keepPrefixes.some((p) => col && col.startsWith(p));

    let i = 0;                       // cursor, always at the start of a line
    // A line's extent, and where the next one starts. The \r of a CRLF pair is
    // excluded so a range behaves exactly as split(/\r?\n/) did.
    let ls = 0, le = 0, next = 0;
    const takeLine = () => {
        ls = i;
        let e = text.indexOf('\n', i);
        if (e < 0) e = n;
        next = e + 1;
        if (e > ls && text.charCodeAt(e - 1) === CC_CR) e--;
        le = e;
    };
    // the first non-blank character of the current line, or -1
    const firstCh = () => {
        let p = ls;
        while (p < le) {
            const c = text.charCodeAt(p);
            if (c !== CC_SPACE && c !== CC_TAB) return p;
            p++;
        }
        return -1;
    };
    const startsWordAt = (p, word) => {
        if (p < 0 || p + word.length > le) return false;
        for (let k = 0; k < word.length; k++) {
            // BOTH SIDES FOLDED. Folding only the text breaks on '_': 95 | 32
            // is 127, so "loop_" never matched and every loop in the file was
            // missed. Folding both leaves non-letters equal to each other,
            // which is all this needs.
            if ((text.charCodeAt(p + k) | 32) !== (word.charCodeAt(k) | 32)) return false;
        }
        return true;
    };
    // start of the line above the one beginning at `p`, or -1 if there is none
    const lineAbove = (p) => {
        if (p <= 0) return -1;
        const nl = text.lastIndexOf('\n', p - 2);
        return nl < 0 ? 0 : nl + 1;
    };

    // Every line that opens a wanted category, in file order. A category is
    // written once, but seeking each prefix separately and merging keeps this
    // independent of how many times it appears.
    // The old walk asked whether a line's first NON-BLANK character began the
    // tag, so seeking "\n_struct_conn." instead would quietly stop matching an
    // indented header. Seeking the bare tag and then checking backwards that
    // only spaces and tabs separate it from the line start is the same
    // predicate, and it also throws out the tag appearing mid-line inside a
    // value.
    const hits = [];
    const atLineStart = (p) => {
        let k = p - 1;
        while (k >= 0) {
            const c = text.charCodeAt(k);
            if (c === CC_LF) return k + 1;
            if (c !== CC_SPACE && c !== CC_TAB) return -1;
            k--;
        }
        return 0;
    };
    for (const pfx of keepPrefixes) {
        let q = text.indexOf(pfx);
        while (q >= 0) {
            const s = atLineStart(q);
            if (s >= 0) hits.push(s);
            q = text.indexOf(pfx, q + 1);
        }
    }
    hits.sort((a, b) => a - b);

    const done = new Set();
    for (const hit of hits) {
        // Back up over the tag lines above the hit to the head of the block -
        // the wanted tag is rarely the first column of its own loop.
        let bs = hit;
        for (;;) {
            const above = lineAbove(bs);
            if (above < 0) break;
            i = above; takeLine();
            const f = firstCh();
            if (f < 0 || text.charCodeAt(f) !== CC_UNDERSCORE) break;
            bs = above;
        }
        if (done.has(bs)) continue;
        done.add(bs);

        // A block not introduced by `loop_` is a set of key-value items, which
        // this function never returned and no caller has ever asked for.
        const lp = lineAbove(bs);
        if (lp < 0) continue;
        i = lp; takeLine();
        const lf = firstCh();
        if (lf < 0 || !startsWordAt(lf, 'loop_')) continue;

        i = bs;
        const cols = [];
        while (i < n) {
            takeLine();
            const h = firstCh();
            if (h < 0 || text.charCodeAt(h) !== CC_UNDERSCORE) break;
            cols.push(text.slice(h, le).trim());
            i = next;
        }
        // the old rule, kept: a loop is read on the strength of its FIRST column
        if (unread(cols[0])) continue;

        const rows = [];
        // i is already at the first row: takeLine above left ls/le on it
        for (;;) {
            if (i >= n) break;
            takeLine();
            const r = firstCh();
            if (r < 0) break;
            const c0 = text.charCodeAt(r);
            if (c0 === CC_HASH || c0 === CC_UNDERSCORE
                    || startsWordAt(r, 'loop_') || startsWordAt(r, 'data_')) break;

            let vals = tokenizeCIFLine_light(text.slice(ls, le));
            i = next;
            // a row shorter than its header continues onto the next line
            while (vals.length < cols.length && i < n) {
                takeLine();
                vals = vals.concat(tokenizeCIFLine_light(text.slice(ls, le)));
                i = next;
            }

            if (vals.length >= cols.length) {
                rows.push(vals.slice(0, cols.length));
            }
        }
        loops.push([cols, rows]);
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

    // ADJACENT SETS, WRITTEN WITH NO SEPARATOR AT ALL.
    //
    // "(1-60)(61-88)" is a product of two operator sets - 1,680 operators -
    // and it is how large icosahedral assemblies are written; "(X0)(1-60)" is
    // the other common shape. Splitting a part on the letter x, as this did,
    // finds no separator in either, so the whole expression came back as one
    // operator id of "1-60)(61-88", which matches nothing in oper_list. The
    // assembly then silently collapses to the asymmetric unit: 1M4X loaded
    // 1,239 positions of its 2.08 million and said nothing.
    //
    // So groups are taken by bracket structure. A lone x or * between two of
    // them is still accepted, since some writers use one.
    const splitProduct = (p) => {
        const groups = [];
        let k = 0;
        while (k < p.length) {
            if (p[k] === '(') {
                const s = k;
                let depth = 0;
                for (; k < p.length; k++) {
                    if (p[k] === '(') depth++;
                    else if (p[k] === ')') { depth--; if (depth === 0) { k++; break; } }
                }
                groups.push(p.slice(s, k));
            } else {
                const s = k;
                while (k < p.length && p[k] !== '(') k++;
                let term = p.slice(s, k);
                if (term === 'x' || term === '*') continue;
                // a separator hanging off the end of a bare term, as in 1x(2-3)
                if ((term.endsWith('x') || term.endsWith('*')) && k < p.length) {
                    term = term.slice(0, -1);
                }
                if (term) groups.push(term);
            }
        }
        return groups;
    };

    const parts = splitTop(expr, ',');
    const seqs = [];

    for (const p of parts) {
        const groups = splitProduct(p);
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
        // RIGHTMOST SET APPLIED FIRST, which is what the dictionary means by
        // adjacent sets, and the reverse of the order composeBiounitOperations
        // walks - it applies a list left to right with the last one outermost.
        // Only products have more than one element, and products have never
        // worked until now, so nothing existing changes order under this.
        for (const seq of acc) seqs.push(seq.length > 1 ? seq.slice().reverse() : seq);
    }
    return seqs;
}

/**
 * Parse first biological assembly from PDB/CIF text
 * @param {string} text - Structure file content
 * @returns {object} - {atoms, meta}
 */
// ============================================================================
// UNIFIED BIOUNIT OPERATION EXTRACTION
// ============================================================================

/**
 * Extract biounit operations from PDB REMARK 350
 * @param {string} text - PDB file text
 * @returns {Array<object>|null} - Array of {id, R, t, chains} operations or null
 */
function extractPDBBiounitOperations(text) {
    // Fast-negative: no REMARK 350? no biounit.
    if (!/REMARK 350/.test(text)) return null;
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
            ops.push({ id: String(k), R, t, chains: [...chains] });
        }
    });

    return ops.length > 0 ? ops : null;
}

/**
 * Multiply two rotation matrices: Rb * Ra
 * @param {Array<number>} Rb - 9-element rotation matrix
 * @param {Array<number>} Ra - 9-element rotation matrix
 * @returns {Array<number>} - 9-element rotation matrix
 */
function multiplyRotationMatrices(Rb, Ra) {
    return [
        Rb[0] * Ra[0] + Rb[1] * Ra[3] + Rb[2] * Ra[6],
        Rb[0] * Ra[1] + Rb[1] * Ra[4] + Rb[2] * Ra[7],
        Rb[0] * Ra[2] + Rb[1] * Ra[5] + Rb[2] * Ra[8],
        Rb[3] * Ra[0] + Rb[4] * Ra[3] + Rb[5] * Ra[6],
        Rb[3] * Ra[1] + Rb[4] * Ra[4] + Rb[5] * Ra[7],
        Rb[3] * Ra[2] + Rb[4] * Ra[5] + Rb[5] * Ra[8],
        Rb[6] * Ra[0] + Rb[7] * Ra[3] + Rb[8] * Ra[6],
        Rb[6] * Ra[1] + Rb[7] * Ra[4] + Rb[8] * Ra[7],
        Rb[6] * Ra[2] + Rb[7] * Ra[5] + Rb[8] * Ra[8],
    ];
}

/**
 * Multiply rotation matrix by translation vector: R * t
 * @param {Array<number>} R - 9-element rotation matrix
 * @param {Array<number>} t - 3-element translation vector
 * @returns {Array<number>} - 3-element translation vector
 */
function multiplyRotationByTranslation(R, t) {
    return [
        R[0] * t[0] + R[1] * t[1] + R[2] * t[2],
        R[3] * t[0] + R[4] * t[1] + R[5] * t[2],
        R[6] * t[0] + R[7] * t[1] + R[8] * t[2],
    ];
}

/**
 * Compose a sequence of biounit operations
 * @param {Array<string>} seq - Sequence of operator IDs
 * @param {Map} opMap - Map of operator ID to {R, t}
 * @returns {object} - Composed {R, t}
 */
function composeBiounitOperations(seq, opMap) {
    // Apply operators left-to-right: x' = O_n(...O_2(O_1(x))...)
    let R = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    let t = [0, 0, 0];
    for (const id of seq) {
        const op = opMap.get(id) || opMap.get('1');
        if (!op) continue;
        const Rb = op.R, tb = op.t;
        // new = Rb * (R*x + t) + tb = (Rb*R) x + (Rb*t + tb)
        const R_new = multiplyRotationMatrices(Rb, R);
        const Rt = multiplyRotationByTranslation(Rb, t);
        const t_new = [Rt[0] + tb[0], Rt[1] + tb[1], Rt[2] + tb[2]];
        R = R_new;
        t = t_new;
    }
    return { R, t };
}

/**
 * Extract biounit operations from CIF file
 * @param {string} text - CIF file text
 * @returns {Array<object>|null} - Array of {id, R, t, chains} operations or null
 */
function extractCIFBiounitOperations(text, cachedLoops = null) {
    // Fast-negative: require both loops to be present
    if (!/_pdbx_struct_assembly_gen\./.test(text) || !/_pdbx_struct_oper_list\./.test(text)) {
        return null;
    }

    let loops;
    if (cachedLoops) {
        // Use cached loops if provided
        loops = cachedLoops;
    } else {
        // ...ASKED FOR BY NAME. parseMinimalCIF_light returns nothing at all
        // when it is not told which categories to keep - it seeks the tags it
        // is given rather than walking the file - so this path handed back an
        // empty list and every caller without cached loops got null. The web
        // app passes its own loops and never noticed; anything else asking for
        // a biological assembly silently got the asymmetric unit.
        loops = parseMinimalCIF_light(text, ['_pdbx_struct_assembly_gen.',
            '_pdbx_struct_oper_list.']);
    }

    const getLoop = (name) => loops.find(([cols]) => cols.includes(name));

    const asmL = getLoop('_pdbx_struct_assembly_gen.assembly_id');
    const operL = getLoop('_pdbx_struct_oper_list.id');

    // A SINGLE ASSEMBLY IS USUALLY NOT A LOOP, and that is the common case
    // rather than an oddity: a file with one assembly writes
    // _pdbx_struct_assembly_gen as three key-value items, and only a file with
    // several uses a loop. parseMinimalCIF_light returns loops alone - it says
    // so where it skips the item form - so asking it for the assembly of a
    // typical structure came back empty and the caller drew the asymmetric
    // unit. 2OMF, a porin trimer, is one: three operators in a loop above a
    // gen block written as items.
    //
    // Read as one row, which is what it is.
    let asmRows = asmL ? asmL[1] : null;
    let asmCols = asmL ? asmL[0] : null;
    if (!asmL) {
        const item = (tag) => {
            const m = new RegExp('^\\s*' + tag.replace(/[.[\]]/g, '\\$&')
                + '\\s+(\'[^\']*\'|"[^"]*"|\\S+)', 'm').exec(text);
            return m ? m[1].replace(/^['"]|['"]$/g, '') : null;
        };
        const oper = item('_pdbx_struct_assembly_gen.oper_expression');
        if (!oper) return null;
        asmCols = ['_pdbx_struct_assembly_gen.assembly_id',
            '_pdbx_struct_assembly_gen.oper_expression',
            '_pdbx_struct_assembly_gen.asym_id_list'];
        asmRows = [[item('_pdbx_struct_assembly_gen.assembly_id') || '1', oper,
            item('_pdbx_struct_assembly_gen.asym_id_list') || '']];
    }

    // Build operator map {id -> {R,t}}
    const opMap = new Map();
    if (operL) {
        const opCols = operL[0];
        const opRows = operL[1];
        const o = (n) => opCols.indexOf(n);
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
    }
    if (opMap.size === 0) {
        opMap.set('1', { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] });
    }

    // Choose assembly 1 (or fall back to first row)
    const a = (n) => asmCols.indexOf(n);
    let candidates = asmRows.filter(r => (r[a('_pdbx_struct_assembly_gen.assembly_id')] || '') === '1');
    if (candidates.length === 0 && asmRows.length > 0) candidates = [asmRows[0]];
    if (candidates.length === 0) return null;

    const chainSet = new Set();
    const operations = [];
    const seenRT = new Set();

    for (const r of candidates) {
        const asymList = (r[a('_pdbx_struct_assembly_gen.asym_id_list')] ||
            r[a('_pdbx_struct_assembly_gen.oper_asym_id_list')] || '').toString();
        // Normalize chain IDs: trim whitespace and convert to string
        const asymIds = asymList.split(',').map(s => String(s).trim()).filter(Boolean);
        asymIds.forEach(c => chainSet.add(c));

        const operExpr = (r[a('_pdbx_struct_assembly_gen.oper_expression')] || '').toString();
        const seqs = (operExpr && typeof expandOperExpr_light === 'function')
            ? expandOperExpr_light(operExpr) : [['1']];

        for (const seq of seqs) {
            const { R, t } = composeBiounitOperations(seq, opMap);
            const key = R.map(v => Number.isFinite(v) ? v.toFixed(6) : 'nan').join(',') + '|' +
                t.map(v => Number.isFinite(v) ? v.toFixed(6) : 'nan').join(',');
            if (!seenRT.has(key)) {
                seenRT.add(key);
                operations.push({ id: seq.join('*') || '1', R, t, chains: [] });
            }
        }
    }

    const chains = [...chainSet];
    operations.forEach(op => op.chains = chains);
    return operations.length > 0 ? operations : null;
}

/**
 * Convenience wrapper to extract biounit operations from PDB or CIF
 * @param {string} text - File text
 * @param {boolean} isCIF - Whether file is CIF format
 * @returns {Array<object>|null} - Array of operations or null
 */
function extractBiounitOperations(text, isCIF, cachedLoops = null) {
    if (isCIF) {
        return extractCIFBiounitOperations(text, cachedLoops);
    } else {
        return extractPDBBiounitOperations(text);
    }
}

/**
 * Apply biounit operations to an array of atoms
 * @param {Array<object>} atoms - Array of atom objects
 * @param {Array<object>} operations - Array of {id, R, t, chains} operations
 * @returns {Array<object>} - Transformed atoms
 */
function applyBiounitOperationsToAtoms(atoms, operations) {
    if (!operations || operations.length === 0) return atoms;

    // Get chains from operations, or use all chains if none specified
    let targetChains = new Set();
    operations.forEach(op => {
        if (op.chains && op.chains.length > 0) {
            op.chains.forEach(c => targetChains.add(c));
        }
    });

    if (targetChains.size === 0) {
        // No chains specified, use all
        atoms.forEach(a => {
            if (a.chain) targetChains.add(a.chain);
        });
    }

    const out = [];
    for (const op of operations) {
        for (const atom of atoms) {
            if (targetChains.size === 0 || targetChains.has(atom.chain)) {
                const transformed = {
                    ...atom,
                    x: op.R[0] * atom.x + op.R[1] * atom.y + op.R[2] * atom.z + op.t[0],
                    y: op.R[3] * atom.x + op.R[4] * atom.y + op.R[5] * atom.z + op.t[1],
                    z: op.R[6] * atom.x + op.R[7] * atom.y + op.R[8] * atom.z + op.t[2],
                    chain: (op.id === '1') ?
                        String(atom.chain || '') :
                        (String(atom.chain || '') + '|' + op.id)
                };
                out.push(transformed);
            }
        }
    }

    return out.length > 0 ? out : atoms;
}
// ============================================================================
// RESIDUE MAPPING UTILITIES
// ============================================================================

/**
 * Residue name to single-letter amino acid code mapping
 */
const RESIDUE_TO_AA = {
    ALA: 'A', ARG: 'R', ASN: 'N', ASP: 'D', CYS: 'C', GLU: 'E', GLN: 'Q', GLY: 'G',
    HIS: 'H', ILE: 'I', LEU: 'L', LYS: 'K', MET: 'M', PHE: 'F', PRO: 'P', SER: 'S',
    THR: 'T', TRP: 'W', TYR: 'Y', VAL: 'V', SEC: 'U', PYL: 'O',
    // common modified residues → canonical letters
    MSE: 'M', HSD: 'H', HSE: 'H', HID: 'H', HIE: 'H', HIP: 'H',
    // D-amino acids → the letter of their L counterpart, as PyMOL and gemmi do
    DAL: 'A', DAR: 'R', DSG: 'N', DAS: 'D', DCY: 'C', DGN: 'Q', DGL: 'E',
    DHI: 'H', DIL: 'I', DLE: 'L', DLY: 'K', MED: 'M', DPN: 'F', DPR: 'P',
    DSN: 'S', DTH: 'T', DTR: 'W', DTY: 'Y', DVA: 'V'
};

// CRYSTALLISATION ADDITIVES: what a structure carries because of how it was
// GROWN rather than because of what it does.
//
// Buffers, cryoprotectants, precipitants and the salts that come with them.
// They are real atoms in the file and they are not what anyone opened the
// structure to look at: a hen lysozyme comes with a dozen sulfates, and drawn
// beside the one inhibitor that matters they are noise with the same weight.
//
// A LIST OF CODES, WHICH IS A JUDGEMENT AND NOT A FACT. Everything here is
// something these files are grown in, but a few of them are occasionally the
// point - a sulfate IS the ligand in a sulfate transporter. So this is a
// default and not a rule: the Filter Additives switch turns it off and every
// atom comes back. What is DELIBERATELY ABSENT matters as much as what is
// here, and the borderline cases are left visible on purpose:
//
//   PO4  phosphate is a buffer AND half of biochemistry (4HHB carries one)
//   BCT  bicarbonate is a standard additive AND a photosystem II cofactor
//   SPM  spermine is a DNA crystallisation additive AND biologically real
//   C8E  a detergent, which in a porin sits where the membrane lipid would
//   metals - a zinc or a magnesium is structural far more often than not,
//         and they are drawn at their own size and colour precisely so they
//         can be read. Only the alkali/halide counter-ions below go.
//
// Hiding a real cofactor is a worse failure than showing a sulfate, so where
// it is a toss-up the atom stays.
const CRYSTAL_ADDITIVES = new Set([
    // precipitants and cryoprotectants
    'SO4', 'GOL', 'EDO', 'PEG', 'PG4', 'PGE', 'P6G', '1PE', '2PE', 'PE4',
    'MPD', 'MRD', 'BU3', 'IPA', 'DIO', 'DOD', 'TRT', 'P33', 'XPE',
    // buffers
    'TRS', 'MES', 'EPE', 'BTB', 'CIT', 'FLC', 'TLA', 'MLA', 'MLI', 'SIN',
    'CAC', 'BIS', 'PIN', 'HEZ', 'IMD', 'TAR', 'MOH',
    // small anions and organics from the drop
    'ACT', 'ACY', 'FMT', 'OXL', 'NO3', 'AZI', 'CN', 'SCN', 'THJ',
    'DMS', 'DMF', 'ACN', 'EOH', 'MEO', 'URE', 'GAI',
    // reducing agents and thiols
    'BME', 'DTT', 'DTU', 'TCE', 'MTN',
    // counter-ions: the alkali metals and halides that come with the buffer.
    // The transition metals are NOT here - see the note above.
    'NA', 'K', 'CS', 'RB', 'LI', 'CL', 'BR', 'IOD', 'F',
]);

// ...AND A METAL IS FILTERED BY HOW MANY OF IT THERE ARE, not by what it is.
//
// The list above keeps every transition metal, because one zinc in a zinc
// finger or one magnesium in an active site is the thing you came to see. A
// RIBOSOME IS NOT THAT: 4UG0 carries 239 magnesiums against 6 zincs, and they
// are structural in the sense that mortar is structural - real, load-bearing,
// and not what anyone is looking at. Two hundred of them are scenery.
//
// So the same code is kept or dropped depending on the structure, which is the
// honest answer: 9FOG's 4 magnesiums and 1AOI's 6 manganeses are sites and
// stay, 4UG0's 239 go. Counted per RESIDUE and only for single-atom ones - a
// photosystem's 60 chlorophylls are many and are the subject, and they have 65
// atoms each.
const CROWD_ION_COUNT = 20;

// Expose globally
if (typeof window !== 'undefined') {
    window.RESIDUE_TO_AA = RESIDUE_TO_AA;
    window.CRYSTAL_ADDITIVES = CRYSTAL_ADDITIVES;
    window.CROWD_ION_COUNT = CROWD_ION_COUNT;
}
