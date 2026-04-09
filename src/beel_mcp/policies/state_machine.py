from __future__ import annotations


class PolicyViolation(ValueError):
    pass


ALLOWED_STATUSES_BY_ACTION: dict[str, set[str]] = {
    "update_invoice_draft": {"DRAFT"},
    "preview_invoice_pdf": {"DRAFT"},
    "issue_invoice": {"DRAFT"},
    "send_invoice_email": {"ISSUED", "SENT", "PAID", "OVERDUE"},
    # Implementacion conservadora: la OpenAPI del endpoint individual
    # documenta SENT -> PAID.
    "mark_invoice_paid": {"SENT"},
}


def is_action_allowed(action: str, current_status: str | None) -> bool:
    allowed = ALLOWED_STATUSES_BY_ACTION.get(action)
    if not allowed:
        return True
    return current_status in allowed


def assert_action_allowed(action: str, current_status: str | None) -> None:
    allowed = ALLOWED_STATUSES_BY_ACTION.get(action)
    if not allowed:
        return
    if current_status not in allowed:
        allowed_display = ", ".join(sorted(allowed))
        raise PolicyViolation(
            f"La accion `{action}` no esta permitida desde el estado `{current_status}`. "
            f"Estados permitidos: {allowed_display}."
        )
