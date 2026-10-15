"""Pure selection policy: exclude personal accounts; never compare owner names."""
from dataclasses import dataclass, field
import re
import unicodedata

from .errors import LoginError

MAX_IDS = 128
ID = re.compile(r"[A-Za-z0-9_-]{1,256}\Z")
KINDS = {"personal": "personal", "team": "team", "business": "team", "enterprise": "team", "organization": "team"}


def error(code="OAUTH_WORKSPACE_INVALID"):
    raise LoginError(code)


def normalize_name(value: object) -> str:
    if not isinstance(value, str) or not 1 <= len(value) <= 256:
        error()
    if any(unicodedata.category(c).startswith("C") for c in value):
        error()
    value = " ".join(unicodedata.normalize("NFKC", value).split()).casefold()
    if not value or len(value) > 256:
        error()
    return value


@dataclass(frozen=True)
class Workspace:
    id: str
    name: str | None = None
    kind: str | None = None
    # Retain source values: equivalent selection classes need not be consistent evidence.
    explicit_type: str | None = None
    explicit_kind: str | None = None


def workspace(value: object) -> Workspace:
    if not isinstance(value, dict) or not isinstance(value.get("id"), str) or not ID.fullmatch(value["id"]):
        error()
    names = {normalize_name(value[key]) for key in ("name", "display_name") if key in value and value[key] is not None}
    kinds = set()
    for key in ("type", "kind"):
        if key in value:
            if not isinstance(value[key], str) or value[key] not in KINDS:
                error()
            kinds.add(KINDS[value[key]])
    if value.get("is_personal") is not None:
        if type(value["is_personal"]) is not bool:
            error()
        kinds.add("personal" if value["is_personal"] else "team")
    if len(names) > 1 or len(kinds) > 1:
        error("OAUTH_WORKSPACE_CONFLICT")
    return Workspace(value["id"], next(iter(names), None), next(iter(kinds), None), value.get("type"), value.get("kind"))


@dataclass
class Evidence:
    items: dict[str, Workspace] = field(default_factory=dict)
    catalogs: set[frozenset[str]] = field(default_factory=set)
    pointers: set[str] = field(default_factory=set)

    def add(self, value: object) -> None:
        self._merge_candidate(workspace(value))

    def _merge_candidate(self, candidate: Workspace) -> None:
        previous = self.items.get(candidate.id)
        if previous:
            if (previous.name is not None and candidate.name is not None and previous.name != candidate.name
                    or previous.kind is not None and candidate.kind is not None and previous.kind != candidate.kind
                    or previous.explicit_type is not None and candidate.explicit_type is not None
                    and previous.explicit_type != candidate.explicit_type
                    or previous.explicit_kind is not None and candidate.explicit_kind is not None
                    and previous.explicit_kind != candidate.explicit_kind):
                error("OAUTH_WORKSPACE_CONFLICT")
            candidate = Workspace(candidate.id, candidate.name or previous.name, candidate.kind or previous.kind,
                                  candidate.explicit_type or previous.explicit_type, candidate.explicit_kind or previous.explicit_kind)
        self.items[candidate.id] = candidate
        if len(self.items) > MAX_IDS:
            error()

    def add_pointer(self, value: object) -> None:
        candidate = workspace({"id": value})
        self._merge_candidate(candidate)
        self.pointers.add(candidate.id)

    def add_catalog(self, values: object) -> None:
        if not isinstance(values, list):
            error()
        ids = set()
        for value in values:
            self.add(value)
            ids.add(value["id"])
        self.catalogs.add(frozenset(ids))

    def merge(self, other: "Evidence") -> "Evidence":
        for candidate in other.items.values():
            self._merge_candidate(candidate)
        self.catalogs.update(other.catalogs)
        self.pointers.update(other.pointers)
        return self

    @property
    def ids(self) -> set[str]:
        return set(self.items)


def choose_workspace(evidence: Evidence) -> str:
    # A current workspace ID is only a pointer. It may be the personal entry
    # within a complete personal+team catalog, not an instruction to select it.
    if len(evidence.pointers) > 1 or len(evidence.catalogs) > 1:
        error("OAUTH_WORKSPACE_CONFLICT")
    if evidence.catalogs and evidence.ids != set(next(iter(evidence.catalogs))):
        error("OAUTH_WORKSPACE_CONFLICT")
    if not evidence.items:
        error("OAUTH_WORKSPACE_NOT_FOUND")
    if len(evidence.items) == 1:
        return next(iter(evidence.items))
    # Multiple unscoped pointers do not constitute a complete choice catalog.
    if not evidence.catalogs:
        error("OAUTH_WORKSPACE_CONFLICT")
    candidates = list(evidence.items.values())
    # Explicit provider metadata wins over localized display labels. Never use
    # substring matching: a team called "Personal research" is still a team.
    personal_labels = {"个人账户", "个人帐户", "个人账号", "personal", "personal account"}
    personal = [c for c in candidates if c.kind == "personal"
                or c.kind is None and c.name in personal_labels]
    teams = [c for c in candidates if c.kind == "team"]
    unknown = [c for c in candidates if c.kind is None and c not in personal]
    # A non-personal name alone is not proof: without an identified personal
    # option, two names may just be an unlabeled personal account and a team.
    if unknown and (not personal or any(c.name is None for c in unknown)):
        error("OAUTH_WORKSPACE_AMBIGUOUS")
    teams.extend(unknown)
    if len(teams) != 1:
        error("OAUTH_WORKSPACE_AMBIGUOUS")
    return teams[0].id
