// ---------------------------------------------------------------------------
// Supabase client
// ---------------------------------------------------------------------------
const supabaseClient = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

let currentTab = 'parts';
let paretoChartInstance = null;
let html5QrcodeScanner = null;
let lastStockCheckResults = [];

document.addEventListener('DOMContentLoaded', () => {
    loadMachinesDropdown();
    loadAllData();
    const bdDate = document.getElementById('bd-date');
    if (bdDate) bdDate.value = new Date().toISOString().slice(0, 10);
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

// Mirrors the old backend's "which parts belong to this machine's assemblies" scoping.
// Returns null for "all machines", otherwise a (possibly empty) array of part ids.
async function scopedPartIds(machineId) {
    if (!machineId || machineId === 'all' || machineId === '0') return null;

    const assemblies = await fetchAllRows(() =>
        supabaseClient.from('assemblies').select('id').eq('machine_id', machineId)
    );
    const assemblyIds = assemblies.map(a => a.id);
    if (assemblyIds.length === 0) return [];

    const apRows = await fetchAllRows(() =>
        supabaseClient.from('assembly_parts').select('part_id').in('assembly_id', assemblyIds)
    );
    return [...new Set(apRows.map(r => r.part_id))];
}

// Supabase/PostgREST caps any single request at a server-side row limit
// (1000 by default) — silently, with no error, so a table past that size
// looks fine until you actually have that many rows. This fetches every
// page until the results run out, so counts and listings are always
// complete regardless of table size. `buildQuery` must be a function that
// returns a FRESH query each call, since a query builder can't be reused
// after `.range()` executes it.
async function fetchAllRows(buildQuery, pageSize = 1000) {
    let allRows = [];
    let from = 0;
    while (true) {
        const { data, error } = await buildQuery().range(from, from + pageSize - 1);
        if (error) { console.error(error); break; }
        if (!data || data.length === 0) break;
        allRows = allRows.concat(data);
        if (data.length < pageSize) break;
        from += pageSize;
    }
    return allRows;
}

function chunkArray(arr, size) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
    return chunks;
}

// Reusable progress overlay for any operation touching more than a handful
// of rows (bulk inserts/updates, matching against a large inventory, etc.).
function showGlobalProgress(title) {
    document.getElementById('global-progress-title').innerText = title;
    document.getElementById('global-progress-fill').style.width = '0%';
    document.getElementById('global-progress-text').innerText = 'Starting...';
    document.getElementById('global-progress-overlay').style.display = 'flex';
}

function updateGlobalProgress(done, total, label) {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    document.getElementById('global-progress-fill').style.width = pct + '%';
    document.getElementById('global-progress-text').innerText = label || `${done} of ${total} (${pct}%)`;
}

function hideGlobalProgress() {
    document.getElementById('global-progress-overlay').style.display = 'none';
}

async function fetchScopedParts(machineId, selectCols = '*') {
    const partIds = await scopedPartIds(machineId);
    if (partIds !== null && partIds.length === 0) return [];

    return fetchAllRows(() => {
        let query = supabaseClient.from('parts').select(selectCols);
        if (partIds !== null) query = query.in('id', partIds);
        return query;
    });
}

function normalizeCode(code) {
    return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// LCS-based similarity, approximating Python's difflib.SequenceMatcher.ratio()
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

// Matches your real-world convention: manufacturer part numbers from manuals
// often live inside the Description text, not as the Item No./internal code
// itself. Checks whether `code` (normalized) appears as a substring inside any
// part's normalized description. Requires 5+ alphanumeric chars to avoid false
// hits from short codes matching by coincidence.
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

// Matches an input description against existing parts' descriptions, so a
// misspelled or reformatted part code can still be caught by name similarity.
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

    const machines = await fetchAllRows(() => supabaseClient.from('machines').select('id'));
    const totalMachines = machines.length;

    const openBd = await fetchAllRows(() => {
        let q = supabaseClient.from('breakdowns').select('id').is('resolved_at', null);
        if (machineId && machineId !== 'all' && machineId !== '0') q = q.eq('machine_id', machineId);
        return q;
    });
    const openBreakdowns = openBd.length;

    document.getElementById('stat-total').innerText = totalParts;
    document.getElementById('stat-low').innerText = lowStock;
    document.getElementById('stat-machines').innerText = totalMachines;
    document.getElementById('stat-breakdowns').innerText = openBreakdowns;
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
        document.getElementById('manual-machine'),
        document.getElementById('edit-bd-machine')
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
const INVENTORY_PAGE_SIZE = 200;
let currentInventoryData = [];
let inventoryPage = 0;

async function loadInventory() {
    const machineId = document.getElementById('global-machine-select').value;
    const q = document.getElementById('part-search-input').value.trim();
    const partIds = await scopedPartIds(machineId);

    if (partIds !== null && partIds.length === 0) { renderParts([]); return; }

    const data = await fetchAllRows(() => {
        let query = supabaseClient.from('parts').select('*');
        if (partIds !== null) query = query.in('id', partIds);
        if (q) query = query.or(`part_code.ilike.%${q}%,description.ilike.%${q}%`);
        return query.order('part_code');
    });
    renderParts(data);
}

function renderParts(data) {
    currentInventoryData = data;
    inventoryPage = 0;
    renderInventoryPage();
}

function changeInventoryPage(direction) {
    const maxPage = Math.max(0, Math.ceil(currentInventoryData.length / INVENTORY_PAGE_SIZE) - 1);
    inventoryPage = Math.min(maxPage, Math.max(0, inventoryPage + direction));
    renderInventoryPage();
}

function renderInventoryPage() {
    const tbody = document.getElementById('parts-tbody');
    tbody.innerHTML = '';
    document.getElementById('parts-select-all').checked = false;
    document.getElementById('parts-select-all').indeterminate = false;
    updateBulkDeleteButton();

    const total = currentInventoryData.length;
    const totalPages = Math.max(1, Math.ceil(total / INVENTORY_PAGE_SIZE));
    document.getElementById('parts-prev-btn').disabled = inventoryPage === 0;
    document.getElementById('parts-next-btn').disabled = inventoryPage >= totalPages - 1;
    document.getElementById('parts-page-label').innerText = `Page ${inventoryPage + 1} of ${totalPages}`;

    if (total === 0) {
        tbody.innerHTML = `<tr class="empty-row"><td colspan="9">No parts found.</td></tr>`;
        document.getElementById('parts-count-label').innerText = 'No parts found.';
        return;
    }

    const start = inventoryPage * INVENTORY_PAGE_SIZE;
    const end = Math.min(start + INVENTORY_PAGE_SIZE, total);
    document.getElementById('parts-count-label').innerText = `Showing ${start + 1}-${end} of ${total} part(s)`;

    currentInventoryData.slice(start, end).forEach(p => {
        tbody.innerHTML += `<tr>
            <td><input type="checkbox" class="part-checkbox" data-id="${p.id}" data-code="${p.part_code.replace(/"/g, '&quot;')}" onchange="updateBulkDeleteButton()"></td>
            <td>${p.part_code}</td><td>${p.description || '-'}</td><td>${p.uom || 'Nos'}</td>
            <td>${p.stock_qty}</td><td>${p.reorder_level}</td><td>$${p.unit_cost || '0.00'}</td>
            <td><button class="btn-secondary" onclick="downloadQr('${p.part_code.replace(/'/g, "\\'")}')">⬇️</button></td>
            <td><button class="btn-danger" onclick="deletePart(${p.id}, '${p.part_code.replace(/'/g, "\\'")}')">Delete</button></td>
        </tr>`;
    });
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

// --- Add Part ---
function toggleAddPartForm() {
    const form = document.getElementById('add-part-form');
    const isHidden = form.style.display === 'none';
    form.style.display = isHidden ? 'block' : 'none';
    document.getElementById('add-part-toggle-btn').innerText = isHidden ? 'Cancel' : '+ Add Part';
}

// ---------------------------------------------------------------------------
// Bulk Add Parts from Excel — adds new parts only. For updating existing
// inventory in bulk, use the Full Stock List round-trip on the Stock Check tab.
// ---------------------------------------------------------------------------
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

    // Auto-detect a header row within the first few rows; fall back to a fixed
    // column order (Code, Description, UoM, Stock, Reorder, Cost, Location) if
    // nothing recognizable is found — covers both this app's own export and
    // arbitrary company sheets like the "Item No. / Description / UoM / Qty" format.
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

    showGlobalProgress('Checking Against Inventory');
    updateGlobalProgress(0, 1, 'Loading current inventory...');
    const existingParts = await fetchAllRows(() => supabaseClient.from('parts').select('id, part_code, description'));
    const byNorm = {};
    existingParts.forEach(p => { byNorm[normalizeCode(p.part_code)] = p; });

    const validRows = dataRows.filter(row => {
        const cells = row.map(c => (c === null || c === undefined) ? '' : String(c).trim());
        const code = colIdx.code >= 0 ? cells[colIdx.code] : '';
        return !!code;
    });

    const parsed = [];
    const CHUNK_SIZE = 200;
    for (let i = 0; i < validRows.length; i += CHUNK_SIZE) {
        const chunk = validRows.slice(i, i + CHUNK_SIZE);
        chunk.forEach(row => {
            const cells = row.map(c => (c === null || c === undefined) ? '' : String(c).trim());
            const code = cells[colIdx.code];

            const description = colIdx.description >= 0 ? cells[colIdx.description] : '';
            const uom = colIdx.uom >= 0 && cells[colIdx.uom] ? cells[colIdx.uom] : 'Nos';
            const stock = colIdx.stock >= 0 && cells[colIdx.stock] !== '' && !isNaN(parseInt(cells[colIdx.stock], 10)) ? parseInt(cells[colIdx.stock], 10) : 0;
            const reorder = colIdx.reorder >= 0 && cells[colIdx.reorder] !== '' && !isNaN(parseInt(cells[colIdx.reorder], 10)) ? parseInt(cells[colIdx.reorder], 10) : 0;
            const cost = colIdx.cost >= 0 && cells[colIdx.cost] !== '' && !isNaN(parseFloat(cells[colIdx.cost])) ? parseFloat(cells[colIdx.cost]) : 0;
            const location = colIdx.location >= 0 ? cells[colIdx.location] : '';

            const norm = normalizeCode(code);
            const exact = byNorm[norm];
            const embedded = !exact ? findMatchInDescriptions(code, existingParts) : null;
            const duplicate = exact || embedded;

            parsed.push({
                code, description, uom, stock, reorder, cost, location,
                duplicateOf: duplicate ? duplicate.part_code : null,
                duplicateVia: exact ? 'code' : (embedded ? 'description' : null)
            });
        });

        updateGlobalProgress(Math.min(i + CHUNK_SIZE, validRows.length), validRows.length, `Checking row ${Math.min(i + CHUNK_SIZE, validRows.length)} of ${validRows.length} against ${existingParts.length} existing part(s)...`);
        await new Promise(r => setTimeout(r, 0)); // yield to keep the tab responsive
    }
    hideGlobalProgress();

    lastBulkAddRows = parsed;
    btn.disabled = false;
    btn.innerText = 'Preview';

    if (parsed.length === 0) {
        resultsDiv.innerHTML = '<p style="color: var(--text-muted);">No rows with a code found in this file.</p>';
        return;
    }

    let html = `
        <p style="color: var(--text-muted); font-size: 13px;">
            ${parsed.length} row(s) found${headerRowIdx >= 0 ? '' : ' — no header row detected, so column order was assumed to be Code, Description, UoM, Stock, Reorder, Cost, Location'},
            checked against ${existingParts.length} existing part(s). Rows already in inventory are unchecked by default.
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

    // Guard against duplicate codes within the uploaded sheet itself
    const seen = new Set();
    const deduped = toInsert.filter(p => {
        const norm = normalizeCode(p.part_code);
        if (seen.has(norm)) return false;
        seen.add(norm);
        return true;
    });

    if (!confirm(`Add ${deduped.length} new part(s) to inventory?`)) return;

    showGlobalProgress('Adding Parts');
    const BATCH_SIZE = 500;
    const batches = chunkArray(deduped, BATCH_SIZE);
    let processed = 0, failed = 0;

    for (const batch of batches) {
        // upsert (not insert) so a row that turns out to already exist updates
        // in place instead of erroring out the whole batch.
        const { error } = await supabaseClient.from('parts').upsert(batch, { onConflict: 'part_code' });
        if (error) { failed += batch.length; console.error(error.message); }
        processed += batch.length;
        updateGlobalProgress(processed, deduped.length, `Adding part ${processed} of ${deduped.length}...`);
    }

    hideGlobalProgress();
    alert(`Added/updated ${processed - failed} part(s)` + (failed ? `, ${failed} failed (see browser console).` : '.'));
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
        const resolveBtn = isResolved
            ? `<span style="color: var(--text-muted); font-size: 12px;">${b.resolution ? b.resolution : '-'}</span>`
            : `<button class="btn-secondary" onclick="resolveBreakdown(${b.id})">Resolve</button>`;
        tbody.innerHTML += `<tr>
            <td>${dateStr}</td>
            <td>${b.machines ? b.machines.name : '-'}</td>
            <td>${b.parts ? b.parts.part_code : '-'}</td>
            <td>${b.description}</td>
            <td>${statusBadge}</td>
            <td style="display:flex; gap:6px; flex-wrap:wrap; align-items:center;">
                ${resolveBtn}
                <button class="btn-secondary" onclick="openEditBreakdownModal(${b.id})">Edit</button>
                <button class="btn-danger" onclick="deleteBreakdown(${b.id})">Delete</button>
            </td>
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

async function deleteBreakdown(breakdownId) {
    if (!confirm('Delete this breakdown record? If it had a part/quantity linked, that quantity will be added back to stock. This cannot be undone.')) return;

    const { data: existing } = await supabaseClient
        .from('breakdowns').select('part_id, qty_used').eq('id', breakdownId).single();

    await supabaseClient.from('breakdowns').delete().eq('id', breakdownId);

    if (existing && existing.part_id && existing.qty_used) {
        await adjustPartStock(existing.part_id, existing.qty_used); // give the stock back
    }

    loadBreakdowns();
    loadStats();
    if (currentTab === 'parts') loadInventory();
    if (currentTab === 'low-stock') loadLowStock();
}

let editingBreakdownOriginal = null;

async function openEditBreakdownModal(breakdownId) {
    const { data: b, error } = await supabaseClient
        .from('breakdowns').select('*, parts(part_code)').eq('id', breakdownId).single();
    if (error || !b) { alert('Could not load this breakdown.'); return; }

    editingBreakdownOriginal = { id: b.id, part_id: b.part_id, qty_used: b.qty_used || 0, resolved_at: b.resolved_at };

    document.getElementById('edit-bd-machine').value = b.machine_id;
    document.getElementById('edit-bd-date').value = new Date(b.reported_at).toISOString().slice(0, 10);
    document.getElementById('edit-bd-part').value = b.parts ? b.parts.part_code : '';
    document.getElementById('edit-bd-qty').value = b.qty_used || 0;
    document.getElementById('edit-bd-reporter').value = b.reported_by || '';
    document.getElementById('edit-bd-desc').value = b.description || '';
    document.getElementById('edit-bd-resolved').checked = !!b.resolved_at;
    document.getElementById('edit-bd-resolution').value = b.resolution || '';
    toggleEditResolutionField();

    document.getElementById('edit-breakdown-modal').style.display = 'flex';
}

function toggleEditResolutionField() {
    const checked = document.getElementById('edit-bd-resolved').checked;
    document.getElementById('edit-bd-resolution-wrap').style.display = checked ? 'block' : 'none';
}

function closeEditBreakdownModal() {
    document.getElementById('edit-breakdown-modal').style.display = 'none';
    editingBreakdownOriginal = null;
}

async function saveBreakdownEdit() {
    if (!editingBreakdownOriginal) return;

    const machineId = document.getElementById('edit-bd-machine').value;
    const dateValue = document.getElementById('edit-bd-date').value;
    const partCode = document.getElementById('edit-bd-part').value.trim();
    const qtyUsed = parseInt(document.getElementById('edit-bd-qty').value, 10) || 0;
    const reportedBy = document.getElementById('edit-bd-reporter').value.trim();
    const description = document.getElementById('edit-bd-desc').value.trim();
    const isResolved = document.getElementById('edit-bd-resolved').checked;
    const resolution = document.getElementById('edit-bd-resolution').value.trim();

    if (!machineId) { alert('Please select a machine.'); return; }
    if (!description) { alert('Please describe the breakdown.'); return; }

    let newPartId = null;
    if (partCode) {
        const resolved = await resolvePartIdFromCode(partCode);
        newPartId = resolved.partId;
        if (resolved.notFound) { alert(`No part found matching "${partCode}".`); return; }
    }

    const payload = {
        machine_id: machineId,
        part_id: newPartId,
        qty_used: qtyUsed,
        reported_by: reportedBy || null,
        description,
        reported_at: dateInputToTimestamp(dateValue),
        resolved_at: isResolved ? (editingBreakdownOriginal.resolved_at || new Date().toISOString()) : null,
        resolution: isResolved ? (resolution || null) : null
    };

    const { error } = await supabaseClient.from('breakdowns').update(payload).eq('id', editingBreakdownOriginal.id);
    if (error) { alert('Error saving changes: ' + error.message); return; }

    // Reconcile stock: undo the old impact, apply the new one.
    const { part_id: oldPartId, qty_used: oldQty } = editingBreakdownOriginal;
    if (oldPartId && oldQty) await adjustPartStock(oldPartId, oldQty); // give back what the old entry took
    if (newPartId && qtyUsed) await adjustPartStock(newPartId, -qtyUsed); // take what the new entry uses

    closeEditBreakdownModal();
    loadBreakdowns();
    loadStats();
    if (currentTab === 'parts') loadInventory();
    if (currentTab === 'low-stock') loadLowStock();
}

// Looks up a part by typed code, preferring an exact match over a partial one.
// Shared between logging and editing a breakdown.
async function resolvePartIdFromCode(partCode) {
    if (!partCode) return null;
    const { data: matches } = await supabaseClient
        .from('parts').select('id, part_code').ilike('part_code', `%${partCode}%`);
    if (!matches || matches.length === 0) return { partId: null, notFound: true };
    const exact = matches.find(p => p.part_code.toLowerCase() === partCode.toLowerCase());
    return { partId: exact ? exact.id : matches[0].id, notFound: false };
}

// Adds qty back to a part's stock — used both to reverse a breakdown's stock
// impact (on edit/delete) and, negated, to apply it (on create/edit).
async function adjustPartStock(partId, delta) {
    if (!partId || !delta) return;
    const { data: partRow } = await supabaseClient.from('parts').select('stock_qty').eq('id', partId).single();
    if (partRow) {
        const newQty = Math.max(0, (partRow.stock_qty || 0) + delta);
        await supabaseClient.from('parts').update({ stock_qty: newQty }).eq('id', partId);
    }
}

// Converts a plain <input type="date"> value into a timestamp for reported_at.
// Uses noon UTC rather than midnight so the date doesn't shift a day back in
// timezones behind UTC when displayed.
function dateInputToTimestamp(dateValue) {
    if (!dateValue) return new Date().toISOString();
    return new Date(dateValue + 'T12:00:00Z').toISOString();
}

async function logBreakdown() {
    const machineId = document.getElementById('bd-machine').value;
    const description = document.getElementById('bd-desc').value.trim();
    const partCode = document.getElementById('bd-part').value.trim();
    const qtyUsed = parseInt(document.getElementById('bd-qty').value, 10) || 0;
    const reportedBy = document.getElementById('bd-reporter').value.trim();
    const dateValue = document.getElementById('bd-date').value;

    if (!machineId) { alert('Please select a machine.'); return; }
    if (!description) { alert('Please describe the breakdown.'); return; }

    let partId = null;
    if (partCode) {
        const resolved = await resolvePartIdFromCode(partCode);
        partId = resolved.partId;
        if (resolved.notFound) alert(`No part found matching "${partCode}". Logging breakdown without a linked part.`);
    }

    await supabaseClient.from('breakdowns').insert({
        machine_id: machineId,
        part_id: partId,
        description,
        reported_by: reportedBy || null,
        qty_used: qtyUsed,
        reported_at: dateInputToTimestamp(dateValue)
    });

    if (partId && qtyUsed) await adjustPartStock(partId, -qtyUsed);

    document.getElementById('bd-desc').value = '';
    document.getElementById('bd-part').value = '';
    document.getElementById('bd-qty').value = '0';
    document.getElementById('bd-reporter').value = '';
    document.getElementById('bd-date').value = new Date().toISOString().slice(0, 10);

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
        const ts = g.timestamps.slice().sort((a, b) => new Date(a) - new Date(b));
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
// Manuals (Supabase Storage)
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
        // Continue anyway — the file may already be gone or the path may be stale;
        // we still want to let the person clean up the orphaned database row.
        console.error('Storage delete error:', storageError.message);
    }

    const { error: dbError } = await supabaseClient.from('manuals').delete().eq('id', manualId);
    if (dbError) { alert('Error deleting manual record: ' + dbError.message); return; }

    loadManuals();
}

// Supabase-js's storage.upload() doesn't expose progress events, so for the
// progress bar we bypass it and talk to the Storage REST endpoint directly
// via XMLHttpRequest, which does support upload progress.
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
                try { message = JSON.parse(xhr.responseText).message || message; } catch (e) { /* not JSON */ }
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

    const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB — Supabase's free-tier default file size limit
    if (file.size > MAX_UPLOAD_BYTES) {
        const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
        alert(
            `"${file.name}" is ${sizeMb} MB, which is over the 50 MB limit.\n\n` +
            `This is Supabase's default per-file limit on the free tier. If you've raised your ` +
            `project's Global file size limit (Storage -> Settings) or upgraded to Pro, you can ` +
            `increase MAX_UPLOAD_BYTES near the top of uploadManual() in app.js to match.`
        );
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

        // Any remaining non-code, non-quantity cell is treated as a description/name,
        // so sheets laid out as [Code, Description, Qty] are picked up naturally.
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

    showGlobalProgress('Matching Against Inventory');
    updateGlobalProgress(0, 1, 'Loading current inventory...');
    const allParts = await fetchAllRows(() => supabaseClient.from('parts').select('id, part_code, description, stock_qty'));

    const byNormCode = {};
    allParts.forEach(p => { byNormCode[normalizeCode(p.part_code)] = p; });
    const allCodesNorm = Object.keys(byNormCode);

    const results = [];
    let matched = 0;
    const CHUNK_SIZE = 100;
    for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
        const chunk = entries.slice(i, i + CHUNK_SIZE);
        chunk.forEach(entry => {
            const norm = normalizeCode(entry.raw_code);
            const exact = byNormCode[norm];
            if (exact) {
                matched++;
                results.push({
                    input_code: entry.raw_code,
                    input_description: entry.description,
                    input_qty: entry.qty,
                    match_type: 'exact',
                    part_id: exact.id,
                    part_code: exact.part_code,
                    description: exact.description,
                    system_qty: exact.stock_qty,
                    delta: entry.qty === null ? null : entry.qty - exact.stock_qty,
                    suggestions: []
                });
                return;
            }

            // Your real-world convention: the manufacturer code often isn't the Item
            // No. itself, but is embedded inside an existing part's Description.
            const embeddedMatch = findMatchInDescriptions(entry.raw_code, allParts);
            if (embeddedMatch) {
                matched++;
                results.push({
                    input_code: entry.raw_code,
                    input_description: entry.description,
                    input_qty: entry.qty,
                    match_type: 'exact',
                    matched_via: 'description',
                    part_id: embeddedMatch.id,
                    part_code: embeddedMatch.part_code,
                    description: embeddedMatch.description,
                    system_qty: embeddedMatch.stock_qty,
                    delta: entry.qty === null ? null : entry.qty - embeddedMatch.stock_qty,
                    suggestions: []
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

            // Merge both sources, keeping the best score per part, capped at 3 suggestions.
            const merged = {};
            [...codeMatches, ...descMatches].forEach(s => {
                if (!merged[s.part_id] || merged[s.part_id].similarity < s.similarity) merged[s.part_id] = s;
            });
            const suggestions = Object.values(merged).sort((a, b) => b.similarity - a.similarity).slice(0, 3);

            results.push({
                input_code: entry.raw_code, input_description: entry.description, input_qty: entry.qty,
                match_type: suggestions.length ? 'fuzzy' : 'unmatched',
                part_id: null, part_code: null, description: null, system_qty: null, delta: null,
                suggestions
            });
        });

        updateGlobalProgress(Math.min(i + CHUNK_SIZE, entries.length), entries.length, `Matching entry ${Math.min(i + CHUNK_SIZE, entries.length)} of ${entries.length} against ${allParts.length} part(s)...`);
        await new Promise(r => setTimeout(r, 0)); // yield to keep the tab responsive
    }
    hideGlobalProgress();

    const unmatched = entries.length - matched;
    await supabaseClient.from('stock_check_uploads').insert({
        filename: file.name, row_count: entries.length, matched_count: matched, unmatched_count: unmatched
    });

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
        .map(r => ({ part_id: r.part_id, new_qty: r.input_qty }));

    if (updates.length === 0) {
        alert('No exact matches with a counted quantity to apply.');
        return;
    }
    if (!confirm(`Apply counted quantities to ${updates.length} part(s)? This overwrites system stock quantities.`)) return;

    let applied = 0;
    for (const u of updates) {
        const { error } = await supabaseClient.from('parts').update({ stock_qty: u.new_qty }).eq('id', u.part_id);
        if (!error) applied++;
    }
    alert(`Applied ${applied} update(s).`);
    loadStats();
    if (currentTab === 'parts') loadInventory();
    if (currentTab === 'low-stock') loadLowStock();
}

// ---------------------------------------------------------------------------
// Full Stock List — export the whole inventory to Excel, edit it, re-upload
// to review and apply changes (updates to existing parts, or new part rows).
// ---------------------------------------------------------------------------
let lastStockListChanges = [];

async function downloadStockListXlsx() {
    showGlobalProgress('Preparing Stock List');
    updateGlobalProgress(0, 1, 'Fetching all parts...');

    const parts = await fetchAllRows(() => supabaseClient.from('parts').select('*').order('part_code'));

    const rows = [['Part Code', 'Description', 'UoM', 'Stock Qty', 'Reorder Level', 'Unit Cost', 'Location']];
    parts.forEach(p => {
        rows.push([p.part_code, p.description || '', p.uom || 'Nos', p.stock_qty, p.reorder_level, p.unit_cost, p.location || '']);
    });

    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 20 }, { wch: 40 }, { wch: 8 }, { wch: 12 }, { wch: 14 }, { wch: 12 }, { wch: 20 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Stock List');
    XLSX.writeFile(wb, `Stock_List_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.xlsx`);

    hideGlobalProgress();
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

    showGlobalProgress('Comparing Stock List');
    updateGlobalProgress(0, 1, 'Loading current inventory...');
    const existingParts = await fetchAllRows(() => supabaseClient.from('parts').select('*'));
    const byNorm = {};
    existingParts.forEach(p => { byNorm[normalizeCode(p.part_code)] = p; });

    const dataRows = rows.filter(row => {
        const cells = row.map(c => (c === null || c === undefined) ? '' : String(c).trim());
        return cells.length && cells[0] && !['code', 'part code', 'part_code'].includes(cells[0].toLowerCase());
    });

    const changes = [];
    const CHUNK_SIZE = 200;
    for (let i = 0; i < dataRows.length; i += CHUNK_SIZE) {
        const chunk = dataRows.slice(i, i + CHUNK_SIZE);
        chunk.forEach(row => {
            const cells = row.map(c => (c === null || c === undefined) ? '' : String(c).trim());
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
                        payload: { part_code: existing.part_code, description: newDesc, uom: newUom, stock_qty: newStock, reorder_level: newReorder, unit_cost: newCost, location: newLocation }
                    });
                }
                return;
            }

            // No code match — check your real convention first: is this code actually
            // embedded inside an existing part's Description? If so, it's an update to
            // that part, not a new one.
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
                    payload: { part_code: embeddedMatch.part_code, uom: newUom, stock_qty: newStock, reorder_level: newReorder, unit_cost: newCost, location: newLocation }
                });
                return;
            }

            // Still no match — check if the description strongly resembles an existing
            // part's, which usually means the code was retyped wrong rather than being new.
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

        updateGlobalProgress(Math.min(i + CHUNK_SIZE, dataRows.length), dataRows.length, `Comparing row ${Math.min(i + CHUNK_SIZE, dataRows.length)} of ${dataRows.length}...`);
        await new Promise(r => setTimeout(r, 0)); // yield to keep the tab responsive
    }

    hideGlobalProgress();
    lastStockListChanges = changes;
    btn.disabled = false;
    btn.innerText = 'Compare & Preview Changes';

    if (changes.length === 0) {
        resultsDiv.innerHTML = `<p style="color: var(--text-muted);">No differences found across ${dataRows.length} row(s) checked against ${existingParts.length} existing part(s) — the uploaded list matches current inventory.</p>`;
        return;
    }

    let html = `
        <p style="color: var(--text-muted); font-size: 13px;">${changes.length} row(s) have changes or are new, out of ${dataRows.length} checked against ${existingParts.length} existing part(s). Review and select which to apply.</p>
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

    // Every payload carries part_code, so both "update" and "new" rows can go
    // through a single upsert keyed on part_code — Postgres updates the row if
    // that code already exists, or inserts it if not. This turns what would be
    // thousands of one-row-at-a-time requests into a handful of batched ones.
    const rowsToUpsert = checkedIdxs
        .map(idx => lastStockListChanges[idx])
        .filter(Boolean)
        .map(change => change.payload);

    const updatedCount = checkedIdxs.filter(idx => lastStockListChanges[idx]?.type === 'update').length;
    const newCount = checkedIdxs.filter(idx => lastStockListChanges[idx]?.type === 'new').length;

    showGlobalProgress('Applying Stock List Changes');
    const BATCH_SIZE = 500;
    const batches = chunkArray(rowsToUpsert, BATCH_SIZE);
    let processed = 0, failed = 0;

    for (const batch of batches) {
        const { error } = await supabaseClient.from('parts').upsert(batch, { onConflict: 'part_code' });
        if (error) { failed += batch.length; console.error(error.message); }
        processed += batch.length;
        updateGlobalProgress(processed, rowsToUpsert.length, `Applying changes: ${processed} of ${rowsToUpsert.length}...`);
    }

    hideGlobalProgress();
    alert(
        `Applied changes to ${processed - failed} part(s) (${updatedCount} update(s), ${newCount} new)` +
        (failed ? `, ${failed} row(s) failed (see browser console).` : '.')
    );
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

// ---------------------------------------------------------------------------
// Scan manuals for spare parts (client-side PDF text extraction + pattern matching)
// ---------------------------------------------------------------------------
if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
}

// Extracts the PDF's text, grouped into approximate lines by y-position,
// since pdf.js only gives a flat stream of positioned text fragments.
// isEvalSupported: false mitigates CVE-2024-4367 (a code-injection issue in
// this pdf.js version's path-resolution logic) — required since we now also
// render pages to canvas for OCR, not just read their text layer.
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

// Heuristic pattern matching over the extracted lines. Three passes, most
// reliable first:
//   "table" confidence — structured "POS  CODE  DESCRIPTION  QTY [unit]" rows,
//                         the standard layout used in most spare-parts manuals
//   "high"  confidence — lines with an explicit label like "Part No:", "P/N", "Item No:"
//   "low"   confidence — general alphanumeric-code-looking tokens on short lines
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
            return; // labeled line already handled — skip the general scan for it
        }

        const wordCount = line.split(/\s+/).length;
        if (wordCount > 12) return; // likely prose, not a parts-list row

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

    return candidates.slice(0, 200); // cap noise on very large/dense manuals
}

// OCR fallback for scanned manuals with no embedded text layer. Renders each
// page to a canvas with pdf.js, then runs Tesseract.js (WASM) over the image.
// Much slower than text extraction — seconds per page, plus a one-time
// download of the OCR engine and language data on first use.
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

        // Resolve each manual code against existing inventory before rendering,
        // checking both the Item No./code field and whether it's embedded inside
        // any part's Description — your actual convention for how these are filed.
        const existingParts = await fetchAllRows(() => supabaseClient.from('parts').select('id, part_code, description'));
        const byNormCode = {};
        existingParts.forEach(p => { byNormCode[normalizeCode(p.part_code)] = p; });

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

    const existingParts = await fetchAllRows(() => supabaseClient.from('parts').select('id, part_code'));
    const byNorm = {};
    existingParts.forEach(p => { byNorm[normalizeCode(p.part_code)] = p; });

    let assemblyId = null;
    if (machineId) {
        try {
            assemblyId = await findOrCreateAssembly(machineId, assemblyLabel);
        } catch (err) {
            console.error('Could not create/find assembly link:', err.message);
        }
    }

    let added = 0, matched = 0, linked = 0, skipped = 0;
    for (const cand of selected) {
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
    }

    alert(
        `Added ${added} new part(s), matched ${matched} already in inventory` +
        (assemblyId ? `, linked ${linked} to this machine` : '') +
        (skipped ? `, skipped ${skipped} row(s) with no SAP code.` : '.')
    );
    closePartsReviewModal();
    loadStats();
    if (currentTab === 'parts') loadInventory();
}
