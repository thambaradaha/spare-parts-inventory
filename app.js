// ---------------------------------------------------------------------------
// Supabase client
// ---------------------------------------------------------------------------
const supabaseClient = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

let currentTab = 'parts';
let paretoChartInstance = null;
let html5QrcodeScanner = null;
let lastStockCheckResults = [];
let currentInventoryData = [];
let inventoryCurrentPage = 1;
const INVENTORY_PAGE_SIZE = 100;

document.addEventListener('DOMContentLoaded', () => {
    loadMachinesDropdown();
    loadAllData();
});

function switchTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    document.getElementById('tab-' + tabId).classList.add('active');
    event.target.classList.add('active');
    currentTab = tabId;
    loadAllData();
}

async function loadAllData() {
    loadStats();
    if (currentTab === 'parts') loadInventory();
    if (currentTab === 'low-stock') loadLowStock();
    if (currentTab === 'breakdowns') loadBreakdowns();
    if (currentTab === 'failure-frequency') loadFailureFrequency();
    if (currentTab === 'machines') loadMachinesTable();
    if (currentTab === 'manuals') loadManuals();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// --- Core Progress UI ---
function showProgress(title, text) {
    document.getElementById('global-progress-title').innerText = title;
    document.getElementById('global-progress-text').innerText = text;
    document.getElementById('global-progress-fill').style.width = '0%';
    document.getElementById('global-progress-overlay').style.display = 'flex';
}

function updateProgress(percent, text) {
    if (text) document.getElementById('global-progress-text').innerText = text;
    document.getElementById('global-progress-fill').style.width = Math.min(100, Math.max(0, percent)) + '%';
}

function hideProgress() {
    document.getElementById('global-progress-overlay').style.display = 'none';
}

// --- Core Pagination Helper ---
async function fetchAllPages(query, pageSize = 1000) {
    let allData = [];
    let page = 0;
    let hasMore = true;

    while (hasMore) {
        const { data, error } = await query.range(page * pageSize, (page + 1) * pageSize - 1);
        if (error) throw error;
        allData.push(...data);
        if (data.length < pageSize) hasMore = false;
        else page++;
    }
    return allData;
}

async function processInBatchesAsync(items, batchSize, processFn, onProgress) {
    let processed = 0;
    let failed = 0;
    for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        const results = await Promise.all(batch.map(processFn));
        failed += results.filter(r => r && r.error).length;
        processed += batch.length;
        if (onProgress) onProgress(processed, items.length);
    }
    return { processed, failed };
}

async function scopedPartIds(machineId) {
    if (!machineId || machineId === 'all' || machineId === '0') return null;

    const { data: assemblies, error: e1 } = await supabaseClient
        .from('assemblies').select('id').eq('machine_id', machineId);
    if (e1) { console.error(e1); return []; }
    const assemblyIds = assemblies.map(a => a.id);
    if (assemblyIds.length === 0) return [];

    const { data: apRows, error: e2 } = await supabaseClient
        .from('assembly_parts').select('part_id').in('assembly_id', assemblyIds);
    if (e2) { console.error(e2); return []; }
    return [...new Set(apRows.map(r => r.part_id))];
}

async function fetchScopedParts(machineId, selectCols = '*') {
    const partIds = await scopedPartIds(machineId);
    let query = supabaseClient.from('parts').select(selectCols);
    if (partIds !== null) {
        if (partIds.length === 0) return [];
        query = query.in('id', partIds);
    }
    return await fetchAllPages(query);
}

function normalizeCode(code) {
    return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function similarityRatio(a, b) {
    const m = a.length, n = b.length;
    if (m === 0 || n === 0) return 0;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
    }
    return (2 * dp[m][n]) / (m + n);
}

function findMatchInDescriptions(code, parts) {
    const normCode = normalizeCode(code);
    if (normCode.length < 5) return null;
    let best = null;
    for (const p of parts) {
        if (!p.description) continue;
        const normDesc = normalizeCode(p.description);
        if (normDesc.includes(normCode)) {
            if (!best || p.description.length < best.description.length) best = p;
        }
    }
    return best;
}

function getCloseMatches(target, candidates, n = 3, cutoff = 0.6) {
    return candidates
        .map(c => ({ code: c, score: similarityRatio(target, c) }))
        .filter(x => x.score >= cutoff)
        .sort((a, b) => b.score - a.score)
        .slice(0, n);
}

function normalizeText(text) {
    return (text || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function getCloseDescriptionMatches(targetDescription, parts, n = 3, cutoff = 0.5) {
    const normTarget = normalizeText(targetDescription);
    if (!normTarget) return [];
    return parts
        .filter(p => p.description)
        .map(p => ({ part: p, score: similarityRatio(normTarget, normalizeText(p.description)) }))
        .filter(x => x.score >= cutoff)
        .sort((a, b) => b.score - a.score)
        .slice(0, n);
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------
async function loadStats() {
    const machineId = document.getElementById('global-machine-select').value;
    const parts = await fetchScopedParts(machineId, 'stock_qty, reorder_level');
    const totalParts = parts.length;
    const lowStock = parts.filter(p => (p.stock_qty || 0) <= (p.reorder_level || 0)).length;

    const { count: totalMachines } = await supabaseClient.from('machines').select('id', { count: 'exact', head: true });

    let bdQuery = supabaseClient.from('breakdowns').select('id', { count: 'exact', head: true }).is('resolved_at', null);
    if (machineId && machineId !== 'all' && machineId !== '0') bdQuery = bdQuery.eq('machine_id', machineId);
    const { count: openBreakdowns } = await bdQuery;

    document.getElementById('stat-total').innerText = totalParts;
    document.getElementById('stat-low').innerText = lowStock;
    document.getElementById('stat-machines').innerText = totalMachines || 0;
    document.getElementById('stat-breakdowns').innerText = openBreakdowns || 0;
}

// ---------------------------------------------------------------------------
// Machines dropdown (shared across tabs)
// ---------------------------------------------------------------------------
async function loadMachinesDropdown() {
    const { data, error } = await supabaseClient.from('machines').select('*').order('name');
    const machines = error ? [] : data;

    const selects = [
        document.getElementById('global-machine-select'),
        document.getElementById('bd-machine'),
        document.getElementById('manual-machine')
    ];
    selects.forEach(sel => {
        if (!sel) return;
        const currentVal = sel.value;
        sel.innerHTML = sel.id === 'global-machine-select'
            ? '<option value="all">All machines</option>'
            : '<option value="">Select Machine...</option>';
        machines.forEach(m => {
            sel.innerHTML += `<option value="${m.id}">${m.name} ${m.model ? '(' + m.model + ')' : ''}</option>`;
        });
        if (currentVal) sel.value = currentVal;
    });
}

// ---------------------------------------------------------------------------
// Parts / Inventory
// ---------------------------------------------------------------------------
async function loadInventory() {
    const machineId = document.getElementById('global-machine-select').value;
    const q = document.getElementById('part-search-input').value.trim();
    const partIds = await scopedPartIds(machineId);

    let query = supabaseClient.from('parts').select('*');
    if (partIds !== null) {
        if (partIds.length === 0) { renderPartsPage([], 1); return; }
        query = query.in('id', partIds);
    }
    if (q) query = query.or(`part_code.ilike.%${q}%,description.ilike.%${q}%`);

    try {
        const data = await fetchAllPages(query.order('part_code'));
        currentInventoryData = data;
        inventoryCurrentPage = 1;
        renderPartsPage(currentInventoryData, inventoryCurrentPage);
    } catch (err) {
        console.error(err);
        renderPartsPage([], 1);
    }
}

function renderPartsPage(data, page) {
    const tbody = document.getElementById('parts-tbody');
    tbody.innerHTML = '';
    document.getElementById('parts-select-all').checked = false;
    document.getElementById('parts-select-all').indeterminate = false;
    updateBulkDeleteButton();

    if (data.length === 0) {
        tbody.innerHTML = `<tr class="empty-row"><td colspan="9">No parts found.</td></tr>`;
        updatePaginationUI(0, page);
        return;
    }

    const startIndex = (page - 1) * INVENTORY_PAGE_SIZE;
    const endIndex = Math.min(startIndex + INVENTORY_PAGE_SIZE, data.length);
    const pageData = data.slice(startIndex, endIndex);

    pageData.forEach(p => {
        tbody.innerHTML += `<tr>
            <td><input type="checkbox" class="part-checkbox" data-id="${p.id}" data-code="${p.part_code.replace(/"/g, '&quot;')}" onchange="updateBulkDeleteButton()"></td>
            <td>${p.part_code}</td><td>${p.description || '-'}</td><td>${p.uom || 'Nos'}</td>
            <td>${p.stock_qty}</td><td>${p.reorder_level}</td><td>$${p.unit_cost || '0.00'}</td>
            <td><button class="btn-secondary" onclick="downloadQr('${p.part_code.replace(/'/g, "\\'")}')">⬇️</button></td>
            <td><button class="btn-danger" onclick="deletePart(${p.id}, '${p.part_code.replace(/'/g, "\\'")}')">Delete</button></td>
        </tr>`;
    });
    
    updatePaginationUI(data.length, page);
}

function updatePaginationUI(totalItems, currentPage) {
    let container = document.getElementById('inventory-pagination');
    if (!container) {
        container = document.createElement('div');
        container.id = 'inventory-pagination';
        container.style.display = 'flex';
        container.style.justifyContent = 'flex-end';
        container.style.gap = '10px';
        container.style.marginTop = '15px';
        document.getElementById('inventory-pagination-container').appendChild(container);
    }
    
    const totalPages = Math.ceil(totalItems / INVENTORY_PAGE_SIZE) || 1;
    container.innerHTML = `
        <span style="align-self: center; font-size: 13px; color: var(--text-muted);">
            Showing ${(currentPage - 1) * INVENTORY_PAGE_SIZE + (totalItems ? 1 : 0)} - ${Math.min(currentPage * INVENTORY_PAGE_SIZE, totalItems)} of ${totalItems}
        </span>
        <button class="btn-secondary" ${currentPage === 1 ? 'disabled' : ''} onclick="changeInventoryPage(${currentPage - 1})">Previous</button>
        <span style="align-self: center; font-size: 13px;">Page ${currentPage} of ${totalPages}</span>
        <button class="btn-secondary" ${currentPage === totalPages ? 'disabled' : ''} onclick="changeInventoryPage(${currentPage + 1})">Next</button>
    `;
}

function changeInventoryPage(newPage) {
    const totalPages = Math.ceil(currentInventoryData.length / INVENTORY_PAGE_SIZE);
    if (newPage >= 1 && newPage <= totalPages) {
        inventoryCurrentPage = newPage;
        renderPartsPage(currentInventoryData, inventoryCurrentPage);
    }
}

function toggleSelectAllParts(checked) {
    document.querySelectorAll('.part-checkbox').forEach(cb => { cb.checked = checked; });
    updateBulkDeleteButton();
}

function updateBulkDeleteButton() {
    const allBoxes = document.querySelectorAll('.part-checkbox');
    const checkedBoxes = document.querySelectorAll('.part-checkbox:checked');
    const btn = document.getElementById('bulk-delete-parts-btn');

    if (checkedBoxes.length > 0) {
        btn.style.display = 'inline-block';
        btn.innerText = `Delete Selected (${checkedBoxes.length})`;
    } else {
        btn.style.display = 'none';
    }

    const selectAll = document.getElementById('parts-select-all');
    if (allBoxes.length === 0) {
        selectAll.checked = false;
        selectAll.indeterminate = false;
    } else {
        selectAll.checked = checkedBoxes.length === allBoxes.length;
        selectAll.indeterminate = checkedBoxes.length > 0 && checkedBoxes.length < allBoxes.length;
    }
}

async function bulkDeleteParts() {
    const checkedBoxes = Array.from(document.querySelectorAll('.part-checkbox:checked'));
    if (checkedBoxes.length === 0) return;

    const ids = checkedBoxes.map(cb => parseInt(cb.dataset.id, 10));
    const codes = checkedBoxes.map(cb => cb.dataset.code);
    const preview = codes.slice(0, 5).join(', ') + (codes.length > 5 ? `, and ${codes.length - 5} more` : '');

    if (!confirm(
        `Delete ${ids.length} part(s)? (${preview})\n\n` +
        `This also removes them from any assemblies they're linked to. Past breakdown records that reference them are kept, just unlinked. This cannot be undone.`
    )) return;

    const { error } = await supabaseClient.from('parts').delete().in('id', ids);
    if (error) { alert('Error: ' + error.message); return; }

    loadInventory();
    loadStats();
}

async function deletePart(partId, partCode) {
    if (!confirm(
        `Delete part "${partCode}"? This also removes it from any assemblies it's linked to. ` +
        `Past breakdown records that reference it are kept, just unlinked from this part. This cannot be undone.`
    )) return;

    const { error } = await supabaseClient.from('parts').delete().eq('id', partId);
    if (error) { alert('Error: ' + error.message); return; }

    loadInventory();
    loadStats();
}

async function downloadQr(partCode) {
    try {
        const dataUrl = await QRCode.toDataURL(partCode, { width: 300, margin: 1 });
        const link = document.createElement('a');
        link.href = dataUrl;
        link.download = `QR_${partCode}.png`;
        link.click();
    } catch (err) {
        alert('Could not generate QR code: ' + err.message);
    }
}

async function loadLowStock() {
    const machineId = document.getElementById('global-machine-select').value;
    const parts = await fetchScopedParts(machineId, '*');
    const lowStock = parts
        .filter(p => (p.stock_qty || 0) <= (p.reorder_level || 0))
        .sort((a, b) => a.part_code.localeCompare(b.part_code));

    const tbody = document.getElementById('low-stock-tbody');
    tbody.innerHTML = '';
    if (lowStock.length === 0) {
        tbody.innerHTML = `<tr class="empty-row"><td colspan="5">Nothing is below its reorder level right now.</td></tr>`;
        return;
    }
    lowStock.forEach(p => {
        const deficit = (p.reorder_level || 0) - (p.stock_qty || 0);
        tbody.innerHTML += `<tr>
            <td style="color:var(--danger);">${p.part_code}</td><td>${p.description || '-'}</td>
            <td style="color:var(--danger); font-weight:bold;">${p.stock_qty}</td>
            <td>${p.reorder_level}</td><td>${deficit > 0 ? deficit : 0}</td>
        </tr>`;
    });
}

async function exportRequisition() {
    const machineId = document.getElementById('global-machine-select').value;
    const parts = await fetchScopedParts(machineId, 'part_code, description, stock_qty, reorder_level, unit_cost');
    const lowStock = parts
        .filter(p => (p.stock_qty || 0) <= (p.reorder_level || 0))
        .sort((a, b) => a.part_code.localeCompare(b.part_code));

    const rows = [
        ['CEYLON BEVERAGE INTERNATIONAL (PVT) LTD'],
        ['Purchase Requisition - Low Stock Spare Parts'],
        [`Date: ${new Date().toISOString().slice(0, 10)}`],
        [],
        ['Part Code', 'Description', 'Current Stock', 'Reorder Level', 'Unit Cost', 'Est. Total Cost', 'Order Qty (Req)']
    ];
    lowStock.forEach(p => {
        const qtyToOrder = Math.max(1, (p.reorder_level || 0) - (p.stock_qty || 0));
        const cost = p.unit_cost || 0;
        rows.push([p.part_code, p.description, p.stock_qty, p.reorder_level, cost, qtyToOrder * cost, qtyToOrder]);
    });

    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 20 }, { wch: 45 }, { wch: 15 }, { wch: 15 }, { wch: 15 }, { wch: 15 }, { wch: 15 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Purchase Requisition');

    const filename = `Purchase_Requisition_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.xlsx`;
    XLSX.writeFile(wb, filename);
}

function toggleAddPartForm() {
    const form = document.getElementById('add-part-form');
    const isHidden = form.style.display === 'none';
    form.style.display = isHidden ? 'block' : 'none';
    document.getElementById('add-part-toggle-btn').innerText = isHidden ? 'Cancel' : '+ Add Part';
}

let lastBulkAddRows = [];

function toggleBulkAddForm() {
    const form = document.getElementById('bulk-add-excel-form');
    const isHidden = form.style.display === 'none';
    form.style.display = isHidden ? 'block' : 'none';
    document.getElementById('bulk-add-toggle-btn').innerText = isHidden ? 'Cancel' : '+ Bulk Add (Excel)';
    if (!isHidden) document.getElementById('bulk-add-results').innerHTML = '';
}

function detectColumnIndex(headerCells, aliases) {
    const normalized = headerCells.map(h => normalizeText(h));
    for (const alias of aliases) {
        const idx = normalized.indexOf(normalizeText(alias));
        if (idx !== -1) return idx;
    }
    return -1;
}

async function previewBulkAdd() {
    const fileInput = document.getElementById('bulk-add-file');
    if (!fileInput.files.length) { alert('Please choose a file.'); return; }
    const file = fileInput.files[0];
    const ext = file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : '';

    const resultsDiv = document.getElementById('bulk-add-results');
    const btn = document.getElementById('bulk-add-preview-btn');
    btn.disabled = true;
    btn.innerText = 'Reading...';
    resultsDiv.innerHTML = '<p style="color: var(--text-muted);">Reading file...</p>';

    let rows;
    try {
        if (ext === 'xlsx' || ext === 'xlsm') {
            const buf = await file.arrayBuffer();
            const wb = XLSX.read(buf, { type: 'array' });
            const ws = wb.Sheets[wb.SheetNames[0]];
            rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        } else {
            rows = parseCsvText(await file.text());
        }
    } catch (err) {
        resultsDiv.innerHTML = `<p style="color: var(--danger);">Error reading file: ${err.message}</p>`;
        btn.disabled = false;
        btn.innerText = 'Preview';
        return;
    }

    let headerRowIdx = -1;
    let colIdx = { code: 0, description: 1, uom: 2, stock: 3, reorder: 4, cost: 5, location: 6 };
    for (let i = 0; i < Math.min(rows.length, 5); i++) {
        const cells = rows[i].map(c => String(c || '').trim());
        const codeIdx = detectColumnIndex(cells, ['part code', 'code', 'item no', 'item no.', 'sap code', 'part_code']);
        if (codeIdx !== -1) {
            headerRowIdx = i;
            colIdx = {
                code: codeIdx,
                description: detectColumnIndex(cells, ['description', 'name', 'item description']),
                uom: detectColumnIndex(cells, ['uom', 'unit', 'unit of measure']),
                stock: detectColumnIndex(cells, ['stock qty', 'quantity', 'qty', 'cumulative qty', 'stock']),
                reorder: detectColumnIndex(cells, ['reorder level', 'reorder']),
                cost: detectColumnIndex(cells, ['unit cost', 'cost', 'price']),
                location: detectColumnIndex(cells, ['location'])
            };
            break;
        }
    }
    const dataRows = headerRowIdx >= 0 ? rows.slice(headerRowIdx + 1) : rows;

    showProgress('Analyzing File...', 'Loading inventory to check for duplicates...');
    
    let existingParts;
    try {
        existingParts = await fetchAllPages(supabaseClient.from('parts').select('id, part_code, description'));
    } catch(err) {
        resultsDiv.innerHTML = `<p style="color: var(--danger);">Error checking inventory: ${err.message}</p>`;
        hideProgress();
        btn.disabled = false;
        btn.innerText = 'Preview';
        return;
    }
    
    updateProgress(50, `Checking for duplicates...`);

    const byNorm = {};
    (existingParts || []).forEach(p => { byNorm[normalizeCode(p.part_code)] = p; });

    const parsed = [];
    dataRows.forEach(row => {
        const cells = row.map(c => (c === null || c === undefined) ? '' : String(c).trim());
        const code = colIdx.code >= 0 ? cells[colIdx.code] : '';
        if (!code) return;

        const description = colIdx.description >= 0 ? cells[colIdx.description] : '';
        const uom = colIdx.uom >= 0 && cells[colIdx.uom] ? cells[colIdx.uom] : 'Nos';
        const stock = colIdx.stock >= 0 && cells[colIdx.stock] !== '' && !isNaN(parseInt(cells[colIdx.stock], 10)) ? parseInt(cells[colIdx.stock], 10) : 0;
        const reorder = colIdx.reorder >= 0 && cells[colIdx.reorder] !== '' && !isNaN(parseInt(cells[colIdx.reorder], 10)) ? parseInt(cells[colIdx.reorder], 10) : 0;
        const cost = colIdx.cost >= 0 && cells[colIdx.cost] !== '' && !isNaN(parseFloat(cells[colIdx.cost])) ? parseFloat(cells[colIdx.cost]) : 0;
        const location = colIdx.location >= 0 ? cells[colIdx.location] : '';

        const norm = normalizeCode(code);
        const exact = byNorm[norm];
        const embedded = !exact ? findMatchInDescriptions(code, existingParts || []) : null;
        const duplicate = exact || embedded;

        parsed.push({
            code, description, uom, stock, reorder, cost, location,
            duplicateOf: duplicate ? duplicate.part_code : null,
            duplicateVia: exact ? 'code' : (embedded ? 'description' : null)
        });
    });

    lastBulkAddRows = parsed;
    btn.disabled = false;
    btn.innerText = 'Preview';
    hideProgress();

    if (parsed.length === 0) {
        resultsDiv.innerHTML = '<p style="color: var(--text-muted);">No rows with a code found in this file.</p>';
        return;
    }

    let html = `
        <p style="color: var(--text-muted); font-size: 13px;">
            ${parsed.length} row(s) found${headerRowIdx >= 0 ? '' : ' — no header row detected, so column order was assumed to be Code, Description, UoM, Stock, Reorder, Cost, Location'}.
            Rows already in inventory are unchecked by default.
        </p>
        <div style="margin-bottom: 15px; display:flex; gap:10px;">
            <button class="btn-secondary" onclick="selectAllBulkAdd(true)">Select All</button>
            <button class="btn-secondary" onclick="selectAllBulkAdd(false)">Select None</button>
            <button class="btn-primary" onclick="applyBulkAdd()">Add Selected Parts</button>
        </div>
        <div style="overflow-x:auto;">
        <table>
            <thead><tr><th></th><th>CODE</th><th>DESCRIPTION</th><th>UoM</th><th>STOCK</th><th>REORDER</th><th>COST</th><th>LOCATION</th><th>STATUS</th></tr></thead>
            <tbody>
    `;
    parsed.forEach((r, idx) => {
        const checked = !r.duplicateOf;
        html += `<tr>
            <td><input type="checkbox" class="bulk-add-checkbox" data-idx="${idx}" ${checked ? 'checked' : ''}></td>
            <td><input type="text" class="bulk-add-code" data-idx="${idx}" value="${r.code.replace(/"/g, '&quot;')}" style="width:110px;"></td>
            <td><input type="text" class="bulk-add-desc" data-idx="${idx}" value="${(r.description || '').replace(/"/g, '&quot;')}" style="width:200px;"></td>
            <td><input type="text" class="bulk-add-uom" data-idx="${idx}" value="${r.uom}" style="width:55px;"></td>
            <td><input type="number" class="bulk-add-stock" data-idx="${idx}" value="${r.stock}" style="width:60px;"></td>
            <td><input type="number" class="bulk-add-reorder" data-idx="${idx}" value="${r.reorder}" style="width:60px;"></td>
            <td><input type="number" step="0.01" class="bulk-add-cost" data-idx="${idx}" value="${r.cost}" style="width:70px;"></td>
            <td><input type="text" class="bulk-add-location" data-idx="${idx}" value="${(r.location || '').replace(/"/g, '&quot;')}" style="width:90px;"></td>
            <td>${r.duplicateOf ? `<span class="badge fuzzy">exists (${r.duplicateOf}${r.duplicateVia === 'description' ? ', via desc' : ''})</span>` : `<span class="badge exact">new</span>`}</td>
        </tr>`;
    });
    html += `</tbody></table></div>`;
    resultsDiv.innerHTML = html;
}

function selectAllBulkAdd(checked) {
    document.querySelectorAll('.bulk-add-checkbox').forEach(cb => { cb.checked = checked; });
}

async function applyBulkAdd() {
    const rows = document.querySelectorAll('#bulk-add-results tbody tr');
    const toInsert = [];
    rows.forEach(row => {
        if (!row.querySelector('.bulk-add-checkbox').checked) return;
        const code = row.querySelector('.bulk-add-code').value.trim();
        if (!code) return;
        toInsert.push({
            part_code: code,
            description: row.querySelector('.bulk-add-desc').value.trim() || null,
            uom: row.querySelector('.bulk-add-uom').value.trim() || 'Nos',
            stock_qty: parseInt(row.querySelector('.bulk-add-stock').value, 10) || 0,
            reorder_level: parseInt(row.querySelector('.bulk-add-reorder').value, 10) || 0,
            unit_cost: parseFloat(row.querySelector('.bulk-add-cost').value) || 0,
            location: row.querySelector('.bulk-add-location').value.trim() || null
        });
    });

    if (toInsert.length === 0) { alert('Select at least one part to add.'); return; }

    const seen = new Set();
    const deduped = toInsert.filter(p => {
        const norm = normalizeCode(p.part_code);
        if (seen.has(norm)) return false;
        seen.add(norm);
        return true;
    });

    if (!confirm(`Add ${deduped.length} new part(s) to inventory?`)) return;

    showProgress('Adding Parts...', `Writing ${deduped.length} parts...`);
    const CHUNK_SIZE = 500;
    let added = 0, failed = 0;

    for (let i = 0; i < deduped.length; i += CHUNK_SIZE) {
        const chunk = deduped.slice(i, i + CHUNK_SIZE);
        const { error } = await supabaseClient.from('parts').insert(chunk);
        if (error) { failed += chunk.length; console.error(error.message); } else added += chunk.length;
        updateProgress((i / deduped.length) * 100, `Adding parts ${i} to ${i + chunk.length}...`);
    }

    hideProgress();
    alert(`Added ${added} part(s)` + (failed ? `, ${failed} failed (see browser console — likely a duplicate code already in inventory).` : '.'));
    
    document.getElementById('bulk-add-results').innerHTML = '';
    document.getElementById('bulk-add-file').value = '';
    toggleBulkAddForm();
    loadInventory();
    loadStats();
}

async function addPart() {
    const partCode = document.getElementById('add-p-code').value.trim();
    if (!partCode) { alert('Part code is required.'); return; }

    const { data: existing } = await supabaseClient.from('parts').select('id').eq('part_code', partCode);
    if (existing && existing.length) {
        alert(`A part with code '${partCode}' already exists.`);
        return;
    }

    const payload = {
        part_code: partCode,
        description: document.getElementById('add-p-desc').value.trim() || null,
        location: document.getElementById('add-p-location').value.trim() || null,
        uom: document.getElementById('add-p-uom').value.trim() || 'Nos',
        stock_qty: parseInt(document.getElementById('add-p-stock').value, 10) || 0,
        reorder_level: parseInt(document.getElementById('add-p-reorder').value, 10) || 0,
        unit_cost: parseFloat(document.getElementById('add-p-cost').value) || 0
    };

    const { error } = await supabaseClient.from('parts').insert(payload);
    if (error) { alert('Error: ' + error.message); return; }

    document.getElementById('add-p-code').value = '';
    document.getElementById('add-p-desc').value = '';
    document.getElementById('add-p-location').value = '';
    document.getElementById('add-p-uom').value = 'Nos';
    document.getElementById('add-p-stock').value = '0';
    document.getElementById('add-p-reorder').value = '0';
    document.getElementById('add-p-cost').value = '0';
    toggleAddPartForm();

    loadInventory();
    loadStats();
}

// ---------------------------------------------------------------------------
// Breakdowns
// ---------------------------------------------------------------------------
async function loadBreakdowns() {
    const machineId = document.getElementById('global-machine-select').value;
    let query = supabaseClient.from('breakdowns').select('*, parts(part_code, description), machines(name)');
    if (machineId && machineId !== 'all' && machineId !== '0') query = query.eq('machine_id', machineId);
    const { data, error } = await query.order('reported_at', { ascending: false });

    const tbody = document.getElementById('breakdowns-tbody');
    tbody.innerHTML = '';
    if (error || !data || data.length === 0) {
        tbody.innerHTML = `<tr class="empty-row"><td colspan="6">No breakdowns logged yet.</td></tr>`;
        return;
    }

    data.forEach(b => {
        const dateStr = new Date(b.reported_at).toLocaleString();
        const isResolved = !!b.resolved_at;
        const statusBadge = isResolved
            ? `<span class="badge resolved">Resolved</span>`
            : `<span class="badge open">Open</span>`;
        const actionCell = isResolved
            ? `<span style="color: var(--text-muted); font-size: 12px;">${b.resolution ? b.resolution : '-'}</span>`
            : `<button class="btn-secondary" onclick="resolveBreakdown(${b.id})">Resolve</button>`;
        tbody.innerHTML += `<tr>
            <td>${dateStr}</td>
            <td>${b.machines ? b.machines.name : '-'}</td>
            <td>${b.parts ? b.parts.part_code : '-'}</td>
            <td>${b.description}</td>
            <td>${statusBadge}</td>
            <td>${actionCell}</td>
        </tr>`;
    });
}

async function resolveBreakdown(breakdownId) {
    const resolution = prompt('Resolution notes (optional):', '');
    if (resolution === null) return;
    await supabaseClient.from('breakdowns')
        .update({ resolved_at: new Date().toISOString(), resolution })
        .eq('id', breakdownId);
    loadBreakdowns();
    loadStats();
}

async function logBreakdown() {
    const machineId = document.getElementById('bd-machine').value;
    const description = document.getElementById('bd-desc').value.trim();
    const partCode = document.getElementById('bd-part').value.trim();
    const qtyUsed = parseInt(document.getElementById('bd-qty').value, 10) || 0;
    const reportedBy = document.getElementById('bd-reporter').value.trim();

    if (!machineId) { alert('Please select a machine.'); return; }
    if (!description) { alert('Please describe the breakdown.'); return; }

    let partId = null;
    if (partCode) {
        const { data: matches } = await supabaseClient
            .from('parts').select('id, part_code').ilike('part_code', `%${partCode}%`);
        if (matches && matches.length) {
            const exact = matches.find(p => p.part_code.toLowerCase() === partCode.toLowerCase());
            partId = exact ? exact.id : matches[0].id;
        } else {
            alert(`No part found matching "${partCode}". Logging breakdown without a linked part.`);
        }
    }

    await supabaseClient.from('breakdowns').insert({
        machine_id: machineId,
        part_id: partId,
        description,
        reported_by: reportedBy || null,
        qty_used: qtyUsed
    });

    if (partId && qtyUsed) {
        const { data: partRow } = await supabaseClient.from('parts').select('stock_qty').eq('id', partId).single();
        if (partRow) {
            const newQty = Math.max(0, (partRow.stock_qty || 0) - qtyUsed);
            await supabaseClient.from('parts').update({ stock_qty: newQty }).eq('id', partId);
        }
    }

    document.getElementById('bd-desc').value = '';
    document.getElementById('bd-part').value = '';
    document.getElementById('bd-qty').value = '0';
    document.getElementById('bd-reporter').value = '';

    loadBreakdowns();
    loadStats();
}

async function loadFailureFrequency() {
    const machineId = document.getElementById('global-machine-select').value;
    let query = supabaseClient.from('breakdowns').select('part_id, reported_at, parts(part_code, description), machines(name)');
    if (machineId && machineId !== 'all' && machineId !== '0') query = query.eq('machine_id', machineId);
    const { data, error } = await query;

    const tbody = document.getElementById('failure-tbody');
    tbody.innerHTML = '';

    if (error || !data || data.length === 0) {
        tbody.innerHTML = `<tr class="empty-row"><td colspan="5">No breakdown history yet.</td></tr>`;
        if (paretoChartInstance) paretoChartInstance.destroy();
        return;
    }

    const grouped = {};
    data.forEach(r => {
        if (!r.part_id) return;
        if (!grouped[r.part_id]) {
            grouped[r.part_id] = {
                part_id: r.part_id,
                part_code: r.parts ? r.parts.part_code : null,
                description: r.parts ? r.parts.description : null,
                machine_name: r.machines ? r.machines.name : null,
                timestamps: []
            };
        }
        grouped[r.part_id].timestamps.push(r.reported_at);
    });

    const results = Object.values(grouped).map(g => {
        const ts = g.timestamps.slice().sort();
        const failureCount = ts.length;
        let mtbf = null;
        if (failureCount > 1) {
            const spanDays = (new Date(ts[ts.length - 1]) - new Date(ts[0])) / 86400000;
            mtbf = Math.round((spanDays / (failureCount - 1)) * 10) / 10;
        }
        return { ...g, failure_count: failureCount, mtbf_days: mtbf };
    }).sort((a, b) => b.failure_count - a.failure_count);

    results.forEach(item => {
        tbody.innerHTML += `<tr>
            <td>${item.part_code}</td><td>${item.description}</td><td>${item.machine_name}</td>
            <td>${item.failure_count}</td><td>${item.mtbf_days !== null ? item.mtbf_days : 'N/A'}</td>
        </tr>`;
    });

    const labels = results.map(d => d.part_code);
    const counts = results.map(d => d.failure_count);
    const total = counts.reduce((a, b) => a + b, 0);
    let cumulative = 0;
    const percentages = counts.map(c => { cumulative += c; return (cumulative / total) * 100; });

    renderParetoChart(labels, counts, percentages);
}

function renderParetoChart(labels, counts, percentages) {
    const ctx = document.getElementById('paretoChart').getContext('2d');
    if (paretoChartInstance) paretoChartInstance.destroy();

    paretoChartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [
                { label: 'Cumulative %', type: 'line', data: percentages, borderColor: '#f5a623', backgroundColor: '#f5a623', yAxisID: 'y-percentage' },
                { label: 'Failure Count', type: 'bar', data: counts, backgroundColor: '#2a3b4c', borderColor: '#34495e', borderWidth: 1, yAxisID: 'y-count' }
            ]
        },
        options: {
            responsive: true,
            scales: {
                x: { ticks: { color: '#8a9ab0' } },
                'y-count': { type: 'linear', position: 'left', ticks: { color: '#8a9ab0', stepSize: 1 } },
                'y-percentage': { type: 'linear', position: 'right', max: 105, min: 0, ticks: { color: '#8a9ab0' } }
            },
            plugins: { legend: { labels: { color: '#8a9ab0' } } }
        }
    });
}

// ---------------------------------------------------------------------------
// Machines
// ---------------------------------------------------------------------------
async function loadMachinesTable() {
    const { data, error } = await supabaseClient.from('machines').select('*').order('name');
    const tbody = document.getElementById('machines-tbody');
    tbody.innerHTML = '';
    if (error || !data || data.length === 0) {
        tbody.innerHTML = `<tr class="empty-row"><td colspan="6">No machines added yet.</td></tr>`;
        return;
    }
    data.forEach(m => {
        tbody.innerHTML += `<tr>
            <td>${m.name}</td>
            <td>${m.model || '-'}</td>
            <td>${m.serial_number || '-'}</td>
            <td>${m.manufacturer || '-'}</td>
            <td>${m.year_built || '-'}</td>
            <td><button class="btn-danger" onclick="deleteMachine(${m.id}, '${m.name.replace(/'/g, "\\'")}')">Delete</button></td>
        </tr>`;
    });
}

async function deleteMachine(machineId, machineName) {
    if (!confirm(`Delete "${machineName}"? This cannot be undone.`)) return;
    await supabaseClient.from('machines').delete().eq('id', machineId);
    await loadMachinesDropdown();
    loadMachinesTable();
    loadStats();
}

async function addMachine() {
    const name = document.getElementById('add-m-name').value.trim();
    if (!name) { alert('Machine name is required.'); return; }

    const payload = {
        name,
        model: document.getElementById('add-m-model').value.trim() || null,
        serial_number: document.getElementById('add-m-serial').value.trim() || null,
        manufacturer: document.getElementById('add-m-manufacturer').value.trim() || null,
        year_built: document.getElementById('add-m-year').value ? parseInt(document.getElementById('add-m-year').value, 10) : null,
        notes: document.getElementById('add-m-notes').value.trim() || null
    };

    const { error } = await supabaseClient.from('machines').insert(payload);
    if (error) { alert('Error: ' + error.message); return; }

    document.getElementById('add-m-name').value = '';
    document.getElementById('add-m-model').value = '';
    document.getElementById('add-m-serial').value = '';
    document.getElementById('add-m-manufacturer').value = '';
    document.getElementById('add-m-year').value = '';
    document.getElementById('add-m-notes').value = '';

    await loadMachinesDropdown();
    loadStats();
    alert(`Machine "${name}" added.`);
}

// ---------------------------------------------------------------------------
// Manuals
// ---------------------------------------------------------------------------
async function loadManuals() {
    const machineId = document.getElementById('global-machine-select').value;
    let query = supabaseClient.from('manuals').select('*, machines(name)');
    if (machineId && machineId !== 'all' && machineId !== '0') query = query.eq('machine_id', machineId);
    const { data, error } = await query.order('uploaded_at', { ascending: false });

    const tbody = document.getElementById('manuals-tbody');
    tbody.innerHTML = '';
    if (error || !data || data.length === 0) {
        tbody.innerHTML = `<tr class="empty-row"><td colspan="5">No manuals uploaded yet.</td></tr>`;
        return;
    }

    data.forEach(m => {
        const dateStr = new Date(m.uploaded_at).toLocaleString();
        const { data: urlData } = supabaseClient.storage.from('manuals').getPublicUrl(m.storage_path);
        const scanLabel = (m.volume_label || m.filename).replace(/'/g, "\\'");
        tbody.innerHTML += `<tr>
            <td>${m.machines ? m.machines.name : 'Unknown'}</td><td>${m.filename}</td><td>${m.volume_label || '-'}</td><td>${dateStr}</td>
            <td style="display:flex; gap:8px; flex-wrap:wrap;">
                <button class="btn-secondary" onclick="openPdfViewer('${urlData.publicUrl}')">View PDF</button>
                <button class="btn-secondary" onclick="scanManualForParts('${urlData.publicUrl}', ${m.machine_id}, '${scanLabel}')">Scan for Parts</button>
                <button class="btn-danger" onclick="deleteManual(${m.id}, '${m.storage_path}', '${m.filename.replace(/'/g, "\\'")}')">Delete</button>
            </td>
        </tr>`;
    });
}

async function deleteManual(manualId, storagePath, filename) {
    if (!confirm(`Delete "${filename}"? This removes the PDF from storage too and cannot be undone.`)) return;

    const { error: storageError } = await supabaseClient.storage.from('manuals').remove([storagePath]);
    if (storageError) {
        console.error('Storage delete error:', storageError.message);
    }

    const { error: dbError } = await supabaseClient.from('manuals').delete().eq('id', manualId);
    if (dbError) { alert('Error deleting manual record: ' + dbError.message); return; }

    loadManuals();
}

function uploadFileWithProgress(bucket, path, file, onProgress) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const url = `${CONFIG.SUPABASE_URL}/storage/v1/object/${bucket}/${path.split('/').map(encodeURIComponent).join('/')}`;
        xhr.open('POST', url, true);
        xhr.setRequestHeader('apikey', CONFIG.SUPABASE_ANON_KEY);
        xhr.setRequestHeader('Authorization', `Bearer ${CONFIG.SUPABASE_ANON_KEY}`);
        xhr.setRequestHeader('Content-Type', file.type || 'application/pdf');
        xhr.setRequestHeader('x-upsert', 'false');

        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable && onProgress) {
                onProgress(Math.round((e.loaded / e.total) * 100));
            }
        };

        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                resolve();
            } else {
                let message = xhr.responseText;
                try { message = JSON.parse(xhr.responseText).message || message; } catch (e) { }
                reject(new Error(message || `Upload failed with status ${xhr.status}`));
            }
        };
        xhr.onerror = () => reject(new Error('Network error during upload'));

        xhr.send(file);
    });
}

async function uploadManual() {
    const machineId = document.getElementById('manual-machine').value;
    const volumeLabel = document.getElementById('manual-volume').value.trim();
    const fileInput = document.getElementById('manual-file');

    if (!machineId) { alert('Please select a machine.'); return; }
    if (!fileInput.files.length) { alert('Please choose a PDF file.'); return; }
    const file = fileInput.files[0];
    if (!file.name.toLowerCase().endsWith('.pdf')) { alert('Only PDF files are supported.'); return; }

    const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; 
    if (file.size > MAX_UPLOAD_BYTES) {
        const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
        alert(`"${file.name}" is ${sizeMb} MB, which is over the 50 MB limit.`);
        return;
    }

    const storagePath = `${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

    const uploadBtn = document.getElementById('upload-manual-btn');
    const progressWrap = document.getElementById('manual-upload-progress-wrap');
    const progressFill = document.getElementById('manual-upload-progress-fill');
    const progressText = document.getElementById('manual-upload-progress-text');

    uploadBtn.disabled = true;
    uploadBtn.innerText = 'Uploading...';
    progressWrap.style.display = 'block';
    progressFill.style.width = '0%';
    progressText.innerText = 'Uploading... 0%';

    try {
        await uploadFileWithProgress('manuals', storagePath, file, (pct) => {
            progressFill.style.width = pct + '%';
            progressText.innerText = `Uploading... ${pct}%`;
        });

        progressText.innerText = 'Saving details...';

        const { error: insertError } = await supabaseClient.from('manuals').insert({
            machine_id: machineId,
            filename: file.name,
            storage_path: storagePath,
            volume_label: volumeLabel || null
        });
        if (insertError) throw new Error('Uploaded, but failed to save record: ' + insertError.message);

        progressText.innerText = 'Done!';
        document.getElementById('manual-volume').value = '';
        fileInput.value = '';
        setTimeout(() => { progressWrap.style.display = 'none'; }, 1000);
        alert('Manual uploaded.');
    } catch (err) {
        progressText.innerText = 'Upload failed.';
        alert('Upload error: ' + err.message);
    } finally {
        uploadBtn.disabled = false;
        uploadBtn.innerText = 'Upload manual';
    }
}

// ---------------------------------------------------------------------------
// Stock check (warehouse reconciliation)
// ---------------------------------------------------------------------------
function parseCsvText(text) {
    return text.split(/\r?\n/).filter(l => l.length).map(line => line.split(','));
}

function parseTxtText(text) {
    const rows = [];
    text.split(/\r?\n/).forEach(line => {
        if (!line.trim()) return;
        let parts;
        if (line.includes('\t')) parts = line.split('\t');
        else if (line.includes(',')) parts = line.split(',');
        else parts = line.split(/\s+/);
        rows.push(parts);
    });
    return rows;
}

function rowsToEntries(rows) {
    const entries = [];
    rows.forEach(row => {
        const cells = row.map(c => String(c).trim()).filter(c => c !== '');
        if (!cells.length) return;
        const code = cells[0];
        if (['code', 'part_code', 'part code', 'sku', 'item'].includes(code.toLowerCase())) return;

        let qty = null;
        let qtyIndex = -1;
        for (let i = 1; i < cells.length; i++) {
            const cNorm = cells[i].replace(',', '.');
            if (/^-?\d+(\.\d+)?$/.test(cNorm)) { qty = parseFloat(cNorm); qtyIndex = i; break; }
        }

        const description = cells.slice(1).filter((_, i) => i + 1 !== qtyIndex).join(' ').trim();
        entries.push({ raw_code: code, description: description || null, qty });
    });
    return entries;
}

async function uploadStockCheck() {
    const fileInput = document.getElementById('stock-file');
    if (!fileInput.files.length) { alert('Please choose a file to analyze.'); return; }
    const file = fileInput.files[0];
    const ext = file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : '';

    const analyzeBtn = document.getElementById('analyze-file-btn');
    const resultsDiv = document.getElementById('stock-results');
    analyzeBtn.disabled = true;
    analyzeBtn.innerText = 'Analyzing...';
    resultsDiv.innerHTML = '<p style="color: var(--text-muted);">Analyzing...</p>';

    let rows;
    try {
        if (ext === 'xlsx' || ext === 'xlsm') {
            const buf = await file.arrayBuffer();
            const wb = XLSX.read(buf, { type: 'array' });
            const ws = wb.Sheets[wb.SheetNames[0]];
            rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }).map(r => r.map(c => String(c)));
        } else if (ext === 'csv') {
            rows = parseCsvText(await file.text());
        } else {
            rows = parseTxtText(await file.text());
        }
    } catch (err) {
        resultsDiv.innerHTML = `<p style="color: var(--danger);">Error: failed to parse file: ${err.message}</p>`;
        analyzeBtn.disabled = false;
        analyzeBtn.innerText = 'Analyze File';
        return;
    }

    const entries = rowsToEntries(rows);

    showProgress('Analyzing Count...', 'Fetching current inventory...');
    
    let allParts;
    try {
        allParts = await fetchAllPages(supabaseClient.from('parts').select('id, part_code, description, stock_qty'));
    } catch (error) {
        resultsDiv.innerHTML = `<p style="color: var(--danger);">Error loading parts: ${error.message}</p>`;
        analyzeBtn.disabled = false;
        analyzeBtn.innerText = 'Analyze File';
        hideProgress();
        return;
    }

    updateProgress(50, `Comparing ${entries.length} items...`);

    const byNormCode = {};
    allParts.forEach(p => { byNormCode[normalizeCode(p.part_code)] = p; });
    const allCodesNorm = Object.keys(byNormCode);

    const results = [];
    let matched = 0;
    
    entries.forEach(entry => {
        const norm = normalizeCode(entry.raw_code);
        const exact = byNormCode[norm];
        if (exact) {
            matched++;
            results.push({
                input_code: entry.raw_code, input_description: entry.description, input_qty: entry.qty,
                match_type: 'exact', part_id: exact.id, part_code: exact.part_code, description: exact.description,
                system_qty: exact.stock_qty, delta: entry.qty === null ? null : entry.qty - exact.stock_qty, suggestions: []
            });
            return;
        }

        const embeddedMatch = findMatchInDescriptions(entry.raw_code, allParts);
        if (embeddedMatch) {
            matched++;
            results.push({
                input_code: entry.raw_code, input_description: entry.description, input_qty: entry.qty,
                match_type: 'exact', matched_via: 'description', part_id: embeddedMatch.id,
                part_code: embeddedMatch.part_code, description: embeddedMatch.description,
                system_qty: embeddedMatch.stock_qty, delta: entry.qty === null ? null : entry.qty - embeddedMatch.stock_qty, suggestions: []
            });
            return;
        }

        const codeMatches = getCloseMatches(norm, allCodesNorm, 3, 0.6).map(c => {
            const p = byNormCode[c.code];
            return {
                part_id: p.id, part_code: p.part_code, description: p.description,
                system_qty: p.stock_qty, similarity: Math.round(c.score * 1000) / 1000, match_basis: 'code'
            };
        });

        const descMatches = entry.description
            ? getCloseDescriptionMatches(entry.description, allParts, 3, 0.5).map(d => ({
                  part_id: d.part.id, part_code: d.part.part_code, description: d.part.description,
                  system_qty: d.part.stock_qty, similarity: Math.round(d.score * 1000) / 1000, match_basis: 'description'
              }))
            : [];

        const merged = {};
        [...codeMatches, ...descMatches].forEach(s => {
            if (!merged[s.part_id] || merged[s.part_id].similarity < s.similarity) merged[s.part_id] = s;
        });
        const suggestions = Object.values(merged).sort((a, b) => b.similarity - a.similarity).slice(0, 3);

        results.push({
            input_code: entry.raw_code, input_description: entry.description, input_qty: entry.qty,
            match_type: suggestions.length ? 'fuzzy' : 'unmatched',
            part_id: null, part_code: null, description: null, system_qty: null, delta: null, suggestions
        });
    });

    const unmatched = entries.length - matched;
    await supabaseClient.from('stock_check_uploads').insert({
        filename: file.name, row_count: entries.length, matched_count: matched, unmatched_count: unmatched
    });

    hideProgress();
    lastStockCheckResults = results;
    renderStockCheckResults({ row_count: entries.length, matched_count: matched, unmatched_count: unmatched, results });
    analyzeBtn.disabled = false;
    analyzeBtn.innerText = 'Analyze File';
}

function renderStockCheckResults(data) {
    const resultsDiv = document.getElementById('stock-results');
    let html = `
        <div style="display:flex; gap: 20px; margin: 15px 0; color: var(--text-muted); font-size: 13px;">
            <span>Rows: <strong style="color: var(--text-main);">${data.row_count}</strong></span>
            <span>Matched: <strong style="color: var(--success);">${data.matched_count}</strong></span>
            <span>Unmatched: <strong style="color: var(--danger);">${data.unmatched_count}</strong></span>
        </div>
        <div style="margin-bottom: 15px;">
            <button class="btn-primary" onclick="applyStockCheck()">Apply Counted Quantities</button>
        </div>
        <table>
            <thead><tr>
                <th>INPUT CODE</th><th>INPUT DESCRIPTION</th><th>MATCHED PART</th><th>MATCH TYPE</th>
                <th>SYSTEM QTY</th><th>COUNTED QTY</th><th>DELTA</th><th>SUGGESTIONS</th>
            </tr></thead>
            <tbody>
    `;

    data.results.forEach(r => {
        const deltaColor = r.delta === null ? 'var(--text-muted)' : (r.delta === 0 ? 'var(--text-muted)' : (r.delta > 0 ? 'var(--accent)' : 'var(--danger)'));
        const suggestionsHtml = r.suggestions.length
            ? r.suggestions.map(s => `${s.part_code} (${Math.round(s.similarity * 100)}% via ${s.match_basis || 'code'})`).join(', ')
            : '-';
        html += `<tr>
            <td>${r.input_code}</td>
            <td style="font-size:12px; color: var(--text-muted);">${r.input_description || '-'}</td>
            <td>${r.part_code || '-'}${r.description ? ' — ' + r.description : ''}${r.matched_via === 'description' ? ' <span style="color: var(--text-muted); font-size:11px;">(via description)</span>' : ''}</td>
            <td><span class="badge ${r.match_type}">${r.match_type}</span></td>
            <td>${r.system_qty !== null ? r.system_qty : '-'}</td>
            <td>${r.input_qty !== null ? r.input_qty : '-'}</td>
            <td style="color:${deltaColor};">${r.delta !== null ? r.delta : '-'}</td>
            <td style="font-size:12px; color: var(--text-muted);">${suggestionsHtml}</td>
        </tr>`;
    });

    html += `</tbody></table>`;
    resultsDiv.innerHTML = html;
}

async function applyStockCheck() {
    const updates = lastStockCheckResults
        .filter(r => r.part_id !== null && r.input_qty !== null && r.match_type === 'exact')
        .map(r => ({ id: r.part_id, stock_qty: r.input_qty }));

    if (updates.length === 0) {
        alert('No exact matches with a counted quantity to apply.');
        return;
    }
    if (!confirm(`Apply counted quantities to ${updates.length} part(s)? This overwrites system stock quantities.`)) return;

    showProgress('Applying Counts...', `Updating ${updates.length} parts...`);
    
    // Batch updates concurrently to avoid partial row wiping via upsert
    const { processed, failed } = await processInBatchesAsync(updates, 50, async (u) => {
        return await supabaseClient.from('parts').update({ stock_qty: u.stock_qty }).eq('id', u.id);
    }, (done, total) => {
        updateProgress((done / total) * 100, `Updated ${done} of ${total} parts...`);
    });

    hideProgress();
    alert(`Applied ${processed - failed} update(s).` + (failed > 0 ? ` Failed: ${failed}.` : ''));
    
    loadStats();
    if (currentTab === 'parts') loadInventory();
    if (currentTab === 'low-stock') loadLowStock();
}

// ---------------------------------------------------------------------------
// Full Stock List
// ---------------------------------------------------------------------------
let lastStockListChanges = [];

async function downloadStockListXlsx() {
    showProgress('Exporting...', 'Fetching full stock list from database...');
    try {
        const parts = await fetchAllPages(supabaseClient.from('parts').select('*').order('part_code'));
        updateProgress(50, `Formatting ${parts.length} parts...`);
        
        const rows = [['Part Code', 'Description', 'UoM', 'Stock Qty', 'Reorder Level', 'Unit Cost', 'Location']];
        (parts || []).forEach(p => {
            rows.push([p.part_code, p.description || '', p.uom || 'Nos', p.stock_qty, p.reorder_level, p.unit_cost, p.location || '']);
        });

        const ws = XLSX.utils.aoa_to_sheet(rows);
        ws['!cols'] = [{ wch: 20 }, { wch: 40 }, { wch: 8 }, { wch: 12 }, { wch: 14 }, { wch: 12 }, { wch: 20 }];
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Stock List');
        
        updateProgress(90, 'Generating file...');
        XLSX.writeFile(wb, `Stock_List_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.xlsx`);
    } catch (error) {
        alert('Error generating export: ' + error.message);
    } finally {
        hideProgress();
    }
}

async function compareStockList() {
    const fileInput = document.getElementById('stock-list-file');
    if (!fileInput.files.length) { alert('Please choose the edited stock list file.'); return; }
    const file = fileInput.files[0];

    const resultsDiv = document.getElementById('stock-list-results');
    const btn = document.getElementById('compare-stock-list-btn');
    btn.disabled = true;
    btn.innerText = 'Comparing...';
    resultsDiv.innerHTML = '<p style="color: var(--text-muted);">Reading file...</p>';

    let rows;
    try {
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    } catch (err) {
        resultsDiv.innerHTML = `<p style="color: var(--danger);">Error reading file: ${err.message}</p>`;
        btn.disabled = false;
        btn.innerText = 'Compare & Preview Changes';
        return;
    }

    showProgress('Analyzing File...', 'Fetching current inventory for comparison...');
    
    let existingParts;
    try {
        existingParts = await fetchAllPages(supabaseClient.from('parts').select('*'));
    } catch (error) {
        resultsDiv.innerHTML = `<p style="color: var(--danger);">Error loading current parts: ${error.message}</p>`;
        btn.disabled = false;
        btn.innerText = 'Compare & Preview Changes';
        hideProgress();
        return;
    }
    
    updateProgress(50, `Comparing rows...`);

    const byNorm = {};
    existingParts.forEach(p => { byNorm[normalizeCode(p.part_code)] = p; });

    const changes = [];
    rows.forEach(row => {
        const cells = row.map(c => (c === null || c === undefined) ? '' : String(c).trim());
        if (!cells.length || !cells[0]) return;
        if (['code', 'part code', 'part_code'].includes(cells[0].toLowerCase())) return; 

        const [rawCode, rawDesc, rawUom, rawStock, rawReorder, rawCost, rawLocation] = cells;
        const norm = normalizeCode(rawCode);
        const existing = byNorm[norm];

        const newDesc = rawDesc || null;
        const newUom = rawUom || 'Nos';
        const newStock = rawStock !== '' && !isNaN(parseInt(rawStock, 10)) ? parseInt(rawStock, 10) : 0;
        const newReorder = rawReorder !== '' && !isNaN(parseInt(rawReorder, 10)) ? parseInt(rawReorder, 10) : 0;
        const newCost = rawCost !== '' && !isNaN(parseFloat(rawCost)) ? parseFloat(rawCost) : 0;
        const newLocation = rawLocation || null;

        if (existing) {
            const diffs = [];
            if ((existing.description || '') !== (newDesc || '')) diffs.push(`Description: "${existing.description || ''}" → "${newDesc || ''}"`);
            if ((existing.uom || 'Nos') !== newUom) diffs.push(`UoM: ${existing.uom || 'Nos'} → ${newUom}`);
            if ((existing.stock_qty || 0) !== newStock) diffs.push(`Stock: ${existing.stock_qty || 0} → ${newStock}`);
            if ((existing.reorder_level || 0) !== newReorder) diffs.push(`Reorder: ${existing.reorder_level || 0} → ${newReorder}`);
            if ((existing.unit_cost || 0) !== newCost) diffs.push(`Cost: ${existing.unit_cost || 0} → ${newCost}`);
            if ((existing.location || '') !== (newLocation || '')) diffs.push(`Location: "${existing.location || ''}" → "${newLocation || ''}"`);

            if (diffs.length) {
                changes.push({
                    type: 'update',
                    part_id: existing.id,
                    part_code: existing.part_code,
                    summary: diffs.join('; '),
                    payload: { description: newDesc, uom: newUom, stock_qty: newStock, reorder_level: newReorder, unit_cost: newCost, location: newLocation }
                });
            }
            return;
        }

        const embeddedMatch = findMatchInDescriptions(rawCode, existingParts);
        if (embeddedMatch) {
            const diffs = [`Matched via description to existing part ${embeddedMatch.part_code}`];
            if ((embeddedMatch.uom || 'Nos') !== newUom) diffs.push(`UoM: ${embeddedMatch.uom || 'Nos'} → ${newUom}`);
            if ((embeddedMatch.stock_qty || 0) !== newStock) diffs.push(`Stock: ${embeddedMatch.stock_qty || 0} → ${newStock}`);
            if ((embeddedMatch.reorder_level || 0) !== newReorder) diffs.push(`Reorder: ${embeddedMatch.reorder_level || 0} → ${newReorder}`);
            if ((embeddedMatch.unit_cost || 0) !== newCost) diffs.push(`Cost: ${embeddedMatch.unit_cost || 0} → ${newCost}`);
            if ((embeddedMatch.location || '') !== (newLocation || '')) diffs.push(`Location: "${embeddedMatch.location || ''}" → "${newLocation || ''}"`);

            changes.push({
                type: 'update',
                part_id: embeddedMatch.id,
                part_code: embeddedMatch.part_code,
                summary: diffs.join('; '),
                payload: { uom: newUom, stock_qty: newStock, reorder_level: newReorder, unit_cost: newCost, location: newLocation }
            });
            return;
        }

        const descSuggestion = newDesc ? getCloseDescriptionMatches(newDesc, existingParts, 1, 0.6)[0] : null;
        changes.push({
            type: 'new',
            part_code: rawCode,
            summary: descSuggestion
                ? `New code, but its description is ${Math.round(descSuggestion.score * 100)}% similar to existing part "${descSuggestion.part.part_code}" — check this isn't a duplicate before adding.`
                : 'Not found in current inventory — will be added as a new part.',
            payload: { part_code: rawCode, description: newDesc, uom: newUom, stock_qty: newStock, reorder_level: newReorder, unit_cost: newCost, location: newLocation }
        });
    });

    hideProgress();
    lastStockListChanges = changes;
    btn.disabled = false;
    btn.innerText = 'Compare & Preview Changes';

    if (changes.length === 0) {
        resultsDiv.innerHTML = '<p style="color: var(--text-muted);">No differences found — the uploaded list matches current inventory.</p>';
        return;
    }

    let html = `
        <p style="color: var(--text-muted); font-size: 13px;">${changes.length} row(s) have changes or are new. Review and select which to apply.</p>
        <div style="margin-bottom: 15px; display:flex; gap:10px;">
            <button class="btn-secondary" onclick="selectAllStockListChanges(true)">Select All</button>
            <button class="btn-secondary" onclick="selectAllStockListChanges(false)">Select None</button>
            <button class="btn-primary" onclick="applyStockListChanges()">Apply Selected Updates</button>
        </div>
        <table>
            <thead><tr><th></th><th>PART CODE</th><th>TYPE</th><th>CHANGES</th></tr></thead>
            <tbody>
    `;
    changes.forEach((c, idx) => {
        html += `<tr>
            <td><input type="checkbox" class="stock-list-change-checkbox" data-idx="${idx}" checked></td>
            <td>${c.part_code}</td>
            <td><span class="badge ${c.type === 'new' ? 'fuzzy' : 'exact'}">${c.type === 'new' ? 'new part' : 'update'}</span></td>
            <td style="font-size:12px;">${c.summary}</td>
        </tr>`;
    });
    html += `</tbody></table>`;
    resultsDiv.innerHTML = html;
}

function selectAllStockListChanges(checked) {
    document.querySelectorAll('.stock-list-change-checkbox').forEach(cb => { cb.checked = checked; });
}

async function applyStockListChanges() {
    const checkedIdxs = Array.from(document.querySelectorAll('.stock-list-change-checkbox:checked'))
        .map(cb => parseInt(cb.dataset.idx, 10));
    if (checkedIdxs.length === 0) { alert('Select at least one row to apply.'); return; }
    if (!confirm(`Apply ${checkedIdxs.length} change(s) to inventory?`)) return;

    showProgress('Applying Changes...', `Writing ${checkedIdxs.length} updates...`);
    const toInsert = [];
    const toUpdate = [];

    for (const idx of checkedIdxs) {
        const change = lastStockListChanges[idx];
        if (!change) continue;
        if (change.type === 'update') {
            toUpdate.push({ id: change.part_id, payload: change.payload });
        } else {
            toInsert.push(change.payload);
        }
    }

    let added = 0, updated = 0, failed = 0;

    // Batch inserts
    const CHUNK_SIZE = 500;
    for (let i = 0; i < toInsert.length; i += CHUNK_SIZE) {
        const chunk = toInsert.slice(i, i + CHUNK_SIZE);
        const { error } = await supabaseClient.from('parts').insert(chunk);
        if (error) { failed += chunk.length; console.error(error.message); } else added += chunk.length;
        updateProgress((i / (toInsert.length + toUpdate.length)) * 100, `Adding new parts...`);
    }

    // Batch async updates 
    const updateStats = await processInBatchesAsync(toUpdate, 50, async (u) => {
        return await supabaseClient.from('parts').update(u.payload).eq('id', u.id);
    }, (done, total) => {
        updateProgress(((toInsert.length + done) / (toInsert.length + toUpdate.length)) * 100, `Updating existing parts...`);
    });

    updated = updateStats.processed - updateStats.failed;
    failed += updateStats.failed;

    hideProgress();
    alert(`Updated ${updated} part(s), added ${added} new part(s)` + (failed ? `, ${failed} failed (see browser console).` : '.'));
    
    document.getElementById('stock-list-results').innerHTML = '';
    document.getElementById('stock-list-file').value = '';
    loadStats();
    if (currentTab === 'parts') loadInventory();
    if (currentTab === 'low-stock') loadLowStock();
}

// ---------------------------------------------------------------------------
// Modals & scanners
// ---------------------------------------------------------------------------
function openPdfViewer(url) {
    document.getElementById('pdf-iframe').src = url;
    document.getElementById('pdf-modal').style.display = 'block';
}

function closePdfViewer() {
    document.getElementById('pdf-iframe').src = '';
    document.getElementById('pdf-modal').style.display = 'none';
}

function openScanner(targetInputId) {
    document.getElementById('scanner-modal').style.display = 'flex';
    html5QrcodeScanner = new Html5QrcodeScanner('reader', { fps: 10, qrbox: { width: 250, height: 250 } }, false);
    html5QrcodeScanner.render((decodedText) => {
        closeScanner();
        document.getElementById(targetInputId).value = decodedText;
        if (targetInputId === 'part-search-input') loadInventory();
    }, () => {});
}

function closeScanner() {
    document.getElementById('scanner-modal').style.display = 'none';
    if (html5QrcodeScanner) html5QrcodeScanner.clear();
}

if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
}

async function extractPdfLines(url, onProgress) {
    const pdf = await pdfjsLib.getDocument({ url, isEvalSupported: false }).promise;
    const lines = [];
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        if (onProgress) onProgress(pageNum, pdf.numPages);
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();
        let lastY = null;
        let currentLine = [];
        textContent.items.forEach(item => {
            const y = Math.round(item.transform[5]);
            if (lastY !== null && Math.abs(y - lastY) > 2) {
                if (currentLine.length) lines.push(currentLine.join(' ').replace(/\s+/g, ' ').trim());
                currentLine = [];
            }
            currentLine.push(item.str);
            lastY = y;
        });
        if (currentLine.length) lines.push(currentLine.join(' ').replace(/\s+/g, ' ').trim());
    }
    return lines.filter(l => l.length > 0);
}

function extractPartCandidates(lines) {
    const candidates = [];
    const seen = new Set();

    const tabularRe = /^(\d{1,3})[\s.)]+([A-Za-z0-9][A-Za-z0-9\-/]{2,24})\s+(.+?)\s+(\d{1,5})\s*[A-Za-z.]{0,6}\s*$/;
    const labeledRe = /(?:part\s*(?:no\.?|number|#)|p\/n|item\s*(?:no\.?|#)|ref\.?\s*no\.?)[:\s]+([A-Za-z0-9][A-Za-z0-9\-/.]{2,24})/i;
    const codeTokenRe = /\b(?=[A-Za-z0-9\-/]{4,20}\b)(?=[A-Za-z0-9\-/]*[A-Za-z])(?=[A-Za-z0-9\-/]*\d)[A-Za-z0-9\-/]{4,20}\b/g;
    const qtyRe = /\bqty\.?\s*[:\-]?\s*(\d{1,4})\b/i;

    lines.forEach(line => {
        const tabMatch = line.match(tabularRe);
        if (tabMatch) {
            const [, pos, code, description, qty] = tabMatch;
            const upperCode = code.toUpperCase();
            if (!seen.has(upperCode)) {
                seen.add(upperCode);
                candidates.push({
                    pos,
                    code: upperCode,
                    description: description.trim().slice(0, 120),
                    qty: parseInt(qty, 10),
                    confidence: 'table'
                });
            }
            return;
        }

        const labeledMatch = line.match(labeledRe);
        if (labeledMatch) {
            const code = labeledMatch[1].toUpperCase();
            if (!seen.has(code)) {
                seen.add(code);
                const qtyMatch = line.match(qtyRe);
                candidates.push({
                    pos: null,
                    code,
                    description: line.replace(labeledMatch[0], '').trim().slice(0, 120),
                    qty: qtyMatch ? parseInt(qtyMatch[1], 10) : null,
                    confidence: 'high'
                });
            }
            return; 
        }

        const wordCount = line.split(/\s+/).length;
        if (wordCount > 12) return; 

        const matches = line.match(codeTokenRe);
        if (!matches) return;
        matches.forEach(code => {
            const upper = code.toUpperCase();
            if (seen.has(upper) || /^\d+$/.test(upper)) return;
            seen.add(upper);
            const qtyMatch = line.match(qtyRe);
            candidates.push({
                pos: null,
                code: upper,
                description: line.replace(code, '').trim().slice(0, 120),
                qty: qtyMatch ? parseInt(qtyMatch[1], 10) : null,
                confidence: 'low'
            });
        });
    });

    return candidates.slice(0, 200); 
}

async function ocrPdfLines(url, onProgress) {
    const pdf = await pdfjsLib.getDocument({ url, isEvalSupported: false }).promise;
    const lines = [];
    const total = pdf.numPages;
    let currentPage = 0;

    const worker = await Tesseract.createWorker('eng', 1, {
        logger: (m) => {
            if (onProgress && m.status === 'recognizing text') {
                onProgress(currentPage, total, Math.round((m.progress || 0) * 100));
            }
        }
    });

    try {
        for (let pageNum = 1; pageNum <= total; pageNum++) {
            currentPage = pageNum;
            if (onProgress) onProgress(pageNum, total, 0);
            const page = await pdf.getPage(pageNum);
            const viewport = page.getViewport({ scale: 2 });
            const canvas = document.createElement('canvas');
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            const ctx = canvas.getContext('2d');
            await page.render({ canvasContext: ctx, viewport }).promise;

            const { data } = await worker.recognize(canvas);
            data.text.split(/\r?\n/).forEach(l => { if (l.trim()) lines.push(l.trim()); });
        }
    } finally {
        await worker.terminate();
    }

    return lines;
}

async function scanManualForParts(publicUrl, machineId, assemblyLabel, forceOcr) {
    const modal = document.getElementById('parts-review-modal');
    const tbody = document.getElementById('parts-review-tbody');
    const statusEl = document.getElementById('parts-review-status');
    const progressWrap = document.getElementById('ocr-progress-wrap');
    const progressFill = document.getElementById('ocr-progress-fill');

    tbody.innerHTML = '';
    document.getElementById('parts-review-actions-left').innerHTML = '';
    progressWrap.style.display = 'none';
    progressFill.style.width = '0%';
    statusEl.innerText = 'Loading PDF...';
    modal.style.display = 'flex';
    modal.dataset.machineId = machineId;
    modal.dataset.assemblyLabel = assemblyLabel;
    modal.dataset.publicUrl = publicUrl;

    try {
        let lines = [];
        let usedOcr = false;

        if (!forceOcr) {
            lines = await extractPdfLines(publicUrl, (page, total) => {
                statusEl.innerText = `Scanning page ${page} of ${total}...`;
            });
        }

        if (lines.length === 0) {
            usedOcr = true;
            statusEl.innerText = forceOcr
                ? 'Running OCR (loading OCR engine first — this can take a moment on first use)...'
                : 'No embedded text found — this looks like a scanned manual. Falling back to OCR (loading OCR engine first — this can take a moment on first use)...';
            progressWrap.style.display = 'block';

            lines = await ocrPdfLines(publicUrl, (page, total, pct) => {
                const overallPct = Math.round(((page - 1) + (pct / 100)) / total * 100);
                progressFill.style.width = overallPct + '%';
                statusEl.innerText = `OCR: page ${page} of ${total} (${overallPct}% overall)...`;
            });

            progressWrap.style.display = 'none';
        }

        if (lines.length === 0) {
            statusEl.innerText = usedOcr
                ? 'OCR ran but found no readable text on any page — the scan quality may be too low, or the pages may be blank.'
                : 'No text found in this PDF.';
            return;
        }

        const candidates = extractPartCandidates(lines);
        if (candidates.length === 0) {
            statusEl.innerText = `Scanned ${lines.length} line(s) of text but found no likely part numbers. You can still add parts manually from the Parts tab.`;
            renderOcrRetryOption(usedOcr);
            return;
        }

        statusEl.innerText =
            `Found ${candidates.length} candidate part number(s) across ${lines.length} line(s). ` +
            `Table rows and explicit "Part No"/"P/N" labels are pre-checked — review the rest before adding.` +
            (usedOcr ? ' Results came from OCR, so double-check codes for recognition mistakes (e.g. "0" vs "O", "1" vs "I").' : '');

        const existingParts = await fetchAllPages(supabaseClient.from('parts').select('id, part_code, description'));
        const byNormCode = {};
        (existingParts || []).forEach(p => { byNormCode[normalizeCode(p.part_code)] = p; });

        candidates.forEach(c => {
            const badgeClass = c.confidence === 'low' ? 'fuzzy' : 'exact';
            const checked = c.confidence !== 'low';

            const resolved = byNormCode[normalizeCode(c.code)] || findMatchInDescriptions(c.code, existingParts || []);
            const sapCodeValue = resolved ? resolved.part_code : '';
            const matchBadge = resolved
                ? `<span class="badge exact">existing</span>`
                : `<span class="badge fuzzy">new</span>`;
            const descValue = resolved
                ? resolved.description || ''
                : `${c.description || ''}${c.description ? ' — ' : ''}Ref: ${c.code}`;

            tbody.innerHTML += `<tr>
                <td><input type="checkbox" class="candidate-checkbox" ${checked ? 'checked' : ''}></td>
                <td><input type="text" class="candidate-pos" value="${c.pos || ''}" style="width:45px;"></td>
                <td><input type="text" class="candidate-code" value="${c.code.replace(/"/g, '&quot;')}" style="width:100px;" title="Code as read from the manual"></td>
                <td><input type="text" class="candidate-desc" value="${descValue.replace(/"/g, '&quot;')}" style="width:200px;"></td>
                <td><input type="text" class="candidate-sap-code" value="${sapCodeValue.replace(/"/g, '&quot;')}" style="width:110px;" placeholder="assign code" title="Your internal Item No./SAP code"></td>
                <td><input type="number" class="candidate-qty" value="${c.qty || 1}" style="width:55px;"></td>
                <td><span class="badge ${badgeClass}">${c.confidence}</span></td>
                <td>${matchBadge}</td>
                <td><button class="btn-danger" onclick="this.closest('tr').remove()" style="padding:4px 8px; font-size:11px;">Remove</button></td>
            </tr>`;
        });

        renderOcrRetryOption(usedOcr);
    } catch (err) {
        progressWrap.style.display = 'none';
        statusEl.innerText = 'Error scanning PDF: ' + err.message;
    }
}

function renderOcrRetryOption(usedOcr) {
    const wrap = document.getElementById('parts-review-actions-left');
    wrap.innerHTML = usedOcr
        ? ''
        : `<button class="btn-secondary" onclick="retryWithOcr()">Try OCR Instead</button>`;
}

function retryWithOcr() {
    const modal = document.getElementById('parts-review-modal');
    scanManualForParts(modal.dataset.publicUrl, modal.dataset.machineId, modal.dataset.assemblyLabel, true);
}

function selectAllCandidates(checked) {
    document.querySelectorAll('.candidate-checkbox').forEach(cb => { cb.checked = checked; });
}

function closePartsReviewModal() {
    document.getElementById('parts-review-modal').style.display = 'none';
}

async function findOrCreateAssembly(machineId, label) {
    const { data: existing } = await supabaseClient
        .from('assemblies').select('id').eq('machine_id', machineId).eq('drawing_code', label).limit(1);
    if (existing && existing.length) return existing[0].id;

    const { data: inserted, error } = await supabaseClient
        .from('assemblies').insert({ machine_id: machineId, drawing_code: label, name: label })
        .select('id').single();
    if (error) throw error;
    return inserted.id;
}

async function confirmAddCandidateParts() {
    const modal = document.getElementById('parts-review-modal');
    const machineId = modal.dataset.machineId;
    const assemblyLabel = modal.dataset.assemblyLabel;

    const rows = document.querySelectorAll('#parts-review-tbody tr');
    const selected = [];
    rows.forEach(row => {
        if (!row.querySelector('.candidate-checkbox').checked) return;
        selected.push({
            pos: row.querySelector('.candidate-pos').value.trim(),
            manualCode: row.querySelector('.candidate-code').value.trim(),
            description: row.querySelector('.candidate-desc').value.trim(),
            sapCode: row.querySelector('.candidate-sap-code').value.trim(),
            qty: parseInt(row.querySelector('.candidate-qty').value, 10) || 1
        });
    });
    if (selected.length === 0) { alert('Select at least one part to add.'); return; }

    const missingSapCode = selected.filter(c => !c.sapCode).length;
    if (missingSapCode > 0) {
        const proceed = confirm(
            `${missingSapCode} selected row(s) don't have a SAP code assigned yet, so they'll be skipped. ` +
            `Fill in the "SAP CODE" column for those rows first if you want them added.\n\nContinue with the rest?`
        );
        if (!proceed) return;
    }

    showProgress('Adding Parts...', 'Linking and inserting candidate parts...');

    const existingParts = await fetchAllPages(supabaseClient.from('parts').select('id, part_code'));
    const byNorm = {};
    (existingParts || []).forEach(p => { byNorm[normalizeCode(p.part_code)] = p; });

    let assemblyId = null;
    if (machineId) {
        try {
            assemblyId = await findOrCreateAssembly(machineId, assemblyLabel);
        } catch (err) {
            console.error('Could not create/find assembly link:', err.message);
        }
    }

    let added = 0, matched = 0, linked = 0, skipped = 0;
    
    for (let i = 0; i < selected.length; i++) {
        const cand = selected[i];
        if (!cand.sapCode) { skipped++; continue; }
        const norm = normalizeCode(cand.sapCode);
        let partId;

        if (byNorm[norm]) {
            partId = byNorm[norm].id;
            matched++;
        } else {
            const { data: inserted, error } = await supabaseClient.from('parts').insert({
                part_code: cand.sapCode,
                description: cand.description || null,
                uom: 'Nos',
                stock_qty: 0,
                reorder_level: 0,
                unit_cost: 0
            }).select('id').single();
            if (error) { console.error(error.message); continue; }
            partId = inserted.id;
            byNorm[norm] = { id: partId, part_code: cand.sapCode };
            added++;
        }

        if (assemblyId) {
            const { data: existingLink } = await supabaseClient
                .from('assembly_parts').select('id').eq('assembly_id', assemblyId).eq('part_id', partId).limit(1);
            if (!existingLink || existingLink.length === 0) {
                await supabaseClient.from('assembly_parts').insert({
                    assembly_id: assemblyId, part_id: partId, quantity: cand.qty || 1, position: cand.pos || null
                });
                linked++;
            }
        }
        updateProgress((i / selected.length) * 100, `Processed ${i + 1} of ${selected.length} items...`);
    }

    hideProgress();
    alert(
        `Added ${added} new part(s), matched ${matched} already in inventory` +
        (assemblyId ? `, linked ${linked} to this machine` : '') +
        (skipped ? `, skipped ${skipped} row(s) with no SAP code.` : '.')
    );
    closePartsReviewModal();
    loadStats();
    if (currentTab === 'parts') loadInventory();
}