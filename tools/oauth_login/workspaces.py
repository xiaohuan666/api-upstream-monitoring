"""Bounded workspace discovery; never execute page scripts or guess the first ID."""
import base64
import json
import re
from html.parser import HTMLParser

from .errors import LoginError
from .protocol_json import decode_json
from .workspace_policy import Evidence, MAX_IDS, choose_workspace

MAX_TEXT = 4 * 1024 * 1024
MAX_NODES = 20000
MAX_DEPTH = 64
ENQUEUE = re.compile(r'(?:window\.)?__reactRouterContext\.streamController\.enqueue\s*\(')
INVALID = "OAUTH_WORKSPACE_INVALID"


def invalid():
    raise LoginError(INVALID)


def loads(text):
    return decode_json(text, INVALID)


def document_evidence(document):
    """Preserve metadata only when it is bound to a workspace list member."""
    evidence, stack, visited = Evidence(), [(document, 0)], 0
    while stack:
        value, depth = stack.pop()
        visited += 1
        if visited > MAX_NODES or depth > MAX_DEPTH:
            invalid()
        if isinstance(value, dict):
            for key, child in value.items():
                if key in {"workspace_id", "workspaceId"}:
                    evidence.add_pointer(child)
                elif key == "workspaces":
                    evidence.add_catalog(child)
                stack.append((child, depth + 1))
        elif isinstance(value, list):
            stack.extend((child, depth + 1) for child in value)
    return evidence


def document_ids(document):
    return document_evidence(document).ids


def unflatten(values):
    """Decode only the basic JSON-container subset of turbo-stream v2.

    Object keys and container entries are references, not adjacent text pairs.
    Unsupported tags/deferred records fail closed rather than hiding candidates.
    """
    if not isinstance(values, list) or not values or len(values) > MAX_NODES:
        invalid()
    active, cache = set(), {}
    visits = 0

    def hydrate(index, depth=0):
        nonlocal visits
        visits += 1
        if visits > MAX_NODES or depth > MAX_DEPTH or type(index) is not int:
            invalid()
        if index in {-5, -7}:  # turbo-stream v2 null/undefined; not a workspace ID
            return None
        if not 0 <= index < len(values) or index in active:
            invalid()
        if index in cache:
            return cache[index]
        active.add(index)
        value = values[index]
        if isinstance(value, dict):
            result = {}
            for key, ref in value.items():
                if not re.fullmatch(r"_\d+", key):
                    invalid()
                name = hydrate(int(key[1:]), depth + 1)
                if not isinstance(name, str) or name in result:
                    invalid()
                result[name] = hydrate(ref, depth + 1)
        elif isinstance(value, list):
            # Tagged/plugin values are not plain arrays; never treat as IDs.
            if value and isinstance(value[0], str):
                invalid()
            result = [hydrate(ref, depth + 1) for ref in value]
        else:
            result = value
        active.remove(index)
        cache[index] = result
        return result

    return hydrate(0)


class WorkspaceHTML(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.evidence, self.scripts, self.script, self.script_type = Evidence(), [], None, ""

    def handle_starttag(self, tag, attributes):
        attrs = dict(attributes)
        if tag == "input" and any(key == "name" and value in {"workspace_id", "workspaceId"} for key, value in attributes):
            if sum(key == "name" for key, _ in attributes) != 1 or sum(key == "value" for key, _ in attributes) != 1:
                invalid()
        if tag == "input" and attrs.get("name") in {"workspace_id", "workspaceId"}:
            self.evidence.add_pointer(attrs.get("value"))
        if tag == "script":
            if self.script is not None:
                invalid()
            self.script, self.script_type = [], attrs.get("type", "").lower()

    def handle_data(self, data):
        if self.script is not None:
            self.script.append(data)

    def handle_endtag(self, tag):
        if tag == "script" and self.script is not None:
            self.scripts.append((self.script_type, "".join(self.script)))
            self.script = None


def html_evidence(html):
    if not isinstance(html, str) or len(html) > MAX_TEXT:
        invalid()
    parser = WorkspaceHTML()
    try:
        parser.feed(html)
        parser.close()
    except (ValueError, RecursionError):
        invalid()
    if parser.script is not None:
        invalid()
    chunks = []
    for kind, text in parser.scripts:
        text = text.strip()
        matches = list(ENQUEUE.finditer(text))
        if matches:
            # The supported script grammar is a sequence of direct enqueue
            # calls. Consume it completely; do not hide other source data in
            # the prefix, gaps or suffix of a recognized call.
            cursor = 0
            while cursor < len(text):
                while cursor < len(text) and (text[cursor].isspace() or text[cursor] == ";"):
                    cursor += 1
                if cursor == len(text):
                    break
                match = ENQUEUE.match(text, cursor)
                if not match:
                    invalid()
                cursor = match.end()
                while cursor < len(text) and text[cursor].isspace():
                    cursor += 1
                try:
                    chunk, end = json.JSONDecoder().raw_decode(text, cursor)
                except (ValueError, RecursionError):
                    invalid()
                cursor = end
                while cursor < len(text) and text[cursor].isspace():
                    cursor += 1
                if not isinstance(chunk, str) or cursor >= len(text) or text[cursor] != ")":
                    invalid()
                chunks.append(chunk)
                cursor += 1
        elif kind == "application/json" or text.startswith(("{", "[")):
            parser.evidence.merge(document_evidence(loads(text)))
        elif re.search(r"(?:[\"'](?:workspaces|workspace_id|workspaceId)[\"']\s*:|\b(?:workspaces|workspace_id|workspaceId)\s*=)", text):
            # A workspace-bearing encoding we cannot prove complete is unsafe.
            invalid()
    if chunks:
        stream = "".join(chunks).strip()
        # Multiple frames/promises require a different protocol decoder. Do not
        # silently accept just the first frame and miss a later workspace.
        parser.evidence.merge(document_evidence(unflatten(loads(stream))))
    return parser.evidence


def html_ids(html):
    return html_evidence(html).ids


def cookie_evidence(encoded):
    if not encoded:
        return Evidence()
    if not isinstance(encoded, str) or len(encoded) > MAX_TEXT:
        invalid()
    segments = encoded.split(".")
    if not 1 <= len(segments) <= 3 or any(not part for part in segments):
        invalid()

    def payload(segment):
        if not re.fullmatch(r"[A-Za-z0-9_-]+={0,2}", segment):
            invalid()
        try:
            decoded = base64.b64decode(segment + "=" * (-len(segment) % 4), altchars=b"-_", validate=True).decode("utf-8")
        except (ValueError, UnicodeError):
            raise LoginError(INVALID) from None
        document = loads(decoded)
        if not isinstance(document, dict):
            invalid()
        return document

    # Supported layouts: payload, payload.signature, header.payload.signature.
    # Signatures are opaque; a valid header never substitutes for its payload.
    if len(segments) == 3:
        header = payload(segments[0])
        if not isinstance(header.get("alg"), str) or not header["alg"] or document_ids(header):
            invalid()
        document = payload(segments[1])
    else:
        document = payload(segments[0])
    return document_evidence(document)


def cookie_ids(encoded):
    return cookie_evidence(encoded).ids


def select_workspace(data, html, encoded):
    evidence = document_evidence(data)
    evidence.merge(html_evidence(html)).merge(cookie_evidence(encoded))
    return choose_workspace(evidence)
