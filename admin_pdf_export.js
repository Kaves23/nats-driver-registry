// Admin PDF Export with Barcodes
// This file contains the PDF export function with barcode generation for race entries

async function exportRaceEntriesPDF() {
  try {
    const race = document.getElementById('filterRace').value;
    if (!race) {
      showToast('Please select a race', 'info');
      return;
    }

    showToast('Preparing PDF export with barcodes...', 'info');

    // Try to load event branding (header / footer images)
    let headerBrandingUrl = null;
    let footerBrandingUrl = null;
    try {
      const brandingRes = await fetch(`/api/admin/events/${race}/docs`, {
        headers: { 'x-admin-token': adminToken }
      });
      if (brandingRes.ok) {
        const brandingData = await brandingRes.json();
        if (brandingData.success) {
          for (const doc of (brandingData.docs || [])) {
            if (doc.folder !== 'branding') continue;
            const base = doc.filename.replace(/\.[^.]+$/, '').toLowerCase();
            if (base === 'header') headerBrandingUrl = doc.url + '?t=' + Date.now();
            if (base === 'footer') footerBrandingUrl = doc.url + '?t=' + Date.now();
          }
        }
      }
    } catch(e) { /* fall back to default branding */ }

    // Fetch race entries data
    const response = await fetch('/api/getRaceEntries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId: race })
    });

    if (!response.ok) throw new Error('Failed to load race entries');
    
    const result = await response.json();
    const entries = result.data || [];

    if (entries.length === 0) {
      showToast('No entries found for this race', 'info');
      return;
    }

    // Code 39 barcode generator
    const CODE39_PATTERNS = {
      "0":"nnnwwnwnn","1":"wnnwnnnnw","2":"nnwwnnnnw","3":"wnwwnnnnn","4":"nnnwwnnnw",
      "5":"wnnwwnnnn","6":"nnwwwnnnn","7":"nnnwnnwnw","8":"wnnwnnwnn","9":"nnwwnnwnn",
      "A":"wnnnnwnnw","B":"nnwnnwnnw","C":"wnwnnwnnn","D":"nnnnwwnnw","E":"wnnnwwnnn",
      "F":"nnwnwwnnn","G":"nnnnnwwnw","H":"wnnnnwwnn","I":"nnwnnwwnn","J":"nnnnwwwnn",
      "K":"wnnnnnnww","L":"nnwnnnnww","M":"wnwnnnnwn","N":"nnnnwnnww","O":"wnnnwnnwn",
      "P":"nnwnwnnwn","Q":"nnnnnnwww","R":"wnnnnnwwn","S":"nnwnnnwwn","T":"nnnnwnwwn",
      "U":"wwnnnnnnw","V":"nwwnnnnnw","W":"wwwnnnnnn","X":"nwnnwnnnw","Y":"wwnnwnnnn",
      "Z":"nwwnwnnnn","-":"nwnnnnwnw",".":"wwnnnnwnn"," ":"nwwnnnwnn","*":"nwnnwnwnn"
    };

    const generateBarcodeSVG = (text) => {
      if (!text) return '';
      const narrow = 1.5, wide = 3.5, height = 28, gap = 1.5;
      const safeText = text.toUpperCase().replace(/[^0-9A-Z]/g, '');
      const value = `*${safeText}*`;
      let bars = '', x = 5;
      for (const ch of value) {
        const pattern = CODE39_PATTERNS[ch] || CODE39_PATTERNS['-'];
        for (let i = 0; i < pattern.length; i++) {
          const isBar = i % 2 === 0;
          const w = pattern[i] === 'w' ? wide : narrow;
          if (isBar) bars += `<rect x="${x}" y="4" width="${w}" height="${height}" fill="#000"/>`;
          x += w;
        }
        x += gap;
      }
      const totalWidth = x + 5, totalHeight = height + 18;
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalWidth} ${totalHeight}" style="width:100%;height:auto;"><rect x="0" y="0" width="${totalWidth}" height="${totalHeight}" fill="#fff" rx="2"/>${bars}<text x="${totalWidth/2}" y="${height + 14}" text-anchor="middle" font-family="Courier New,monospace" font-size="8" font-weight="bold" fill="#000">${safeText}</text></svg>`;
    };

    // Create PDF container
    const element = document.createElement('div');
    element.style.padding = '0';
    element.style.backgroundColor = 'white';
    element.style.fontFamily = 'Arial, sans-serif';
    element.style.fontSize = '8px';
    element.style.lineHeight = '1.2';

    // Header
    const headerHTML = headerBrandingUrl
      ? `<div style="margin-bottom:8px;">
          <img src="${headerBrandingUrl}" style="width:100%;max-height:110px;object-fit:contain;display:block;" crossorigin="anonymous">
          <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-top:6px;padding-bottom:6px;border-bottom:1px solid #eee;">
            <div>
              <div style="font-size:16px;font-weight:700;color:#059669;">RACE ENTRIES WITH BARCODES</div>
              <div style="font-size:9px;color:#666;margin-top:2px;">${race}</div>
            </div>
            <div style="text-align:right;font-size:8px;color:#666;">
              <div><strong>Issued:</strong> ${new Date().toLocaleDateString('en-ZA')} ${new Date().toLocaleTimeString('en-ZA', {hour:'2-digit',minute:'2-digit'})}</div>
              <div><strong>Total Entries:</strong> ${entries.length}</div>
            </div>
          </div>
        </div>`
      : `
      <div style="margin-bottom: 8px;">
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 3px solid #059669;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <div style="background: linear-gradient(135deg, #059669 0%, #047857 100%); color: white; padding: 6px 12px; border-radius: 3px;">
              <span style="font-size: 20px; font-weight: 900; letter-spacing: -1px;">ROK</span>
              <span style="font-size: 12px; font-weight: 600; margin-left: 2px;">CUP</span>
            </div>
            <div style="font-size: 8px; color: #666; text-transform: uppercase; letter-spacing: 1px;">Race Entries</div>
          </div>
          <div style="text-align: right; min-width: 80px;">
            <div style="font-size: 18px; font-weight: 800; color: #059669; letter-spacing: 2px;">NATS</div>
            <div style="font-size: 7px; color: #666; text-transform: uppercase;">Admin Export</div>
          </div>
        </div>
        <div style="display: flex; justify-content: space-between; align-items: flex-end; margin-top: 6px; padding-bottom: 6px; border-bottom: 1px solid #eee;">
          <div>
            <div style="font-size: 16px; font-weight: 700; color: #059669;">RACE ENTRIES WITH BARCODES</div>
            <div style="font-size: 9px; color: #666; margin-top: 2px;">${race}</div>
          </div>
          <div style="text-align: right; font-size: 8px; color: #666;">
            <div><strong>Issued:</strong> ${new Date().toLocaleDateString('en-ZA')} ${new Date().toLocaleTimeString('en-ZA', {hour: '2-digit', minute: '2-digit'})}</div>
            <div><strong>Total Entries:</strong> ${entries.length}</div>
          </div>
        </div>
      </div>
    `;

    // Generate table rows
    const rows = entries.map((entry, idx) => {
      const driverName = `${entry.driver_first_name || ''} ${entry.driver_last_name || ''}`.trim();
      const raceNumber = entry.race_number || '?';
      const raceClass = entry.race_class || entry.driver_class || '-';
      const bgColor = idx % 2 === 0 ? '#ffffff' : '#f8f9fa';
      
      // Parse items to check what was purchased
      const itemsArray = entry.entry_items ? JSON.parse(typeof entry.entry_items === 'string' ? entry.entry_items : JSON.stringify(entry.entry_items)) : [];
      const itemContains = (searchText) => itemsArray.some(i => {
        const itemName = typeof i === 'string' ? i : (i.name || '');
        return itemName.toLowerCase().includes(searchText.toLowerCase());
      });
      
      const hasEngine = itemContains('engine') || entry.engine === 1 || entry.engine === '1';
      const hasTyres = itemContains('tyre');
      const hasTransponder = itemContains('transponder');
      const hasFuel = itemContains('fuel');
      
      // Generate barcode for race number
      const raceNumberBarcode = raceNumber && raceNumber !== '?' ? generateBarcodeSVG(raceNumber) : '';
      
      // Generate barcodes for each ticket
      const engineBarcode = entry.ticket_engine_ref ? generateBarcodeSVG(entry.ticket_engine_ref.slice(-12)) : '';
      const tyresBarcode = entry.ticket_tyres_ref ? generateBarcodeSVG(entry.ticket_tyres_ref.slice(-12)) : '';
      const transponderBarcode = entry.ticket_transponder_ref ? generateBarcodeSVG(entry.ticket_transponder_ref.slice(-12)) : '';
      const fuelBarcode = entry.ticket_fuel_ref ? generateBarcodeSVG(entry.ticket_fuel_ref.slice(-12)) : '';
      
      return `
        <tr style="background-color: ${bgColor}; page-break-inside: avoid;">
          <td style="border: 1px solid #dee2e6; padding: 3px; text-align: center;">${raceNumberBarcode ? raceNumberBarcode : `<span style="color: #059669; font-weight: 700; font-size: 11px;">#${raceNumber}</span>`}</td>
          <td style="border: 1px solid #dee2e6; padding: 6px 8px; font-weight: 600; color: #1a1a2e; font-size: 9px;">${driverName}</td>
          <td style="border: 1px solid #dee2e6; padding: 6px 8px; text-align: center; font-size: 8px; color: #1a1a2e;">${raceClass}</td>
          <td style="border: 1px solid #dee2e6; padding: 3px; text-align: center;">${hasEngine && engineBarcode ? engineBarcode : '<span style="color: #999; font-size: 7px;">-</span>'}</td>
          <td style="border: 1px solid #dee2e6; padding: 3px; text-align: center;">${hasTyres && tyresBarcode ? tyresBarcode : '<span style="color: #999; font-size: 7px;">-</span>'}</td>
          <td style="border: 1px solid #dee2e6; padding: 3px; text-align: center;">${hasTransponder && transponderBarcode ? transponderBarcode : '<span style="color: #999; font-size: 7px;">-</span>'}</td>
          <td style="border: 1px solid #dee2e6; padding: 3px; text-align: center;">${hasFuel && fuelBarcode ? fuelBarcode : '<span style="color: #999; font-size: 7px;">-</span>'}</td>
        </tr>
      `;
    }).join('');

    const tableHTML = `
      <table style="width: 100%; border-collapse: collapse; font-size: 8px;">
        <thead>
          <tr style="background: linear-gradient(180deg, #059669 0%, #047857 100%); color: white;">
            <th style="border: 1px solid #dee2e6; padding: 6px 8px; text-align: center; font-weight: 700; font-size: 8px; text-transform: uppercase; width: 11%;">Race #</th>
            <th style="border: 1px solid #dee2e6; padding: 6px 8px; text-align: left; font-weight: 700; font-size: 8px; text-transform: uppercase; width: 17%;">Driver Name</th>
            <th style="border: 1px solid #dee2e6; padding: 6px 8px; text-align: center; font-weight: 700; font-size: 8px; text-transform: uppercase; width: 10%;">Class</th>
            <th style="border: 1px solid #dee2e6; padding: 6px 8px; text-align: center; font-weight: 700; font-size: 8px; text-transform: uppercase; width: 15.5%;">Engine Ticket</th>
            <th style="border: 1px solid #dee2e6; padding: 6px 8px; text-align: center; font-weight: 700; font-size: 8px; text-transform: uppercase; width: 15.5%;">Tyres Ticket</th>
            <th style="border: 1px solid #dee2e6; padding: 6px 8px; text-align: center; font-weight: 700; font-size: 8px; text-transform: uppercase; width: 15.5%;">Transponder</th>
            <th style="border: 1px solid #dee2e6; padding: 6px 8px; text-align: center; font-weight: 700; font-size: 8px; text-transform: uppercase; width: 15.5%;">Fuel Ticket</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    `;

    const footerHTML = footerBrandingUrl
      ? `<div style="margin-top:10px;text-align:center;"><img src="${footerBrandingUrl}" style="width:100%;max-height:70px;object-fit:contain;" crossorigin="anonymous"></div>`
      : `
      <div style="margin-top: 10px; padding: 8px; background: #f8f9fa; border-left: 3px solid #059669;">
        <div style="display: flex; justify-content: space-between; align-items: center; font-size: 7px; color: #666;">
          <div>ROK Cup NATS • www.rokthenats.co.za • Internal Use Only</div>
          <div>Scan barcodes to validate tickets</div>
        </div>
      </div>
    `;

    element.innerHTML = headerHTML + tableHTML + footerHTML;

    // Generate PDF in landscape
    const opt = {
      margin: [6, 6, 6, 6],
      filename: `${race.replace(/[^a-zA-Z0-9]/g, '_')}_Race_Entries_Barcodes_${new Date().toISOString().slice(0,10)}.pdf`,
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true },
      jsPDF: { orientation: 'landscape', unit: 'mm', format: 'a4' }
    };

    html2pdf().set(opt).from(element).save();
    showToast('PDF with barcodes exported successfully!', 'success');
  } catch (err) {
    console.error('exportRaceEntriesPDF error:', err);
    showToast('Error generating PDF: ' + err.message, 'error');
  }
}

async function exportTyreCollectionList() {
  const race = document.getElementById('filterRace').value;
  if (!race) { showToast('Please select a race first', 'info'); return; }

  showToast('Building tyre collection list...', 'info');

  try {
    const response = await fetch('/api/getRaceEntries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken },
      body: JSON.stringify({ eventId: race })
    });
    if (!response.ok) throw new Error('Failed to load race entries');
    const result = await response.json();
    const allEntries = result.data?.entries || result.data || [];

    // Filter out cancelled / incomplete entries
    const entries = allEntries.filter(e => {
      const st = (e.status || '').toLowerCase();
      return st !== 'cancelled' && st !== 'incomplete' && st !== 'pending_payment';
    });

    if (entries.length === 0) { showToast('No active entries found for this race', 'info'); return; }

    // Parse each entry's tyre purchases
    const parsed = entries.map(e => {
      const raw = e.entry_items;
      let items = [];
      try { items = Array.isArray(raw) ? raw : JSON.parse(raw || '[]'); } catch(_) { items = []; }
      const ic = txt => items.some(i => (typeof i === 'string' ? i : (i.name || '')).toLowerCase().includes(txt.toLowerCase()));
      const hasRaceTyres = ic('race tyre') || ic('tyre') && !ic('practice') && !ic('wet');
      const hasWets = ic('wet');
      const hasPrac = ic('practice');
      let pracQty = 1;
      if (hasPrac) {
        const pracItem = items.find(i => (typeof i === 'string' ? i : (i.name || '')).toLowerCase().includes('practice'));
        const pracStr = typeof pracItem === 'string' ? pracItem : (pracItem ? pracItem.name || '' : '');
        const m = pracStr.match(/[×x](\d+)/i) || pracStr.match(/(\d+)\s*set/i);
        if (m) pracQty = Math.max(1, parseInt(m[1], 10) || 1);
      }
      const cls = (e.race_class || e.driver_class || '').toUpperCase().trim();
      const raceNum = parseInt(e.race_number, 10) || 9999;
      return { e, cls, raceNum, hasRaceTyres, hasWets, hasPrac, pracQty };
    });

    // Group by class category
    const mini = parsed.filter(r => r.cls.includes('MINI'));
    const cadet = parsed.filter(r => r.cls.includes('CADET'));
    const senior = parsed.filter(r => !r.cls.includes('MINI') && !r.cls.includes('CADET'));

    const sortGroup = arr => arr.sort((a, b) => a.cls.localeCompare(b.cls) || a.raceNum - b.raceNum);
    sortGroup(mini); sortGroup(cadet); sortGroup(senior);

    const CB = `<span style="display:inline-block;width:15px;height:15px;border:1.5px solid #000;vertical-align:middle;margin:0 1px;"></span>`;
    const DASH = `<span style="color:#bbb;">—</span>`;

    const buildRows = (arr) => arr.map((r, idx) => {
      const driverName = `${r.e.driver_first_name || ''} ${r.e.driver_last_name || ''}`.trim() || r.e.driver_name || '—';
      const ticketRef = r.e.ticket_tyres_ref || '<span style="color:#ccc;font-size:9px;">—</span>';
      const wets = r.hasWets ? CB : DASH;
      const pracBoxes = r.hasPrac ? Array.from({ length: Math.max(1, r.pracQty) }, () => CB).join('') : DASH;
      const prac = r.hasPrac ? `<div style="display:flex;justify-content:center;gap:2px;flex-wrap:wrap;">${pracBoxes}</div>` : DASH;
      const bg = idx % 2 === 0 ? '#fff' : '#f7f7f7';
      return `<tr style="background:${bg};">
        <td style="${TD}text-align:center;width:28px;">${idx + 1}</td>
        <td style="${TD}text-align:center;font-weight:700;width:44px;">${r.e.race_number || '?'}</td>
        <td style="${TD}font-weight:600;">${driverName}</td>
        <td style="${TD}text-align:center;font-size:9px;">${r.e.race_class || r.e.driver_class || '—'}</td>
        <td style="${TD}text-align:center;font-family:monospace;font-size:9px;">${ticketRef}</td>
        <td style="${TD}text-align:center;">${r.hasRaceTyres ? CB : DASH}</td>
        <td style="${TD}text-align:center;">${r.hasRaceTyres ? CB : DASH}</td>
        <td style="${TD}text-align:center;">${wets}</td>
        <td style="${TD}text-align:center;">${prac}</td>
      </tr>`;
    }).join('');

    const THEAD_TH = `border:1px solid #000;padding:5px 6px;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;`;
    const TD = `border:1px solid #ccc;padding:5px 6px;font-size:10px;`;
    const GRP_HDR = (label, count) => `<tr>
      <td colspan="9" style="background:#000;color:#fff;font-weight:800;font-size:11px;letter-spacing:1px;padding:6px 10px;text-transform:uppercase;border:1px solid #000;">
        ${label} &nbsp;<span style="font-weight:400;font-size:9px;opacity:0.7;">(${count} ${count === 1 ? 'entry' : 'entries'})</span>
      </td></tr>`;

    const tableHead = `<thead><tr style="background:#1e293b;color:#fff;">
      <th style="${THEAD_TH}width:28px;">#</th>
      <th style="${THEAD_TH}width:44px;">Race No</th>
      <th style="${THEAD_TH}">Driver Name</th>
      <th style="${THEAD_TH}width:90px;">Class</th>
      <th style="${THEAD_TH}width:90px;">Tyre Ticket</th>
      <th style="${THEAD_TH}width:62px;">Race Tyres SAT</th>
      <th style="${THEAD_TH}width:62px;">Race Tyres SUN</th>
      <th style="${THEAD_TH}width:54px;">Wet Tyres</th>
      <th style="${THEAD_TH}width:72px;">Practice Tyres</th>
    </tr></thead>`;

    let tbody = '<tbody>';
    if (mini.length)   { tbody += GRP_HDR('Mini ROK Classes', mini.length)   + buildRows(mini); }
    if (cadet.length)  { tbody += GRP_HDR('Cadet Classes', cadet.length)  + buildRows(cadet); }
    if (senior.length) { tbody += GRP_HDR('Senior / OK Classes', senior.length) + buildRows(senior); }
    tbody += '</tbody>';

    const dateStr = new Date().toLocaleDateString('en-ZA', {weekday:'short',year:'numeric',month:'long',day:'numeric'});
    const timeStr = new Date().toLocaleTimeString('en-ZA', {hour:'2-digit',minute:'2-digit'});
    const totalActive = entries.length;

    const html = `<!DOCTYPE html><html lang="en"><head>
      <meta charset="UTF-8">
      <title>Tyre Collection List — ${race}</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: Arial, sans-serif; color: #000; background: #fff; padding: 16px 20px; }
        @page { size: A4 portrait; margin: 14mm 12mm 14mm 12mm; }
        @media print {
          body { padding: 0; }
          .no-print { display: none !important; }
          table { page-break-inside: auto; }
          tr { page-break-inside: avoid; }
        }
        table { width: 100%; border-collapse: collapse; }
        .print-btn { position:fixed; bottom:20px; right:20px; padding:10px 22px;
          background:#1e293b; color:#fff; border:none; border-radius:4px;
          font-size:13px; font-weight:700; cursor:pointer; box-shadow:0 2px 8px rgba(0,0,0,0.3); }
        .print-btn:hover { background:#334155; }
      </style>
    </head><body>
      <!-- HEADER -->
      <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #000;padding-bottom:10px;margin-bottom:10px;">
        <div style="display:flex;align-items:center;gap:14px;">
          <img src="/icons/rok-logo-original.png" alt="ROK" style="height:56px;object-fit:contain;" onerror="this.style.display='none'">
          <div>
            <div style="font-size:20px;font-weight:900;letter-spacing:1px;text-transform:uppercase;">Tyre Collection List</div>
            <div style="font-size:11px;font-weight:600;margin-top:2px;color:#444;">${race}</div>
          </div>
        </div>
        <div style="text-align:right;font-size:9px;color:#555;line-height:1.6;">
          <div><strong>Generated:</strong> ${dateStr} ${timeStr}</div>
          <div><strong>Total Entries:</strong> ${totalActive}</div>
          <div style="margin-top:4px;font-size:8px;border:1px solid #999;padding:2px 6px;border-radius:2px;">OFFICIAL USE ONLY</div>
        </div>
      </div>
      <!-- INSTRUCTION -->
      <div style="font-size:9px;border:1px solid #000;padding:5px 10px;margin-bottom:10px;background:#f5f5f5;">
        <strong>TYRE MARSHAL:</strong> Tick each box as tyres are handed out. Driver must present tyre ticket ref before collection. Race Tyres: 2 sets (Saturday + Sunday). Wet Tyres &amp; Practice Tyres: collected at entry.
      </div>
      <!-- TABLE -->
      <table>${tableHead}${tbody}</table>
      <!-- FOOTER -->
      <div style="margin-top:14px;border-top:1.5px solid #000;padding-top:6px;display:flex;justify-content:space-between;align-items:center;font-size:8px;color:#555;">
        <div>ROK Cup NATS &bull; www.rokthenats.co.za &bull; Tyre Marshal Sign-Off Sheet</div>
        <div>&#9632; = item purchased &nbsp;&nbsp; &mdash; = not purchased</div>
      </div>
      <button class="print-btn no-print" onclick="window.print()">&#128424; Print</button>
    </body></html>`;

    const win = window.open('', '_blank');
    win.document.write(html);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 800);
    showToast('Tyre collection list opened', 'success');
  } catch (err) {
    console.error('exportTyreCollectionList error:', err);
    showToast('Error building tyre list: ' + err.message, 'error');
  }
}
