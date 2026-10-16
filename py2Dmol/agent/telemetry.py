"""Opt-in telemetry for the two agent entry points, and nothing else.

py2Dmol is a public package used mostly from notebooks by people who never asked
for any of this, so:

- ``import py2Dmol`` and ``view.show()`` never emit anything. This module is
  imported only by ``py2dmol`` and ``py2dmol-mcp``.
- Even there it is OFF unless ``CISTERNAL_TELEMETRY`` is ``all|1|true|yes|py2dmol``
  - cisternal's own consumer gate (``consumer_telemetry_enabled``), called rather
  than copied. ``cisternal.init()`` itself has no gate, so this one is ours to keep.
- Events are local JSONL (``CISTERNAL_LOG_DIR`` > ... > ``~/.cisternal/logs``);
  nothing leaves the machine unless the user has configured an OTLP exporter.
- Fields are counts and enums. No paths, no sequences, no structure ids.

Tool calls are recorded for free: the CLI path through ``timed_command`` (which
``wire()`` puts round every command) and the MCP path through
``CisternalMiddleware``. ``event()`` adds what only py2Dmol knows.
"""
from __future__ import annotations

CONSUMER = "py2dmol"
_ON = False


def enabled() -> bool:
    from cisternal.probe.telemetry_env import consumer_telemetry_enabled
    return consumer_telemetry_enabled(CONSUMER)


def init() -> bool:
    """Start the pipeline if the user opted in. Returns whether it is on."""
    global _ON
    if _ON:
        return True
    if not enabled():
        return False
    import cisternal
    cisternal.init()
    _ON = True
    return True


def event(name: str, **fields) -> None:
    """A py2dmol.* event. A no-op when telemetry is off; never raises."""
    if not _ON:
        return
    try:
        import cisternal
        cisternal.emit_event(f"{CONSUMER}.{name}", **fields)
    except Exception:  # noqa: BLE001 - telemetry must never break a tool call
        pass
