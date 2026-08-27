"""A RIBOSE IS NOT A NUCLEOTIDE ON ITS OWN.

    python3 tests/parse_ligand.py

viewer.py promotes a residue gemmi does not flag as nucleic to a nucleotide
when it carries C4' + O4' + C1'. That is there for MODIFIED BASES INSIDE an RNA
chain - 1EHZ's YYG, 5MC and OMG are tabulated without the flag, and without the
rule the chain loses them and the backbone breaks at each one.

SAM, SAH, ATP, NAD and FAD all carry a ribose too. A cofactor promoted this way
collapses to a SINGLE position at its C4': twenty-seven atoms drawn as one
sphere, which is what "the ligand does not show up" looks like. It also makes a
trajectory look like it cannot recognise its own ligand, because every frame is
that same sphere.

What separates the two is the company the residue keeps, so the rule is gated
on the chain holding nucleic acid at all. src/io/parse.js has always asked a
stricter version of the same question - a KNOWN nucleic residue plus
connectivity - which is why such a file loads correctly on the website and as a
sphere in a notebook.

The fixtures are written here rather than read from a repository file: the one
that found this is somebody's design run and is not in the tree.
"""
import os, sys, tempfile, types
from collections import Counter

ROOT = '/Users/mini/Documents/GitHub/py2Dmol'
ip = types.ModuleType('IPython'); disp = types.ModuleType('IPython.display')
for _n in ('display', 'HTML', 'Javascript', 'update_display'):
    setattr(disp, _n, lambda *a, **k: None)
ip.display = disp
sys.modules['IPython'] = ip
sys.modules['IPython.display'] = disp
sys.path.insert(0, ROOT)
import py2Dmol  # noqa: E402

bad = []


def pdb(lines):
    path = os.path.join(tempfile.gettempdir(), 'py2dmol_lig_fixture.pdb')
    open(path, 'w').write('\n'.join(lines) + '\nEND\n')
    return path


def atom(serial, name, res, chain, seq, x, y, z, el, het=True):
    return ('{:6s}{:5d} {:^4s} {:>3s} {:1s}{:4d}    '
            '{:8.3f}{:8.3f}{:8.3f}  1.00 50.00          {:>2s}').format(
        'HETATM' if het else 'ATOM  ', serial, name, res, chain, seq,
        x, y, z, el)


def parse(path):
    v = py2Dmol.view()
    v.add_pdb(path)
    return v.objects[0]['frames'][0]


# --- A COFACTOR IN ITS OWN CHAIN -----------------------------------------
# The ribose three plus enough of the rest to be a real molecule. No
# phosphate, no other residue in the chain: this is a ligand.
sam = []
_names = [("N", 'N'), ("CA", 'C'), ("C", 'C'), ("O", 'O'), ("CB", 'C'),
          ("CG", 'C'), ("SD", 'S'), ("CE", 'C'), ("C5'", 'C'), ("C4'", 'C'),
          ("O4'", 'O'), ("C3'", 'C'), ("O3'", 'O'), ("C2'", 'C'),
          ("O2'", 'O'), ("C1'", 'C'), ("N9", 'N'), ("C8", 'C')]
for i, (nm, el) in enumerate(_names):
    sam.append(atom(1 + i, nm, 'LIG', 'C', 1, i * 1.4, 0.0, 0.0, el))
frame = parse(pdb(sam))
tally = Counter(frame['position_types'])
print(f"  a ribose-bearing cofactor alone in its chain: {dict(tally)}")
if tally.get('L') != len(_names):
    bad.append(f"the cofactor parsed as {dict(tally)} - eighteen atoms, and"
               " anything but eighteen 'L' positions means it was promoted to"
               " a nucleotide and collapsed onto its C4'")
if tally.get('R') or tally.get('D'):
    bad.append('a lone cofactor was read as nucleic acid')
# ...and it kept its per-atom columns, which is what element colouring reads
if len(set(frame['position_elements'])) < 3:
    bad.append(f"the cofactor's elements came out"
               f" {sorted(set(frame['position_elements']))}")

# --- THE SAME RESIDUE INSIDE AN RNA CHAIN --------------------------------
# One standard nucleotide beside it, and the promotion has to fire: this is
# the modified-base case the rule exists for.
mixed = []
n = 0
for nm, el in (("P", 'P'), ("O5'", 'O'), ("C5'", 'C'), ("C4'", 'C'),
               ("O4'", 'O'), ("C3'", 'C'), ("C2'", 'C'), ("O2'", 'O'),
               ("C1'", 'C'), ("N9", 'N')):
    n += 1
    mixed.append(atom(n, nm, 'G', 'A', 1, n * 1.4, 0.0, 0.0, el, het=False))
for nm, el in (("C5'", 'C'), ("C4'", 'C'), ("O4'", 'O'), ("C3'", 'C'),
               ("C2'", 'C'), ("O2'", 'O'), ("C1'", 'C'), ("N9", 'N')):
    n += 1
    mixed.append(atom(n, nm, 'YYG', 'A', 2, 6.0 + n * 1.4, 0.0, 0.0, el))
frame = parse(pdb(mixed))
tally = Counter(frame['position_types'])
print(f"  a modified base beside a standard one:        {dict(tally)}")
if tally.get('R', 0) + tally.get('D', 0) != 2:
    bad.append(f"the RNA fixture parsed as {dict(tally)} - a standard"
               " nucleotide and a modified one are two nucleic positions, and"
               " losing the modified one is what the structural test exists"
               " to prevent")

# --- AND A REAL tRNA, which is where the rule came from -------------------
if os.path.exists(os.path.join(ROOT, '1EHZ.cif')):
    frame = parse(os.path.join(ROOT, '1EHZ.cif'))
    tally = Counter(frame['position_types'])
    print(f"  1EHZ:                                        {dict(tally)}")
    if tally.get('R') != 76:
        bad.append(f"1EHZ came out {dict(tally)} rather than 76 RNA positions -"
                   " it carries thirteen modified bases and every one of them"
                   " needs the structural test")
else:
    bad.append('1EHZ.cif is not in the tree, so the case the rule exists for'
               ' is unmeasured')

if bad:
    print('FAIL')
    for b in bad:
        print('  - ' + b)
    sys.exit(1)
print('PASS')
