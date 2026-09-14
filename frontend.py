"""CLI formatting helpers for a tiny URL-shortener service.

Stdlib-only, standalone module. No imports from sibling files.
"""


def render_table(rows: list[tuple]) -> str:
    """Render rows of cells as an aligned plain-text table.

    Columns are padded to the widest cell in each column and separated
    by two spaces. Returns an empty string for an empty row list.
    """
    if not rows:
        return ""
    ncols = max(len(row) for row in rows)
    widths = [0] * ncols
    for row in rows:
        for i in range(ncols):
            cell = str(row[i]) if i < len(row) else ""
            widths[i] = max(widths[i], len(cell))
    lines = []
    for row in rows:
        cells = []
        for i in range(ncols):
            cell = str(row[i]) if i < len(row) else ""
            if i < ncols - 1:
                cells.append(cell.ljust(widths[i]))
            else:
                cells.append(cell)  # no trailing padding on last column
        lines.append("  ".join(cells))
    return "\n".join(lines)


def shorten_output(url: str, slug: str) -> str:
    """Return a one-line result string for a shortened URL."""
    return f"{url} -> {slug}"
