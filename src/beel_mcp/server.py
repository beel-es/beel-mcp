from __future__ import annotations

from contextlib import asynccontextmanager

from fastmcp import FastMCP
from fastmcp.apps import AppConfig, ResourceCSP

from beel_mcp.auth import build_auth
from beel_mcp.client.beel_client import BeelClient
from beel_mcp.config import get_settings
from beel_mcp.services.customer_service import CustomerService
from beel_mcp.services.delivery_service import DeliveryService
from beel_mcp.services.export_service import ExportService
from beel_mcp.services.invoice_service import InvoiceService
from beel_mcp.services.nif_service import NifService
from beel_mcp.services.pdf_service import PdfService
from beel_mcp.services.verifactu_service import VerifactuService
from beel_mcp.ui.pdf_viewer import (
    PDF_VIEWER_URI,
    RESOURCE_DOMAINS,
    get_pdf_viewer_html,
)


@asynccontextmanager
async def lifespan(_: FastMCP):
    settings = get_settings()
    client_cache: dict[str, dict] = {}

    default_client = None
    default_services: dict = {}
    if settings.beel_api_key:
        default_client = BeelClient(settings)
        default_services = {
            "beel_client": default_client,
            "customer_service": CustomerService(default_client),
            "nif_service": NifService(default_client),
            "invoice_service": InvoiceService(default_client),
            "pdf_service": PdfService(default_client),
            "delivery_service": DeliveryService(default_client),
            "verifactu_service": VerifactuService(default_client),
            "export_service": ExportService(default_client),
        }

    try:
        yield {
            "settings": settings,
            "client_cache": client_cache,
            **default_services,
        }
    finally:
        if default_client:
            await default_client.close()
        for entry in client_cache.values():
            await entry["beel_client"].close()


_settings = get_settings()
_auth = build_auth(_settings)

mcp = FastMCP(
    name="BeeL MCP Server",
    instructions=(
        "Servidor MCP para operar BeeL con guardrails fiscales. "
        "Permite buscar y crear clientes, validar NIF, listar y obtener facturas, "
        "crear y emitir facturas, consultar VeriFactu, enviar por email y exportar datos."
    ),
    auth=_auth,
    lifespan=lifespan,
)


# --- Recurso UI: visor PDF embebido ---
@mcp.resource(
    PDF_VIEWER_URI,
    app=AppConfig(
        csp=ResourceCSP(resource_domains=RESOURCE_DOMAINS),
    ),
)
def pdf_viewer_resource() -> str:
    """HTML del visor de PDF con PDF.js para renderizado en iframe."""
    return get_pdf_viewer_html()


# --- Imports de tools ---
from beel_mcp.tools.customer_tools import (  # noqa: E402
    create_customer,
    search_customers,
    upsert_customer,
)
from beel_mcp.tools.delivery_tools import send_invoice_email  # noqa: E402
from beel_mcp.tools.export_tools import export_invoices_excel  # noqa: E402
from beel_mcp.tools.invoice_tools import (  # noqa: E402
    create_invoice_draft,
    issue_invoice,
    list_invoices,
    update_invoice_draft,
)
from beel_mcp.tools.nif_tools import validate_nif  # noqa: E402
from beel_mcp.tools.payment_tools import mark_invoice_paid  # noqa: E402
from beel_mcp.tools.pdf_tools import (  # noqa: E402
    get_invoice_pdf_download,
    preview_invoice_pdf,
)
from beel_mcp.tools.status_tools import (  # noqa: E402
    get_invoice,
    get_verifactu_status,
)
from beel_mcp.tools.workflow_tools import (  # noqa: E402
    ensure_customer_ready_for_invoicing,
    follow_up_unpaid_invoices,
    issue_send_and_track_invoice,
)


# --- Registro de tools ---
mcp.tool(search_customers)
mcp.tool(create_customer)
mcp.tool(upsert_customer)
mcp.tool(validate_nif)
mcp.tool(list_invoices)
mcp.tool(get_invoice)
mcp.tool(create_invoice_draft)
mcp.tool(update_invoice_draft)
mcp.tool(issue_invoice)
# preview_invoice_pdf se registra con AppConfig para que el host
# sepa que debe cargar el visor PDF cuando esta tool se invoque
mcp.tool(
    preview_invoice_pdf,
    app=AppConfig(resource_uri=PDF_VIEWER_URI),
)
mcp.tool(get_invoice_pdf_download)
mcp.tool(send_invoice_email)
mcp.tool(mark_invoice_paid)
mcp.tool(get_verifactu_status)
mcp.tool(export_invoices_excel)
mcp.tool(ensure_customer_ready_for_invoicing)
mcp.tool(issue_send_and_track_invoice)
mcp.tool(follow_up_unpaid_invoices)


def main() -> None:
    settings = get_settings()
    if settings.oauth_enabled:
        mcp.run(transport="http", host="0.0.0.0", port=8000)
    else:
        mcp.run()


if __name__ == "__main__":
    main()
