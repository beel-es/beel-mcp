from __future__ import annotations

import uuid


def generate_idempotency_key() -> str:
    return str(uuid.uuid4())
