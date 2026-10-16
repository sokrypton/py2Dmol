"""Where structures fetched by id (``pdb:1UBQ``, ``afdb:Q5VSL9``) are kept.

The notebook's ``from_pdb`` downloads into the current directory, which is right
for a notebook and wrong for a server that was launched from wherever a plugin
host happened to start it. The agent surface resolves a directory instead:

    explicit argument
    > PY2DMOL_CACHE_DIR            ("none" or empty disables)
    > [tool.py2dmol] cache_dir     in the nearest pyproject.toml above the cwd
    > cache_dir                    in ${XDG_CONFIG_HOME:-~/.config}/py2dmol/config.toml
    > off                          a temporary directory for this process only

``cache_dir_source()`` says which of those decided. A malformed config file is an
error, never a silent fall-through. Entries are keyed by the id itself (an RCSB code
or a UniProt accession names exactly one file) and written atomically.
"""
from __future__ import annotations

import os
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

ENV = "PY2DMOL_CACHE_DIR"
_OFF_DIR: Path | None = None


class CacheConfigError(ValueError):
    """A config file that names a cache directory could not be read."""


class FetchError(RuntimeError):
    """A structure named by id could not be downloaded."""


def _toml_load(path: Path) -> dict:
    import tomllib
    try:
        with path.open("rb") as fh:
            return tomllib.load(fh)
    except (OSError, tomllib.TOMLDecodeError) as e:
        raise CacheConfigError(f"{path}: {e}") from e


def _nearest_pyproject(start: Path) -> Path | None:
    for d in (start, *start.parents):
        p = d / "pyproject.toml"
        if p.is_file():
            return p
    return None


def cache_dir_source(explicit: str | os.PathLike | None = None,
                     cwd: Path | None = None) -> tuple[Path | None, str]:
    """(directory or None for off, the layer that decided)."""
    if explicit is not None:
        return Path(explicit).expanduser(), "argument"
    env = os.environ.get(ENV)
    if env is not None:
        if env.strip().lower() in ("", "none"):
            return None, f"{ENV} (disabled)"
        return Path(env).expanduser(), ENV
    pp = _nearest_pyproject((cwd or Path.cwd()).resolve())
    if pp is not None:
        val = _toml_load(pp).get("tool", {}).get("py2dmol", {}).get("cache_dir")
        if val:
            return (pp.parent / Path(val).expanduser()).resolve(), f"{pp} [tool.py2dmol]"
    cfg = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "py2dmol" / "config.toml"
    if cfg.is_file():
        val = _toml_load(cfg).get("cache_dir")
        if val:
            return Path(val).expanduser(), str(cfg)
    return None, "off"


def cache_dir(explicit: str | os.PathLike | None = None) -> Path:
    """The directory to fetch into, created; a per-process temp dir when off."""
    global _OFF_DIR
    path, _ = cache_dir_source(explicit)
    if path is None:
        if _OFF_DIR is None:
            _OFF_DIR = Path(tempfile.mkdtemp(prefix="py2dmol-fetch-"))
        return _OFF_DIR
    path.mkdir(parents=True, exist_ok=True)
    return path


def _download(url: str, dest: Path) -> Path:
    if dest.is_file() and dest.stat().st_size > 0:
        return dest
    tmp = dest.with_name(f".{dest.name}.{os.getpid()}.part")
    try:
        urllib.request.urlretrieve(url, tmp)
        os.replace(tmp, dest)
    except (urllib.error.URLError, OSError) as e:
        tmp.unlink(missing_ok=True)
        raise FetchError(f"could not download {url}: {e}") from e
    return dest


def fetch_pdb(code: str, directory: Path) -> Path:
    code = code.strip().upper()
    if len(code) != 4 or not code.isalnum():
        raise FetchError(f"not a PDB code: {code!r} (expected four characters, e.g. 1UBQ)")
    return _download(f"https://files.rcsb.org/download/{code}.cif", directory / f"{code}.cif")


def fetch_afdb(accession: str, directory: Path, pae: bool = False) -> tuple[Path, Path | None]:
    acc = accession.strip().upper()
    struct = _download(f"https://alphafold.ebi.ac.uk/files/AF-{acc}-F1-model_v6.cif",
                       directory / f"AF-{acc}.cif")
    pae_path = None
    if pae:
        try:
            pae_path = _download(
                f"https://alphafold.ebi.ac.uk/files/AF-{acc}-F1-predicted_aligned_error_v6.json",
                directory / f"AF-{acc}-pae.json")
        except FetchError:
            pae_path = None
    return struct, pae_path
