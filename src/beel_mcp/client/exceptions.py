from __future__ import annotations

from typing import Any


class BeelApiError(Exception):
    def __init__(
        self,
        *,
        status_code: int | None,
        code: str,
        message: str,
        details: Any | None = None,
        request_id: str | None = None,
        retryable: bool = False,
    ) -> None:
        self.status_code = status_code
        self.code = code
        self.message = message
        self.details = details
        self.request_id = request_id
        self.retryable = retryable
        super().__init__(self.__str__())

    def __str__(self) -> str:
        base = f"{self.code}: {self.message}"
        if self.status_code is not None:
            base = f"[{self.status_code}] {base}"
        if self.request_id:
            base = f"{base} (request_id={self.request_id})"
        return base


class BeelBadRequestError(BeelApiError):
    pass


class BeelUnauthorizedError(BeelApiError):
    pass


class BeelForbiddenError(BeelApiError):
    pass


class BeelNotFoundError(BeelApiError):
    pass


class BeelConflictError(BeelApiError):
    pass


class BeelValidationError(BeelApiError):
    pass


class BeelRateLimitError(BeelApiError):
    pass


class BeelServerError(BeelApiError):
    pass


class BeelTransportError(BeelApiError):
    pass
