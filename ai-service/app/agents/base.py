from typing import AsyncIterator, Protocol, runtime_checkable, Any

from app.schemas import QueryRequest


class AgentChunk:
    """An output unit an agent emits verbatim.

    Agents that own their own wire format -- their own ``header_message`` per
    turn and their own structured ``data`` -- yield subclasses of this instead
    of plain strings or ``Job`` models. The orchestrator emits them exactly as
    given, with no accumulation, formatting or header substitution of its own,
    so the wire contract for those agents lives in the agent package rather
    than in the orchestrator.

    Subclasses supply four attributes: ``header_message``, ``response``,
    ``data`` and ``is_end``.
    """

    __slots__ = ()

    header_message: str
    response: str
    data: Any
    is_end: bool


@runtime_checkable
class Agent(Protocol):
    """An agent is a named async generator of deltas, strings, or structured items.

    Agents yield output chunks or objects. The orchestrator accumulates them
    into the running response (Markdown and optional structured payload) and is
    the single place that talks to the Socket.IO server.
    """

    name: str

    def run(self, req: QueryRequest) -> AsyncIterator[Any]:
        ...

    # Optional class attributes -- read by the orchestrator through getattr, so
    # an agent that doesn't set them keeps the default behaviour:
    #
    #   ROUTING_RULES       : RoutingRules  strong / weak / veto regexes that
    #                              describe this agent's requests. The router
    #                              scores them (restricted to the modes the
    #                              caller's role may use, app/agents/roles.py).
    #   SWITCH_MESSAGE      : str  the one-line "mode:switch:*" confirmation.
    #   emits_own_chunks    : bool True when run() yields AgentChunk objects, so
    #                              the orchestrator emits them verbatim and adds
    #                              no final chunk of its own (it still guarantees
    #                              a terminal chunk if the agent forgets one).
    #   content_header      : str  fallback header for anything this agent
    #                              yields that is not an AgentChunk.
    #
    # Optional hooks -- none of them are part of the Protocol, so agents that
    # don't need them stay untouched. They let an agent that owns a multi-turn
    # workflow have a say in being rerouted away from:
    #
    #   @staticmethod error_chunk(message, session_id="") -> AgentChunk
    #       The agent's own terminal error chunk (the data shape its panel
    #       expects). Used when run() raises; the exception text is logged only.
    #
    #   async def should_release(self, req, target) -> str
    #       Called once the router has decided the user wants another agent.
    #       Return "release" to switch now, "hold" to stay put silently, or
    #       "ask" to stay put for one turn and put the question to the user.
    #       Missing hook -- or a hook that raises -- means release. Cannot
    #       cause a switch, only stop one.
    #
    #   async def pending_switch(self, req) -> Optional[tuple[str, str]]
    #       Called before the router. Return (target_mode, original_query) once
    #       the user has confirmed a switch this agent asked about, so their
    #       original request -- not their "yes" -- reaches the new agent.
    #
    #   async def on_mode_exit(self, req) -> Optional[str]
    #       Called when the reroute actually happens. Tear down anything that
    #       must not keep running (a live interview, a pending confirmation).
    #       Return a short notice to show alongside the mode-switch line.
    #
    # The copilot (app/agents/copilot/) is the fallback agent: it answers when
    # no other agent matches, when scores tie, and whenever a role may not use
    # the agent that owns a request. Its should_release always releases and its
    # on_mode_exit drops any pending confirmation.
