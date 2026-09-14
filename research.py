"""Design notes for a tiny URL-shortener service.

The service accepts a long URL, assigns it a compact slug, and redirects
requests for that slug to the stored URL.  The design favors a small HTTP API,
a single lookup by slug, and storage that can grow from a local prototype into
a multi-process deployment.
"""

SERVICE_DESIGN = {
    "endpoint": "POST /shorten creates a slug; GET /<slug> redirects to the long URL.",
    "storage": "A key-value store maps each slug to its long URL and creation metadata.",
    "slug_length": "Use 7 URL-safe random characters, retrying on collisions.",
}


def tradeoffs():
    """Return storage choices with their primary advantages and drawbacks."""
    return [
        (
            "In-memory dictionary",
            "Zero setup and very fast lookups for a local prototype.",
            "Data is lost on restart and cannot be shared reliably across processes.",
        ),
        (
            "SQLite",
            "Durable, transactional, and available with no separate database service.",
            "A single file can limit write concurrency and horizontal scaling.",
        ),
        (
            "Redis",
            "Fast key-value access with straightforward expiration and replication options.",
            "Requires an external service and careful persistence and operational setup.",
        ),
        (
            "Managed key-value database",
            "Scales operationally with built-in availability and backup features.",
            "Adds ongoing cost, vendor coupling, and network latency.",
        ),
    ]
