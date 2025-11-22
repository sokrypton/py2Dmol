#!/usr/bin/env python3
"""Test loading multiple PDBs into same viewer."""

import sys
sys.path.insert(0, '/Users/mini/Documents/GitHub/py2Dmol')

import py2Dmol

print("=" * 70)
print("MULTIPLE PDB IN SAME VIEWER TEST")
print("=" * 70)

print("\nCreating viewer...")
viewer1 = py2Dmol.view((600, 600))

print("\nLoading 6MRR...")
viewer1.from_pdb('6MRR')
print(f"  Objects: {len(viewer1.objects)}")
for i, obj in enumerate(viewer1.objects):
    print(f"    [{i}] {obj.get('name')}")

print("\nLoading 1UBQ...")
viewer1.from_pdb('1UBQ')
print(f"  Objects: {len(viewer1.objects)}")
for i, obj in enumerate(viewer1.objects):
    print(f"    [{i}] {obj.get('name')}")

print("\nShowing viewer...")
viewer1.show()

print(f"\nFinal state:")
print(f"  _is_live: {viewer1._is_live}")
print(f"  Objects: {len(viewer1.objects)}")
for i, obj in enumerate(viewer1.objects):
    print(f"    [{i}] {obj.get('name')} - {len(obj.get('frames', []))} frame(s)")
