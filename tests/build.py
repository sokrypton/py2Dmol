"""Build every cartoon/ribbon test page into tests/out/, then serve it.

    python tests/build.py           # build only
    python tests/build.py --serve   # build, then serve tests/out on :8931

The pages are static HTML with the viewer JS inlined, so a rebuild is the only
way to pick up an edit to py2Dmol/resources/viewer-*.js. Rebuild after every
change to the renderer; a stale page looks exactly like a fix that did nothing.
"""
import argparse
import functools
import http.server
import os
import runpy
import socketserver
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUTDIR = os.path.join(HERE, "out")
SCRIPTS = [
    "make_box_test.py",     # slab ladder: box -> beam -> curved helix piece
    "make_helix_big.py",    # ideal helix, 12 residues
    "make_helix_test.py",   # ideal helix, 30 residues, large canvas
    "make_test_html.py",    # real structures, ribbon vs cartoon side by side
    "make_na_test.py",      # nucleic acids: duplex, folded RNA, protein/DNA
    "make_ligand_test.py",  # ligand occlusion: hemes, pocket ligands
    "make_richardson_test.py",  # richardson preset vs cartoon, per SS content
]
# Not built by default: make_ribosome.py (4UG0, ~1 min to parse) and
# make_bench.py (synthetic sweep to 10000 residues). Run them directly.
PORT = 8931


def build():
    for name in SCRIPTS:
        path = os.path.join(HERE, name)
        print(f"--- {name}")
        runpy.run_path(path, run_name="__main__")


def serve():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=OUTDIR)
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", PORT), handler) as httpd:
        print(f"serving {OUTDIR} at http://localhost:{PORT}/  (ctrl-c to stop)")
        httpd.serve_forever()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--serve", action="store_true", help=f"serve tests/out on :{PORT} after building")
    args = ap.parse_args()
    build()
    print(f"\nwrote {len(SCRIPTS)} page(s) to {OUTDIR}")
    if args.serve:
        serve()
    else:
        print(f"open with: python {os.path.relpath(__file__)} --serve")
        sys.exit(0)
