from typing import List, Optional, Any, Dict
from pydantic import BaseModel


class PastMessage(BaseModel):
    """One turn of prior conversation, for agents that use history as context."""

    role: str
    content: str


class MailDraftState(BaseModel):
    """Optional live PR-outreach composer state sent by the frontend."""

    to: str = ""
    subject: str = ""
    body: str = ""
    status: Optional[str] = None
    confidence_score: Optional[float] = None


class AlumniRequestDraftState(BaseModel):
    """Optional live alumni connection composer sent by the frontend."""

    alumni_id: str = ""
    alumni_name: str = ""
    request_type: str = "career-guidance"
    message: str = ""
    selected_job: Optional[Dict[str, Any]] = None
    share_resume: bool = False
    resume: str = ""
    status: Optional[str] = None


class ResumeShareDraftState(BaseModel):
    connection_id: str = ""
    alumni_name: str = ""
    resume_version_id: str = ""
    resume_title: str = ""
    resume_version: int = 1
    message: str = ""
    status: Optional[str] = None


class QueryRequest(BaseModel):
    """What Node sends over its per-request connection to start a job."""

    requestId: str
    sessionId: str
    user_query: str
    user_role: Optional[str] = None
    mode_name: Optional[str] = None
    past_messages: Optional[List[PastMessage]] = None
    meta_data: Optional[Dict[str, Any]] = None
    mail_draft: Optional[MailDraftState] = None
    alumni_request_draft: Optional[AlumniRequestDraftState] = None
    resume_share_draft: Optional[ResumeShareDraftState] = None


class ResponseChunk(BaseModel):
    """What we emit back on that same connection, one or more times.

    `response` is the full markdown so far, not just the new delta -- the
    caller can render it directly with no accumulation of its own. `data`
    contains optional structured payload (e.g. array of scraped job dicts).
    `isEnd` marks the last chunk; the caller closes the connection on seeing it.
    `confidence_score` is an optional float (0-1) representing the agent's
    confidence in its response quality.
    `options` is an optional list of string choices rendered as clickable
    buttons in the frontend chat UI.
    """

    requestId: str
    header_message: str
    response: str
    data: Optional[Any] = None
    isEnd: bool
    confidence_score: Optional[float] = None
    options: Optional[List[str]] = None
