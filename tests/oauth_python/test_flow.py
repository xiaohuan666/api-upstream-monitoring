"""Offline protocol fixtures: no credentials or requests leave this process."""
import base64
import copy
import http.cookiejar
import json
import sys
import unittest
from pathlib import Path
from urllib.parse import urlencode, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))
from oauth_login.errors import LoginError
from oauth_login.flow import LoginFlow, auth_contract, callback, validate_input
from oauth_login.totp import normalize_secret, totp_now
from oauth_login.transport import AUTH, CHAT, Response
from test_workspaces import graph, stream_html, encode_cookie

SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
REDIRECT = "http://localhost:1455/auth/callback"
WEB_CALLBACK = CHAT + "/api/auth/callback/openai"
AUTH_URL = AUTH + "/oauth/authorize?" + urlencode({"client_id": "sub2-client", "response_type": "code", "state": "sub2-state", "redirect_uri": REDIRECT, "code_challenge": "original-pkce", "code_challenge_method": "S256", "prompt": "login"})
WEB_AUTH = AUTH + "/api/accounts/authorize?" + urlencode({"response_type": "code", "state": "web-state", "redirect_uri": WEB_CALLBACK})
WEB_RESULT = WEB_CALLBACK + "?code=web-code&state=web-state"
RESULT = REDIRECT + "?code=target-code&state=sub2-state"
INPUT = {"authUrl": AUTH_URL, "email": "fixture@example.test", "password": "offline-password", "totpSecret": SECRET}


def resp(body=None, status=200, **headers):
    return Response(status, {"content-type": "application/json", **headers}, json.dumps(body or {}), "")


def redirect(url, status=302):
    return resp(status=status, location=url)


def page(kind, target="", **payload):
    return resp({"page": {"type": kind, "payload": payload}, "continue_url": target})


class Jar:
    def __init__(self):
        self.jar = http.cookiejar.CookieJar()
        self.add("oai-did", "offline-device", ".chatgpt.com")
        self.workspace(["workspace-one"])

    def add(self, name, value, domain):
        self.jar.set_cookie(http.cookiejar.Cookie(0, name, value, None, False, domain, True, True, "/", True, False, None, True, None, None, {}))

    def workspace(self, ids):
        data = json.dumps({"workspaces": [{"id": i} for i in ids]}).encode()
        self.add("oai-client-auth-session", base64.urlsafe_b64encode(data).decode().rstrip("=") + ".signature", ".auth.openai.com")


class FakeTransport:
    def __init__(self):
        self.cookies, self.calls = Jar(), []
        self.responses = [
            resp(), resp({"csrfToken": "web-csrf"}), resp({"url": WEB_AUTH}),
            redirect(AUTH + "/log-in"), Response(200, {"content-type": "text/html"}, "<html/>", ""),
            page("login_password", "/log-in/password"),
            page("mfa_challenge", "/mfa-challenge/challenge-one"),
            page("external_url", WEB_RESULT), redirect(CHAT + "/"),
            resp({"user": {"email": INPUT["email"]}, "accessToken": "web-only-token"}),
            redirect(AUTH + "/sign-in-with-chatgpt/codex/consent"),
            Response(200, {"content-type": "text/html"}, "<html/>", ""),
            page("external_url", RESULT),
        ]

    def request(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        if not self.responses:
            raise AssertionError("Unexpected network request")
        response = self.responses.pop(0)
        response.url = url
        return response


class FlowTests(unittest.TestCase):
    def setUp(self):
        self.transport, self.events, self.sentinel_calls = FakeTransport(), [], []

        def sentinel(*args):
            self.sentinel_calls.append(args)
            return "offline-sentinel", "offline-so"
        self.flow = LoginFlow(self.transport, sentinel, self.events.append)

    def run_flow(self, **changes):
        return self.flow.run({**INPUT, **changes})

    def fails(self, code, **changes):
        with self.assertRaises(LoginError) as caught:
            self.run_flow(**changes)
        self.assertEqual(caught.exception.code, code)
        self.assertEqual(str(caught.exception), code)

    def test_web_authorize_entry_paths_preserve_separate_callback_contracts(self):
        for path in ["/api/accounts/authorize", "/oauth/authorize", "/authorize"]:
            with self.subTest(path=path):
                url = WEB_AUTH.replace("/api/accounts/authorize?", path + "?")
                self.assertEqual(auth_contract(url, web=True), {"state": "web-state", "redirectUri": WEB_CALLBACK})
        target = AUTH_URL.replace("/oauth/authorize?", "/api/accounts/authorize?")
        with self.assertRaisesRegex(LoginError, "^OAUTH_INVALID_AUTH_URL$"):
            auth_contract(target)
        for invalid in [WEB_AUTH.replace(urlencode({"redirect_uri": WEB_CALLBACK}), urlencode({"redirect_uri": REDIRECT})),
                        WEB_AUTH.replace("state=web-state", "state="),
                        WEB_AUTH.replace("state=web-state", "state=web-state&state=another"),
                        WEB_AUTH.replace("response_type=code", "response_type=token"),
                        WEB_AUTH.replace("auth.openai.com", "evil.example.test"),
                        WEB_AUTH.replace("/api/accounts/authorize?", "/api/accounts/authorize/other?")]:
            with self.subTest(invalid=invalid):
                with self.assertRaisesRegex(LoginError, "^OAUTH_INVALID_AUTH_URL$"):
                    auth_contract(invalid, web=True)

    def test_fresh_login_totp_then_original_sub2_pkce_callback(self):
        self.assertEqual(self.run_flow(), {"code": "target-code", "state": "sub2-state", "redirectUri": REDIRECT})
        self.assertEqual([e["stage"] for e in self.events], ["warmup", "csrf", "authorizing", "email", "password", "totp", "authorizing", "consent"])
        self.assertEqual(len(self.sentinel_calls), 1)
        self.assertEqual(self.transport.responses, [])
        self.assertIn(("GET", AUTH_URL), [(m, u) for m, u, _ in self.transport.calls])
        self.assertFalse(any(urlsplit(u).hostname in {"localhost", "127.0.0.1"} for _, u, _ in self.transport.calls))
        posts = [(u, k) for m, u, k in self.transport.calls if m == "POST"]
        password = next(k for u, k in posts if u.endswith("password/verify"))
        self.assertEqual(password["json"], {"password": INPUT["password"]})
        self.assertEqual(password["headers"]["openai-sentinel-token"], "offline-sentinel")
        mfa = next(k["json"] for u, k in posts if u.endswith("mfa/verify"))
        self.assertEqual(mfa["id"], "challenge-one")
        self.assertRegex(mfa["code"], r"^\d{6}$")
        self.assertNotIn(INPUT["password"], json.dumps(self.events))

    def test_reference_flow_without_mfa(self):
        self.transport.responses[6] = page("external_url", WEB_RESULT)
        del self.transport.responses[7]
        self.assertEqual(self.run_flow(totpSecret="")["code"], "target-code")
        self.assertFalse(any(u.endswith("mfa/verify") for _, u, _ in self.transport.calls))

    def test_http_challenge_is_not_password_failure_and_never_retried(self):
        for index in [0, 1, 4, 5, 6, 7, 11]:
            with self.subTest(index=index):
                self.setUp()
                self.transport.responses[index] = Response(403, {"cf-mitigated": "challenge"}, "UPSTREAM-SECRET", "")
                self.fails("OAUTH_HTTP_CHALLENGE")
                self.assertEqual(len(self.transport.calls), index + 1)

    def test_invalid_password_not_replayed(self):
        self.transport.responses[6] = resp({"message": "SECRET"}, status=401)
        self.fails("OAUTH_INVALID_CREDENTIALS")
        self.assertEqual(sum(u.endswith("password/verify") for _, u, _ in self.transport.calls), 1)

    def test_totp_wrong_missing_and_missing_challenge(self):
        self.transport.responses[7] = resp(status=401)
        self.fails("OAUTH_TOTP_REJECTED")
        self.setUp()
        self.fails("OAUTH_TOTP_REQUIRED", totpSecret="")
        self.setUp()
        self.transport.responses[6] = page("mfa_challenge", "/mfa-challenge")
        self.fails("OAUTH_UNKNOWN_STEP")

    def test_email_or_phone_requirement_never_registration_fallback(self):
        for kind, path, code in [("email_otp_verification", "/email-verification", "OAUTH_EMAIL_OTP_REQUIRED"), ("phone_otp_verification", "/phone-verification", "OAUTH_PHONE_REQUIRED"), ("create_account_password", "/create-account/password", "OAUTH_UNTRUSTED_ORIGIN")]:
            with self.subTest(kind=kind):
                self.setUp()
                self.transport.responses[5] = page(kind, path)
                self.fails(code)
                self.assertEqual(len(self.transport.calls), 6)

    def test_sentinel_failure_is_not_skipped(self):
        def fail(*_):
            raise RuntimeError("SECRET-TOKEN")
        self.flow.sentinel = fail
        self.fails("OAUTH_SENTINEL_FAILED")
        self.assertEqual(len(self.transport.calls), 5)

    def test_untrusted_continuation_never_receives_credentials(self):
        for url in ["https://evil.test/log-in/password", "https://auth.openai.com.evil.test/log-in/password", "https://user:pw@auth.openai.com/log-in/password", "http://auth.openai.com/log-in/password", "https://auth.openai.com/api/accounts/delete", "https://auth.openai.com/%2e%2e/log-in/password"]:
            with self.subTest(url=url):
                self.setUp()
                self.transport.responses[5] = page("login_password", url)
                self.fails("OAUTH_UNTRUSTED_ORIGIN" if url.startswith("https:") else "OAUTH_INVALID_CALLBACK")
                self.assertEqual(len(self.transport.calls), 6)

    def test_web_and_sub2_states_not_interchangeable(self):
        self.transport.responses[7] = page("external_url", WEB_RESULT.replace("web-state", "sub2-state"))
        self.fails("OAUTH_STATE_MISMATCH")
        self.setUp()
        self.transport.responses[12] = page("external_url", RESULT.replace("sub2-state", "web-state"))
        self.fails("OAUTH_STATE_MISMATCH")

    def test_callback_duplicates_errors_and_wrong_loopback(self):
        for url, code in [(RESULT + "&state=sub2-state", "OAUTH_INVALID_CALLBACK"), (RESULT + "&code=second", "OAUTH_INVALID_CALLBACK"), (RESULT + "&error=denied", "OAUTH_CALLBACK_ERROR"), (RESULT.replace(":1455", ":1555"), "OAUTH_INVALID_CALLBACK"), (RESULT + "#fragment", "OAUTH_UNTRUSTED_ORIGIN")]:
            with self.subTest(url=url):
                self.setUp()
                self.transport.responses[12] = page("external_url", url)
                self.fails(code)
                self.assertEqual(len(self.transport.calls), 13)

    def test_post_redirect_307_not_replayed(self):
        self.transport.responses[6] = redirect(WEB_RESULT, status=307)
        self.fails("OAUTH_INVALID_CALLBACK")
        self.assertEqual(len(self.transport.calls), 7)

    def test_wrong_web_identity_prevents_target_oauth(self):
        self.transport.responses[9] = resp({"user": {"email": "other@example.test"}})
        self.fails("OAUTH_INVALID_CREDENTIALS")
        self.assertFalse(any(u == AUTH_URL for _, u, _ in self.transport.calls))

    def test_multiple_workspaces_not_blindly_selected(self):
        self.transport.cookies.workspace(["personal", "organization"])
        self.fails("OAUTH_WORKSPACE_AMBIGUOUS")
        self.assertFalse(any(u.endswith("workspace/select") for _, u, _ in self.transport.calls))

    def test_repeated_credential_step_is_stopped(self):
        self.transport.responses[6] = page("login_password", "/log-in/password")
        self.fails("OAUTH_UNKNOWN_STEP")
        self.assertEqual(len(self.transport.calls), 7)

    def test_redirect_loop_is_bounded(self):
        self.transport.responses[4] = redirect(WEB_AUTH)
        self.fails("OAUTH_UNKNOWN_STEP")
        self.assertEqual(len(self.transport.calls), 5)

    def test_missing_oai_did_fails_before_secret_post(self):
        self.transport.cookies.jar.clear()
        self.fails("OAUTH_UNKNOWN_STEP")
        self.assertEqual(len(self.transport.calls), 1)

    def test_unique_account_session_is_selected_without_choosing_first_of_many(self):
        choices = Response(200, {"content-type": "text/html"}, '<script>"us_1234567890abcdef"</script>', "")
        self.transport.responses[10:10] = [redirect(AUTH + "/choose-an-account"), choices, page("external_url", AUTH + "/oauth/authorize?next=fixture")]
        self.assertEqual(self.run_flow()["code"], "target-code")
        selects = [k["json"] for _, u, k in self.transport.calls if u.endswith("session/select")]
        self.assertEqual(selects, [{"session_id": "us_1234567890abcdef"}])
        self.setUp()
        choices = Response(200, {"content-type": "text/html"}, '"us_1234567890abcdef" "us_abcdef1234567890"', "")
        self.transport.responses[10:10] = [redirect(AUTH + "/choose-an-account"), choices]
        self.fails("OAUTH_ACCOUNT_SELECTION_REQUIRED")
        self.assertFalse(any(u.endswith("session/select") for _, u, _ in self.transport.calls))

    def test_session_selection_may_return_original_authorize_or_only_cookie(self):
        for result in (page("external_url", AUTH_URL), resp({})):
            with self.subTest(result=result.text):
                self.setUp()
                choices = Response(200, {"content-type": "text/html"}, '"us_1234567890abcdef"', "")
                self.transport.responses[10:10] = [redirect(AUTH + "/choose-an-account"), choices, result]
                self.assertEqual(self.run_flow()["code"], "target-code")
                self.assertEqual(sum(u == AUTH_URL for _, u, _ in self.transport.calls), 2)
                self.assertEqual(sum(u.endswith("session/select") for _, u, _ in self.transport.calls), 1)

    def test_cookie_only_selection_does_not_loop_or_repeat_select(self):
        choices = Response(200, {"content-type": "text/html"}, '"us_1234567890abcdef"', "")
        self.transport.responses[10:] = [redirect(AUTH + "/choose-an-account"), choices, resp({}), redirect(AUTH + "/choose-an-account"), choices]
        self.fails("OAUTH_UNKNOWN_STEP")
        self.assertEqual(sum(u.endswith("session/select") for _, u, _ in self.transport.calls), 1)

    def test_workspace_from_html_is_unique_across_all_sources(self):
        html_cases = [
            '<input type="hidden" name="workspace_id" value="workspace-html">',
            '<script>{"workspace_id":"workspace-html"}</script>',
            '<script>{"workspaces":[{"id":"workspace-html"}]}</script>',
            stream_html(graph(["12345678-1234-1234-1234-123456789abc"])),
        ]
        for html in html_cases:
            with self.subTest(html=html):
                self.setUp()
                self.transport.cookies.jar.clear(".auth.openai.com", "/", "oai-client-auth-session")
                self.transport.responses[11] = Response(200, {"content-type": "text/html"}, html, "")
                self.assertEqual(self.run_flow()["code"], "target-code")
        for html, code in [(html_cases[0] + '<input name="workspace_id" value="another">', "OAUTH_WORKSPACE_CONFLICT"), ('<script>{"workspaces":[{"id":"first"},' + " " * 1700 + '{"id":"second"}]}</script>', "OAUTH_WORKSPACE_AMBIGUOUS")]:
            self.setUp()
            self.transport.cookies.jar.clear(".auth.openai.com", "/", "oai-client-auth-session")
            self.transport.responses[11] = Response(200, {"content-type": "text/html"}, html, "")
            self.fails(code)
            self.assertFalse(any(u.endswith("workspace/select") for _, u, _ in self.transport.calls))
        self.setUp()
        self.transport.responses[11] = Response(200, {"content-type": "text/html"}, html_cases[0], "")
        self.fails("OAUTH_WORKSPACE_CONFLICT")  # Cookie and HTML disagree.

    def test_workspace_source_integrity_fails_before_any_selection(self):
        html = stream_html(graph(["candidate-a"]))
        extra = 'window.additional={"workspaces":[{"id":"candidate-b"}]};'
        header = encode_cookie({"alg": "HS256"}).split('.')[0]
        duplicate_json = '{"page":{"type":"consent"},"workspaces":[{"id":"candidate-a"},{"id":"candidate-b"}],"workspaces":[{"id":"candidate-a"}]}'
        cases = [("text/html", html.replace('</script>', extra+'</script>'), ""),
                 ("application/json", duplicate_json, "")]
        for bad in ["not%base64", base64.urlsafe_b64encode(b'\xff').decode(), base64.urlsafe_b64encode(b'null').decode()]:
            cases.append(("text/html", html, header+'.'+bad+'.signature'))
        for content_type, body, cookie in cases:
            with self.subTest(content_type=content_type, cookie_present=bool(cookie)):
                self.setUp()
                self.transport.cookies.jar.clear(".auth.openai.com", "/", "oai-client-auth-session")
                if cookie:
                    self.transport.cookies.add("oai-client-auth-session", cookie, ".auth.openai.com")
                self.transport.responses[11] = Response(200, {"content-type": content_type}, body, "")
                self.fails("OAUTH_WORKSPACE_INVALID")
                self.assertFalse(any(url.endswith("workspace/select") for _, url, _ in self.transport.calls))

    def test_web_completion_redirect_rejects_nonstandard_port(self):
        self.transport.responses[8] = redirect(CHAT + ":444/")
        self.fails("OAUTH_UNTRUSTED_ORIGIN")
        self.assertEqual(len(self.transport.calls), 9)

    def test_second_oauth_transaction_can_require_password_once(self):
        self.transport.responses[10:] = [redirect(AUTH + "/log-in"), Response(200, {"content-type": "text/html"}, "", ""), page("login_password", "/log-in/password"), page("external_url", RESULT)]
        self.assertEqual(self.run_flow()["code"], "target-code")
        self.assertEqual(sum(u.endswith("password/verify") for _, u, _ in self.transport.calls), 2)

    def test_personal_direct_callback_never_selects_workspace(self):
        self.transport.responses[10:] = [redirect(RESULT)]
        self.assertEqual(self.run_flow()["code"], "target-code")
        self.assertFalse(any(u.endswith("workspace/select") for _, u, _ in self.transport.calls))

    def test_team_excludes_personal_without_session_display_name(self):
        self.transport.cookies.jar.clear(".auth.openai.com", "/", "oai-client-auth-session")
        self.transport.responses[11] = resp({"page": {"type": "consent"}, "workspaces": [
            {"id": "team-target", "name": "Kitgiz"}, {"id": "personal", "name": "个人账户"}]})
        self.assertEqual(self.run_flow()["code"], "target-code")
        selected = [kw["json"] for _, u, kw in self.transport.calls if u.endswith("workspace/select")]
        self.assertEqual(selected, [{"workspace_id": "team-target"}])

    def test_team_can_be_selected_before_web_session_name_exists(self):
        self.transport.cookies.jar.clear(".auth.openai.com", "/", "oai-client-auth-session")
        self.transport.responses[10:] = [redirect(RESULT)]
        self.transport.responses[7] = resp({"page": {"type": "workspace_selection"}, "workspaces": [
            {"id": "p", "name": "个人账户"}, {"id": "t", "name": "Kitgiz"}]})
        self.transport.responses.insert(8, page("external_url", WEB_RESULT))
        self.assertEqual(self.run_flow()["code"], "target-code")
        selected = [kw["json"] for _, u, kw in self.transport.calls if u.endswith("workspace/select")]
        self.assertEqual(selected, [{"workspace_id": "t"}])

    def test_multiple_non_personal_stops_before_selection(self):
        self.transport.cookies.jar.clear(".auth.openai.com", "/", "oai-client-auth-session")
        self.transport.responses[11] = resp({"page": {"type": "consent"}, "workspaces": [
            {"id": "p", "name": "个人账户"}, {"id": "t", "name": "One"}, {"id": "u", "name": "Two"}]})
        self.fails("OAUTH_WORKSPACE_AMBIGUOUS")
        self.assertFalse(any(u.endswith("workspace/select") for _, u, _ in self.transport.calls))

    def test_input_and_rfc6238(self):
        self.assertEqual(totp_now(SECRET, at=59), "287082")
        self.assertEqual(validate_input(copy.deepcopy(INPUT))["email"], INPUT["email"])
        for data in [None, {**INPUT, "timeoutMs": True}, {**INPUT, "timeoutMs": 0}, {**INPUT, "password": ""}, {**INPUT, "email": "invalid"}, {**INPUT, "totpSecret": "bad0"}]:
            with self.subTest(data=type(data)):
                with self.assertRaises(LoginError):
                    validate_input(data)
        for secret in ["MZ", "MY===", "123"]:
            with self.assertRaises(LoginError):
                normalize_secret(secret)
        self.assertEqual(normalize_secret("my======"), "MY")

    def test_invalid_auth_before_network(self):
        for url in [AUTH_URL + "&state=duplicate", AUTH_URL.replace("https:", "http:"), AUTH_URL.replace("response_type=code", "response_type=token"), AUTH_URL.replace("auth.openai.com", "evil.test")]:
            with self.subTest(url=url):
                self.fails("OAUTH_INVALID_AUTH_URL", authUrl=url)
                self.assertEqual(self.transport.calls, [])


if __name__ == "__main__":
    unittest.main()
