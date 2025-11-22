#!/usr/bin/env python3
"""Test script to verify Orient button callback integration."""

import sys
sys.path.insert(0, '/Users/mini/Documents/GitHub/py2Dmol')

import py2Dmol

print("=" * 70)
print("ORIENT BUTTON CALLBACK TEST")
print("=" * 70)

# Create viewer
print("\nCreating viewer...")
viewer = py2Dmol.view((600, 600))
print(f"  viewer_id: {viewer.config['viewer_id']}")
print(f"  callbacks: {viewer.config['callbacks']}")

# Load PDB
print("\nLoading 6MRR...")
viewer.from_pdb('6MRR')

# Show the viewer (this is where the callback gets registered)
print("\nShowing viewer...")
viewer.show()

# Test direct Python orient() call
print("\nTesting Python orient() call...")
print(f"  viewer._is_live: {viewer._is_live}")
print(f"  viewer.objects: {len(viewer.objects)}")
viewer.orient()

print("\n" + "=" * 70)
print("✓ TEST COMPLETE")
print("=" * 70)
print("\nThe Orient button in the viewer should now:")
print("1. Call the JavaScript callback function")
print("2. Execute Python code: viewer.orient(objectName)")
print("3. Receive the computed rotation matrices back")
print("4. Apply the orientation to the viewer")
print("\nIf you click the 'Orient' button in the displayed viewer,")
print("it should orient the 6MRR structure to its optimal viewing angle.")
