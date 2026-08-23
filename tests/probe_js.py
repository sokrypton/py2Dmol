"""The JavaScript every browser probe needs, in one place.

A probe builds its page by appending a script to index.html and reading back
one JSON result. The waiting is the part they all get wrong the same way, so it
lives here:

  settle(n)     n animation frames - "the browser has painted". What to use
                after a click or a call, which is nearly everything: the step
                is synchronous and only the paint is not. Three frames is 50 ms
                where the flat sleeps these replaced were 300-1,500.

  until(c, ms)  poll until a condition holds. What to use after something
                ASYNCHRONOUS - a file parsed, a session restored - where no
                number of frames means "done". Converting to this found two
                sleeps that were too SHORT as well as many that were too long:
                a restored session is still assembling itself three frames in.

  loaded()      the standard condition after processFiles: the viewer has
                coordinates.

Import it and interpolate it into the page script:

    from probe_js import HELPERS
    JS = "<script>window.addEventListener('load', () => {" + HELPERS + " ... "
"""

HELPERS = """
  const settle = async (n = 3) => {
    for (let k = 0; k < n; k++) {
      await new Promise((s) => requestAnimationFrame(() => s()));
    }
  };
  const until = async (cond, ms = 4000) => {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      if (cond()) return true;
      await new Promise((s) => setTimeout(s, 40));
    }
    return false;
  };
  const loaded = () => {
    const v = window.py2dmol_viewers && window.py2dmol_viewers['standalone-viewer-1'];
    return !!(v && v.renderer && v.renderer.coords && v.renderer.coords.length);
  };
"""


# A PROBE THAT CANNOT FINISH MUST FAIL FAST.
#
# A syntax error in the injected script means the page never runs, so the
# result never arrives - and the probe then sat out its whole deadline before
# saying "no result posted". One mis-escaped newline in a JS string literal
# cost 400 seconds of a 35-second suite, twice, before anyone looked.
#
# So: the script is parsed before Chrome is started, and the wait is capped at
# half a minute. Nothing here legitimately takes that long; the slowest probe
# is four seconds.
DEADLINE = 30

import subprocess as _sp, tempfile as _tf, os as _os, sys as _sys


def check_js(js, name='the probe script'):
    """Parse the page script before launching a browser at it."""
    body = js.replace('<script>', '').replace('</script>', '')
    try:
        with _tf.NamedTemporaryFile('w', suffix='.js', delete=False) as f:
            f.write(body)
            path = f.name
        out = _sp.run(['node', '--check', path], capture_output=True, text=True)
    except FileNotFoundError:
        return          # no node here: the browser will have to be the judge
    finally:
        try: _os.unlink(path)
        except OSError: pass
    if out.returncode:
        first = [l for l in out.stderr.splitlines() if l.strip()][:4]
        _sys.exit(f'{name} does not parse:\n  ' + '\n  '.join(first))
