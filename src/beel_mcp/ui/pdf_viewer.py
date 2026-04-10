"""Visor de PDF embebido para MCP Apps.

Usa PDF.js para renderizar el PDF dentro del iframe del cliente MCP.
Recibe el PDF como base64 en structured_content via postMessage.
"""

PDF_VIEWER_URI = "ui://beel/pdf-viewer.html"

# Version pinneada de PDF.js y del SDK de MCP Apps
_PDFJS_VERSION = "4.9.155"
_PDFJS_CDN = f"https://cdnjs.cloudflare.com/ajax/libs/pdf.js/{_PDFJS_VERSION}"
_EXT_APPS_VERSION = "0.4.0"
_EXT_APPS_CDN = f"https://unpkg.com/@modelcontextprotocol/ext-apps@{_EXT_APPS_VERSION}"

# Dominios CDN necesarios para el CSP del iframe
RESOURCE_DOMAINS = [
    "https://unpkg.com",
    "https://cdnjs.cloudflare.com",
]


def get_pdf_viewer_html() -> str:
    """Devuelve el HTML completo del visor PDF."""
    return f"""<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <style>
    * {{ margin: 0; padding: 0; box-sizing: border-box; }}

    body {{
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      background: transparent;
      padding: 12px;
      color: #333;
    }}

    @media (prefers-color-scheme: dark) {{
      body {{ color: #e0e0e0; }}
      .controls {{ background: #1e1e1e; border-color: #444; }}
      .controls button {{ background: #333; color: #e0e0e0; border-color: #555; }}
      .controls button:hover {{ background: #444; }}
      .controls button:disabled {{ background: #2a2a2a; color: #666; }}
      #status {{ color: #aaa; }}
      .canvas-wrapper {{ border-color: #444; }}
    }}

    #status {{
      text-align: center;
      padding: 40px 16px;
      color: #666;
      font-size: 14px;
    }}

    .controls {{
      display: none;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 8px 12px;
      margin-bottom: 12px;
      background: #f8f9fa;
      border: 1px solid #dee2e6;
      border-radius: 8px;
      flex-wrap: wrap;
    }}

    .controls button {{
      padding: 6px 14px;
      border: 1px solid #ced4da;
      border-radius: 6px;
      background: #fff;
      cursor: pointer;
      font-size: 13px;
      transition: background 0.15s;
    }}

    .controls button:hover {{ background: #e9ecef; }}
    .controls button:disabled {{
      opacity: 0.4;
      cursor: not-allowed;
    }}

    .page-info {{
      font-size: 13px;
      font-weight: 500;
      min-width: 100px;
      text-align: center;
    }}

    .zoom-info {{
      font-size: 12px;
      color: #888;
      min-width: 50px;
      text-align: center;
    }}

    .separator {{
      width: 1px;
      height: 20px;
      background: #dee2e6;
      margin: 0 4px;
    }}

    .canvas-wrapper {{
      display: flex;
      justify-content: center;
      align-items: flex-start;
      overflow: auto;
      border: 1px solid #dee2e6;
      border-radius: 8px;
      background: #fff;
      max-height: 70vh;
      padding: 8px;
    }}

    @media (prefers-color-scheme: dark) {{
      .canvas-wrapper {{ background: #2a2a2a; }}
    }}

    #pdfCanvas {{
      display: block;
      flex-shrink: 0;
      height: auto;
      max-width: 100%;
      box-shadow: 0 2px 8px rgba(0,0,0,0.08);
    }}

    .error {{
      color: #dc3545;
      text-align: center;
      padding: 20px;
    }}
  </style>
</head>
<body>
  <div id="status">Cargando PDF...</div>
  <div class="controls" id="controls">
    <button id="prevBtn" title="Pagina anterior">&#9664; Anterior</button>
    <span class="page-info" id="pageInfo"></span>
    <button id="nextBtn" title="Pagina siguiente">Siguiente &#9654;</button>
    <span class="separator"></span>
    <button id="zoomOutBtn" title="Reducir">-</button>
    <span class="zoom-info" id="zoomInfo">100%</span>
    <button id="zoomInBtn" title="Ampliar">+</button>
    <span class="separator"></span>
    <button id="downloadBtn" title="Descargar PDF">&#128190; Descargar</button>
  </div>
  <div class="canvas-wrapper">
    <canvas id="pdfCanvas"></canvas>
  </div>

  <script type="module">
    import {{ App }} from "{_EXT_APPS_CDN}/app-with-deps";

    const app = new App({{ name: "BeeL PDF Viewer", version: "1.0.0" }});

    let pdfDoc = null;
    let currentPage = 1;
    let currentScale = 1.0;
    let baseScale = 1.0;
    let userZoom = 1.0;
    let pdfBase64Raw = null;
    let invoiceId = null;

    const ZOOM_STEP = 0.25;
    const MIN_ZOOM = 0.5;
    const MAX_ZOOM = 3.0;
    // Ancho maximo natural del PDF en px para legibilidad comoda
    // (A4 a ~85dpi, tamano ideal para panel lateral de agente)
    const MAX_NATURAL_WIDTH = 500;

    const canvas = document.getElementById('pdfCanvas');
    const ctx = canvas.getContext('2d');
    const wrapper = document.querySelector('.canvas-wrapper');

    async function calcFitScale(page) {{
      const unscaled = page.getViewport({{ scale: 1.0 }});
      const availableWidth = wrapper.clientWidth - 2;
      // Si el contenedor es mas ancho que MAX_NATURAL_WIDTH, limitamos
      // el ancho objetivo para que el PDF no se renderice gigante.
      const targetWidth = Math.min(availableWidth, MAX_NATURAL_WIDTH);
      return targetWidth / unscaled.width;
    }}

    function updateControls() {{
      document.getElementById('pageInfo').textContent =
        `Pagina ${{currentPage}} de ${{pdfDoc.numPages}}`;
      document.getElementById('prevBtn').disabled = currentPage <= 1;
      document.getElementById('nextBtn').disabled = currentPage >= pdfDoc.numPages;
      document.getElementById('zoomInfo').textContent =
        `${{Math.round(userZoom * 100)}}%`;
      document.getElementById('zoomOutBtn').disabled = userZoom <= MIN_ZOOM;
      document.getElementById('zoomInBtn').disabled = userZoom >= MAX_ZOOM;
    }}

    async function renderPage(num) {{
      currentPage = num;
      const page = await pdfDoc.getPage(num);
      baseScale = await calcFitScale(page);
      currentScale = baseScale * userZoom;
      const viewport = page.getViewport({{ scale: currentScale }});
      canvas.height = viewport.height;
      canvas.width = viewport.width;
      await page.render({{ canvasContext: ctx, viewport }}).promise;
      updateControls();
    }}

    function showError(msg) {{
      document.getElementById('status').innerHTML =
        `<div class="error">${{msg}}</div>`;
    }}

    // --- Event handlers ---

    document.getElementById('prevBtn').addEventListener('click', () => {{
      if (currentPage > 1) renderPage(currentPage - 1);
    }});

    document.getElementById('nextBtn').addEventListener('click', () => {{
      if (pdfDoc && currentPage < pdfDoc.numPages) renderPage(currentPage + 1);
    }});

    document.getElementById('zoomInBtn').addEventListener('click', () => {{
      if (userZoom < MAX_ZOOM) {{
        userZoom = Math.min(userZoom + ZOOM_STEP, MAX_ZOOM);
        renderPage(currentPage);
      }}
    }});

    document.getElementById('zoomOutBtn').addEventListener('click', () => {{
      if (userZoom > MIN_ZOOM) {{
        userZoom = Math.max(userZoom - ZOOM_STEP, MIN_ZOOM);
        renderPage(currentPage);
      }}
    }});

    // Re-render si cambia el tamano del panel (debounced)
    let resizeTimer = null;
    window.addEventListener('resize', () => {{
      if (!pdfDoc) return;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => renderPage(currentPage), 150);
    }});

    document.getElementById('downloadBtn').addEventListener('click', () => {{
      if (!pdfBase64Raw) return;
      const link = document.createElement('a');
      link.href = `data:application/pdf;base64,${{pdfBase64Raw}}`;
      link.download = invoiceId
        ? `factura-preview-${{invoiceId}}.pdf`
        : 'factura-preview.pdf';
      link.click();
    }});

    // --- MCP Apps bridge ---

    app.ontoolresult = async ({{ structuredContent }}) => {{
      if (!structuredContent?.pdf_base64) {{
        showError('No se recibio contenido PDF.');
        return;
      }}

      try {{
        pdfBase64Raw = structuredContent.pdf_base64;
        invoiceId = structuredContent.invoice_id || null;

        // Decode base64 to Uint8Array
        const raw = atob(pdfBase64Raw);
        const uint8 = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) uint8[i] = raw.charCodeAt(i);

        // Load PDF.js from CDN
        const pdfjsLib = await import('{_PDFJS_CDN}/pdf.min.mjs');
        pdfjsLib.GlobalWorkerOptions.workerSrc =
          '{_PDFJS_CDN}/pdf.worker.min.mjs';

        pdfDoc = await pdfjsLib.getDocument({{ data: uint8 }}).promise;

        document.getElementById('status').style.display = 'none';
        document.getElementById('controls').style.display = 'flex';
        await renderPage(1);
      }} catch (err) {{
        showError(`Error al renderizar el PDF: ${{err.message}}`);
        console.error(err);
      }}
    }};

    await app.connect();
  </script>
</body>
</html>"""
