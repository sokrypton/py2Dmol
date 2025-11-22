#!/usr/bin/env python3
"""Test to reproduce the switching bug between objects."""

import sys
sys.path.insert(0, '/Users/mini/Documents/GitHub/py2Dmol')

import py2Dmol

print("=" * 70)
print("BUG REPRODUCTION: Switch between objects in same viewer")
print("=" * 70)

print("\nCreating viewer...")
viewer = py2Dmol.view((600, 600))

print("\nLoading 6MRR...")
viewer.from_pdb('6MRR')
print(f"  Objects in viewer: {[obj['name'] for obj in viewer.objects]}")
print(f"  Current: {viewer.objects[-1]['name']}")

print("\nShowing viewer...")
viewer.show()

print("\nLoading 1UBQ...")
viewer.from_pdb('1UBQ')
print(f"  Objects in viewer: {[obj['name'] for obj in viewer.objects]}")
print(f"  Current: {viewer.objects[-1]['name']}")

print("\n" + "=" * 70)
print("TESTING: Try switching between objects in the viewer UI")
print("=" * 70)
print("\nSteps to verify bug:")
print("1. The viewer should display 1UBQ initially")
print("2. Use the object dropdown menu to select '6MRR'")
print("3. EXPECTED: 6MRR should display correctly")
print("4. ACTUAL BUG: 6MRR appears blank")
print("\nOnce we identify what's going wrong, we can fix it!")
