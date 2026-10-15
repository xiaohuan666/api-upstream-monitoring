"""Real worker/flow IPC with an in-memory HTTP fixture, never external network."""
import sys
import base64
import json
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tests/oauth_python"))
sys.path.insert(0, str(ROOT / "tools"))
from test_flow import FakeTransport, Response, resp, page, redirect, WEB_RESULT, RESULT
from test_workspaces import graph, stream_html, encode_cookie
from oauth_login import worker, sentinel

transport = FakeTransport()
transport.close = lambda: None
original_validate = worker.validate_input
mode = ""
EXPECTED_SELECTIONS = {"": "workspace-one", "help-link": "workspace-one", "single": "workspace-one", "typed-team": "workspace-team",
                       "typed-flags": "workspace-team", "kind-web-team": "workspace-team",
                       "kind-type-web-team": "workspace-team", "kind-html-team": "workspace-team",
                       "kind-cookie-team": "workspace-team", "label-team": "workspace-team",
                       "label-team-en": "workspace-team", "label-team-short": "workspace-team",
                       "label-team-traditional": "workspace-team", "label-team-account": "workspace-team"}
PERSONAL_LABELS = {"label-team": "个人账户", "label-team-en": "Personal account", "label-team-short": "Personal",
                   "label-team-traditional": "个人帐户", "label-team-account": "个人账号"}

KIND_WORKSPACES = [
    {"id": "workspace-team", "name": "fixture-kind-team-private", "kind": "organization"},
    {"id": "workspace-personal", "name": None, "kind": "personal",
     "description": "fixture-kind-personal-private", "is_default": True},
]
EARLY_KIND_MODES = {"kind-web-team", "kind-type-web-team", "kind-raw-conflict-web",
                    "kind-type-conflict-web", "kind-type-source-conflict-web", "unknown-kind-web",
                    "nonstring-kind-web", "null-kind-web", "null-kind-cookie-web"}
selection_attempts = 0


def configure_kind_fixture():
    items = [dict(item) for item in KIND_WORKSPACES]
    if mode == "kind-type-web-team":
        # Distinct fields may contain different raw values with the same category.
        items[0]["type"] = "business"
        items[1]["type"] = "personal"
    elif mode == "kind-type-conflict-web":
        items[0]["type"] = "personal"
    elif mode == "unknown-kind-web":
        items[0]["kind"] = "fixture-kind-unknown-private"
    elif mode == "nonstring-kind-web":
        items[0]["kind"] = {"private": "fixture-kind-invalid-private"}
    elif mode in {"null-kind-web", "null-kind-html"}:
        items[0]["kind"] = None
        items[0]["type"] = "organization"
    if mode == "null-kind-cookie-web":
        cookie_items = [dict(item) for item in items]
        cookie_items[0]["kind"] = None
        transport.cookies.add("oai-client-auth-session", encode_cookie({"workspaces": cookie_items}), ".auth.openai.com")
    if mode in {"kind-raw-conflict-web", "kind-raw-conflict-html", "kind-type-source-conflict-web"}:
        cookie_items = [dict(item) for item in items]
        if mode == "kind-type-source-conflict-web":
            cookie_items[0].pop("kind")
            cookie_items[0]["type"] = "personal"
        else:
            # Same team category must not hide a disagreement in the explicit kind.
            cookie_items[0]["kind"] = "business"
        transport.cookies.add("oai-client-auth-session", encode_cookie({"workspaces": cookie_items}), ".auth.openai.com")
    if mode in EARLY_KIND_MODES:
        # MFA must select before Web callback/session; the later target transaction is direct.
        transport.responses[10:] = [redirect(RESULT)]
        transport.responses[7] = resp({"page": {"type": "workspace_selection", "payload": {"workspaces": items}}})
        transport.responses.insert(8, page("external_url", WEB_RESULT))
    elif mode == "kind-cookie-team":
        transport.cookies.add("oai-client-auth-session", encode_cookie({"workspaces": items}), ".auth.openai.com")
        transport.responses[11] = Response(200, {"content-type": "text/html"}, "<html/>", "")
    else:
        transport.responses[11] = Response(200, {"content-type": "text/html"}, metadata_html(items), "")


def metadata_html(items):
    values = graph([item["id"] for item in items])
    for index, item in zip(values[2], items):
        for key, value in item.items():
            if key != "id":
                key_index = len(values)
                values[index][f"_{key_index}"] = key_index + 1
                values.extend([key, value])
    return stream_html(values, split=True)


def validate(data):
    global mode
    mode = parse_qs(urlsplit(data.get("authUrl", "")).query).get("workspace_fixture", [""])[0]
    if mode in {"help-link", "manual-widget", "bad-password-widget"}:
        body = ("<a href='https://challenges.cloudflare.com'>help</a>" if mode == "help-link"
                else "<script src='https://challenges.cloudflare.com/turnstile/v0/api.js'></script>")
        index, status = (6, 401) if mode == "bad-password-widget" else (4, 200)
        transport.responses[index] = Response(status, {"content-type": "text/html"}, body, "")
        return original_validate(data)
    if mode == "challenge-authorize":
        transport.responses[3] = Response(403, {"cf-mitigated": "challenge"}, "UPSTREAM-PRIVATE-BODY", "")
        return original_validate(data)
    if mode:
        transport.cookies.jar.clear(".auth.openai.com", "/", "oai-client-auth-session")
        if mode in EARLY_KIND_MODES or mode in {"kind-html-team", "kind-cookie-team", "kind-raw-conflict-html", "null-kind-html"}:
            configure_kind_fixture()
            return original_validate(data)
        teams = {
            "typed-team": [{"id": "workspace-personal", "name": "fixture-personal-renamed", "type": "personal"},
                           {"id": "workspace-team", "name": "Personal account", "type": "team"}],
            "typed-flags": [{"id": "workspace-personal", "is_personal": True},
                            {"id": "workspace-team", "is_personal": False}],
            "multiple-teams": [{"id": "workspace-personal", "type": "personal"},
                               {"id": "workspace-team", "name": "fixture-team-private", "type": "team"},
                               {"id": "workspace-team-other", "name": "fixture-other-private", "type": "team"}],
            "multiple-nonpersonal": [{"id": "workspace-personal", "name": "个人账户"},
                                     {"id": "workspace-team", "name": "fixture-team-private"},
                                     {"id": "workspace-team-other", "name": "fixture-other-private"}],
            "unclassified": [{"id": "workspace-personal", "name": "fixture-personal-renamed"},
                             {"id": "workspace-team", "name": "fixture-team-private"}],
            "missing-label": [{"id": "workspace-personal", "name": "个人账户"}, {"id": "workspace-team"}],
        }
        base = [{"id": "workspace-personal", "type": "personal"}, {"id": "workspace-team", "type": "team"}]
        teams.update({"pointer-conflict": base, "type-conflict": base})
        teams.update({name: [{"id": "workspace-team", "display_name": "开悟之境"},
                            {"id": "workspace-personal", "name": label}] for name, label in PERSONAL_LABELS.items()})
        html = {
            "single": stream_html(graph(["workspace-one"])),
            "missing": "<html></html>",
            "multiple": stream_html(graph(["workspace-one", "workspace-two"])),
            "conflict": stream_html(graph(["workspace-two"])),
            "invalid": '<script>{"workspaces":[{"id":null}]}</script>',
            "mixed-script": stream_html(graph(["workspace-one"])).replace('</script>', 'window.additional={"workspaces":[{"id":"workspace-two"}]};</script>'),
            "http-duplicate": '{"page":{"type":"consent"},"workspaces":[{"id":"workspace-one"},{"id":"workspace-two"}],"workspaces":[{"id":"workspace-one"}]}',
            "cookie-corrupt": stream_html(graph(["workspace-one"])),
            "cookie-nonutf8": stream_html(graph(["workspace-one"])),
            "cookie-null": stream_html(graph(["workspace-one"])),
        }
        if mode in teams:
            html = metadata_html(teams[mode])
        else:
            html = html[mode]
        if mode == "conflict":
            transport.cookies.workspace(["workspace-one"])
        if mode.startswith("cookie-"):
            header = encode_cookie({"alg": "HS256"}).split('.')[0]
            body = {"cookie-corrupt": "not%base64", "cookie-nonutf8": base64.urlsafe_b64encode(b'\xff').decode(),
                    "cookie-null": base64.urlsafe_b64encode(b'null').decode()}[mode]
            transport.cookies.add("oai-client-auth-session", header+'.'+body+'.signature', ".auth.openai.com")
        if mode in {"pointer-conflict", "type-conflict"}:
            cookie = ({"workspace_id": "workspace-team"} if mode == "pointer-conflict" else
                      {"workspaces": [{"id": "workspace-personal", "type": "personal"},
                                      {"id": "workspace-team", "type": "business"}]})
            transport.cookies.add("oai-client-auth-session", encode_cookie(cookie), ".auth.openai.com")
        if mode in {"typed-team", "pointer-conflict", "type-conflict"}:
            html = json.dumps({"page": {"type": "consent", "payload": {
                "workspaces": teams[mode], "workspace_id": "workspace-personal"}}})
        content_type = "application/json" if mode in {"http-duplicate", "typed-team", "pointer-conflict", "type-conflict"} else "text/html"
        transport.responses[11] = Response(200, {"content-type": content_type}, html, "")
    return original_validate(data)


worker.validate_input = validate
worker.Transport = lambda *_: transport
sentinel.get_tokens = lambda *_: ("offline-sentinel", "offline-so")
request = transport.request


def guarded_request(method, url, **kwargs):
    global selection_attempts
    path = urlsplit(url).path
    if mode in EARLY_KIND_MODES and path in {"/api/auth/callback/openai", "/api/auth/session", "/oauth/authorize"}:
        assert selection_attempts == 1, "Web callback/session and target authorization must follow selection"
    if path == "/api/accounts/workspace/select":
        selection_attempts += 1
        expected = EXPECTED_SELECTIONS.get(mode)
        assert expected is not None, "Failed fixture must not issue workspace selection"
        assert method == "POST", "Workspace selection must use POST"
        if mode in EARLY_KIND_MODES:
            assert transport.calls[-1][0] == "POST" and urlsplit(transport.calls[-1][1]).path == "/api/accounts/mfa/verify", "First Web MFA must immediately select the team"
            assert not any(urlsplit(call[1]).path in {"/api/auth/callback/openai", "/api/auth/session", "/oauth/authorize"} for call in transport.calls), "Selection must precede Web session and target authorization"
        assert kwargs.get("json") == {"workspace_id": expected}, "Unexpected workspace selection body"
        assert not any(urlsplit(call[1]).path == "/api/accounts/workspace/select" for call in transport.calls), "Duplicate workspace selection"
    return request(method, url, **kwargs)


transport.request = guarded_request
exit_code = worker.main()
selections = [call for call in transport.calls if urlsplit(call[1]).path == "/api/accounts/workspace/select"]
if exit_code == 0:
    assert selection_attempts == len(selections) == 1, "Successful fixture must issue exactly one workspace selection"
    assert not transport.responses, "Successful fixture must reach the original target callback"
else:
    assert selection_attempts == 0 and not selections, "Failed fixture must not issue workspace selection"
sys.exit(exit_code)
