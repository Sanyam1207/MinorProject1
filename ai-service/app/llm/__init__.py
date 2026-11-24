"""Shared LLM clients. Import the module (``from app.llm import gemini``) and
call ``gemini.generate_json(...)`` so a single monkeypatch reaches every caller."""

from app.llm import gemini

__all__ = ["gemini"]
