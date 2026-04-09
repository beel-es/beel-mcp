from __future__ import annotations

import pytest

from beel_mcp.config import Settings


@pytest.fixture
def mock_settings() -> Settings:
    return Settings(
        BEEL_API_KEY="beel_sk_test_fake",
        BEEL_BASE_URL="https://app.beel.es/api",
        BEEL_ENVIRONMENT="sandbox",
        BEEL_TIMEOUT_SECONDS=5,
        BEEL_MAX_RETRIES=1,
        BEEL_RETRY_BACKOFF_SECONDS=0.1,
        BEEL_MAX_INLINE_BINARY_BYTES=100_000,
    )
