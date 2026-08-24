"""Cut a run of methods out of Pseudo3DRenderer into a part file.

    python3 tools/extract_part.py clip 3575 3912 \\
        --title "CLIP (a part of Pseudo3DRenderer)" \\
        --doc "A slab in camera space..."

The mechanical half of a split, so the same three mistakes are not available
each time: forgetting the comma an object literal needs and a class body does
not, taking a range that starts or ends inside a doc comment, and leaving a copy
behind in the source.

It does NOT decide what to move. Run tools/free_vars.js over the range first and
read the answer - anything under MUST HANDLE has to be dealt with before the
range can go anywhere. This script refuses a range whose free variables it has
not been told about, because a clean extraction that throws ReferenceError on
first use is worse than no extraction.

After it runs, four things still need doing, and tools/bundle.py names all of
them: add the module to MODULES, add the tag to index.html, add the
inline read to viewer.py (AFTER core/mol.js's, because those reads prepend),
and add the file to setup.py. Then add the path to tests/lift.js SOURCES so the
node tests follow the methods.
"""
import argparse
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'src/core/mol.js')


def free_vars(a, b):
    """Ask the pre-flight what the range closes over."""
    out = subprocess.run(
        ['node', os.path.join(ROOT, 'tools/free_vars.js'),
         'src/core/mol.js', str(a), str(b)],
        capture_output=True, text=True, cwd=ROOT)
    if out.returncode != 0:
        sys.exit('free_vars failed: ' + (out.stderr or out.stdout)[:300])
    m = re.search(r'MUST HANDLE[^(]*\((\d+)\)', out.stdout)
    n = int(m.group(1)) if m else -1
    u = re.search(r'unresolved[^(]*\((\d+)\)', out.stdout)
    return n, (int(u.group(1)) if u else -1), out.stdout


ap = argparse.ArgumentParser()
ap.add_argument('name')
ap.add_argument('start', type=int)
ap.add_argument('end', type=int)
ap.add_argument('--title', required=True)
ap.add_argument('--doc', default='')
ap.add_argument('--allow-free', type=int, default=0,
                help='how many MUST HANDLE entries are known and handled')
args = ap.parse_args()

lines = open(SRC).read().split('\n')
a, b = args.start, args.end
block = lines[a - 1:b]

# A RANGE THAT STARTS OR ENDS INSIDE A COMMENT is the easy mistake: the doc
# above the first method belongs with it, and the doc below the last one belongs
# with whatever comes next. Both show up as unstripped prose in free_vars.
if block[-1] != '        }':
    sys.exit(f'line {b} is {block[-1]!r}, not a method-closing brace at eight spaces'
             ' - the range ends mid-method or mid-comment')
# ...counted as SUBSTRINGS, not as lines. A one-line `/** ... */` opens and
# closes on the same line, and counting lines called that unbalanced.
text = '\n'.join(block)
opens = text.count('/*')
closes = text.count('*/')
if opens != closes:
    sys.exit(f'the range has {opens} doc openers and {closes} closers'
             ' - it starts or ends inside a comment')

n_free, n_unres, report = free_vars(a, b)
if n_free > args.allow_free:
    print(report)
    sys.exit(f'{n_free} enclosing-scope locals, and --allow-free is {args.allow_free}.'
             ' Hoist, pass or recompute them first.')

# STATICS GO IN A DIFFERENT BUCKET. `static get X()` lives on the CONSTRUCTOR,
# and the class reads it as `this.constructor.X`. Dropped into `proto` it would
# become a getter on instances instead, `this.constructor.X` would be undefined,
# and the first symptom is a capture panel with no defaults. In an object
# literal the `static` keyword goes away and `get X()` stays a getter, which
# installMolParts preserves by copying descriptors rather than assigning.
STATIC = re.compile(r'^        static (?:get )?([A-Za-z_$][\w$]*)\s*\(')
proto, statics = [], []
i = 0
while i < len(block):
    ln = block[i]
    m = STATIC.match(ln)
    if not m:
        proto.append(ln)
        i += 1
        continue
    # ...take the whole member, one line or many, by counting braces
    depth = 0
    j = i
    while j < len(block):
        depth += block[j].count('{') - block[j].count('}')
        if depth <= 0 and '{' in ''.join(block[i:j + 1]):
            break
        j += 1
    member = block[i:j + 1]
    member[0] = member[0].replace('static ', '', 1)
    statics.append('\n'.join(member).rstrip() + ',')
    i = j + 1

# A COMMA AFTER EVERY MEMBER, found by tracking depth rather than by matching
# the literal line `        }`. That rule missed ONE-LINE methods -
# `objectStateToJSON(object) { return objectStateToJSON(object); }` closes on
# the same line it opens - so two of them in a row came out with no comma
# between and the file did not parse.
out = []
depth = 0
for ln in proto:
    was = depth
    depth += ln.count('{') - ln.count('}')
    closes_member = was > 0 and depth == 0 and ln.rstrip().endswith('}')
    opens_and_closes = was == 0 and depth == 0 and ln.strip().endswith('}') and '{' in ln
    out.append(ln + ',' if (closes_member or opens_and_closes) else ln)
n_methods = sum(1 for l in out if l.rstrip().endswith('},'))
n_statics = len(statics)
if n_methods == 0:
    sys.exit('no methods found in the range')

path = f'src/parts/{args.name}.js'
# THE HEADER SAYS WHAT THE FILE OWNS AND STOPS. It used to repeat how a part
# file works and how this script performed the move - the first belongs once,
# beside installMolParts, and the second is what git is for. Six copies of one
# paragraph is five copies of nothing.
header = f"""// ============================================================================
// {path}
// {'-' * len(path)}
// AI Context: {args.title}
{args.doc}
// ============================================================================
(function () {{
'use strict';
(window.py2dmolMolParts = window.py2dmolMolParts || []).push({{
    name: '{args.name}',
    proto: {{
"""
footer = "});\n}());\n"

body = '\n'.join(out) + '\n    },\n'
if statics:
    body += '    statics: {\n' + '\n'.join(statics) + '\n    },\n'
open(os.path.join(ROOT, path), 'w').write(header + body + footer)
open(SRC, 'w').write('\n'.join(lines[:a - 1] + lines[b:]))
print(f'{path}: {len(block)} lines, {n_methods} methods, {n_statics} statics'
      f' ({n_free} free, {n_unres} unresolved)')
print('now: tools/bundle.py MODULES, the two HTML tags, viewer.py, setup.py,'
      ' tests/lift.js SOURCES')
