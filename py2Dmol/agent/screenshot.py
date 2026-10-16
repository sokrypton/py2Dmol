"""render_image: a spec's picture as a PNG or SVG file, through headless Chromium.

WHY THIS EXISTS WHEN ``view.save_image`` WAS REMOVED. A Python image door was built
once and taken out of the notebook API ("keep it simple, provide user a html for
bulk only"). The agent case is the reason the batch page cannot meet: an agent
cannot drop files on render.html, and a model that cannot SEE a picture cannot
critique it. So it lives here, behind the ``screenshot`` extra, and ``view`` is
untouched.

ONE RENDERING PATH. The page rendered is the standalone file ``render_html``
writes, and the picture comes out through the renderer's own ``toImage`` - not a
page screenshot - so the dpi, the export scale, transparency and the "SVG needs the
2D painter" refusal stay where capture.js keeps them. The HTML an agent opens and
the PNG it looks at cannot disagree.

THE BROWSER IS FOUND, NEVER DOWNLOADED MID-CALL. Playwright's pip package carries no
browser; ``playwright install chromium`` is a separate ~150 MB download, and a tool
call is no place to start one. In order:

    1. the Chromium this Playwright version expects (``playwright install chromium``)
    2. PY2DMOL_CHROMIUM, a path to any Chromium/Chrome executable
    3. the newest Chromium already in Playwright's cache (~/.cache/ms-playwright),
       from ANY Playwright version - measured: Playwright wanting build 1248 drives
       a cached 1243 headless shell and renders correctly. This is what makes a
       browser installed once survive a uvx env resolving a newer Playwright.

and otherwise ScreenshotUnavailable, carrying the command that fixes it.

Measured (2026-10-16, headless shell, no WebGL2 there - the 2D painter draws):
1UBQ 0.46 s and 4HHB 0.55 s for the first image including page load, 0.06 s and
0.19 s for a second, browser launch 0.6 s.
"""
from __future__ import annotations

import base64
import glob
import os
from pathlib import Path

ENV_BROWSER = "PY2DMOL_CHROMIUM"
SETUP_HINT = ('pip install "py2Dmol[screenshot]" && playwright install chromium '
              "(or: py2dmol screenshot-setup)")
FORMATS = ("png", "svg")

_WAIT_JS = """async (vid) => {
  const t0 = performance.now();
  while (performance.now() - t0 < 30000) {
    const v = window.py2dmol_viewers && window.py2dmol_viewers[vid];
    if (v && v.renderer && v.renderer.coords && v.renderer.coords.length) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  return false;
}"""

_SHOT_JS = """async ([vid, opts]) => {
  const r = window.py2dmol_viewers[vid].renderer;
  const out = await r.toImage(Object.assign({dataUrl: true}, opts));
  return {width: out.width, height: out.height, format: out.format, dataUrl: out.dataUrl};
}"""


_PLUGINS_JS = """(vid) => {
  const P = window.py2dmolPlugins || {};
  const r = window.py2dmol_viewers[vid].renderer;
  return {registered: (P.list || []).map(d => d && d.name),
          rejected: P.rejected || [],
          errors: P.errors ? P.errors(r) : []};
}"""


class ScreenshotUnavailable(RuntimeError):
    """Playwright or a browser is missing. ``exit_code`` is the CLI's, ``hint`` the fix."""
    exit_code = 5

    def __init__(self, why: str):
        self.hint = SETUP_HINT
        super().__init__(f"{why}. Install with: {SETUP_HINT}")


class RenderTimeout(RuntimeError):
    exit_code = 6


def _cached_browsers() -> list[str]:
    root = Path(os.environ.get("PLAYWRIGHT_BROWSERS_PATH") or Path.home() / ".cache" / "ms-playwright")
    found = glob.glob(str(root / "chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell"))
    found += glob.glob(str(root / "chromium-*/chrome-linux*/chrome"))
    found += glob.glob(str(root / "chromium_headless_shell-*/chrome-headless-shell-mac*/chrome-headless-shell"))
    found += glob.glob(str(root / "chromium-*/chrome-mac*/Chromium.app/Contents/MacOS/Chromium"))

    def build(p: str) -> int:
        for part in Path(p).parts:
            if "-" in part and part.rsplit("-", 1)[1].isdigit():
                return int(part.rsplit("-", 1)[1])
        return 0
    return sorted(found, key=build, reverse=True)


class Shooter:
    """One browser, reused across images. A context manager; close() is idempotent."""

    def __init__(self):
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            raise ScreenshotUnavailable("Playwright is not installed") from None
        self._pw = sync_playwright().start()
        self.browser = None
        self.executable = None
        errors = []
        candidates = [None]
        if os.environ.get(ENV_BROWSER):
            candidates.append(os.environ[ENV_BROWSER])
        candidates += _cached_browsers()
        for exe in candidates:
            try:
                self.browser = self._pw.chromium.launch(executable_path=exe)
                self.executable = exe or "playwright default"
                break
            except Exception as e:  # noqa: BLE001 - try the next one, report all
                errors.append(f"{exe or 'playwright default'}: {str(e).splitlines()[0]}")
        if self.browser is None:
            self._pw.stop()
            raise ScreenshotUnavailable("no Chromium could be launched (" + "; ".join(errors[:3]) + ")")
        self.page = self.browser.new_page()

    def shoot(self, html_path: str | Path, viewer_id: str, out: str | Path,
              fmt: str = "png", dpi: int = 150, transparent: bool = False) -> dict:
        """Write one image. The camera is the spec's (its orient/focus steps), not a parameter here."""
        if fmt not in FORMATS:
            raise ValueError(f"format must be one of {FORMATS}, not {fmt!r}")
        self.page.goto(Path(html_path).resolve().as_uri())
        if not self.page.evaluate(_WAIT_JS, viewer_id):
            raise RenderTimeout(f"the viewer in {html_path} drew nothing within 30 s")
        res = self.page.evaluate(_SHOT_JS, [viewer_id, {"format": fmt, "dpi": int(dpi),
                                                        "transparent": bool(transparent)}])
        data = base64.b64decode(res["dataUrl"].split(",", 1)[1])
        out = Path(out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(data)
        return {"path": str(out), "format": res["format"], "width": res["width"],
                "height": res["height"], "bytes": len(data)}

    def plugin_state(self, viewer_id: str) -> dict:
        """The registry's own view of the page last shot: registered, rejected, draw errors."""
        return self.page.evaluate(_PLUGINS_JS, viewer_id)

    def close(self):
        if self.browser is not None:
            self.browser.close()
            self.browser = None
        if self._pw is not None:
            self._pw.stop()
            self._pw = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


class ThreadedShooter:
    """A Shooter that lives on one dedicated thread, with the same methods.

    🔴 PLAYWRIGHT'S SYNC API REFUSES TO RUN INSIDE AN ASYNCIO LOOP, and under MCP
    every tool body does: FastMCP awaits the tool, and cisternal's wrapper calls the
    sync function from inside that loop. The CLI has no loop, so only a real
    stdio server showed it ("It looks like you are using Playwright Sync API inside
    the asyncio loop"). Sync Playwright objects are also bound to the thread that
    made them, so the browser gets one thread of its own, created there and called
    only there, and every caller - CLI or MCP - goes through it.
    """

    def __init__(self):
        from concurrent.futures import ThreadPoolExecutor
        self._pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="py2dmol-browser")
        self._inner = self._pool.submit(Shooter).result()   # raises ScreenshotUnavailable here
        self.executable = self._inner.executable

    def shoot(self, *a, **k) -> dict:
        return self._pool.submit(self._inner.shoot, *a, **k).result()

    def plugin_state(self, viewer_id: str) -> dict:
        return self._pool.submit(self._inner.plugin_state, viewer_id).result()

    def close(self):
        if self._inner is not None:
            try:
                self._pool.submit(self._inner.close).result()
            except RuntimeError:
                # At interpreter exit concurrent.futures has already shut its
                # workers down (it registers before atexit runs); the browser
                # process is a child and goes with us.
                pass
            self._inner = None
        self._pool.shutdown(wait=True)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def install_browser() -> int:
    """`playwright install chromium`, the one explicit download. Returns its exit code."""
    import subprocess
    import sys
    try:
        import playwright  # noqa: F401
    except ImportError:
        raise ScreenshotUnavailable("Playwright is not installed") from None
    return subprocess.call([sys.executable, "-m", "playwright", "install", "chromium"],
                           stdout=sys.stderr)
