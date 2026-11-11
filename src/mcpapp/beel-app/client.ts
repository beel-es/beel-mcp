/**
 * The BeeL. app's data layer. The app has no backend of its own: every read and
 * write is one of the server's tools, called through the host, so it runs with
 * the session's credentials and goes through the same validation, guardrails
 * and scopes as a call Claude makes.
 *
 * Tool names are derived from operationIds (BEEL_APP_CALLS) with the same
 * `toolName` the server uses, so they cannot drift from what it exposes.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { toolName } from '../../spec/derive.js';
import { BEEL_APP_CALLS, BEEL_APP_SETUP_TOOL, type InvoicePdfAppData } from '../contract.js';
import type { Customer, FiscalSummary, Invoice, Setup } from './model.js';

/** Calls one server tool; in the app, the host's `callServerTool`. */
export type ToolCaller = (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;

/** A call the server or the API refused. The message is the server's explanation. */
export class ToolError extends Error {
  override name = 'ToolError';
}

const TOOL = Object.fromEntries(
  Object.entries(BEEL_APP_CALLS).map(([key, operationId]) => [key, toolName(operationId)]),
) as Record<keyof typeof BEEL_APP_CALLS, string>;

function firstText(result: CallToolResult): string | undefined {
  for (const block of result.content ?? []) if (block.type === 'text') return block.text;
  return undefined;
}

interface InvoicePage {
  invoices: Invoice[];
  total?: number;
}

interface InvoicePdf extends Partial<InvoicePdfAppData> {
  /** The PDF itself, base64, when the server attached it to the result. */
  base64?: string;
}

export class BeelClient {
  constructor(
    private readonly call: ToolCaller,
    /** A fresh Idempotency-Key per user action; injectable for tests. */
    private readonly newKey: () => string = () => crypto.randomUUID(),
  ) {}

  private async result(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const result = await this.call(name, args);
    if (result.isError) throw new ToolError(firstText(result) ?? `${name} failed`);
    return result;
  }

  /** API tools answer with the payload as JSON in their first text block. */
  private async json<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const text = firstText(await this.result(name, args));
    if (text === undefined) throw new ToolError(`${name} returned no content`);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ToolError(`${name} returned a payload that is not JSON`);
    }
  }

  setup(): Promise<Setup> {
    return this.json(BEEL_APP_SETUP_TOOL, {});
  }

  fiscalSummary(companyId: string, startDate: string, endDate: string): Promise<FiscalSummary> {
    return this.json(TOOL.fiscalSummary, {
      company_id: companyId,
      start_date: startDate,
      end_date: endDate,
    });
  }

  async invoices(
    companyId: string,
    options: { search?: string; status?: readonly string[]; limit: number },
  ): Promise<InvoicePage> {
    const args: Record<string, unknown> = { company_id: companyId, limit: options.limit };
    if (options.search) args.search = options.search;
    if (options.status?.length) args.status = [...options.status];
    const page = await this.json<{ invoices?: Invoice[]; pagination?: { total_items?: number } }>(
      TOOL.listInvoices,
      args,
    );
    return { invoices: page.invoices ?? [], total: page.pagination?.total_items };
  }

  invoice(companyId: string, invoiceId: string): Promise<Invoice> {
    return this.json(TOOL.getInvoice, { company_id: companyId, invoice_id: invoiceId });
  }

  issue(companyId: string, invoiceId: string): Promise<Invoice> {
    return this.json(TOOL.issueInvoice, {
      company_id: companyId,
      invoice_id: invoiceId,
      idempotency_key: this.newKey(),
    });
  }

  /** Sends to the recipient on file; the API rejects an invoice without one. */
  send(companyId: string, invoiceId: string): Promise<{ sent_to?: string[] }> {
    return this.json(TOOL.sendInvoice, {
      company_id: companyId,
      invoice_id: invoiceId,
      idempotency_key: this.newKey(),
    });
  }

  markPaid(companyId: string, invoiceId: string, paymentDate: string): Promise<Invoice> {
    return this.json(TOOL.setInvoiceStatus, {
      company_id: companyId,
      invoice_id: invoiceId,
      body: { status: 'PAID', payment_date: paymentDate },
    });
  }

  /** The PDF tool answers in prose, with the link as structured content and maybe the file. */
  async pdf(companyId: string, invoiceId: string): Promise<InvoicePdf> {
    const result = await this.result(TOOL.invoicePdf, {
      company_id: companyId,
      invoice_id: invoiceId,
    });
    const data = (result.structuredContent ?? {}) as Partial<InvoicePdfAppData>;
    const pdf: InvoicePdf = { download_url: data.download_url, file_name: data.file_name };
    for (const block of result.content ?? []) {
      if (block.type === 'resource' && 'blob' in block.resource) pdf.base64 = block.resource.blob;
    }
    return pdf;
  }

  async customers(
    companyId: string,
    search: string | undefined,
    limit: number,
  ): Promise<Customer[]> {
    const args: Record<string, unknown> = { company_id: companyId, limit };
    if (search) args.search = search;
    const page = await this.json<{ customers?: Customer[] }>(TOOL.listCustomers, args);
    return page.customers ?? [];
  }
}
