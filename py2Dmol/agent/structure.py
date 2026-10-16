"""inspect_structure: what is in a structure, in the terms a spec's selectors use.

An agent asked for "the binding site of chain B" has to know there IS a chain B,
where it sits, what the ligands are called and whether the B-factor column is a
pLDDT, before it can write a selector.

🔴 THIS READS py2Dmol's OWN PARSE, NOT THE FILE. A selector's ``position`` is the
renderer's index into what the object DRAWS (``view._selector``): one position
per polymer residue and one per ligand ATOM, across every chain, counted from 0.
It is not a residue number and not an index within a chain. A second parser would
be a second answer to "which index is residue 45 of chain B", so this builds the
object with ``add_pdb`` - the same call a spec makes, biounit and all - and reports
the ranges it actually produced.
"""
from __future__ import annotations

import contextlib
import io
from pathlib import Path

TYPE_NAMES = {"P": "protein", "D": "dna", "R": "rna", "N": "nucleic", "L": "ligand"}
_THREE_TO_ONE = {
    "ALA": "A", "ARG": "R", "ASN": "N", "ASP": "D", "CYS": "C", "GLN": "Q", "GLU": "E",
    "GLY": "G", "HIS": "H", "ILE": "I", "LEU": "L", "LYS": "K", "MET": "M", "PHE": "F",
    "PRO": "P", "SER": "S", "THR": "T", "TRP": "W", "TYR": "Y", "VAL": "V", "MSE": "M",
}


def _runs(chains, types):
    """Contiguous [start, end) runs of (chain, type)."""
    start = 0
    for i in range(1, len(chains) + 1):
        if i == len(chains) or chains[i] != chains[start] or types[i] != types[start]:
            yield chains[start], types[start], start, i
            start = i


def inspect_file(path: str | Path, use_biounit: bool = True, chains=None) -> dict:
    from ..viewer import view

    v = view()
    log = io.StringIO()
    with contextlib.redirect_stdout(log):
        v.add_pdb(str(path), use_biounit=use_biounit, chains=chains, name=Path(str(path)).stem)
    if not v.objects or not v.objects[-1]["frames"]:
        raise ValueError(f"{path}: no structure could be read" + (f" ({log.getvalue().strip()})" if log.getvalue().strip() else ""))
    obj = v.objects[-1]
    f0 = obj["frames"][0]
    ch, ty = f0["chains"], f0["position_types"]
    resn, names = f0["residue_numbers"], f0["position_names"]

    polymers, ligands = [], []
    for c, t, a, b in _runs(ch, ty):
        if t == "L":
            # one position per ATOM: split the run into residues by residue number + name
            s = a
            for i in range(a + 1, b + 1):
                if i == b or resn[i] != resn[s] or names[i] != names[s]:
                    ligands.append({"chain": c, "name": names[s], "residue": resn[s],
                                    "positions": {"from": s, "to": i}, "atoms": i - s})
                    s = i
        else:
            entry = {"chain": c, "type": TYPE_NAMES.get(t, t), "positions": {"from": a, "to": b},
                     "length": b - a, "first_residue": resn[a], "last_residue": resn[b - 1]}
            if t == "P":
                entry["sequence"] = "".join(_THREE_TO_ONE.get(n, "X") for n in names[a:b])
            polymers.append(entry)

    pl = [x for x in (f0.get("plddts") or []) if x is not None]
    rng = [round(min(pl), 2), round(max(pl), 2)] if pl else None
    return {
        "source": str(path),
        "name": obj["name"],
        "frames": len(obj["frames"]),
        "positions": len(ch),
        "biounit": bool(use_biounit),
        "chains": polymers,
        "ligands": ligands,
        "b_factor_range": rng,
        "b_factor_may_be_plddt": bool(rng and 0 <= rng[0] and rng[1] <= 100
                                      and (Path(str(path)).name.upper().startswith("AF-") or rng[0] >= 20)),
        "selector_note": ("`position` is an index into the drawn positions above (one per residue, "
                          "one per ligand atom, all chains, from 0). Give a range as "
                          "{\"from\": a, \"to\": b} (b excluded); a JSON list [a, b] means exactly "
                          "positions a and b. chain and position cannot be combined in set_color."),
        "warnings": [ln for ln in log.getvalue().splitlines() if ln.strip()],
    }
