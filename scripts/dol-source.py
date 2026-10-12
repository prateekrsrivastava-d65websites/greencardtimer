"""Discover published LCA disclosures without probing unpublished file names."""

from datetime import date
from html.parser import HTMLParser
import re
import urllib.parse
import urllib.request


SOURCE_PAGE = "https://www.dol.gov/agencies/eta/foreign-labor/performance"
MAX_PAGE_BYTES = 2 * 1024 * 1024
USER_AGENT = "GreenCardTimer data updater (+https://greencardtimer.pages.dev)"
DISCLOSURE_FILENAME = re.compile(
    r"LCA_Disclosure_Data_FY(20\d{2})(?:_Q([1-4]))?\.xlsx\Z"
)


def fiscal_year(today=None):
    today = today or date.today()
    return today.year + (1 if today.month >= 10 else 0)


def canonical_dol_url(value, base_url=SOURCE_PAGE):
    if not isinstance(value, str) or not value or re.search(r"[\s\\\x00-\x1f\x7f]", value):
        raise ValueError("DOL URL is malformed")
    try:
        parts = urllib.parse.urlsplit(urllib.parse.urljoin(base_url, value))
        port = parts.port
    except ValueError as error:
        raise ValueError("DOL URL is malformed") from error
    if (parts.scheme != "https" or parts.hostname not in {"dol.gov", "www.dol.gov"}
            or parts.username is not None or parts.password is not None
            or port not in {None, 443} or parts.query or parts.fragment):
        raise ValueError("DOL URL must be an unqualified official HTTPS URL")
    path = re.sub(r"/+", "/", parts.path)
    if "%" in path or any(part in {".", ".."} for part in path.split("/")):
        raise ValueError("DOL URL path is malformed")
    return urllib.parse.urlunsplit(("https", "www.dol.gov", path or "/", "", ""))


class _OfficialRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        canonical = canonical_dol_url(new_url, request.full_url)
        return super().redirect_request(request, response, code, message, headers, canonical)


def open_dol_url(url, *, timeout=60, headers=None, method=None):
    """Apply the same host and HTTPS policy before every redirect."""
    request_headers = {"User-Agent": USER_AGENT, "Accept-Encoding": "identity"}
    request_headers.update(headers or {})
    request = urllib.request.Request(
        canonical_dol_url(url), headers=request_headers, method=method
    )
    return urllib.request.build_opener(_OfficialRedirects()).open(request, timeout=timeout)


def fetch_page():
    with open_dol_url(SOURCE_PAGE, timeout=30, headers={"Accept": "text/html"}) as response:
        if canonical_dol_url(response.geturl()).rstrip("/") != SOURCE_PAGE:
            raise ValueError("DOL performance page redirected to an unexpected page")
        if response.headers.get_content_type() not in {"text/html", "application/xhtml+xml"}:
            raise ValueError("DOL performance page did not return HTML")
        length = response.headers.get("Content-Length")
        if length is not None:
            try:
                declared_bytes = int(length)
            except ValueError as error:
                raise ValueError("DOL performance page has an invalid Content-Length") from error
            if declared_bytes < 0 or declared_bytes > MAX_PAGE_BYTES:
                raise ValueError("DOL performance page exceeds the size limit")
        body = response.read(MAX_PAGE_BYTES + 1)
        if len(body) > MAX_PAGE_BYTES:
            raise ValueError("DOL performance page exceeds the size limit")
        html = body.decode("utf-8-sig")
        lowered = html.lower()
        if "<html" not in lowered or any(marker in lowered for marker in (
                "<title>access denied", "verify you are human", "<title>just a moment")):
            raise ValueError("DOL performance page is missing or an access challenge")
        return html


class _DisclosureLinks(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.links = []

    def handle_starttag(self, tag, attributes):
        if tag.lower() == "a":
            for key, value in attributes:
                if key.lower() == "href" and value:
                    self.links.append(value)


def _period(value):
    if isinstance(value, dict):
        value = (value.get("fiscalYear"), value.get("quarter"))
    if not isinstance(value, (tuple, list)) or len(value) != 2:
        raise ValueError("Pinned DOL period is invalid")
    year, quarter = value
    if (type(year) is not int or not 2000 <= year <= 2099
            or type(quarter) is not int or quarter not in range(1, 5)):
        raise ValueError("Pinned DOL period is invalid")
    return year, quarter


def discover_latest(html, current_fiscal_year=None, minimum_period=None):
    """Select an actually linked quarter; never guess URLs or roll the pin back."""
    current_fiscal_year = fiscal_year() if current_fiscal_year is None else current_fiscal_year
    if type(current_fiscal_year) is not int or not 2000 <= current_fiscal_year <= 2099:
        raise ValueError("Current fiscal year is invalid")
    if not isinstance(html, str) or len(html.encode("utf-8")) > MAX_PAGE_BYTES:
        raise ValueError("DOL performance page is invalid or exceeds the size limit")
    parser = _DisclosureLinks()
    parser.feed(html)
    parser.close()
    candidates = {}
    for href in parser.links:
        try:
            url = canonical_dol_url(href)
        except ValueError:
            continue
        filename = urllib.parse.urlsplit(url).path.rsplit("/", 1)[-1]
        match = DISCLOSURE_FILENAME.fullmatch(filename)
        if not match:
            continue
        year = int(match.group(1))
        if year > current_fiscal_year:
            continue
        # A bare FY file can only represent a completed fiscal year, never an
        # in-progress year's quarter. Current releases use explicit Q suffixes.
        if match.group(2) is None and year >= current_fiscal_year:
            continue
        quarter = int(match.group(2)) if match.group(2) else 4
        candidate = {"fiscalYear": year, "quarter": quarter,
                     "url": url, "filename": filename}
        candidates.setdefault((year, quarter), {})[url] = candidate
    if not candidates:
        raise ValueError("DOL performance page contains no supported LCA disclosures")
    latest = max(candidates)
    if minimum_period is not None and latest < _period(minimum_period):
        raise ValueError("DOL performance page would roll back the pinned disclosure")
    matches = candidates[latest]
    if len(matches) != 1:
        raise ValueError("DOL performance page has ambiguous links for the newest disclosure")
    return next(iter(matches.values()))
