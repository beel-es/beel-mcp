from __future__ import annotations


def evaluate_nif_result(status: str | None) -> dict[str, object]:
    if status == "VALID":
        return {
            "can_proceed": True,
            "warning": None,
            "recommendation": "NIF valido. Se puede continuar.",
        }
    if status == "PENDING":
        return {
            "can_proceed": True,
            "warning": (
                "La API de VeriFactu no estaba disponible; el NIF tiene formato valido "
                "pero no se pudo verificar contra AEAT."
            ),
            "recommendation": "Se puede continuar con precaucion y revalidar mas tarde.",
        }
    if status == "INVALID":
        return {
            "can_proceed": False,
            "warning": "NIF invalido segun AEAT.",
            "recommendation": "Bloquear por defecto y corregir el NIF antes de emitir.",
        }
    return {
        "can_proceed": False,
        "warning": "Error tecnico validando el NIF.",
        "recommendation": "Reintentar validacion antes de continuar.",
    }
