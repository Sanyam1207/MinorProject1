"""Thin re-export shim — kept for backwards compatibility.

The real implementation lives in ``agent.py``.  The orchestrator's
``REGISTRY`` already imports ``ResumeGeneratorAgent`` from
``app.agents.resume_generator`` (the package), so this file exists only to
preserve the module path that was in the original stub.
"""

from app.agents.resume_generator.agent import ResumeGeneratorAgent

__all__ = ["ResumeGeneratorAgent"]
