"""Gemini function calling for the copilot (PYTHON.md §5.5).

The Node manifest's JSON-schema subset becomes Gemini ``functionDeclarations``;
``GeminiCopilotLLM.step`` runs one model round and returns its text, function
calls and the model ``content`` VERBATIM (so ``thoughtSignature`` and any other
part fields are passed back unchanged on the next round).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional

from app.config import settings
from app.llm import gemini
from app.llm.gemini import FunctionCall
from app.agents.copilot.tools_client import Manifest

log = logging.getLogger("copilot.llm")

_TYPE_MAP = {
    "object": "OBJECT",
    "string": "STRING",
    "number": "NUMBER",
    "integer": "INTEGER",
    "boolean": "BOOLEAN",
    "array": "ARRAY",
}
_DESCRIPTION_MAX = 1000


class CopilotLLMError(Exception):
    """The model could not produce a usable step (HTTP error, malformed call, no candidate)."""


@dataclass
class LLMStep:
    text: str = ""
    calls: List[FunctionCall] = field(default_factory=list)
    model_content: Optional[dict] = None
    finish_reason: Optional[str] = None
    blocked: bool = False


def to_gemini_schema(schema: Any) -> Optional[dict]:
    """Convert a JSON-schema subset to a Gemini ``Schema`` (unknown keywords stripped)."""
    if not isinstance(schema, dict):
        return None
    raw_type = schema.get("type")
    nullable = schema.get("nullable") is True
    if isinstance(raw_type, list):
        names = [str(t).lower() for t in raw_type if isinstance(t, str)]
        if "null" in names:
            nullable = True
        non_null = [t for t in names if t != "null"]
        raw_type = non_null[0] if non_null else None
    if raw_type is None:
        if isinstance(schema.get("properties"), dict):
            raw_type = "object"
        elif isinstance(schema.get("items"), dict):
            raw_type = "array"
    gtype = _TYPE_MAP.get(str(raw_type).lower(), "STRING") if raw_type is not None else "STRING"

    out: Dict[str, Any] = {"type": gtype}
    description = schema.get("description") if isinstance(schema.get("description"), str) else ""

    enum = schema.get("enum")
    if isinstance(enum, list) and enum:
        if all(isinstance(value, str) for value in enum):
            out["type"] = gtype = "STRING"
            out["enum"] = list(enum)
            out["format"] = "enum"
        else:
            allowed = ", ".join(str(value) for value in enum)
            description = f"{description} Allowed values: {allowed}".strip()

    if gtype == "OBJECT":
        properties: Dict[str, Any] = {}
        raw_props = schema.get("properties") if isinstance(schema.get("properties"), dict) else {}
        for name, sub in raw_props.items():
            converted = to_gemini_schema(sub)
            if converted is None:
                continue
            if converted.get("type") == "OBJECT" and not converted.get("properties"):
                continue  # e.g. open_panel.params: free-form objects are not declarable
            properties[str(name)] = converted
        if properties:
            out["properties"] = properties
        required = [name for name in (schema.get("required") or []) if isinstance(name, str) and name in properties]
        if required:
            out["required"] = required
    elif gtype == "ARRAY":
        items = to_gemini_schema(schema.get("items"))
        if items is None or (items.get("type") == "OBJECT" and not items.get("properties")):
            items = {"type": "STRING"}
        out["items"] = items

    if nullable:
        out["nullable"] = True
    if description:
        out["description"] = description[:_DESCRIPTION_MAX]
    return out


def manifest_to_function_declarations(manifest: Manifest) -> List[dict]:
    declarations: List[dict] = []
    for spec in manifest.tools:
        declaration: Dict[str, Any] = {
            "name": spec.name,
            "description": (spec.description or spec.name.replace("_", " "))[:_DESCRIPTION_MAX],
        }
        params = spec.parameters if isinstance(spec.parameters, dict) else None
        if params and isinstance(params.get("properties"), dict) and params["properties"]:
            converted = to_gemini_schema({**params, "type": "object"})
            if converted and converted.get("properties"):
                declaration["parameters"] = converted
        declarations.append(declaration)
    return declarations


def _message_parts(message: Any) -> tuple[str, str]:
    if isinstance(message, dict):
        role, content = message.get("role"), message.get("content")
    else:
        role, content = getattr(message, "role", None), getattr(message, "content", None)
    return str(role or ""), content if isinstance(content, str) else ""


def history_to_contents(
    past_messages: Optional[Iterable[Any]],
    user_query: str,
    *,
    max_messages: int = 12,
    max_chars: int = 2000,
) -> List[dict]:
    """Gemini ``contents`` from the chat history plus the current user turn."""
    messages = []
    for message in past_messages or []:
        role, content = _message_parts(message)
        if content.strip():
            messages.append((role, content.strip()))
    messages = messages[-max_messages:] if max_messages > 0 else []

    entries: List[Dict[str, str]] = []
    for role, content in messages:
        gemini_role = "user" if role.strip().lower() == "user" else "model"
        text = content[:max_chars]
        if entries and entries[-1]["role"] == gemini_role:
            entries[-1]["text"] += "\n\n" + text
        else:
            entries.append({"role": gemini_role, "text": text})
    while entries and entries[0]["role"] == "model":
        entries.pop(0)

    query = (user_query or "").strip()
    if entries and entries[-1]["role"] == "user" and entries[-1]["text"].strip() == query[:max_chars].strip():
        entries.pop()
    if entries and entries[-1]["role"] == "user":
        entries[-1]["text"] += "\n\n" + query
    else:
        entries.append({"role": "user", "text": query})
    return [{"role": entry["role"], "parts": [{"text": entry["text"]}]} for entry in entries]


class GeminiCopilotLLM:
    """One function-calling round against Gemini."""

    @property
    def available(self) -> bool:
        return gemini.is_configured()

    async def step(
        self,
        *,
        system: str,
        contents: List[dict],
        declarations: List[dict],
        force_text: bool = False,
    ) -> LLMStep:
        try:
            response = await gemini.generate(
                model=settings.COPILOT_MODEL or settings.GEMINI_MODEL,
                contents=contents,
                system=system,
                tools=[{"functionDeclarations": declarations}] if declarations else None,
                tool_config=(
                    {"functionCallingConfig": {"mode": "NONE" if force_text else "AUTO"}} if declarations else None
                ),
                generation_config={"maxOutputTokens": 2048},
                timeout=settings.COPILOT_LLM_TIMEOUT_SECONDS,
            )
        except gemini.GeminiError as exc:
            raise CopilotLLMError(str(exc)) from exc
        if response.blocked:
            return LLMStep(
                text="", calls=[], model_content=response.content,
                finish_reason=response.finish_reason, blocked=True,
            )
        if response.finish_reason == "MALFORMED_FUNCTION_CALL":
            raise CopilotLLMError("the model produced a malformed function call")
        if response.content is None:
            raise CopilotLLMError("the model returned no candidate")
        return LLMStep(
            text=response.text,
            calls=list(response.function_calls),
            model_content=response.content,
            finish_reason=response.finish_reason,
            blocked=False,
        )
