"""Synthetic personal/team choice contracts, not captured login data."""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))
from oauth_login.errors import LoginError
from oauth_login.workspace_policy import Evidence, choose_workspace, normalize_name
from oauth_login.workspaces import select_workspace
from test_workspaces import encode_cookie, stream_html


def catalog(*items):
    evidence = Evidence()
    evidence.add_catalog(list(items))
    return evidence


def flatten(value):
    """Encode the supported turbo-stream basic container index graph."""
    values = []
    def add(item):
        index = len(values)
        values.append(None)
        if isinstance(item, dict):
            result = {}
            for key, child in item.items():
                key_index = add(key)
                result[f"_{key_index}"] = add(child)
            values[index] = result
        elif isinstance(item, list):
            values[index] = [add(child) for child in item]
        else:
            values[index] = item
        return index
    add(value)
    return values


class PolicyTests(unittest.TestCase):
    def fails(self, fn, code="OAUTH_WORKSPACE_AMBIGUOUS"):
        with self.assertRaises(LoginError) as caught:
            fn()
        self.assertEqual(str(caught.exception), code)

    def test_actual_kind_schema_with_null_personal_name(self):
        doc = {"workspaces": [{"id": "team", "name": "Fixture team", "kind": "organization"},
                              {"id": "personal", "name": None, "kind": "personal"}]}
        for data, html, cookie in [(doc, "", ""), ({}, "", encode_cookie(doc)),
                                   ({}, stream_html(flatten(doc)), "")]:
            self.assertEqual(select_workspace(data, html, cookie), "team")
        self.assertEqual(choose_workspace(catalog(*doc["workspaces"][::-1])), "team")

    def test_kind_priority_aliases_and_boolean_agreement(self):
        for kind in ["team", "business", "enterprise", "organization"]:
            self.assertEqual(choose_workspace(catalog(
                {"id": "p", "kind": "personal", "name": "Renamed"},
                {"id": "t", "kind": kind, "name": "个人账户", "is_personal": False})), "t")
        self.assertEqual(choose_workspace(catalog({"id": "p", "kind": "personal"})), "p")
        # type and kind describe compatible categories, not necessarily identical labels.
        self.assertEqual(choose_workspace(catalog({"id": "t", "type": "team", "kind": "organization"})), "t")

    def test_kind_conflicts_are_not_discarded(self):
        for item in [{"id": "x", "kind": "personal", "type": "team"},
                     {"id": "x", "kind": "organization", "is_personal": True}]:
            self.fails(lambda: catalog(item), "OAUTH_WORKSPACE_CONFLICT")
        doc = {"workspaces": [{"id": "p", "kind": "personal"}, {"id": "t", "kind": "organization"}]}
        for other_kind in ["team", "personal", "enterprise"]:
            other = {"workspaces": [{"id": "p", "kind": "personal"}, {"id": "t", "kind": other_kind}]}
            self.fails(lambda: select_workspace(doc, "", encode_cookie(other)), "OAUTH_WORKSPACE_CONFLICT")
        self.assertEqual(select_workspace(doc, "", encode_cookie(doc)), "t")
        other = {"workspaces": [{"id": "p", "type": "personal"}, {"id": "t", "type": "team"}]}
        self.assertEqual(select_workspace(doc, "", encode_cookie(other)), "t")
        # Merging another type-only source must not erase a previously observed kind.
        combined = {"sources": [doc, other]}
        changed = {"workspaces": [{"id": "p"}, {"id": "t", "kind": "business"}]}
        self.fails(lambda: select_workspace(combined, "", encode_cookie(changed)), "OAUTH_WORKSPACE_CONFLICT")

    def test_bad_kind_never_falls_back_to_names_or_other_fields(self):
        for kind in [None, False, 0, [], {}, "", "unknown", "personal "]:
            self.fails(lambda: catalog({"id": "x", "kind": kind, "type": "team"}), "OAUTH_WORKSPACE_INVALID")
        self.fails(lambda: choose_workspace(catalog({"id": "a", "kind": "organization"},
                                                   {"id": "b", "kind": "organization"})))

    def test_explicit_null_classification_is_not_missing_evidence(self):
        good = {"workspaces": [{"id": "t", "kind": "organization"}, {"id": "p", "kind": "personal", "name": None}]}
        for key in ["kind", "type"]:
            doc = {"workspaces": [{"id": "t", "kind": "organization", "type": "team", key: None},
                                  {"id": "p", "kind": "personal"}]}
            for data, html, cookie in [(doc, "", ""), ({}, stream_html(flatten(doc)), ""),
                                       ({}, "", encode_cookie(doc)), (good, "", encode_cookie(doc))]:
                self.fails(lambda: select_workspace(data, html, cookie), "OAUTH_WORKSPACE_INVALID")

    def test_empty_and_single_personal_or_team(self):
        self.fails(lambda: choose_workspace(Evidence()), "OAUTH_WORKSPACE_NOT_FOUND")
        for item in [{"id": "one"}, {"id": "one", "type": "personal"}, {"id": "one", "type": "team"}]:
            self.assertEqual(choose_workspace(catalog(item)), "one")

    def test_explicit_types_do_not_depend_on_names_or_order(self):
        for kind in ["team", "business", "enterprise", "organization"]:
            items = [{"id": "p", "type": "personal", "name": "Renamed account"},
                     {"id": "t", "type": kind, "name": "个人账户"}]
            for ordered in [items, items[::-1]]:
                self.assertEqual(choose_workspace(catalog(*ordered)), "t")
        self.assertEqual(choose_workspace(catalog({"id": "p", "is_personal": True},
                                                {"id": "t", "is_personal": False})), "t")

    def test_excludes_personal_label_not_owner_name(self):
        for label in ["个人账户", "个人帐户", "个人账号", "Personal account", "Personal", " ＰＥＲＳＯＮＡＬ　 account "]:
            for team_name in ["Kitgiz", "Arbitrary name", "Personal research", "fixture", "本人名字"]:
                for reverse in [False, True]:
                    items = [{"id": "p", "name": label}, {"id": "t", "display_name": team_name}]
                    self.assertEqual(choose_workspace(catalog(*(items[::-1] if reverse else items))), "t")

    def test_partial_metadata_is_safe_only_with_identifiable_personal(self):
        self.assertEqual(choose_workspace(catalog({"id": "p", "type": "personal"}, {"id": "t", "name": "Any name"})), "t")
        self.assertEqual(choose_workspace(catalog({"id": "p", "name": "个人账户"}, {"id": "t", "type": "team"})), "t")
        for items in [
            [{"id": "p", "name": "Owner"}, {"id": "t", "name": "Team"}],
            [{"id": "p"}, {"id": "t", "type": "team"}],
            [{"id": "p", "type": "personal"}, {"id": "t"}],
            [{"id": "p", "type": "personal"}, {"id": "q", "type": "personal"}],
            [{"id": "t", "type": "team"}, {"id": "u", "type": "team"}],
            [{"id": "p", "name": "个人账户"}, {"id": "t", "name": "Team"}, {"id": "u", "name": "Other"}],
        ]:
            self.fails(lambda: choose_workspace(catalog(*items)))

    def test_current_personal_pointer_does_not_override_team(self):
        doc = {"workspaces": [{"id": "p", "type": "personal"}, {"id": "t", "type": "team"}]}
        self.assertEqual(select_workspace(doc, "", encode_cookie({"workspace_id": "p"})), "t")
        self.fails(lambda: select_workspace(doc, "", encode_cookie({"workspace_id": "outside"})), "OAUTH_WORKSPACE_CONFLICT")

    def test_catalog_and_metadata_conflicts_cannot_be_hidden_by_selection(self):
        doc = {"workspaces": [{"id": "p", "type": "personal"}, {"id": "t", "type": "team"}]}
        for other in [{"workspaces": []}, {"workspaces": [{"id": "p"}]},
                      {"workspaces": [{"id": "p", "type": "team"}, {"id": "t"}]}]:
            self.fails(lambda: select_workspace(doc, "", encode_cookie(other)), "OAUTH_WORKSPACE_CONFLICT")
        self.fails(lambda: catalog({"id": "t", "name": "A"}, {"id": "t", "name": "B"}), "OAUTH_WORKSPACE_CONFLICT")
        self.fails(lambda: catalog({"id": "t", "type": "team", "is_personal": True}), "OAUTH_WORKSPACE_CONFLICT")
        self.fails(lambda: catalog({"id": "t", "name": "A", "display_name": "B"}), "OAUTH_WORKSPACE_CONFLICT")
        self.assertEqual(choose_workspace(catalog({"id": "t", "name": "Ａ"}, {"id": "t", "name": "a"})), "t")

    def test_conflicting_current_pointers_inside_catalog_stop(self):
        doc = {"workspace_id": "p", "workspaces": [
            {"id": "p", "type": "personal"}, {"id": "t", "type": "team"}]}
        self.fails(lambda: select_workspace(doc, "", encode_cookie({"workspace_id": "t"})), "OAUTH_WORKSPACE_CONFLICT")
        self.fails(lambda: select_workspace(doc, '<input name="workspace_id" value="t">', ""), "OAUTH_WORKSPACE_CONFLICT")
        self.assertEqual(select_workspace(doc, "", encode_cookie({"workspaceId": "p"})), "t")

    def test_raw_nonpersonal_type_conflicts_are_not_normalized_away(self):
        for kind in ["business", "enterprise", "organization"]:
            doc = {"workspaces": [{"id": "p", "type": "personal"}, {"id": "t", "type": "team"}]}
            other = {"workspaces": [{"id": "p", "type": "personal"}, {"id": "t", "type": kind}]}
            self.fails(lambda: select_workspace(doc, "", encode_cookie(other)), "OAUTH_WORKSPACE_CONFLICT")
            self.assertEqual(select_workspace(other, "", encode_cookie(other)), "t")
            self.assertEqual(select_workspace(other, "", encode_cookie({"workspaces": [
                {"id": "p", "is_personal": True}, {"id": "t", "is_personal": False}]})), "t")

    def test_bad_metadata_is_rejected_even_for_one_candidate(self):
        for metadata in [{"type": "unknown"}, {"type": []}, {"is_personal": "false"}, {"is_personal": 0},
                         {"name": []}, {"name": ""}, {"name": " "}, {"name": "a\x00"}, {"name": "x" * 257}]:
            self.fails(lambda: catalog({"id": "x", **metadata}), "OAUTH_WORKSPACE_INVALID")

    def test_unscoped_pointers_conflict_and_do_not_borrow_adjacent_names(self):
        self.fails(lambda: select_workspace({"a": {"workspace_id": "p", "name": "个人账户"},
                                              "b": {"workspace_id": "t", "name": "Team"}}, "", ""), "OAUTH_WORKSPACE_CONFLICT")

    def test_metadata_survives_all_supported_sources(self):
        doc = {"workspaces": [{"id": "p", "name": "个人账户"}, {"id": "t", "name": "Kitgiz"}],
               "user": {"name": "Kitgiz"}}
        for data, html, cookie in [(doc, "", ""), ({}, '<script>'+json.dumps(doc)+'</script>', ""),
                                   ({}, stream_html(flatten(doc), split=True), ""), ({}, "", encode_cookie(doc))]:
            self.assertEqual(select_workspace(data, html, cookie), "t")
        self.assertEqual(normalize_name(" ＡＢＣ　 Def "), "abc def")


if __name__ == "__main__":
    unittest.main()
