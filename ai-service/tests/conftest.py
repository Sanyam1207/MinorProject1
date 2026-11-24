"""Shared pytest setup for the agent service.

Tests never touch the network: no real Gemini key is used and the Node tool
API is always faked. Each test that needs settings should monkeypatch them.
"""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# Make accidental real LLM calls impossible during tests.
os.environ["GEMINI_API_KEY"] = ""
os.environ.setdefault("AI_SERVICE_TOKEN", "")
