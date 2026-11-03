from __future__ import annotations

import os


def configured_api_base_url() -> str:
    """Return the trusted API URL configured by the deployment environment."""
    return str(
        os.getenv("FLOWLY_API_BASE_URL")
        or os.getenv("FLOWLY_API_URL")
        or "http://localhost:5000/api"
    ).strip()
