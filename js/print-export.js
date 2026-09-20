/* ==========================================================================
   IB-TECH — print / PDF / image export for generated e-pin batches
   --------------------------------------------------------------------------
   Shared by user-dashboard.html (customer "Print cards") and
   admin-stock.html (admin "generate e-pins"). Works on whatever markup is
   inside the #printableArea container passed to it — it doesn't know or
   care about pins specifically.

   Requires html2canvas + jsPDF to be loaded on the page (CDN <script> tags)
   before this file. Sending to a physical printer uses the browser's own
   print dialog (window.print), scoped to #printableArea via the
   @media print rules in css/style.css — the person picks their printer
   from that native dialog, same as printing any other web page.
   ========================================================================== */
const IBTPrint = (() => {

  function getArea(areaId) {
    const el = document.getElementById(areaId);
    if (!el || !el.querySelector(".print-card")) {
      IBT.toast("Nothing to export yet — generate some e-pins first.", true);
      return null;
    }
    return el;
  }

  // Fills in the batch header (title + timestamp) that's only shown while
  // printing/exporting, so the printed sheet / PDF / image is self-labelled.
  function stampHeader(area, title) {
    let header = area.querySelector(".printable-header");
    if (!header) {
      header = document.createElement("div");
      header.className = "printable-header";
      area.insertBefore(header, area.firstChild);
    }
    header.classList.add("show");
    header.innerHTML = `<b>${IBT.escapeHTML(title)}</b><span>${new Date().toLocaleString("en-NG", { dateStyle: "medium", timeStyle: "short" })}</span>`;
    return header;
  }

  // ---- send to physical printer ----
  function printArea(areaId, title) {
    const area = getArea(areaId);
    if (!area) return;
    const header = stampHeader(area, title);
    window.print();
    // Only needed for on-screen state — the @media print rules already
    // scope what physically appears on paper.
    setTimeout(() => header.classList.remove("show"), 300);
  }

  async function ensureLibs() {
    if (!window.html2canvas || !window.jspdf) {
      IBT.toast("Export tools are still loading — try again in a second.", true);
      return false;
    }
    return true;
  }

  async function renderCanvas(area) {
    area.classList.add("exporting");
    try {
      return await window.html2canvas(area, { scale: 2, backgroundColor: "#ffffff", useCORS: true });
    } finally {
      area.classList.remove("exporting");
    }
  }

  // ---- download as a PDF document ----
  async function downloadPdf(areaId, title, filename) {
    const area = getArea(areaId);
    if (!area) return;
    if (!(await ensureLibs())) return;
    const header = stampHeader(area, title);
    IBT.toast("Preparing PDF…");
    try {
      const canvas = await renderCanvas(area);
      const { jsPDF } = window.jspdf;
      const pdf = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
      const pageW = pdf.internal.pageSize.getWidth();
      const pageH = pdf.internal.pageSize.getHeight();
      const margin = 24;
      const imgW = pageW - margin * 2;
      const usableH = pageH - margin * 2;
      const pxPerPage = Math.floor((usableH * canvas.width) / imgW);

      let y = 0, first = true;
      while (y < canvas.height) {
        const sliceH = Math.min(pxPerPage, canvas.height - y);
        const sliceCanvas = document.createElement("canvas");
        sliceCanvas.width = canvas.width;
        sliceCanvas.height = sliceH;
        sliceCanvas.getContext("2d").drawImage(canvas, 0, y, canvas.width, sliceH, 0, 0, canvas.width, sliceH);
        if (!first) pdf.addPage();
        pdf.addImage(sliceCanvas.toDataURL("image/png"), "PNG", margin, margin, imgW, (sliceH * imgW) / canvas.width);
        y += sliceH;
        first = false;
      }
      pdf.save(`${filename}.pdf`);
      IBT.toast("PDF downloaded.");
    } catch (e) {
      IBT.toast("Couldn't generate the PDF — try again.", true);
    } finally {
      header.classList.remove("show");
    }
  }

  // ---- save as a PNG image ----
  async function saveAsImage(areaId, title, filename) {
    const area = getArea(areaId);
    if (!area) return;
    if (!(await ensureLibs())) return;
    const header = stampHeader(area, title);
    IBT.toast("Preparing image…");
    try {
      const canvas = await renderCanvas(area);
      const a = document.createElement("a");
      a.href = canvas.toDataURL("image/png");
      a.download = `${filename}.png`;
      a.click();
      IBT.toast("Image saved.");
    } catch (e) {
      IBT.toast("Couldn't generate the image — try again.", true);
    } finally {
      header.classList.remove("show");
    }
  }

  return { printArea, downloadPdf, saveAsImage };
})();
