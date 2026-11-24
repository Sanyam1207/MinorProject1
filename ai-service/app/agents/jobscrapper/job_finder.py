"""Jobs finder: real job search, careers-page crawling and the job tracker.

Modes, checked in this order:

1. **Careers URL** -- the user pasted a link: the page is crawled (robots.txt
   respected, SSRF-checked) and every verified listing is streamed.
2. **Wishlist / applied** -- "save job 2", "mark the 1st job as applied":
   persisted through the Node tools ``market_job_save`` /
   ``market_job_mark_applied`` (JOB-FEED.md §12.8).
3. **Details** -- "tell me about job 3": a grounded description of a listed job.
4. **Search** -- everything else: ``jobs_search_campus`` (students) and
   ``jobs_search_market`` through the Node tool API, merged into one list.

No code path yields an LLM-generated job: every listing comes from a tool
result or from the page the user asked us to crawl.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any, AsyncIterator, Dict, List, Optional, Set

from app.config import settings
from app.llm import gemini
from app.schemas import QueryRequest
from app.tools_client import execute_tool, has_tool_access
from app.utils.url_utils import validate_url, is_safe_url, normalize_url
from app.utils.text_utils import NOT_MENTIONED
from app.agents.jobscrapper.scraper.robots_checker import check_robots_permission
from app.agents.jobscrapper.scraper.ats_detector import detect_ats
from app.agents.jobscrapper.scraper.crawler import JobCrawler
from app.agents.jobscrapper.scraper.extractor import JobExtractor
from app.normalizer.job_normalizer import normalize_job
from app.agents.jobscrapper.classifier.job_classifier import classify_job
from app.verifier.link_verifier import LinkVerifier
from app.agents.jobscrapper.search import (
    campus_item,
    crawl_item,
    extract_search_args,
    item_label,
    job_index_from_text,
    market_item,
    merge_items,
)
from app.agents.jobscrapper.session_store import session_job_store
from app.agents.routing import RoutingRules, URL_PATTERN

logger = logging.getLogger(__name__)

WISHLIST_HEADER = "mode:jobparser:addjob:wishlist"
DETAILS_HEADER = "mode:jobparser:jobdetails"

IRRELEVANT_TEXT = (
    "Please ask only job-finding related queries. I can assist you by scraping career website URLs "
    "or finding job openings across domains such as Tech, Finance, Marketing, HR, or Engineering."
)
NO_TOOLS_SEARCH_TEXT = (
    "Job search needs the backend connection, which isn't configured right now "
    "(AGENT_TOOL_SECRET is missing on the server). Please try again later."
)
NO_JOBS_TEXT = (
    "There's no job list in this chat yet. Search first (e.g. “find data analyst internships”), "
    "then say “save job 2”."
)
CRAWL_NOT_SAVEABLE_TEXT = (
    "That listing came from the careers page you shared and isn't in the job feed, so it can't be saved. "
    "Use its Apply link instead."
)
TRACKER_UNREACHABLE_TEXT = "I couldn't reach your job tracker just now. Please try again."

_IRRELEVANT_PATTERNS = (
    "generate me a python code", "write a python code", "write python code",
    "generate code", "write code", "code to", "script to", "how to code",
    "solve math", "write a poem", "write an essay", "tell me a joke",
    "create a script", "build an app",
)
_JOB_KEYWORDS = (
    "tech", "technology", "software", "developer", "engineer", "finance", "banking",
    "accounting", "marketing", "sales", "hr", "human resources", "design", "ui/ux",
    "data", "manager", "product", "consulting", "legal", "healthcare", "python",
    "java", "remote", "intern", "internship", "associate", "role", "roles", "job", "jobs", "find", "search",
    "drive", "drives", "opportunit", "opening", "vacanc", "hiring", "company", "companies",
)
_WISHLIST_TRIGGERS = (
    "wishlist", "wish list", "wish-list", "save job", "saved job", "save jobs",
    "add to wishlist", "add to my wishlist", "save to wishlist", "save to my wishlist",
    "move to wishlist", "move to my wishlist", "move it to wishlist", "move this to wishlist",
    "move to saved", "move it to saved", "put in wishlist", "put into wishlist", "put in my wishlist",
    "bookmark", "shortlist", "favorite", "favourite", "save for later", "keep for later",
    "save this job", "add to saved", "save to saved", "mark as favorite", "add to favorites",
)
_WISHLIST_VERBS = {"move", "add", "save", "put", "keep", "bookmark", "shortlist", "favorite", "favourite", "store", "place"}
_WISHLIST_NOUNS = {"wishlist", "saved", "favorites", "favourites", "bookmarks", "shortlist", "tracker"}
_SAVE_REF_RE = re.compile(
    r"\b(save|bookmark)\b[^.?!]{0,30}\b(job|role|listing|opening|position|posting|one|it|this|that)\b", re.I
)
_APPLIED_RE = re.compile(
    r"\b(mark|set)\b[^.?!]{0,40}\bas\s+applied\b|\bi\s+(?:have\s+|'ve\s+|just\s+)?applied\b|\bapplied\s+(?:to|for)\b",
    re.I,
)
# Questions and listings ("show my saved jobs", "which jobs have I applied for?")
# are reads: they must never write to the job tracker.
_READ_REQUEST_RE = re.compile(
    r"^\s*(show|list|view|see|display|open|get|what|which|where|how\s+many|do\s+i|did\s+i|have\s+i|any)\b|\?\s*$",
    re.I,
)
_PRONOUN_RE = re.compile(
    r"\b(this|that|the\s+same|the\s+selected)\s+(job|role|position|one|opening|posting|listing)\b|\bit\b", re.I
)
_SEARCH_REQUEST_RE = re.compile(
    r"\b(find|search|show|get|browse|fetch|look(ing)?\s+for)\b[^.?!]{0,25}"
    r"\b(jobs?|openings?|vacanc(y|ies)|internships?|roles?|positions?)\b",
    re.I,
)
_DETAIL_KEYWORDS = (
    "detail", "details", "more info", "information", "tell me about",
    "explain", "requirements", "description", "what is", "about job",
    "about the job", "about role", "salary of", "responsibilities",
    "tell me", "this job", "about this", "job details", "know about",
)


class JobFinderAgent:
    """Real job search (campus + open market), careers-page crawling, and the job tracker."""

    name = "jobs-finder"

    ROUTING_RULES = RoutingRules(
        strong=(
            r"\b(find|search|show|get|browse|fetch|look(ing)?\s+for)\b[^.?!]{0,25}\b(jobs?|openings?|vacanc(y|ies)|internships?|roles?|positions?)\b",
            # "jobs in Pune", "jobs at Infosys" -- a place or an employer.
            # Deliberately excludes "for": "put up a job for Infosys" is a TPO
            # posting one, not a student browsing.
            r"\bjobs?\b\s+(in|at|near)\b",
            r"\b(job|career)\s+(search|hunt)\b",
            r"\b(who|anyone|companies?)\s+(is\s+)?hiring\b",
            r"\bscrape\b[^.?!]{0,25}\b(careers?|jobs?)\b",
            # The job tracker (JOB-FEED.md §12.9).
            r"\b(add|save|move|put|keep|bookmark|shortlist)\b[^.?!]{0,30}\b(wish\s*-?\s*list|saved(\s+jobs?)?|tracker|bookmarks?|favou?rites?)\b",
            r"\bmark\b[^.?!]{0,40}\bas\s+applied\b",
            URL_PATTERN,
        ),
        weak=(
            r"\bjobs?\b", r"\bopenings?\b", r"\bvacanc(y|ies)\b",
            r"\binternships?\b", r"\bcareers?\b", r"\bhiring\b",
        ),
        # "mock interview for an SDE job" belongs to the interviewer.
        veto=(r"\bmock\s+interview\b", r"\binterview\s+me\b"),
    )
    SWITCH_MESSAGE = "Sure -- let's look for some jobs."

    def __init__(self) -> None:
        self.verifier = LinkVerifier()

    # ------------------------------------------------------------------
    # Parsing helpers
    # ------------------------------------------------------------------

    def _extract_url_from_query(self, query: str) -> str:
        """Extract an http(s) or bare-domain URL from the message."""
        if not query:
            return ""
        clean_query = query.strip('\'"')
        url_match = re.search(r'https?://[^\s<>\'"]+', clean_query)
        if url_match:
            return url_match.group(0).rstrip('.,;)\'"')
        domain_match = re.search(r'\b(?:[a-zA-Z0-9\-]+\.)+[a-zA-Z]{2,}(?:/[^\s<>\'"]*)?', clean_query)
        if domain_match:
            matched_str = domain_match.group(0).rstrip('.,;)\'"')
            if '/' in matched_str or matched_str.lower().startswith("www."):
                return f"https://{matched_str}"
        return ""

    @staticmethod
    def _extract_ordinal_or_index(query: str, count: int = 0) -> Optional[int]:
        """1-based position from "the 2nd job", "job 5", "#5", "the last one" (may be out of range)."""
        return job_index_from_text(query or "", count)

    @staticmethod
    def _is_wishlist_request(query: str) -> bool:
        query_lower = (query or "").strip().lower()
        if not query_lower or _READ_REQUEST_RE.search(query_lower):
            return False
        words = set(re.findall(r"\b\w+\b", query_lower))
        has_verb_and_noun = bool(words & _WISHLIST_VERBS) and bool(words & _WISHLIST_NOUNS)
        return (
            any(trigger in query_lower for trigger in _WISHLIST_TRIGGERS)
            or has_verb_and_noun
            or bool(_SAVE_REF_RE.search(query_lower))
        )

    @staticmethod
    def _is_applied_request(query: str) -> bool:
        if _READ_REQUEST_RE.search(query or ""):
            return False
        return bool(_APPLIED_RE.search(query or ""))

    # ------------------------------------------------------------------
    # Target resolution ("job 2", "the Infosys one", "it")
    # ------------------------------------------------------------------

    async def _resolve_target_index(
        self, query: str, cached: List[Dict[str, Any]], session_id: str, purpose: str
    ) -> Optional[int]:
        count = len(cached)
        if not count:
            return None

        index = self._extract_ordinal_or_index(query, count)
        if index is not None:
            return index if 1 <= index <= count else None

        lowered = query.lower()
        named = []
        for position, item in enumerate(cached, 1):
            company = str(item.get("company_name") or "")
            title = str(item.get("title") or "")
            company_hit = len(company) >= 3 and company != NOT_MENTIONED and company.lower() in lowered
            title_hit = len(title) >= 3 and title != NOT_MENTIONED and title.lower() in lowered
            if company_hit or title_hit:
                named.append(position)
        if len(named) == 1:
            return named[0]

        last_viewed = session_job_store.get_last_viewed_job(session_id)
        last_index = None
        if last_viewed:
            for position, item in enumerate(cached, 1):
                if item.get("id") and item.get("id") == last_viewed.get("id"):
                    last_index = position
                    break
        if _PRONOUN_RE.search(query) and last_index is not None:
            return last_index
        if last_index is not None:
            return last_index
        if count == 1:
            return 1
        return await self._llm_target_index(query, cached, purpose)

    async def _llm_target_index(self, query: str, cached: List[Dict[str, Any]], purpose: str) -> Optional[int]:
        """Last resort: ask the shared Gemini client which listed job is meant (6 s, no retries)."""
        if not gemini.is_configured():
            return None
        summaries = "\n".join(
            f"[{position}] Company: {item.get('company_name') or 'Unknown'} | Title: {item.get('title') or 'Unknown'}"
            for position, item in enumerate(cached, 1)
        )
        prompt = (
            "You are an intent parser for a career assistant.\n"
            f"Job listings currently shown to the user:\n{summaries}\n\n"
            f'User message: "{query}"\n\n'
            f"The user wants to {purpose} one of these listings. Which 1-based index do they mean? "
            'Return strictly valid JSON only: {"target_index": <integer or null>}'
        )
        try:
            parsed = await gemini.generate_json(contents=[gemini.user_turn(prompt)], timeout=6, max_retries=0)
        except Exception:
            logger.warning("job target resolution via Gemini failed", exc_info=True)
            return None
        target = parsed.get("target_index") if isinstance(parsed, dict) else None
        if isinstance(target, int) and 1 <= target <= len(cached):
            return target
        return None

    # ------------------------------------------------------------------
    # Wishlist / applied (JOB-FEED.md §12.8)
    # ------------------------------------------------------------------

    async def _track(self, req: QueryRequest, action: str, cached: List[Dict[str, Any]]) -> Dict[str, Any]:
        sid = req.sessionId or ""
        meta = req.meta_data if isinstance(req.meta_data, dict) else {}
        result: Dict[str, Any] = {
            "type": "wishlist", "action": action, "ok": False, "job_id": None,
            "kind": None, "status": None, "error": None, "ui": None,
        }

        def reply(text: str) -> Dict[str, Any]:
            return {"type": "add_wishlist", "header_message": WISHLIST_HEADER, "content": text, "data": result}

        if not cached:
            result["error"] = "NO_JOBS"
            return reply(NO_JOBS_TEXT)

        purpose = "save to their job tracker" if action == "save" else "mark as applied"
        index = await self._resolve_target_index(req.user_query or "", cached, sid, purpose)
        if index is None:
            result["error"] = "AMBIGUOUS_TARGET"
            verb = "add to your wishlist" if action == "save" else "mark as applied"
            example = "add 1st job to wishlist" if action == "save" else "mark job 1 as applied"
            return reply(
                f"Please specify which job you would like to {verb} (e.g. '{example}' or mention the company name). "
                f"Found {len(cached)} job(s) in session."
            )

        item = cached[index - 1]
        session_job_store.set_last_viewed_job(sid, item)
        result["job_id"] = item.get("id")
        result["kind"] = item.get("kind")
        label = item_label(item)

        if item.get("kind") == "campus":
            result["error"] = "CAMPUS_DRIVE"
            if action == "save":
                return reply(
                    f"{label} is a campus drive — campus drives are tracked in Applications, not the saved list. "
                    f"Say “apply to job {index}” to apply."
                )
            return reply(
                f"{label} is a campus drive — apply in the portal (say “apply to job {index}”) "
                "and its status will appear under Applications."
            )
        if not item.get("saveable") or str(item.get("id") or "").startswith("crawl:"):
            result["error"] = "NOT_SAVEABLE"
            return reply(CRAWL_NOT_SAVEABLE_TEXT)

        tool = "market_job_save" if action == "save" else "market_job_mark_applied"
        response = await execute_tool(
            meta, tool, {"job": item["id"]},
            timeout=settings.JOBS_FINDER_TOOL_TIMEOUT_SECONDS, request_id=req.requestId,
        )
        if not isinstance(response, dict):
            response = {"ok": False, "error": "INTERNAL", "message": "Unexpected tool response."}
        ui = response.get("ui")
        if isinstance(ui, list):
            ui = next((entry for entry in ui if isinstance(entry, dict)), None)
        result["ui"] = ui if isinstance(ui, dict) else None

        if response.get("ok") is True:
            data = response.get("data") if isinstance(response.get("data"), dict) else {}
            tracked = data.get("item") if isinstance(data.get("item"), dict) else {}
            status = tracked.get("status") or ("saved" if action == "save" else "applied")
            result.update(ok=True, status=status)
            session_job_store.update_job(sid, item["id"], application_status=status)
            return reply(response.get("summary") or (
                f"Saved {label} to your job tracker." if action == "save" else f"Marked {label} as applied."
            ))

        code = response.get("error") or "ERROR"
        result["error"] = code
        if code == "FORBIDDEN":
            text = "Only students have a job tracker."
        elif code == "NOT_FOUND":
            text = "That job is no longer in the feed."
        elif code in ("AUTH", "UNAVAILABLE", "NO_TOOL_TOKEN"):
            text = TRACKER_UNREACHABLE_TEXT
        else:
            text = response.get("message") or TRACKER_UNREACHABLE_TEXT
        return reply(text)

    # ------------------------------------------------------------------
    # Details ("tell me about job 3")
    # ------------------------------------------------------------------

    async def _resolve_target_job_with_gemini(
        self, user_query: str, cached_jobs: List[Dict[str, Any]]
    ) -> tuple[bool, Optional[int]]:
        """Is the message asking for details on a listed job, and which one?"""
        if not user_query or not cached_jobs:
            return False, None
        query_lower = user_query.strip().lower()
        if self._extract_url_from_query(user_query):
            return False, None

        extracted_index = self._extract_ordinal_or_index(user_query, len(cached_jobs))
        has_detail_keyword = any(keyword in query_lower for keyword in _DETAIL_KEYWORDS)

        # "job 2", "the 3rd one", "tell me about the last job": a listed job.
        if extracted_index is not None:
            return True, extracted_index
        # A search request ("find data analyst jobs") is never a details request.
        if _SEARCH_REQUEST_RE.search(user_query) or not has_detail_keyword:
            return False, None

        named = [
            position for position, item in enumerate(cached_jobs, 1)
            if (len(str(item.get("company_name") or "")) >= 3
                and str(item.get("company_name")) != NOT_MENTIONED
                and str(item.get("company_name")).lower() in query_lower)
            or (len(str(item.get("title") or "")) >= 3 and str(item.get("title")).lower() in query_lower)
        ]
        if len(named) == 1:
            return True, named[0]
        if len(cached_jobs) == 1:
            return True, 1

        if gemini.is_configured():
            summaries = "\n".join(
                f"[{position}] Company: {item.get('company_name') or 'Unknown'} | Title: {item.get('title') or 'Unknown'}"
                for position, item in enumerate(cached_jobs, 1)
            )
            prompt = (
                "You are an intent parser for a career assistant.\n"
                f"Job listings currently shown to the user:\n{summaries}\n\n"
                f'User message: "{user_query}"\n\n'
                "Is the user asking for details about one of these listings, and which 1-based index? "
                'Return strictly valid JSON only: {"is_detail_query": true|false, "target_index": <integer or null>}'
            )
            try:
                parsed = await gemini.generate_json(contents=[gemini.user_turn(prompt)], timeout=6, max_retries=0)
            except Exception:
                logger.warning("detail-intent resolution via Gemini failed", exc_info=True)
                parsed = None
            if isinstance(parsed, dict):
                target = parsed.get("target_index")
                if isinstance(target, int):
                    return bool(parsed.get("is_detail_query", True)), target
                return bool(parsed.get("is_detail_query")), None
        return True, None

    async def _stream_job_details_response(
        self, user_query: str, target_job: Dict[str, Any], job_index: int, total_jobs: int
    ) -> AsyncIterator[str]:
        """A grounded, human-toned description of one listed job (LLM, else a template)."""
        apply_hint = (
            f"Clickable link to apply: [{target_job.get('title') or 'Apply'}]({target_job['application_url']})."
            if target_job.get("application_url")
            else "There is no external link: the student applies inside the campus portal."
        )
        prompt = f"""You are a warm, professional AI Career Advisor assisting a candidate.
The user asked: "{user_query}"

Describe job listing #{job_index} of {total_jobs} recent listings.

Job Data:
{json.dumps(target_job, indent=2, ensure_ascii=False)}

Use only facts present in Job Data. If a field is missing or 'Not mentioned', say so; never invent salary, skills, responsibilities, perks or links.

Format guidelines:
1. Tone: encouraging, natural and informative.
2. Do NOT use asterisks (*) anywhere; use plain text, numbers, emojis or dashes (-).
3. Structure:
   - 📌 Role overview
   - 🏢 Company & location
   - 💼 Employment type & experience
   - 💰 Compensation
   - 🛠️ Skills
   - 📋 Requirements
   - 🔗 How to apply: {apply_hint}
"""
        produced = False
        try:
            async for text_chunk in gemini.stream_text(
                contents=[gemini.user_turn(prompt)],
                generation_config={"temperature": 0.3},
                timeout=15,
            ):
                clean_chunk = text_chunk.replace("*", "")
                if clean_chunk:
                    produced = True
                    yield clean_chunk
        except gemini.GeminiNotConfigured:
            pass
        except Exception as exc:
            logger.warning("job details stream failed: %s", exc)
        if produced:
            return

        title = str(target_job.get("title") or "Job role").replace("*", "")
        company = str(target_job.get("company_name") or target_job.get("company") or "Company").replace("*", "")
        skills = target_job.get("skills")
        skills_text = ", ".join(skills) if isinstance(skills, list) and skills else "Not mentioned"
        yield f"### 📌 Details for {title} at {company} (Job #{job_index})\n\n"
        yield f"- Location: {target_job.get('location') or 'Not mentioned'}\n"
        yield f"- Type: {target_job.get('job_type') or 'Not mentioned'}\n"
        yield f"- Experience: {target_job.get('experience') or 'Not mentioned'}\n"
        yield f"- Salary/Stipend: {target_job.get('salary') or 'Not mentioned'}\n"
        yield f"- Skills: {skills_text}\n\n"
        description = target_job.get("description")
        if description and description != NOT_MENTIONED:
            yield f"Overview: {description}\n\n"
        requirements = target_job.get("requirements")
        if requirements and requirements != NOT_MENTIONED:
            yield f"Requirements: {requirements}\n\n"
        if target_job.get("application_url"):
            yield f"🔗 [Click here to apply]({target_job['application_url']})\n"
        else:
            yield f"🔗 Apply inside the campus portal (say “apply to job {job_index}”).\n"

    # ------------------------------------------------------------------
    # Careers-page crawl
    # ------------------------------------------------------------------

    async def _crawl(self, target_url: str, session_id: str) -> AsyncIterator[Any]:
        if not validate_url(target_url):
            yield f"Error: Invalid URL format provided ({target_url}). Please specify a valid http:// or https:// URL.\n"
            return
        if not is_safe_url(target_url):
            yield f"Access Denied: Provided URL ({target_url}) resolves to a private or loopback IP address range.\n"
            return
        allowed, _status_code, perm_message = await check_robots_permission(target_url)
        if not allowed:
            yield f"Scraping Disallowed: {perm_message}\n"
            return

        yield (
            f"🔍 Job Discovery Pipeline\n"
            f"- Target URL: {target_url}\n"
            f"- URL Validation: Passed\n"
            f"- Robots.txt Check: Permitted ({perm_message})\n"
            f"- Job Discovery: Fetching pages and streaming jobs...\n\n"
        )

        crawler = JobCrawler(max_depth=2, max_pages=15)
        seen_keys: Set[str] = set()
        extractor = JobExtractor()
        found: List[Dict[str, Any]] = []
        try:
            async for page_url, html_content in crawler.crawl_stream(target_url):
                ats_type = detect_ats(page_url, html_content)
                raw_jobs = extractor.extract_jobs(html_content, page_url, ats_type)
                for raw_job in raw_jobs:
                    app_url = raw_job.get("application_url") or ""
                    title = raw_job.get("title") or ""
                    company = raw_job.get("company") or ""
                    location = raw_job.get("location") or ""
                    if app_url and app_url != page_url and app_url != NOT_MENTIONED:
                        dedup_key = normalize_url(app_url)
                    else:
                        dedup_key = f"{company.lower()}:{title.lower()}:{location.lower()}"
                    if dedup_key in seen_keys:
                        continue
                    seen_keys.add(dedup_key)

                    category, subcategory = classify_job(
                        title=title,
                        description=raw_job.get("description", ""),
                        requirements=raw_job.get("requirements", ""),
                        skills=raw_job.get("skills", []),
                    )
                    raw_job["category"] = category
                    raw_job["subcategory"] = subcategory
                    job_model = normalize_job(raw_job)

                    is_genuine, reason = await self.verifier.verify_link(
                        job_title=job_model.title,
                        company=job_model.company,
                        application_url=job_model.application_url,
                        source_url=job_model.source_url,
                    )
                    if not is_genuine:
                        logger.info("Rejecting non-job link %r (%s)", job_model.title, reason)
                        continue
                    found.append(crawl_item(job_model.model_dump()))
                    yield job_model
                    await asyncio.sleep(0.01)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("crawl of %s failed: %s", target_url, exc)
            yield f"\nCrawling Error: {exc}\n"
        finally:
            await crawler.close()

        if found:
            session_job_store.replace_jobs(session_id, found)
        else:
            yield "\nNo structured job listings could be extracted from the target pages.\n"

    # ------------------------------------------------------------------
    # Search (JOB-FEED.md §12.6)
    # ------------------------------------------------------------------

    @staticmethod
    def _role(req: QueryRequest, meta: dict) -> str:
        actor = meta.get("actor") if isinstance(meta.get("actor"), dict) else {}
        role = actor.get("role") or req.user_role or "student"
        return str(role).strip().lower() or "student"

    @staticmethod
    def _jobs_of(result: dict) -> List[dict]:
        data = result.get("data") if isinstance(result, dict) else None
        jobs = data.get("jobs") if isinstance(data, dict) else None
        return [job for job in jobs if isinstance(job, dict)] if isinstance(jobs, list) else []

    async def _search(self, req: QueryRequest, query: str, meta: dict) -> AsyncIterator[Any]:
        query_lower = query.lower()
        if any(pattern in query_lower for pattern in _IRRELEVANT_PATTERNS):
            yield IRRELEVANT_TEXT
            return
        if not (any(keyword in query_lower for keyword in _JOB_KEYWORDS) and len(query) > 3):
            yield IRRELEVANT_TEXT
            return

        is_student = self._role(req, meta) == "student"
        if not has_tool_access(meta):
            yield NO_TOOLS_SEARCH_TEXT
            return

        args = extract_search_args(query)
        scope = "campus drives and the open-market job feed" if is_student else "the open-market job feed"
        facets = "".join(f" · {value}" for value in (args.job_type, args.work_type, args.location) if value)
        if args.query:
            yield f"🔎 Searching {scope} for “{args.query}”{facets}…\n\n"
        else:
            yield f"🔎 Finding the best matches for your profile in {scope}{facets}…\n\n"

        timeout = float(settings.JOBS_FINDER_TOOL_TIMEOUT_SECONDS)
        market_args: Dict[str, Any] = {
            key: value for key, value in (
                ("query", args.query), ("jobType", args.job_type),
                ("workType", args.work_type), ("location", args.location),
            ) if value
        }
        market_args["sort"] = "match" if is_student else "newest"
        market_args["limit"] = settings.JOBS_FINDER_MAX_RESULTS
        calls = []
        if is_student:
            campus_args: Dict[str, Any] = {
                key: value for key, value in (("query", args.query), ("location", args.location)) if value
            }
            campus_args["limit"] = settings.JOBS_FINDER_CAMPUS_LIMIT
            calls.append(execute_tool(meta, "jobs_search_campus", campus_args, timeout=timeout, request_id=req.requestId))
        calls.append(execute_tool(meta, "jobs_search_market", market_args, timeout=timeout, request_id=req.requestId))
        try:
            results = await asyncio.wait_for(asyncio.gather(*calls), timeout=timeout + 5)
        except asyncio.TimeoutError:
            results = [{"ok": False, "error": "UNAVAILABLE", "message": "the search timed out"} for _ in calls]

        normalized = [r if isinstance(r, dict) else {"ok": False, "error": "INTERNAL", "message": "bad response"} for r in results]
        campus_result = normalized[0] if is_student else None
        market_result = normalized[-1]
        campus_ok = bool(campus_result) and campus_result.get("ok") is True
        market_ok = market_result.get("ok") is True

        def message_of(result: Optional[dict]) -> str:
            return str((result or {}).get("message") or (result or {}).get("error") or "unknown error")

        if not market_ok and (not is_student or not campus_ok):
            failed = market_result if not market_ok else campus_result
            yield f"I couldn't reach the job database just now ({message_of(failed)}). Please try again in a moment."
            return
        if is_student and not campus_ok:
            yield f"⚠️ Campus drives are unavailable right now ({message_of(campus_result)}); showing open-market jobs only.\n\n"
        if not market_ok:
            yield f"⚠️ The open-market job feed is unavailable right now ({message_of(market_result)}); showing campus drives only.\n\n"

        campus_items = [campus_item(job, student=is_student) for job in self._jobs_of(campus_result)] if campus_ok else []
        market_items = [market_item(job) for job in self._jobs_of(market_result)] if market_ok else []
        items = merge_items(
            campus_items, market_items,
            campus_limit=settings.JOBS_FINDER_CAMPUS_LIMIT,
            max_results=settings.JOBS_FINDER_MAX_RESULTS,
        )
        if not items:
            target = f"“{args.query}”" if args.query else "your profile"
            yield (
                f"I couldn't find any open roles matching {target}{facets} right now. Try fewer keywords, "
                "a different city, or say “show the latest internships”."
            )
            return

        session_job_store.replace_jobs(req.sessionId or "", items)
        for item in items:
            yield {"type": "job_item", "job": item}

    # ------------------------------------------------------------------
    # Entry point
    # ------------------------------------------------------------------

    async def run(self, req: QueryRequest) -> AsyncIterator[Any]:
        query = (req.user_query or "").strip()
        session_id = req.sessionId or ""
        meta = req.meta_data if isinstance(req.meta_data, dict) else {}

        target_url = self._extract_url_from_query(query)
        if target_url:
            async for item in self._crawl(target_url, session_id):
                yield item
            return

        cached_jobs = session_job_store.get_jobs(session_id)

        if self._is_wishlist_request(query):
            yield await self._track(req, "save", cached_jobs)
            return
        if self._is_applied_request(query):
            yield await self._track(req, "applied", cached_jobs)
            return

        is_detail_query, target_index = await self._resolve_target_job_with_gemini(query, cached_jobs)
        if is_detail_query:
            if not cached_jobs:
                yield {
                    "type": "job_details",
                    "content": "I don't have any job listings for this chat yet. Search first or share a careers-page URL, then ask me about a specific job.",
                    "header_message": DETAILS_HEADER,
                }
                return
            if target_index is None:
                yield {
                    "type": "job_details",
                    "content": (
                        f"I found {len(cached_jobs)} job listing(s) from our recent search. Which one would you like "
                        "details on (e.g. 'details on 1st job', '5th listing', or the company name)?"
                    ),
                    "header_message": DETAILS_HEADER,
                }
                return
            if not 1 <= target_index <= len(cached_jobs):
                yield {
                    "type": "job_details",
                    "content": (
                        f"I only found {len(cached_jobs)} job listing(s) in our recent search. Please pick a number "
                        f"between 1 and {len(cached_jobs)}, or mention the company name."
                    ),
                    "header_message": DETAILS_HEADER,
                }
                return
            target_job = cached_jobs[target_index - 1]
            session_job_store.set_last_viewed_job(session_id, target_job)
            async for chunk in self._stream_job_details_response(query, target_job, target_index, len(cached_jobs)):
                yield {
                    "type": "job_details",
                    "content": chunk,
                    "header_message": DETAILS_HEADER,
                    "data": {"selected_job": target_job},
                }
            return

        async for item in self._search(req, query, meta):
            yield item
