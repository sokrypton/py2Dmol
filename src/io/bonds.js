// ============================================================================
// src/io/bonds.js
// -------------------------------
// AI Context: WHAT IS BONDED TO WHAT, BY ELEMENT
// - One table, read by the parser and by the renderer's distance fallback.
// ============================================================================

// ============================================================================
// TWO PARSERS, ONE QUESTION - and this is the question.
//
// A ligand's bonds are DERIVED, because most files do not say: mmCIF's
// _struct_conn carries the exceptions (covale, disulf) and not the ordinary
// bonds inside a residue. src/io/parse.js derived them with the table below;
// core/mol.js, which is what runs when a file carried no bonds at all - the
// whole NOTEBOOK path, since viewer.py only forwards bonds a caller supplied
// by hand - used ONE number, 2.0 A, for every pair of elements.
//
// Measured across every ligand in the fixtures (3PTB, 4HHB, 1HVR, 1EHZ, 2R8S:
// 243 ligand atoms) the two rules AGREE EXACTLY. That is not luck: a covalent
// bond between C, N, O, P or S is 1.2-1.8 A and the nearest non-bonded contact
// - the 1-3 distance across a tetrahedral or aromatic centre - is 2.2 A or
// more, so a line at 2.0 sits in the gap. What the flat number gets wrong is
// everything outside that band:
//
//   S-S   2.05 A   a disulfide inside a ligand, drawn as two loose spheres
//   C-I   2.14 A   an iodinated ligand, ditto
//   C-Br  1.94     inside 2.0 by 0.06, which is not a margin
//   O-O   1.48     a 1.9 A O...O contact drawn as a bond it is not
//
// So the reason to share the table is not that today's pictures are wrong. It
// is that ONE question had TWO answers, and which one you got depended on
// whether the file carried bonds - that is, on whether you were on the website
// or in a notebook. This codebase has paid for that split three times: the SAM
// cofactor drawn as one sphere, the side-chain table, and the selection mark
// reading `bonds` where the sticks read the segments.
// ============================================================================

/**
 * The longest a bond between these two elements may be, in Angstrom.
 *
 * Element names are case-insensitive and the pair is unordered. Anything not
 * named takes `fallback`, which is the caller's own flat cutoff - so a table
 * miss is exactly the behaviour there was before the table.
 */
function bondMaxFor(elem1, elem2, fallback) {
    const e1 = (elem1 || '').toUpperCase();
    const e2 = (elem2 || '').toUpperCase();
    if (!e1 || !e2) return fallback;
    const pair = e1 < e2 ? (e1 + '-' + e2) : (e2 + '-' + e1);
    const v = BOND_MAX_BY_PAIR[pair];
    return (v === undefined) ? fallback : v;
}

// Typical covalent bond lengths plus about 15%. The comment on each row is the
// single-bond length it is derived from; shorter orders are covered by it.
const BOND_MAX_BY_PAIR = {
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
    // ...AND THE HALOGENS AND SELENIUM, which are the elements a flat 2.0 A
    // gets wrong on an ordinary drug-like ligand: C-I at 2.14 is outside it
    // altogether and C-Br at 1.94 is inside it by 0.06.
    'C-F': 1.6,   // Single: 1.35
    'C-CL': 2.0,  // Single: 1.77
    'C-BR': 2.2,  // Single: 1.94
    'C-I': 2.4,   // Single: 2.14
    'C-SE': 2.2,  // Single: 1.95
    'SE-SE': 2.6, // Single: 2.33
    'O-SE': 2.1,  // Single: 1.80
    // Metal-ligand bonds (typically longer). NOT the same thing as
    // coordination, which is deliberately not drawn - see _struct_conn's
    // `metalc` in CLAUDE.md; these are for a metal genuinely bonded inside a
    // ligand group.
    'C-FE': 2.5, 'C-ZN': 2.5, 'C-MG': 2.5, 'C-CA': 2.8,
    'N-FE': 2.5, 'N-ZN': 2.5, 'N-MG': 2.5, 'N-CA': 2.8,
    'O-FE': 2.5, 'O-ZN': 2.5, 'O-MG': 2.5, 'O-CA': 2.8,
    'S-FE': 2.8, 'S-ZN': 2.8, 'S-MG': 2.8, 'S-CA': 3.0,
};

/** The largest entry, for a caller that needs one prefilter distance. */
const BOND_MAX_ANY = Object.keys(BOND_MAX_BY_PAIR)
    .reduce((m, k) => Math.max(m, BOND_MAX_BY_PAIR[k]), 0);
