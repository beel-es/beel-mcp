from __future__ import annotations

from fastmcp import Context

from beel_mcp.client.exceptions import BeelApiError
from beel_mcp.policies.nif_policy import evaluate_nif_result
from beel_mcp.runtime import error_response, get_from_lifespan, success_response


async def validate_nif(
    nif: str,
    legal_name: str | None = None,
    ctx: Context | None = None,
) -> dict:
    """Valida un NIF/CIF contra AEAT a traves del endpoint publico de BeeL."""
    nif_svc = get_from_lifespan(ctx, "nif_service")
    try:
        result = await nif_svc.validate(nif=nif.upper(), legal_name=legal_name)
        nif_data = result.get("data", {})
        status = nif_data.get("status")
        policy = evaluate_nif_result(status)
        return success_response(
            action_taken="nif_validated",
            human_summary=f"NIF {nif.upper()}: estado {status}. {policy['recommendation']}",
            data={
                "nif": nif.upper(),
                "valid": nif_data.get("valid"),
                "status": status,
                "legal_name_from_aeat": nif_data.get("legal_name"),
                "validated_at": nif_data.get("validated_at"),
                "can_proceed": policy["can_proceed"],
                "warning": policy["warning"],
            },
            next_actions=["create_customer", "create_invoice_draft"]
            if policy["can_proceed"]
            else ["corregir_nif"],
        )
    except BeelApiError as exc:
        return error_response(
            action_taken="nif_validation_failed",
            human_summary=f"Error validando NIF: {exc.message}",
            error=str(exc),
        )
