from datetime import date
from email.message import Message
import importlib.util
import io
from pathlib import Path
import unittest
from unittest import mock
import urllib.error
import urllib.request


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "dol-source.py"
SPEC = importlib.util.spec_from_file_location("dol_source", SCRIPT)
source = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(source)


def link(year=2026, quarter=3, prefix="/media/"):
    suffix = f"_Q{quarter}" if quarter is not None else ""
    return f'<a href="{prefix}LCA_Disclosure_Data_FY{year}{suffix}.xlsx">Disclosure</a>'


class PageResponse(io.BytesIO):
    def __init__(self, body=b"<html><body>Public page</body></html>",
                 url=source.SOURCE_PAGE, content_type="text/html", length=None):
        super().__init__(body)
        self.url = url
        self.headers = Message()
        self.headers["Content-Type"] = content_type
        if length is not None:
            self.headers["Content-Length"] = str(length)

    def geturl(self):
        return self.url


class DOLDiscoveryTests(unittest.TestCase):
    def test_latest_linked_period_wins_independent_of_page_order(self):
        result = source.discover_latest(link(2025, 4) + link() + link(2026, 2), 2027)
        self.assertEqual((result["fiscalYear"], result["quarter"]), (2026, 3))
        self.assertEqual(result["filename"], "LCA_Disclosure_Data_FY2026_Q3.xlsx")

    def test_current_official_double_slash_is_normalized(self):
        result = source.discover_latest(link(prefix="https://www.dol.gov//media/"), 2027)
        self.assertEqual(result["url"], "https://www.dol.gov/media/LCA_Disclosure_Data_FY2026_Q3.xlsx")

    def test_repeated_normalized_link_is_not_ambiguous(self):
        html = link() + link(prefix="https://dol.gov//media/") + link()
        self.assertEqual(source.discover_latest(html, 2027)["quarter"], 3)

    def test_distinct_newest_urls_fail_closed(self):
        with self.assertRaisesRegex(ValueError, "ambiguous"):
            source.discover_latest(link() + link(prefix="/other/"), 2027)

    def test_old_ambiguous_period_does_not_block_unambiguous_newest(self):
        html = link(2025, 4) + link(2025, 4, prefix="/other/") + link()
        self.assertEqual(source.discover_latest(html, 2027)["fiscalYear"], 2026)

    def test_same_period_updated_link_is_returned(self):
        result = source.discover_latest(link(prefix="/revised/"), 2027, (2026, 3))
        self.assertIn("/revised/", result["url"])

    def test_rollback_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "roll back"):
            source.discover_latest(link(2025, 4), 2027, {"fiscalYear": 2026, "quarter": 3})

    def test_future_fiscal_year_is_not_published_data(self):
        result = source.discover_latest(link(2028, 1) + link(), 2027)
        self.assertEqual(result["fiscalYear"], 2026)

    def test_fiscal_year_rolls_over_on_october_first(self):
        self.assertEqual(source.fiscal_year(date(2026, 9, 30)), 2026)
        self.assertEqual(source.fiscal_year(date(2026, 10, 1)), 2027)
        result = source.discover_latest(link(2027, 1) + link(), 2027)
        self.assertEqual((result["fiscalYear"], result["quarter"]), (2027, 1))

    def test_bare_completed_fiscal_year_is_q4(self):
        result = source.discover_latest(link(2026, None), 2027)
        self.assertEqual(result["quarter"], 4)

    def test_bare_current_fiscal_year_is_not_assumed_complete(self):
        result = source.discover_latest(link(2027, None) + link(), 2027)
        self.assertEqual((result["fiscalYear"], result["quarter"]), (2026, 3))

    def test_invalid_quarters_and_non_disclosure_files_are_ignored(self):
        html = link(2026, 0) + link(2026, 5) + link().replace("Disclosure_Data", "Appendix_A")
        with self.assertRaisesRegex(ValueError, "no supported"):
            source.discover_latest(html, 2027)

    def test_href_is_used_instead_of_link_text(self):
        html = '<a href="/wrong.xlsx">LCA_Disclosure_Data_FY2026_Q3.xlsx</a>'
        with self.assertRaisesRegex(ValueError, "no supported"):
            source.discover_latest(html, 2027)

    def test_deceptive_hosts_credentials_and_insecure_urls_are_ignored(self):
        for prefix in ("https://dol.gov.evil.example/", "https://www.dol.gov@evil.example/",
                       "https://user@www.dol.gov/", "http://www.dol.gov/",
                       "https://www.dol.gov:8443/", "//evil.example/"):
            with self.subTest(prefix=prefix):
                with self.assertRaisesRegex(ValueError, "no supported"):
                    source.discover_latest(link(prefix=prefix), 2027)

    def test_query_fragment_and_encoded_paths_are_rejected(self):
        for suffix in ("?download=1", "#release", "%3Fother.xlsx"):
            html = link().replace('.xlsx"', f'.xlsx{suffix}"')
            with self.subTest(suffix=suffix):
                with self.assertRaisesRegex(ValueError, "no supported"):
                    source.discover_latest(html, 2027)

    def test_comments_and_scripts_do_not_publish_a_release(self):
        html = f'<!--{link()}--><script>const hidden = `{link()}`;</script>'
        with self.assertRaisesRegex(ValueError, "no supported"):
            source.discover_latest(html, 2027)

    def test_non_anchor_href_does_not_publish_a_release(self):
        with self.assertRaisesRegex(ValueError, "no supported"):
            source.discover_latest(link().replace("<a ", "<link ").replace("</a>", ""), 2027)

    def test_invalid_fiscal_year_and_pinned_period_are_rejected(self):
        for year in (True, "2027", 1999, 2100):
            with self.subTest(year=year), self.assertRaisesRegex(ValueError, "Current fiscal year"):
                source.discover_latest(link(), year)
        for period in ((2026, 0), (2026, True), ("2026", 3), [2026], {}):
            with self.subTest(period=period), self.assertRaisesRegex(ValueError, "Pinned DOL period"):
                source.discover_latest(link(), 2027, period)

    def test_oversized_html_is_rejected_before_parsing(self):
        with mock.patch.object(source, "MAX_PAGE_BYTES", 20):
            with self.assertRaisesRegex(ValueError, "size limit"):
                source.discover_latest(link(), 2027)


class DOLPageFetchTests(unittest.TestCase):
    def test_public_html_is_accepted(self):
        with mock.patch.object(source, "open_dol_url", return_value=PageResponse()) as fetch:
            self.assertIn("Public page", source.fetch_page())
        self.assertEqual(fetch.call_args.kwargs["timeout"], 30)

    def test_http_access_denied_is_not_bypassed(self):
        error = urllib.error.HTTPError(source.SOURCE_PAGE, 403, "Forbidden", None, None)
        self.addCleanup(error.close)
        with mock.patch.object(source, "open_dol_url", side_effect=error):
            with self.assertRaises(urllib.error.HTTPError):
                source.fetch_page()

    def test_declared_oversized_page_is_rejected_without_reading(self):
        response = PageResponse(length=source.MAX_PAGE_BYTES + 1)
        with mock.patch.object(source, "open_dol_url", return_value=response), \
                mock.patch.object(response, "read", side_effect=AssertionError("must not read")):
            with self.assertRaisesRegex(ValueError, "size limit"):
                source.fetch_page()

    def test_streamed_size_limit_is_enforced(self):
        response = PageResponse(body=b"x" * 101)
        with mock.patch.object(source, "MAX_PAGE_BYTES", 100), \
                mock.patch.object(source, "open_dol_url", return_value=response):
            with self.assertRaisesRegex(ValueError, "size limit"):
                source.fetch_page()

    def test_non_html_and_challenge_pages_are_rejected(self):
        responses = (PageResponse(content_type="application/json"),
                     PageResponse(body=b"<html><title>Access Denied</title></html>"),
                     PageResponse(body=b"<html>Verify you are human</html>"),
                     PageResponse(body=b"not a page"))
        for response in responses:
            with self.subTest(response=response):
                with mock.patch.object(source, "open_dol_url", return_value=response):
                    with self.assertRaises(ValueError):
                        source.fetch_page()

    def test_redirect_to_another_page_is_rejected(self):
        with mock.patch.object(source, "open_dol_url", return_value=PageResponse(url="https://www.dol.gov/")):
            with self.assertRaisesRegex(ValueError, "unexpected page"):
                source.fetch_page()

    def test_redirect_policy_blocks_non_dol_and_http_before_following(self):
        handler = source._OfficialRedirects()
        request = urllib.request.Request(source.SOURCE_PAGE)
        for url in ("https://example.com/file.xlsx", "http://www.dol.gov/file.xlsx"):
            with self.subTest(url=url), self.assertRaisesRegex(ValueError, "official HTTPS"):
                handler.redirect_request(request, None, 302, "Found", {}, url)

    def test_official_redirect_policy_normalizes_a_safe_url(self):
        handler = source._OfficialRedirects()
        request = urllib.request.Request(source.SOURCE_PAGE)
        redirected = handler.redirect_request(request, None, 302, "Found", {},
                                             "https://dol.gov//media/file.xlsx")
        self.assertEqual(redirected.full_url, "https://www.dol.gov/media/file.xlsx")


if __name__ == "__main__":
    unittest.main()
