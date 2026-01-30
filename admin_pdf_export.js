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
    const headerHTML = `
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
      
      // Generate barcodes for each ticket
      const engineBarcode = entry.ticket_engine_ref ? generateBarcodeSVG(entry.ticket_engine_ref.slice(-12)) : '';
      const tyresBarcode = entry.ticket_tyres_ref ? generateBarcodeSVG(entry.ticket_tyres_ref.slice(-12)) : '';
      const transponderBarcode = entry.ticket_transponder_ref ? generateBarcodeSVG(entry.ticket_transponder_ref.slice(-12)) : '';
      const fuelBarcode = entry.ticket_fuel_ref ? generateBarcodeSVG(entry.ticket_fuel_ref.slice(-12)) : '';
      
      return `
        <tr style="background-color: ${bgColor}; page-break-inside: avoid;">
          <td style="border: 1px solid #dee2e6; padding: 6px 8px; font-weight: 600; color: #1a1a2e; font-size: 9px;">${driverName}</td>
          <td style="border: 1px solid #dee2e6; padding: 6px 8px; text-align: center; font-size: 8px; color: #1a1a2e;">${raceClass}</td>
          <td style="border: 1px solid #dee2e6; padding: 6px 8px; font-family: monospace; font-size: 8px; color: #666;">${entry.driver_email || '-'}</td>
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
            <th style="border: 1px solid #dee2e6; padding: 6px 8px; text-align: left; font-weight: 700; font-size: 8px; text-transform: uppercase; width: 18%;">Driver Name</th>
            <th style="border: 1px solid #dee2e6; padding: 6px 8px; text-align: center; font-weight: 700; font-size: 8px; text-transform: uppercase; width: 10%;">Class</th>
            <th style="border: 1px solid #dee2e6; padding: 6px 8px; text-align: center; font-weight: 700; font-size: 8px; text-transform: uppercase; width: 16%;">Email</th>
            <th style="border: 1px solid #dee2e6; padding: 6px 8px; text-align: center; font-weight: 700; font-size: 8px; text-transform: uppercase; width: 14%;">Engine Ticket</th>
            <th style="border: 1px solid #dee2e6; padding: 6px 8px; text-align: center; font-weight: 700; font-size: 8px; text-transform: uppercase; width: 14%;">Tyres Ticket</th>
            <th style="border: 1px solid #dee2e6; padding: 6px 8px; text-align: center; font-weight: 700; font-size: 8px; text-transform: uppercase; width: 14%;">Transponder Ticket</th>
            <th style="border: 1px solid #dee2e6; padding: 6px 8px; text-align: center; font-weight: 700; font-size: 8px; text-transform: uppercase; width: 14%;">Fuel Ticket</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    `;

    const footerHTML = `
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
