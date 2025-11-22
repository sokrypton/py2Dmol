#!/usr/bin/env python3
"""Test script to verify 3+ viewers work correctly without cross-interference."""

import sys
sys.path.insert(0, '/Users/mini/Documents/GitHub/py2Dmol')

import py2Dmol

print("=" * 70)
print("COMPREHENSIVE MULTI-VIEWER TEST - 3 VIEWERS")
print("=" * 70)

# Viewer 1: Load and show immediately
print("\n[VIEWER 1] Creating viewer1...")
viewer1 = py2Dmol.view((400, 400))
print(f"  Objects: {len(viewer1.objects)}, _is_live: {viewer1._is_live}")

print("  Loading 6MRR...")
viewer1.from_pdb('6MRR')
print(f"  After from_pdb: Objects: {len(viewer1.objects)}")

print("  Showing viewer1...")
viewer1.show()
print(f"  After show: _is_live: {viewer1._is_live}, Objects: {len(viewer1.objects)}")

# Viewer 2: Load, orient (before explicit show), then show
print("\n[VIEWER 2] Creating viewer2...")
viewer2 = py2Dmol.view((400, 400))
print(f"  Objects: {len(viewer2.objects)}, _is_live: {viewer2._is_live}")

print("  Loading 1UBQ...")
viewer2.from_pdb('1UBQ')
print(f"  After from_pdb: _is_live: {viewer2._is_live}, Objects: {len(viewer2.objects)}")

print("  Calling orient() BEFORE explicit show()...")
viewer2.orient()
print(f"  After orient: _is_live: {viewer2._is_live}, Objects: {len(viewer2.objects)}")

print("  Showing viewer2...")
viewer2.show()
print(f"  After show: _is_live: {viewer2._is_live}, Objects: {len(viewer2.objects)}")

# Viewer 3: Load, show, then orient
print("\n[VIEWER 3] Creating viewer3...")
viewer3 = py2Dmol.view((400, 400))
print(f"  Objects: {len(viewer3.objects)}, _is_live: {viewer3._is_live}")

print("  Loading 1A3N...")
viewer3.from_pdb('1A3N')
print(f"  After from_pdb: _is_live: {viewer3._is_live}, Objects: {len(viewer3.objects)}")

print("  Showing viewer3...")
viewer3.show()
print(f"  After show: _is_live: {viewer3._is_live}, Objects: {len(viewer3.objects)}")

print("  Calling orient() AFTER show()...")
viewer3.orient()
print(f"  After orient: _is_live: {viewer3._is_live}, Objects: {len(viewer3.objects)}")

# Final verification
print("\n" + "=" * 70)
print("FINAL VERIFICATION")
print("=" * 70)

print(f"\nViewer1 objects: {len(viewer1.objects)}")
for i, obj in enumerate(viewer1.objects):
    print(f"  [{i}] {obj.get('name', 'unknown')}")

print(f"\nViewer2 objects: {len(viewer2.objects)}")
for i, obj in enumerate(viewer2.objects):
    print(f"  [{i}] {obj.get('name', 'unknown')}")

print(f"\nViewer3 objects: {len(viewer3.objects)}")
for i, obj in enumerate(viewer3.objects):
    print(f"  [{i}] {obj.get('name', 'unknown')}")

print("\n" + "=" * 70)
print("✓ TEST COMPLETE - All viewers should show their respective PDBs")
print("=" * 70)
