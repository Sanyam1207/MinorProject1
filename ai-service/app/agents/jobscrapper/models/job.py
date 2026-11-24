from enum import Enum
from typing import List, Optional, Any, Dict
from pydantic import BaseModel, Field


class ScrapingStatus(str, Enum):
    SUCCESS = "SUCCESS"
    SCRAPING_DISALLOWED = "SCRAPING_DISALLOWED"
    INVALID_URL = "INVALID_URL"
    PAGE_NOT_FOUND = "PAGE_NOT_FOUND"
    ACCESS_DENIED = "ACCESS_DENIED"
    LOGIN_REQUIRED = "LOGIN_REQUIRED"
    BOT_PROTECTION = "BOT_PROTECTION"
    JAVASCRIPT_REQUIRED = "JAVASCRIPT_REQUIRED"
    NO_JOBS_FOUND = "NO_JOBS_FOUND"
    SCRAPING_ERROR = "SCRAPING_ERROR"


class Job(BaseModel):
    title: str = "Not mentioned"
    company: str = "Not mentioned"
    category: str = "Other"
    subcategory: str = "General"
    location: str = "Not mentioned"
    employment_type: str = "Not mentioned"
    experience: str = "Not mentioned"
    salary: str = "Not mentioned"
    stipend: str = "Not mentioned"
    skills: List[str] = Field(default_factory=list)
    description: str = "Not mentioned"
    requirements: str = "Not mentioned"
    posted_date: str = "Not mentioned"
    application_url: str = "Not mentioned"
    source_url: str = "Not mentioned"


class SSEEvent(BaseModel):
    type: str  # status, job, progress, error, complete
    message: Optional[str] = None
    data: Optional[Dict[str, Any]] = None
    current: Optional[int] = None
    total: Optional[int] = None
    status_code: Optional[ScrapingStatus] = None
    total_jobs: Optional[int] = None
