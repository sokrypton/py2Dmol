#!/usr/bin/env python3
"""Test script to reproduce multi-viewer orient issue."""

import sys
sys.path.insert(0, '/Users/mini/Documents/GitHub/py2Dmol')

import py2Dmol

# Reproduce the exact issue
print("Creating viewer1...")
viewer1 = py2Dmol.view((400, 400))
print(f"viewer1 created. Objects: {len(viewer1.objects)}, _is_live: {viewer1._is_live}")

print("\nLoading 6MRR into viewer1...")
viewer1.from_pdb('6MRR')
print(f"After from_pdb(6MRR). Objects in viewer1: {len(viewer1.objects)}")
for i, obj in enumerate(viewer1.objects):
    print(f"  [{i}] {obj.get('name', 'unknown')} - frames: {len(obj.get('frames', []))}")

print("\nCalling viewer1.show()...")
viewer1.show()
print(f"After show(). viewer1._is_live: {viewer1._is_live}")

print("\n" + "="*60)
print("Creating viewer2...")
viewer2 = py2Dmol.view((400, 400))
print(f"viewer2 created. Objects: {len(viewer2.objects)}, _is_live: {viewer2._is_live}")

print("\nLoading 1UBQ into viewer2...")
viewer2.from_pdb('1UBQ')
print(f"After from_pdb(1UBQ). Objects in viewer2: {len(viewer2.objects)}")
for i, obj in enumerate(viewer2.objects):
    print(f"  [{i}] {obj.get('name', 'unknown')} - frames: {len(obj.get('frames', []))}")

print("\n*** CRITICAL TEST: Calling viewer2.orient() BEFORE viewer2.show() ***")
print(f"viewer2._is_live before orient: {viewer2._is_live}")
viewer2.orient()
print(f"viewer2._is_live after orient: {viewer2._is_live}")

print("\nChecking viewer1 objects after viewer2.orient():")
print(f"  Objects in viewer1: {len(viewer1.objects)}")
for i, obj in enumerate(viewer1.objects):
    print(f"  [{i}] {obj.get('name', 'unknown')} - frames: {len(obj.get('frames', []))}")

print("\nCalling viewer2.show()...")
viewer2.show()
print(f"After show(). viewer2._is_live: {viewer2._is_live}")

print("\nFinal check of viewer1 objects:")
print(f"  Objects in viewer1: {len(viewer1.objects)}")
for i, obj in enumerate(viewer1.objects):
    print(f"  [{i}] {obj.get('name', 'unknown')} - frames: {len(obj.get('frames', []))}")
