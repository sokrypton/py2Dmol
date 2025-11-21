#!/usr/bin/env python3
"""
Test script to verify that bonds are properly handled in py2Dmol.
Tests bonds extraction from structure files and bonds parameter in add() method.
"""

from py2Dmol import view

# Test 1: Load a PDB file with CONECT records (bonds in structure)
print("Test 1: Loading PDB with CONECT records")
v1 = view()
v1.add_pdb('examples/test_ligand.pdb')

if v1.objects:
    bonds = v1.objects[0].get('bonds')
    if bonds:
        print(f"✓ Found {len(bonds)} bonds from PDB CONECT records")
        print(f"  Sample bonds: {bonds[:3]}")
    else:
        print("⚠ No bonds extracted from PDB (this is normal with current auto-extraction disabled)")
else:
    print("✗ No objects loaded")

print()

# Test 2: Add bonds using add_bonds() method
print("Test 2: Add bonds using add_bonds() method")
v2 = view()
v2.add_pdb('examples/test_ligand.pdb')
custom_bonds = [[0, 1], [1, 2], [2, 3], [3, 0]]
v2.add_bonds(custom_bonds)

if v2.objects:
    bonds = v2.objects[0].get('bonds')
    if bonds:
        print(f"✓ Added {len(bonds)} bonds via add_bonds() method")
        print(f"  Bonds: {bonds}")
    else:
        print("✗ add_bonds() method not working")
else:
    print("✗ No objects loaded")

print()

# Test 3: Add bonds directly via add() method with coordinates
print("Test 3: Add bonds directly via add() method")
v3 = view()
# Create some test coordinates
import numpy as np
coords = np.random.randn(10, 3) * 10
bonds_for_add = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6]]
v3.add(coords, bonds=bonds_for_add)

if v3.objects:
    bonds = v3.objects[0].get('bonds')
    if bonds:
        print(f"✓ Added {len(bonds)} bonds via add() method")
        print(f"  Bonds: {bonds}")
    else:
        print("✗ bonds parameter not working in add() method")
else:
    print("✗ No objects loaded")

print("\nNote: Bonds can be specified as [idx1, idx2] pairs where indices are atom positions.")
