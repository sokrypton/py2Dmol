"""The three spellings of a contact, and the one that draws nothing.

    python3 tests/contacts_forms.py

TWO FAULTS, ONE FUNCTION. _process_contacts is the only thing between what a
caller writes and what src/core/mol.js reads, and it did not know which form it
was looking at.

  🔴 A CONTACT FROM A POSITION TO ITSELF IS DROPPED AT THE FAR END. mol.js
  refuses `idx1 === idx2` - a contact is a line between two points - so the
  record travels the whole way into the payload and vanishes on arrival.
  Reported by someone who tried every weight from 0.3 to 3.6 looking for a
  sphere they had been told it drew. Nothing said a word at any point.

  🔴 AND A NAMED COLOUR SURVIVED IN ONE FORM AND NOT THE OTHER. The .cst parser
  turns `A 10 B 50 0.5 yellow` into `{"r":.., "g":.., "b":..}`; the same contact
  written as a Python list kept the string, because the colour was looked for
  at index 3 whatever the form - and in the chain+residue form index 3 is the
  SECOND RESIDUE NUMBER. mol.js takes a colour only as an object, so the list
  spelling of a file that worked came out in the default colour.

WHAT IS MEASURED, on the payload the page is actually handed:

  * the file and the list spelling of the SAME contact produce the same record,
    colour included - the comparison is between two forms, not against a
    constant, so it cannot pass by agreeing with a stale expectation;
  * a self-contact never reaches the payload, and SAYS SO on the way out;
  * every other form is carried through untouched, which is the control: a
    validator that drops things is easy to write and this one must not.
"""
import io, json, os, sys, types
from contextlib import redirect_stdout

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
try:
    import IPython.display  # noqa: F401
except ImportError:
    _disp = types.ModuleType('IPython.display')
    for _n in ('display', 'HTML', 'Javascript', 'update_display'):
        setattr(_disp, _n, lambda *a, **k: None)
    _ip = types.ModuleType('IPython'); _ip.display = _disp
    sys.modules['IPython'] = _ip; sys.modules['IPython.display'] = _disp
sys.path.insert(0, ROOT)
import py2Dmol  # noqa: E402

bad = []
CST = os.path.join(ROOT, '_contacts_forms.cst')
open(CST, 'w').write("10 50 1.0 red\nA 10 B 50 0.5 yellow\n")


def run(contacts):
    """The contacts as they reach the object, plus whatever was printed."""
    v = py2Dmol.view((200, 200))
    v.add_pdb(os.path.join(ROOT, '1UBQ.cif'), name='obj', use_biounit=False)
    out = io.StringIO()
    with redirect_stdout(out):
        v.add_contacts(contacts)
    return v.objects[-1].get('contacts'), out.getvalue()


from_file, _ = run(CST)
as_list, _ = run([[10, 50, 1.0, 'red'], ['A', 10, 'B', 50, 0.5, 'yellow']])
os.remove(CST)
print(f"  from file: {json.dumps(from_file)}")
print(f"  from list: {json.dumps(as_list)}")
if from_file != as_list:
    bad.append("the same two contacts read from a .cst file and written as a"
               f" list produce different records:\n      file {from_file}\n"
               f"      list {as_list}")
# ...and a colour did arrive, in both. Two forms that agree on dropping it
# would pass the comparison above.
for tag, got in (('file', from_file), ('list', as_list)):
    for c in (got or []):
        if not any(isinstance(e, dict) for e in c):
            bad.append(f"{tag}: {c} carries no colour object - the name was"
                       " never parsed")

# THE SELF-CONTACT, in both spellings, and both must be refused out loud.
for contacts in ([[10, 10, 1.0]], [['A', 10, 'A', 10, 1.0]]):
    got, said = run(contacts)
    print(f"  {contacts} -> {got}, said {said.strip()[:70]!r}")
    if got:
        bad.append(f"{contacts} reached the payload as {got} - mol.js drops it"
                   " on arrival, so it can only ever draw nothing")
    if 'itself' not in said or 'color' not in said:
        bad.append(f"{contacts} was dropped without saying so, or without"
                   f" naming what to use instead: {said.strip()!r}")

# THE CONTROL: everything else goes through unchanged. A validator that drops
# what it does not recognise passes every check above.
KEEP = [[10, 50, 1.0],
        [10, 50, 1.0, {'r': 1, 'g': 2, 'b': 3}],
        ['A', 10, 'B', 50, 0.5],
        ['A', 10, 'B', 50, 0.5, {'r': 1, 'g': 2, 'b': 3}],
        [{'chain': 'A', 'residue': 10}, {'chain': 'B', 'residue': 50}, 1.0]]
got, _ = run(KEEP)
print(f"  carried through: {len(got or [])} of {len(KEEP)}")
if got != KEEP:
    bad.append(f"contacts that were always valid came back changed:\n"
               f"      in  {KEEP}\n      out {got}")

print()
for b in bad:
    print("FAIL: " + b)
print("contacts_forms: " + ("FAILED" if bad else "ok"))
sys.exit(1 if bad else 0)
