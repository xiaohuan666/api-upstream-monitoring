"""Lossless-at-the-boundary JSON validation shared by protocol and discovery."""
import json

from .errors import LoginError

MAX_JSON_TEXT = 4 * 1024 * 1024


def decode_json(text, error_code="OAUTH_UNKNOWN_STEP"):
    def reject():
        raise LoginError(error_code)

    def pairs(items):
        value = {}
        for key, child in items:
            if key in value:
                reject()
            value[key] = child
        return value

    if not isinstance(text, str) or len(text) > MAX_JSON_TEXT:
        reject()
    try:
        return json.loads(text, object_pairs_hook=pairs, parse_constant=lambda _: reject())
    except (ValueError, RecursionError):
        raise LoginError(error_code) from None
