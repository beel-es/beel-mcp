from __future__ import annotations


ACTIONS_REQUIRING_CONFIRMATION: dict[str, str] = {
    "issue_invoice": "Emitir una factura tiene efectos fiscales irreversibles.",
    "send_invoice_email": "Enviar una factura por email es una accion operativa real.",
    "mark_invoice_paid": "Marcar una factura como pagada modifica su estado contable.",
    "export_invoices_excel": "La exportacion puede exponer datos fiscales y personales.",
    "issue_send_and_track_invoice": (
        "Este workflow emite la factura y puede enviarla por email en el mismo paso."
    ),
}


def requires_confirmation(action: str) -> bool:
    return action in ACTIONS_REQUIRING_CONFIRMATION


def get_confirmation_message(action: str) -> str:
    return ACTIONS_REQUIRING_CONFIRMATION[action]
