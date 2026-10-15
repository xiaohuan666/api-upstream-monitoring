"""Synthetic structural fixtures; never use captured sessions or live credentials."""
import base64
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))
from oauth_login.errors import LoginError
from oauth_login.workspaces import (MAX_DEPTH, MAX_IDS, MAX_NODES, MAX_TEXT,
                                    cookie_ids, document_ids, html_ids, select_workspace, unflatten)

W1 = "11111111-1111-4111-8111-111111111111"
W2 = "22222222-2222-4222-8222-222222222222"
USER = "33333333-3333-4333-8333-333333333333"


def encode_cookie(value):
    return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=") + ".signature"


def graph(ids, extra=True):
    # turbo-stream object keys (_N) and array items refer to values[N].
    values = [{"_1": 2}, "workspaces", []]
    for wid in ids:
        obj = len(values)
        values[2].append(obj)
        values.extend([{f"_{obj + 1}": obj + 2}, "id", wid])
    if extra:
        key = len(values)
        values[0][f"_{key}"] = key + 1
        values.extend(["user", {f"_{key + 2}": key + 3}, "id", USER])
    return values


def stream_html(values, split=False):
    text = json.dumps(values) + "\n"
    parts = [text[:17], text[17:]] if split else [text]
    return "".join('<script nonce="fixture">window.__reactRouterContext.streamController.enqueue(' + json.dumps(part) + ');</script>' for part in parts)


class WorkspaceTests(unittest.TestCase):
    def assert_error(self, fn, code="OAUTH_WORKSPACE_INVALID"):
        with self.assertRaises(LoginError) as caught:
            fn()
        self.assertEqual(caught.exception.code, code)
        self.assertEqual(str(caught.exception), code)

    def test_unrelated_ids_are_not_workspace_candidates(self):
        doc = {"workspaces": [{"id": W1}], "user": {"id": USER}, "org": {"id": W2}}
        self.assertEqual(html_ids('<script type="application/json">' + json.dumps(doc) + '</script>'), {W1})
        self.assertEqual(html_ids(stream_html(graph([W1]))), {W1})
        self.assertEqual(select_workspace({}, stream_html(graph([W1])), encode_cookie({"workspaces": [{"id": W1}]})), W1)

    def test_flat_graph_follows_references_not_adjacent_first_id(self):
        # Value/key placement is arbitrary; the first adjacent id string is a user.
        values = [{"_1": 2, "_5": 6}, "user", {"_3": 4}, "id", USER,
                  "workspaces", [7, 8], {"_3": 10}, {"_3": 9}, W2, W1]
        self.assertEqual(html_ids(stream_html(values)), {W1, W2})
        self.assert_error(lambda: select_workspace({}, stream_html(values), ""), "OAUTH_WORKSPACE_AMBIGUOUS")

    def test_empty_single_multiple_and_conflicting_sources(self):
        self.assert_error(lambda: select_workspace({}, "", ""), "OAUTH_WORKSPACE_NOT_FOUND")
        self.assert_error(lambda: select_workspace({"workspaces": []}, "", ""), "OAUTH_WORKSPACE_NOT_FOUND")
        self.assertEqual(select_workspace({"workspace_id": W1}, "", ""), W1)
        self.assert_error(lambda: select_workspace({"workspaces": [{"id": W1}, {"id": W2}]}, "", ""), "OAUTH_WORKSPACE_AMBIGUOUS")
        self.assert_error(lambda: select_workspace({"workspace_id": W1}, '', encode_cookie({"workspace_id": W2})), "OAUTH_WORKSPACE_CONFLICT")
        self.assertEqual(select_workspace({"workspace_id": W1}, '<input name="workspace_id" value="'+W1+'">', encode_cookie({"workspace_id": W1})), W1)

    def test_nested_payload_and_duplicate_candidate_deduplication(self):
        self.assertEqual(document_ids({"page": {"payload": {"workspaces": [{"id": W1}, {"id": W1}]}}}), {W1})
        self.assertEqual(html_ids('<input name="workspaceId" value="'+W1+'"><script>{"workspace_id":"'+W1+'"}</script>'), {W1})
        self.assertEqual(html_ids('<div id="'+USER+'"></div><input name="user_id" value="'+USER+'">'), set())

    def test_chunk_split_and_escaped_json_are_decoded_not_evaluated(self):
        self.assertEqual(html_ids(stream_html(graph([W1]), split=True)), {W1})
        self.assertEqual(html_ids(stream_html(graph([W1])).replace('workspaces', r'\\u0077orkspaces')), {W1})
        self.assert_error(lambda: html_ids('<script>window.__reactRouterContext.streamController.enqueue(fetch("secret"));</script>'))
        self.assert_error(lambda: html_ids('<script>var workspaces = [{id:"'+W1+'"}];</script>'))

    def test_bad_references_cycles_tags_and_trailing_frames_fail_closed(self):
        for value in [[{"_1": 99}, "workspaces"], [{"_1": 2}, "workspaces", [0]],
                      [{"_1": 2}, "workspaces", [True]], [{"_1": 2}, "workspaces", ["P", 5]],
                      [{"_999": 1}, W1], [{"workspace_id": 1}, W1],
                      [{"_1": 2, "_3": 4}, "workspace_id", W1, "workspace_id", W2]]:
            with self.subTest(value=value):
                self.assert_error(lambda: html_ids(stream_html(value)))
        self.assert_error(lambda: html_ids(stream_html(graph([W1])) + stream_html(graph([W2]))))
        self.assert_error(lambda: html_ids('<script>{"workspaces": [{"id":"'+W1+'"}], "workspaces": []}</script>'))

    def test_invalid_candidate_does_not_disappear_next_to_valid_candidate(self):
        for bad in [None, "", 123, "id with space", "x"*257]:
            self.assert_error(lambda: select_workspace({"workspaces": [{"id": W1}, {"id": bad}]}, "", ""))
        for doc in [{"workspaces": {}}, {"workspaces": [{}]}, {"workspace_id": None}]:
            self.assert_error(lambda: select_workspace(doc, "", encode_cookie({"workspace_id": W1})))
        self.assert_error(lambda: select_workspace({"workspace_id": W1}, '<script>{"workspaces": [</script>', ""))

    def test_cookie_first_second_segments_and_invalid_cookie(self):
        payload = encode_cookie({"workspaces": [{"id": W1}]}).split('.')[0]
        header = encode_cookie({"alg": "HS256"}).split('.')[0]
        self.assertEqual(cookie_ids(payload+'.signature'), {W1})
        self.assertEqual(cookie_ids(header+'.'+payload+'.signature'), {W1})
        self.assert_error(lambda: cookie_ids('not-a-json-cookie'))
        bad = base64.urlsafe_b64encode(b'{"workspaces":[').decode()
        self.assert_error(lambda: cookie_ids(bad+'.'+payload))

    def test_limits_and_incomplete_markup_fail_closed(self):
        self.assert_error(lambda: html_ids('x'*(MAX_TEXT+1)))
        self.assert_error(lambda: document_ids({"workspaces": [{"id": str(i)} for i in range(MAX_IDS+1)]}))
        self.assert_error(lambda: unflatten([None]*(MAX_NODES+1)))
        doc = {"workspace_id": W1}
        for _ in range(MAX_DEPTH+1):
            doc = {"nested": doc}
        self.assert_error(lambda: document_ids(doc))
        self.assert_error(lambda: html_ids('<script>{"workspace_id":"'+W1+'"}'))
        self.assert_error(lambda: html_ids('<input name="workspace_id">'))

    def test_mixed_enqueue_script_never_hides_unconsumed_sources(self):
        extra = 'window.additional={"workspaces":[{"id":"'+W2+'"}]};'
        html = stream_html(graph([W1]))
        for mixed in [html.replace('</script>', extra+'</script>'),
                      html.replace('<script nonce="fixture">', '<script nonce="fixture">'+extra),
                      html.replace('</script>', 'ignoredCall();</script>')]:
            self.assert_error(lambda: select_workspace({}, mixed, ''))
        # Two direct calls in a single script remain supported.
        self.assertEqual(html_ids(stream_html(graph([W1]), split=True).replace('</script><script nonce="fixture">', '')), {W1})

    def test_cookie_header_never_masks_invalid_payload(self):
        header = encode_cookie({"alg": "HS256"}).split('.')[0]
        for bad in ["not%base64", base64.urlsafe_b64encode(b'\xff').decode(),
                    base64.urlsafe_b64encode(b'null').decode(),
                    base64.urlsafe_b64encode(b'{"workspaces":[').decode()]:
            self.assert_error(lambda: select_workspace({}, stream_html(graph([W1])), header+'.'+bad+'.signature'))
        self.assert_error(lambda: cookie_ids(encode_cookie({"workspace_id": W1})+'.extra.signature'))
        self.assertEqual(cookie_ids(encode_cookie({"workspace_id": W1}).split('.')[0]), {W1})

    def test_protocol_null_and_undefined_constants_are_not_holes_or_nan(self):
        for sentinel in [-5, -7]:
            values = [{"_1": 2, "_3": sentinel}, "workspace_id", W1, "optional"]
            self.assertEqual(document_ids(unflatten(values)), {W1})
            self.assert_error(lambda: select_workspace(unflatten([{"_1": sentinel}, "workspaces"]), "", ""))
        for sentinel in [-1, -2, -3, -4, -6, -8]:
            self.assert_error(lambda: unflatten([{"_1": sentinel}, "workspaces"]))

    def test_large_list_is_not_truncated_to_first_workspace(self):
        html = '<script>{"workspaces":[{"id":"'+W1+'"},'+' '*5000+'{"id":"'+W2+'"}]}</script>'
        self.assert_error(lambda: select_workspace({}, html, ""), "OAUTH_WORKSPACE_AMBIGUOUS")


if __name__ == '__main__':
    unittest.main()
