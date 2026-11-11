/**
 * Every string the user reads in the BeeL. app, in one place: product copy is
 * changed here, not hunted for across the views. Spanish, because the people
 * who issue Spanish invoices read it.
 *
 * Messages the app hands to Claude on the user's behalf are here too: they are
 * sent as the user's own words, so they are in the user's language.
 */
export const COPY = {
  app: { loading: 'Cargando…', test: 'Test', live: 'Live', open: 'Abrir BeeL.' },
  tabs: { home: 'Inicio', invoices: 'Facturas', customers: 'Clientes' },
  company: { select: 'Empresa' },

  home: {
    ready: (env: string) => `Lista para emitir en ${env}.`,
    blocked: 'Antes de emitir falta:',
    fixWithClaude: 'Resolverlo con Claude',
    quarter: (label: string) => `Trimestre ${label}`,
    taxableBase: 'Base imponible',
    vat: 'IVA repercutido',
    irpf: 'IRPF retenido',
    count: 'Facturas',
    newInvoice: 'Nueva factura',
    unpaid: 'Pendientes de cobro',
    recent: 'Últimas facturas',
  },

  invoices: {
    search: 'Número, cliente o NIF',
    searchAction: 'Buscar',
    filters: {
      all: 'Todas',
      drafts: 'Borradores',
      unpaid: 'Pendientes de cobro',
      paid: 'Cobradas',
    },
    columns: {
      number: 'Factura',
      customer: 'Cliente',
      total: 'Total',
      status: 'Estado',
      verifactu: 'VeriFactu',
    },
    draftNumber: 'Sin número',
    noCustomer: 'Sin cliente',
    empty: 'No hay facturas con este filtro.',
    shown: (shown: number, total: number) => `${shown} de ${total}`,
    exportCsv: 'Descargar CSV',
    csvFile: (date: string) => `facturas-${date}.csv`,
  },

  invoice: {
    back: 'Facturas',
    notFound: 'No se encuentra la factura.',
    issued: (date: string) => `Emisión ${date}`,
    due: (date: string) => `Vence ${date}`,
    columns: {
      concept: 'Concepto',
      quantity: 'Cant.',
      price: 'Precio',
      vat: 'IVA',
      amount: 'Importe',
    },
    taxableBase: 'Base imponible',
    vat: 'IVA',
    irpf: 'IRPF',
    total: 'Total',
    issue: 'Emitir…',
    confirmLive:
      'Live: la factura recibe su número definitivo y se registra en la AEAT. Después no se puede editar ni borrar, solo rectificar.',
    confirmTest: 'Test: la factura se emite con numeración de pruebas y no llega a la AEAT.',
    issueLive: 'Emitir en Live',
    issueTest: 'Emitir en Test',
    cancel: 'Cancelar',
    draftHint: 'Pide los cambios en el chat: Claude sabe qué borrador estás viendo.',
    send: 'Enviar por email',
    resend: 'Reenviar',
    markPaid: 'Marcar cobrada',
    viewPdf: 'Ver PDF',
    downloadPdf: 'Descargar PDF',
    correct: 'Rectificar o anular…',
    aeatHelp: '¿Qué hago?',
    loadingPdf: 'Cargando PDF…',
    working: 'Un momento…',
  },

  customers: {
    search: 'Nombre, NIF o email',
    newCustomer: 'Nuevo cliente',
    empty: 'No hay clientes con esta búsqueda.',
    invoice: 'Facturar',
    theirInvoices: 'Sus facturas',
  },

  status: {
    DRAFT: 'Borrador',
    SCHEDULED: 'Programada',
    ISSUED: 'Emitida',
    SENT: 'Enviada',
    PAID: 'Cobrada',
    OVERDUE: 'Vencida',
    RECTIFIED: 'Rectificada',
    VOIDED: 'Anulada',
    CONVERTED: 'Convertida',
    ACTIVE: 'Activa',
    EXPIRED: 'Caducada',
  } as Record<string, string>,

  /** The invoice page's VeriFactu chip, worded as in the web app. */
  verifactu: {
    name: 'VeriFactu',
    note: {
      ACCEPTED_WITH_ERRORS: 'Por revisar',
      REJECTED: 'Rechazada',
      NOT_SUBMITTED: 'Sin enviar',
    } as Record<string, string>,
    title: {
      ACCEPTED: 'Registrada en la AEAT',
      ACCEPTED_WITH_ERRORS: 'Registrada en la AEAT, con datos por revisar',
      REJECTED: 'Se ha rechazado el registro',
      PENDING: 'Enviando a la AEAT',
      VOIDED: 'Anulada en la AEAT',
      NOT_SUBMITTED: 'Sin enviar a la AEAT',
    } as Record<string, string>,
  },

  /** The web app's VeriFactu labels. */
  aeat: {
    PENDING: 'Pendiente',
    ACCEPTED: 'Aceptado',
    ACCEPTED_WITH_ERRORS: 'Por revisar',
    REJECTED: 'Rechazado',
    VOIDED: 'Anulado',
    NOT_SUBMITTED: 'No enviada',
  } as Record<string, string>,

  done: {
    issuedLive: (n: string) => `Factura ${n} emitida. La AEAT la está procesando.`,
    issuedTest: (n: string) => `Factura ${n} emitida en Test. No llega a la AEAT.`,
    sent: (to: string) => `Enviada a ${to}.`,
    paid: 'Marcada como cobrada con fecha de hoy.',
    downloaded: (file: string) => `Descargado: ${file}`,
    openedPdf: 'PDF abierto en el navegador.',
    toClaude: 'Enviado a Claude. Sigue en el chat.',
  },

  failed: {
    load: 'No se ha podido cargar.',
    issue: 'No se ha podido emitir la factura.',
    send: 'No se ha podido enviar la factura.',
    paid: 'No se ha podido marcar como cobrada.',
    pdf: 'No se ha podido obtener el PDF.',
    noPdf: 'Esta factura todavía no tiene PDF.',
    download: 'La descarga no se ha completado.',
    toClaude: 'Claude no ha recibido el mensaje. Escríbelo en el chat: ya sabe qué estás viendo.',
    noCompany: 'Esta cuenta no tiene ninguna empresa todavía.',
    chatAction: 'La acción del chat ha fallado. Revisa la respuesta de Claude.',
  },

  /** What the buttons ask Claude, in the user's voice. */
  ask: {
    newInvoice: 'Quiero crear una factura nueva.',
    newCustomer: 'Quiero dar de alta un cliente nuevo.',
    fixSetup: (company: string, blockers: string[]) =>
      `Ayúdame a dejar lista la empresa ${company} para emitir. Falta: ${blockers.join('; ')}.`,
    invoiceCustomer: (name: string, id: string) =>
      `Crea un borrador de factura para ${name} (customer_id ${id}). Pregúntame el concepto y el importe.`,
    correct: (number: string, id: string) =>
      `Quiero rectificar o anular la factura ${number} (invoice_id ${id}). Pregúntame qué ha pasado y dime qué corresponde.`,
    aeat: (number: string, id: string, status: string, detail: string) =>
      `La AEAT ha devuelto ${status} en la factura ${number} (invoice_id ${id})${detail ? `: ${detail}` : ''}. Explícame qué pasa y cómo lo corrijo.`,
  },
} as const;
