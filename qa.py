"""Small stdlib-only QA helpers for slug validation."""


def check_slug(slug: str) -> tuple[bool, str]:
    """Validate a URL shortener slug.

    Slugs must be 3-16 characters and contain only lowercase ASCII letters
    and digits.
    """
    if not isinstance(slug, str):
        return False, "slug must be a string"

    if not 3 <= len(slug) <= 16:
        return False, "slug must be 3-16 characters"

    if not all(("a" <= char <= "z") or ("0" <= char <= "9") for char in slug):
        return False, "slug must contain only lowercase letters and digits"

    return True, "ok"


def run_checks(cases: list[tuple]) -> dict[str, int]:
    """Run check_slug for cases and return pass/fail counts.

    Each case is expected to contain at least ``(slug, expected_valid)``.
    Extra tuple items are ignored.
    """
    counts = {"pass": 0, "fail": 0}

    for case in cases:
        slug, expected_valid = case[0], case[1]
        actual_valid, _ = check_slug(slug)
        if actual_valid == expected_valid:
            counts["pass"] += 1
        else:
            counts["fail"] += 1

    return counts
