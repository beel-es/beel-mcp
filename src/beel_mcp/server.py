from __future__ import annotations

from contextlib import asynccontextmanager

from fastmcp import FastMCP

from beel_mcp.client.beel_client import BeelClient
from beel_mcp.config import get_settings
from beel_mcp.services.customer_service import CustomerService
from beel_mcp.services.delivery_service import DeliveryService
from beel_mcp.services.export_service import ExportService
from beel_mcp.services.invoice_service import InvoiceService
from beel_mcp.services.nif_service import NifService
from beel_mcp.services.pdf_service import PdfService
from beel_mcp.services.verifactu_service import VerifactuService


@asynccontextmanager
async def lifespan(_: FastMCP):
    settings = get_settings()
    beel_client = BeelClient(settings)
    try:
        yield {
            "settings": settings,
            "beel_client": beel_client,
            "customer_service": CustomerService(beel_client),
            "nif_service": NifService(beel_client),
            "invoice_service": InvoiceService(beel_client),
            "pdf_service": PdfService(beel_client),
            "delivery_service": DeliveryService(beel_client),
            "verifactu_service": VerifactuService(beel_client),
            "export_service": ExportService(beel_client),
        }
    finally:
        await beel_client.close()


mcp = FastMCP(
    name="BeeL MCP Server",
    instructions=(
        "Servidor MCP para operar BeeL con guardrails fiscales. "
        "Permite buscar y crear clientes, validar NIF, crear y emitir facturas, "
        "consultar VeriFactu, enviar por email y exportar datos."
    ),
    lifespan=lifespan,
)


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
    update_invoice_draft,
)
from beel_mcp.tools.nif_tools import validate_nif  # noqa: E402
from beel_mcp.tools.payment_tools import mark_invoice_paid  # noqa: E402
from beel_mcp.tools.pdf_tools import (  # noqa: E402
    get_invoice_pdf_download,
    preview_invoice_pdf,
)
from beel_mcp.tools.status_tools import (  # noqa: E402
    get_invoice_status,
    get_verifactu_status,
)
from beel_mcp.tools.workflow_tools import (  # noqa: E402
    ensure_customer_ready_for_invoicing,
    follow_up_unpaid_invoices,
    issue_send_and_track_invoice,
)


mcp.tool(search_customers)
mcp.tool(create_customer)
mcp.tool(upsert_customer)
mcp.tool(validate_nif)
mcp.tool(create_invoice_draft)
mcp.tool(update_invoice_draft)
mcp.tool(issue_invoice)
mcp.tool(preview_invoice_pdf)
mcp.tool(get_invoice_pdf_download)
mcp.tool(send_invoice_email)
mcp.tool(mark_invoice_paid)
mcp.tool(get_invoice_status)
mcp.tool(get_verifactu_status)
mcp.tool(export_invoices_excel)
mcp.tool(ensure_customer_ready_for_invoicing)
mcp.tool(issue_send_and_track_invoice)
mcp.tool(follow_up_unpaid_invoices)


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
