import asyncio
import json
import logging
import re
from typing import AsyncIterator, Set, Any, List, Dict, Optional, Tuple
import httpx

from app.config import settings
from app.schemas import QueryRequest
from app.utils.url_utils import validate_url, is_safe_url, normalize_url
from app.utils.text_utils import NOT_MENTIONED
from app.agents.jobscrapper.scraper.robots_checker import check_robots_permission
from app.agents.jobscrapper.scraper.ats_detector import detect_ats
from app.agents.jobscrapper.scraper.crawler import JobCrawler
from app.agents.jobscrapper.scraper.extractor import JobExtractor
from app.normalizer.job_normalizer import normalize_job
from app.agents.jobscrapper.classifier.job_classifier import classify_job
from app.verifier.link_verifier import LinkVerifier
from app.agents.jobscrapper.models.job import Job
from app.agents.jobscrapper.session_store import session_job_store
from app.agents.routing import RoutingRules, URL_PATTERN

logger = logging.getLogger(__name__)


ORDINAL_MAP = {
    "first": 1, "1st": 1,
    "second": 2, "2nd": 2,
    "third": 3, "3rd": 3,
    "fourth": 4, "4th": 4,
    "fifth": 5, "5th": 5,
    "sixth": 6, "6th": 6,
    "seventh": 7, "7th": 7,
    "eighth": 8, "8th": 8,
    "ninth": 9, "9th": 9,
    "tenth": 10, "10th": 10
}


class JobFinderAgent:
    """Multi-Mode Agent that:
    1. Crawls career URLs if a link is provided, verifying links and streaming jobs page-by-page.
    2. Streams domain-specific jobs in real-time from AI LLM via SSE if no URL is provided.
    3. Responds with rich human-toned details when asked about a previously scraped job listing (e.g. 'fifth job', 'job at Infosys').
    """

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

    def __init__(self):
        self.verifier = LinkVerifier()
        self.stream_endpoint = f"https://generativelanguage.googleapis.com/v1beta/models/{settings.GEMINI_MODEL}:streamGenerateContent?key={settings.GEMINI_API_KEY}&alt=sse"

    def _extract_url_from_query(self, query: str) -> str:
        """Extract HTTP/HTTPS or domain URL from user prompt string."""
        if not query:
            return ""

        clean_query = query.strip('\'"')

        # 1. Match explicit http/https URLs
        url_match = re.search(r'https?://[^\s<>\'"]+', clean_query)
        if url_match:
            return url_match.group(0).rstrip('.,;)\'"')

        # 2. Match URLs starting with www. or containing domain/path (e.g. debugwithshubham.com/jobs)
        domain_match = re.search(r'\b(?:[a-zA-Z0-9\-]+\.)+[a-zA-Z]{2,}(?:/[^\s<>\'"]*)?', clean_query)
        if domain_match:
            matched_str = domain_match.group(0).rstrip('.,;)\'"')
            if '/' in matched_str or matched_str.lower().startswith("www."):
                return f"https://{matched_str}"

        return ""

    def _extract_ordinal_or_index(self, query: str) -> Optional[int]:
        """Extract explicit 1-based job index or ordinal word from query string."""
        query_lower = query.lower()

        # Match words like 'fifth job', '5th job', 'job 5', 'job #5'
        for word, index_val in ORDINAL_MAP.items():
            if re.search(r'\b' + re.escape(word) + r'\b', query_lower):
                return index_val

        # Match patterns like 'job 5', 'listing 3', '#2', 'role 4'
        match = re.search(r'(?:job|listing|role|position|number|#)\s*(\d+)', query_lower)
        if match:
            try:
                return int(match.group(1))
            except ValueError:
                pass

        return None

    async def _resolve_target_job_with_gemini(
        self, user_query: str, cached_jobs: List[Dict[str, Any]]
    ) -> Tuple[bool, Optional[int]]:
        """Determine if user query is asking for details on a specific cached job listing."""
        if not user_query or not cached_jobs:
            return False, None

        query_lower = user_query.strip().lower()

        # 1. Direct URL scraping is NEVER a detail query
        if self._extract_url_from_query(user_query):
            return False, None

        # 2. Check for explicit search verbs/phrases (never a detail query)
        search_phrases = [
            "find ", "search ", "looking for ", "show me jobs", "get jobs",
            "scrape ", "browse ", "jobs in ", "developer jobs", "engineer jobs",
            "python jobs", "remote jobs", "hiring "
        ]
        if any(query_lower.startswith(p) for p in search_phrases):
            return False, None

        # 3. Check fast regex / ordinal parser
        extracted_index = self._extract_ordinal_or_index(user_query)

        # Check detail keywords
        detail_keywords = [
            "detail", "details", "more info", "information", "tell me about",
            "explain", "requirements", "description", "what is", "about job",
            "about the job", "about role", "salary of", "responsibilities",
            "tell me", "this job", "about this", "job details", "know about"
        ]
        has_detail_keyword = any(kw in query_lower for kw in detail_keywords)

        if extracted_index is not None and has_detail_keyword:
            return True, extracted_index

        if not has_detail_keyword and extracted_index is None:
            return False, None

        # Build prompt for Gemini intent & index resolution
        job_summaries = []
        for idx, j in enumerate(cached_jobs, 1):
            comp = j.get("company") or j.get("company_name") or "Unknown"
            title = j.get("title") or "Unknown"
            job_summaries.append(f"[{idx}] Company: {comp} | Title: {title}")

        jobs_text = "\n".join(job_summaries)

        prompt = f"""You are an intent parser for a career assistant.
Available recent job listings in active session:
{jobs_text}

User prompt: "{user_query}"

Determine:
1. Is the user explicitly asking for details, clarification, qualifications, or description of one of the job listings above (e.g., "tell me more about job 1", "tell me about this job", or "details on Infosys")?
2. If yes, which 1-based job index ([1], [2], etc.) are they referring to? If they say "this job" and there is only 1 job listing, return 1.

Return strictly valid JSON only:
{{"is_detail_query": true|false, "target_index": 1-based integer or null}}
"""
        payload = {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"response_mime_type": "application/json"}
        }

        try:
            async with httpx.AsyncClient(timeout=6.0) as client:
                endpoint = f"https://generativelanguage.googleapis.com/v1beta/models/{settings.GEMINI_MODEL}:generateContent?key={settings.GEMINI_API_KEY}"
                resp = await client.post(endpoint, json=payload)
                if resp.status_code == 200:
                    text_res = resp.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
                    parsed = json.loads(text_res)
                    is_detail = bool(parsed.get("is_detail_query"))
                    target_idx = parsed.get("target_index")
                    if isinstance(target_idx, int):
                        return is_detail, target_idx
                    if is_detail and len(cached_jobs) == 1:
                        return True, 1
                    return is_detail, extracted_index
        except Exception as exc:
            logger.warning(f"Gemini job resolution fallback: {exc}")

        if has_detail_keyword and len(cached_jobs) == 1:
            return True, 1

        return has_detail_keyword, extracted_index

    async def _resolve_wishlist_intent_with_gemini(
        self, user_query: str, cached_jobs: List[Dict[str, Any]], session_id: str = ""
    ) -> Tuple[bool, Optional[int]]:
        """Ask Gemini LLM to determine if the user wants to wishlist/save a job listing and identify the target job index."""
        if not user_query:
            return False, None

        query_lower = user_query.strip().lower()

        # Direct URL scraping is NEVER a wishlist request
        if self._extract_url_from_query(user_query):
            return False, None

        last_viewed = session_job_store.get_last_viewed_job(session_id) if session_id else None
        last_viewed_index = None
        if last_viewed and cached_jobs:
            for idx, j in enumerate(cached_jobs, 1):
                if (
                    j.get("title") == last_viewed.get("title")
                    and j.get("company", j.get("company_name")) == last_viewed.get("company", last_viewed.get("company_name"))
                ):
                    last_viewed_index = idx
                    break

        extracted_index = self._extract_ordinal_or_index(user_query)
        is_pronoun_reference = any(p in query_lower for p in ["this job", "this role", "this position", "that job", "it to", "it in", "this one"])
        if is_pronoun_reference and extracted_index is None and last_viewed_index is not None:
            extracted_index = last_viewed_index

        wishlist_triggers = [
            "wishlist", "wish list", "wish-list", "save job", "saved job", "save jobs",
            "add to wishlist", "add to my wishlist", "save to wishlist", "save to my wishlist",
            "move to wishlist", "move to my wishlist", "move it to wishlist", "move this to wishlist",
            "move job to wishlist", "move 1st job to wishlist", "move one to wishlist", "move a job to wishlist",
            "move that to wishlist", "move this job to wishlist", "move to saved", "move it to saved",
            "put in wishlist", "put into wishlist", "put in my wishlist", "put job in wishlist",
            "add job to wishlist", "add it to wishlist", "add this job to wishlist", "add one to wishlist",
            "bookmark", "shortlist", "favorite", "favourite", "save for later", "keep for later",
            "save this job", "add to saved", "save to saved", "mark as favorite", "add to favorites"
        ]
        wishlist_verbs = {"move", "add", "save", "put", "keep", "bookmark", "shortlist", "favorite", "favourite", "store", "place"}
        wishlist_nouns = {"wishlist", "wish-list", "wish list", "saved", "favorites", "favourites", "bookmarks", "shortlist"}

        query_words = set(re.findall(r"\b\w+\b", query_lower))
        has_verb_and_noun = bool(query_words & wishlist_verbs) and bool(query_words & wishlist_nouns)

        fast_match = (
            any(trig in query_lower for trig in wishlist_triggers)
            or has_verb_and_noun
            or ("wishlist" in query_lower)
        )

        if fast_match and extracted_index is not None and cached_jobs and 1 <= extracted_index <= len(cached_jobs):
            return True, extracted_index

        if fast_match and last_viewed_index is not None:
            return True, last_viewed_index

        if fast_match and len(cached_jobs) == 1:
            return True, 1

        # Call Gemini LLM to classify wishlist intent and resolve target job index
        job_summaries = []
        for idx, j in enumerate(cached_jobs, 1):
            comp = j.get("company") or j.get("company_name") or "Unknown"
            title = j.get("title") or "Unknown"
            marker = " (LAST DETAILED BY USER)" if idx == last_viewed_index else ""
            job_summaries.append(f"[{idx}] Company: {comp} | Title: {title}{marker}")

        jobs_text = "\n".join(job_summaries) if job_summaries else "No cached jobs in session."
        last_viewed_context = f"\nMost recently elaborated/detailed job in this session: Job #{last_viewed_index}\n" if last_viewed_index else ""

        prompt = f"""You are an intent parser for a career assistant.
Available recent job listings in active session:
{jobs_text}
{last_viewed_context}
User prompt: "{user_query}"

Task:
Determine:
1. Is the user asking to save, move, bookmark, shortlist, favorite, or add a job listing to their wishlist/saved list? (e.g. "move 1st job to wishlist", "I want to save this one", "add this job to wishlist", "shortlist job 2").
2. If yes, which 1-based job index ([1], [2], etc.) are they referring to?
   - If they say "this job", "it", "this role", "this position", or "move to wishlist" without specifying a number, and a job was recently elaborated (Job #{last_viewed_index or 1}), map it to Job #{last_viewed_index or 1}.
   - If they refer to a company name or job title from the list, map it to the corresponding index.

Return strictly valid JSON only:
{{"is_wishlist_query": true|false, "target_index": 1-based integer or null}}
"""
        payload = {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"response_mime_type": "application/json"}
        }

        try:
            async with httpx.AsyncClient(timeout=6.0) as client:
                endpoint = f"https://generativelanguage.googleapis.com/v1beta/models/{settings.GEMINI_MODEL}:generateContent?key={settings.GEMINI_API_KEY}"
                resp = await client.post(endpoint, json=payload)
                if resp.status_code == 200:
                    text_res = resp.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
                    parsed = json.loads(text_res)
                    is_wishlist = bool(parsed.get("is_wishlist_query"))
                    target_idx = parsed.get("target_index")
                    if isinstance(target_idx, int):
                        return is_wishlist, target_idx
                    if is_wishlist and last_viewed_index is not None:
                        return True, last_viewed_index
                    if is_wishlist and len(cached_jobs) == 1:
                        return True, 1
                    return is_wishlist, extracted_index
        except Exception as exc:
            logger.warning(f"Gemini wishlist resolution fallback: {exc}")

        final_idx = extracted_index if extracted_index is not None else last_viewed_index
        return fast_match, final_idx

    async def _stream_job_details_response(
        self, user_query: str, target_job: Dict[str, Any], job_index: int, total_jobs: int
    ) -> AsyncIterator[str]:
        """Stream a warm, detailed, human-toned breakdown for the specified job listing using Gemini."""
        prompt = f"""You are a warm, professional AI Career Advisor assisting a candidate.
The user asked: "{user_query}"

Provide a comprehensive, engaging, human-toned detailed breakdown for Job listing #{job_index} out of {total_jobs} total recent listings:

Job Data:
{json.dumps(target_job, indent=2)}

Format guidelines:
1. Tone: Encouraging, natural, conversational, and highly informative human tone.
2. STRICT FORMATTING RULE: Do NOT use any asterisks (*) anywhere in your response text. Do NOT use bold markdown with asterisks (**), italic markdown with asterisks (*), or bullet points with asterisks (*). Use clean text, numbers, emojis, or dashes (-) for formatting without any asterisks (*).
3. Structure:
   - 📌 Role Overview & Impact: High-level summary of the position and team.
   - 🏢 Company & Location: Hiring company overview, work setup (Remote/On-site/Hybrid).
   - 💼 Employment & Experience: Job type (Full-time/Contract/Internship) and required experience level.
   - 💰 Compensation & Perks: Salary/stipend details.
   - 🛠️ Required Skills & Tech Stack: Clear bulleted list of skills.
   - 📋 Key Responsibilities & Qualifications: Specific requirements.
   - 🔗 Application Instructions: Clickable link to apply: [{target_job.get('title', 'Apply Now')}]({target_job.get('application_url', '#')}). Plus helpful tips on applying.
"""
        payload = {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": 0.3}
        }

        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                async with client.stream("POST", self.stream_endpoint, json=payload) as response:
                    if response.status_code == 200:
                        async for line in response.aiter_lines():
                            if line.startswith("data: "):
                                json_str = line[6:].strip()
                                try:
                                    data = json.loads(json_str)
                                    text_chunk = data["candidates"][0]["content"]["parts"][0]["text"]
                                    clean_chunk = text_chunk.replace("*", "")
                                    yield clean_chunk
                                    await asyncio.sleep(0.01)
                                except Exception:
                                    pass
                        return
        except Exception as exc:
            logger.error(f"LLM streaming error for job details: {exc}")

        # Fallback response if LLM call encounters error
        title = target_job.get("title", "Job Role").replace("*", "")
        company = target_job.get("company", target_job.get("company_name", "Company")).replace("*", "")
        app_url = target_job.get("application_url", "#")
        yield f"### 📌 Details for {title} at {company} (Job #{job_index})\n\n"
        yield f"- Location: {target_job.get('location', 'Not mentioned')}\n"
        yield f"- Experience: {target_job.get('experience', 'Not mentioned')}\n"
        yield f"- Salary/Stipend: {target_job.get('salary', target_job.get('stipend', 'Not mentioned'))}\n"
        yield f"- Skills: {', '.join(target_job.get('skills', [])) if isinstance(target_job.get('skills'), list) else target_job.get('skills', 'Not mentioned')}\n\n"
        if target_job.get("description"):
            yield f"Overview: {target_job.get('description')}\n\n"
        if target_job.get("requirements"):
            yield f"Requirements: {target_job.get('requirements')}\n\n"
        yield f"🔗 [Click here to apply]({app_url})\n"

    async def _stream_domain_jobs_from_gemini(self, user_query: str) -> AsyncIterator[Job]:
        """Stream domain/role job listings in real-time as AI LLM generates them."""
        prompt = f"""You are an automated AI Job Discovery & Market Intelligence Agent.
The user wants to find job listings matching the following domain/role query:
"{user_query}"

Task: Curate and return a realistic list of 8 to 12 structured job listings matching the requested domain, role, skills, or location.

Required JSON Output Array Format:
[
  {{
    "title": "exact job title",
    "company": "company name",
    "category": "Technology, Finance, Business & Management, Marketing & Sales, Human Resources, Design & Creative, Healthcare, Legal, Research, Engineering, or Other",
    "subcategory": "specific subcategory (e.g. Software Development, AI / Machine Learning, Investment Banking, Financial Analysis, Product Management, UI/UX & Design, etc.)",
    "location": "City, Country or Remote",
    "employment_type": "Full-time, Part-time, Contract, or Internship",
    "experience": "required experience (e.g. 2+ years, Senior, Entry Level)",
    "salary": "salary range or Not mentioned",
    "stipend": "stipend or Not mentioned",
    "skills": ["Skill1", "Skill2", "Skill3"],
    "description": "2-3 sentence overview of job role and team",
    "requirements": "Key qualifications and technical requirements",
    "posted_date": "recent date or Not mentioned",
    "application_url": "https://company.com/careers/job-1"
  }}
]
Return ONLY a valid JSON array of job objects.
"""
        payload = {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"response_mime_type": "application/json"}
        }

        raw_buffer = ""
        emitted_titles: Set[str] = set()

        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                async with client.stream("POST", self.stream_endpoint, json=payload) as response:
                    if response.status_code != 200:
                        logger.warning(f"Streaming status: {response.status_code}")
                        return

                    async for line in response.aiter_lines():
                        if line.startswith("data: "):
                            json_str = line[6:].strip()
                            try:
                                data = json.loads(json_str)
                                text_chunk = data["candidates"][0]["content"]["parts"][0]["text"]
                                raw_buffer += text_chunk

                                # Parse completed job objects from buffer incrementally
                                matches = re.finditer(r'\{[^{}]*"title"\s*:\s*"([^"]+)"[^{}]*\}', raw_buffer, re.DOTALL)
                                for match in matches:
                                    try:
                                        full_obj_str = match.group(0)
                                        obj = json.loads(full_obj_str)
                                        title = obj.get("title")
                                        if title and title not in emitted_titles:
                                            emitted_titles.add(title)
                                            cat, subcat = classify_job(
                                                title=obj.get("title", ""),
                                                description=obj.get("description", ""),
                                                requirements=obj.get("requirements", ""),
                                                skills=obj.get("skills", [])
                                            )
                                            if not obj.get("category"):
                                                obj["category"] = cat
                                            if not obj.get("subcategory"):
                                                obj["subcategory"] = subcat

                                            job_model = normalize_job(obj)
                                            yield job_model
                                            await asyncio.sleep(0.01)
                                    except Exception:
                                        pass
                            except Exception:
                                pass

            # Parse any remaining objects at completion
            if raw_buffer:
                try:
                    full_array = json.loads(raw_buffer)
                    if isinstance(full_array, list):
                        for obj in full_array:
                            if isinstance(obj, dict):
                                title = obj.get("title")
                                if title and title not in emitted_titles:
                                    emitted_titles.add(title)
                                    cat, subcat = classify_job(
                                        title=obj.get("title", ""),
                                        description=obj.get("description", ""),
                                        requirements=obj.get("requirements", ""),
                                        skills=obj.get("skills", [])
                                    )
                                    if not obj.get("category"):
                                        obj["category"] = cat
                                    if not obj.get("subcategory"):
                                        obj["subcategory"] = subcat

                                    job_model = normalize_job(obj)
                                    yield job_model
                except Exception:
                    pass
        except Exception as exc:
            logger.error(f"LLM streaming error: {exc}")

    async def run(self, req: QueryRequest) -> AsyncIterator[Any]:
        target_url = self._extract_url_from_query(req.user_query)
        session_id = req.sessionId or ""

        # ----------------------------------------------------
        # MODE 1: Direct Career URL Web Scraping
        # ----------------------------------------------------
        if target_url:
            if not validate_url(target_url):
                yield f"Error: Invalid URL format provided ({target_url}). Please specify a valid http:// or https:// URL.\n"
                return

            if not is_safe_url(target_url):
                yield f"Access Denied: Provided URL ({target_url}) resolves to a private or loopback IP address range.\n"
                return

            allowed, status_code, perm_message = await check_robots_permission(target_url)
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
            jobs_found_count = 0
            scraped_jobs_list: List[Dict[str, Any]] = []

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

                        cat, subcat = classify_job(
                            title=title,
                            description=raw_job.get("description", ""),
                            requirements=raw_job.get("requirements", ""),
                            skills=raw_job.get("skills", [])
                        )
                        raw_job["category"] = cat
                        raw_job["subcategory"] = subcat

                        job_model = normalize_job(raw_job)

                        # Verify Application Link with LinkVerifier
                        is_genuine, reason = await self.verifier.verify_link(
                            job_title=job_model.title,
                            company=job_model.company,
                            application_url=job_model.application_url,
                            source_url=job_model.source_url
                        )

                        if not is_genuine:
                            logger.info(f"Rejecting non-job link '{job_model.title}' -> {job_model.application_url} ({reason})")
                            continue

                        jobs_found_count += 1
                        job_dict = job_model.model_dump()
                        scraped_jobs_list.append(job_dict)
                        yield job_model
                        await asyncio.sleep(0.01)

            except Exception as exc:
                yield f"\nCrawling Error: {str(exc)}\n"
            finally:
                await crawler.close()

            if scraped_jobs_list:
                session_job_store.save_jobs(session_id, scraped_jobs_list)

            if jobs_found_count == 0:
                yield "\nNo structured job listings could be extracted from the target pages.\n"

            return

        # ----------------------------------------------------
        # WISHLIST ACTION: Add / Move Job to Wishlist Query Check (LLM-backed)
        # ----------------------------------------------------
        cached_jobs = session_job_store.get_jobs(session_id)
        is_wishlist_request, wishlist_target_index = await self._resolve_wishlist_intent_with_gemini(
            req.user_query, cached_jobs, session_id=session_id
        )

        if is_wishlist_request:
            if not cached_jobs:
                yield {
                    "type": "add_wishlist",
                    "content": "No cached job listings found in this session to add to your wishlist. Please search for job opportunities first!",
                    "header_message": "mode:jobparser:addjob:wishlist"
                }
                return

            target_job = None
            if wishlist_target_index is not None and 1 <= wishlist_target_index <= len(cached_jobs):
                target_job = cached_jobs[wishlist_target_index - 1]
            elif len(cached_jobs) == 1:
                target_job = cached_jobs[0]

            if target_job:
                session_job_store.set_last_viewed_job(session_id, target_job)
                title = target_job.get("title") or target_job.get("job_title") or "Job"
                company = target_job.get("company") or target_job.get("company_name") or "Company"
                yield {
                    "type": "add_wishlist",
                    "content": f"Successfully added {title} at {company} to your wishlist!",
                    "header_message": "mode:jobparser:addjob:wishlist"
                }
                return
            else:
                yield {
                    "type": "add_wishlist",
                    "content": f"Please specify which job you would like to add to your wishlist (e.g. 'add 1st job to wishlist' or mention the company name). Found {len(cached_jobs)} job(s) in session.",
                    "header_message": "mode:jobparser:addjob:wishlist"
                }
                return

        # ----------------------------------------------------
        # MODE 3: Follow-Up Job Details Query Check
        # ----------------------------------------------------
        cached_jobs = session_job_store.get_jobs(session_id)
        is_detail_query, target_index = await self._resolve_target_job_with_gemini(req.user_query, cached_jobs)

        if is_detail_query:
            if not cached_jobs:
                yield {
                    "type": "job_details",
                    "content": "I don't have any cached job listings for this session yet! Please start by searching for job opportunities or providing a career page URL, and then ask me about any specific job.",
                    "header_message": "mode:jobparser:jobdetails"
                }
                return

            if target_index is not None:
                if 1 <= target_index <= len(cached_jobs):
                    target_job = cached_jobs[target_index - 1]
                    session_job_store.set_last_viewed_job(session_id, target_job)
                    async for chunk in self._stream_job_details_response(req.user_query, target_job, target_index, len(cached_jobs)):
                        yield {
                            "type": "job_details",
                            "content": chunk,
                            "header_message": "mode:jobparser:jobdetails",
                            "data": {"selected_job": target_job},
                        }
                    return
                else:
                    yield {
                        "type": "job_details",
                        "content": f"I only found {len(cached_jobs)} job listing(s) in our recent search for this session. Please specify a job number between 1 and {len(cached_jobs)}, or mention the company name!",
                        "header_message": "mode:jobparser:jobdetails"
                    }
                    return
            else:
                yield {
                    "type": "job_details",
                    "content": f"I found {len(cached_jobs)} job listing(s) from our recent search. Could you specify which job you'd like details on (e.g. 'details on 1st job', '5th listing', or mention the company name)?",
                    "header_message": "mode:jobparser:jobdetails"
                }
                return

        # ----------------------------------------------------
        # MODE 2: No URL Provided -> Real-Time Streaming AI Domain Search
        # ----------------------------------------------------
        query_text = req.user_query.strip()
        query_lower = query_text.lower()

        # Check for explicit code generation / non-job prompts
        is_irrelevant = any(
            pattern in query_lower
            for pattern in [
                "generate me a python code", "write a python code", "write python code",
                "generate code", "write code", "code to", "script to", "how to code",
                "solve math", "write a poem", "write an essay", "tell me a joke",
                "create a script", "build an app"
            ]
        )

        if is_irrelevant:
            yield "Please ask only job-finding related queries. I can assist you by scraping career website URLs or finding job openings across domains such as Tech, Finance, Marketing, HR, or Engineering."
            return

        # Check if query contains job domain/role keywords
        has_domain_details = any(
            kw in query_lower
            for kw in [
                "tech", "technology", "software", "developer", "engineer", "finance", "banking",
                "accounting", "marketing", "sales", "hr", "human resources", "design", "ui/ux",
                "data", "manager", "product", "consulting", "legal", "healthcare", "python",
                "java", "remote", "intern", "internship", "associate", "role", "roles", "job", "jobs", "find", "search"
            ]
        ) and len(query_text) > 3

        if not has_domain_details:
            yield "Please ask only job-finding related queries. I can assist you by scraping career website URLs or finding job openings across domains such as Tech, Finance, Marketing, HR, or Engineering."
            return

        yield f"Domain Search: {query_text}\n\n"
        yield "- Searching active job listings...\n\n"
        await asyncio.sleep(0.05)

        domain_jobs_found = 0
        domain_jobs_list: List[Dict[str, Any]] = []
        async for job_model in self._stream_domain_jobs_from_gemini(query_text):
            domain_jobs_found += 1
            domain_jobs_list.append(job_model.model_dump())
            yield job_model

        if domain_jobs_list:
            session_job_store.save_jobs(session_id, domain_jobs_list)

        if domain_jobs_found == 0:
            yield "\nUnable to fetch job listings for the specified domain at this moment. Please try providing a specific careers page URL.\n"
