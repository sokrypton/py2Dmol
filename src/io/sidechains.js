// ============================================================================
// src/io/sidechains.js
// -----------------------------
// AI Context: SIDE CHAINS, AS COEFFICIENTS (no DOM, no dependencies)
// - buildSidechainTable and the chemistry it needs: which atoms are backbone,
//   which bonds a residue has, and how near two atoms must be to be bonded.
// - The table stores each atom in ITS RESIDUE'S OWN BACKBONE FRAME, which is
//   what makes side chains follow the backbone wherever it goes - through a
//   trajectory, through an alignment, through a re-centring.
// - CUT OUT OF src/io/parse.js so the NOTEBOOK can have it. The notebook
//   parses in Python and ships no parser at all, so a Python payload could
//   carry raw side-chain atoms and have nothing to turn them into a table.
//   Taking the whole 36 KB parser for 15 KB of chemistry was the alternative.
//   The cut was clean: tools/free_vars.js reports the range closing over
//   NOTHING, which is why it moved verbatim.
// - It needs localFrame from cartoon/geom.js, read off window at call time,
//   so it has no load-order requirement of its own beyond preceding parse.js.
// ============================================================================
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
