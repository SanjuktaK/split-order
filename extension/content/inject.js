(() => {
  const EXT_NS = 'osz';
  // Session-only deleted item IDs (do not persist across reloads)
  const DELETED_IDS = new Set();

  function log(...args) {
    console.log('[OrderSplitter]', ...args);
  }

  const DEBUG = false;
  const dlog = (...args) => { if (DEBUG) log(...args); };

  // Storage helpers (content scripts can use chrome.storage)
  const storage = {
    async get(key, defaultVal) {
      return new Promise((resolve) => {
        chrome.storage.sync.get([key], (data) => {
          if (chrome.runtime.lastError) {
            console.warn('storage error', chrome.runtime.lastError);
            resolve(defaultVal);
          } else {
            resolve(data[key] ?? defaultVal);
          }
        });
      });
    },
    async set(key, value) {
      return new Promise((resolve) => {
        chrome.storage.sync.set({ [key]: value }, () => resolve());
      });
    }
  };

  // Data model
  // Item: { id, title, qty, price, currency, orderId, date, meta }
  // Annotation: { assignee: 'me'|'shared'|'roommate:<name>', split: number }

  function currencyFromText(t) {
    if (!t) return '$';
    if (t.includes('€')) return '€';
    if (t.includes('£')) return '£';
    if (t.includes('¥')) return '¥';
    return '$';
  }

  function parsePrice(text) {
    if (!text) return { value: 0, currency: '$' };
    const cur = currencyFromText(text);
    const n = parseFloat((text.replace(/[^0-9.,-]/g, '') || '0').replace(/,/g, ''));
    return { value: isNaN(n) ? 0 : n, currency: cur };
  }

  // Remove common UI noise from scraped titles
  function cleanTitleText(t) {
    if (!t) return '';
    let s = String(t);
    // Strip obvious UI words
    s = s.replace(/\b(Substitution|Substitutions|Shopped)\b/gi, ' ');
    // Handle jammed tokens like "SubstitutionsQty" or "(2 items)Substitution"
    s = s.replace(/Substitutions\s*Qty\s*\d*/gi, ' ');
    s = s.replace(/\(\s*\d+\s*items?\s*\)\s*Substitution(s)?/gi, ' ');
    s = s.replace(/\b(Substituted|Replacement|Replaced\s*with)\b/gi, ' ');
    s = s.replace(/Add\s*to\s*cart/gi, ' ');
    s = s.replace(/Review\s*item/gi, ' ');
    // Remove quantity markers embedded in name
    s = s.replace(/\bQty\s*[:\-]?\s*\d+(?:\.\d+)?\s*(?:ea|each)?\b/gi, ' ');
    s = s.replace(/\b\d+\s*(?:ea|each)\b/gi, ' ');
    s = s.replace(/\bQty\b/gi, ' '); // stray Qty without number
    s = s.replace(/\bCount:\s*\d+\b/gi, ' ');
    s = s.replace(/\(\s*\d+\s*items?\s*\)/gi, ' ');
    // Remove size/multipack decorations
    s = s.replace(/\bSize:\s*[^,]+/gi, ' ');
    s = s.replace(/\bMultipack Quantity:\s*\d+\b/gi, ' ');
    // Remove unit price hints like 16.6¢/ea, 12.0¢/oz, 144.2¢/fl oz
    s = s.replace(/\b\d+(?:\.\d+)?¢\/[a-z]+\b/gi, ' ');
    // Remove currency amounts that might have bled into title
    s = s.replace(/(?:₹|\$|£|€)\s?\d{1,3}(?:[\s,]\d{3})*(?:\.\d{2})?/g, ' ');
    // Collapse whitespace and stray punctuation
    s = s.replace(/\s{2,}/g, ' ').replace(/\s+,/g, ',').replace(/,\s*,/g, ',');
    return s.trim();
  }

  // Extract a concise product name from a noisy Walmart title block
  function extractCoreName(t) {
    let s = cleanTitleText(t);
    if (!s) return '';

    // Drop anything after a dash separator which often introduces actions or extras
    s = s.split(' - ')[0];

    // If parentheses contain sizes/units, drop those parentheses
    const unitInner = /(\d+(?:\.\d+)?\s*(?:oz|ounce|fl\.?\s*oz|lb|lbs|pound|g|kg|ct|count|pack|pk|qt|pt|gal|liter|l|ml|cm|inch|in|ft|pcs?))|(?:(?:family|value) size)/i;
    s = s.replace(/\(([^)]*)\)/g, (m, inner) => unitInner.test(inner) ? '' : m);

    // Stop at commas that introduce sizes/units/colors/counts
    const stopSeg = /^(?:\s*(?:\d+(?:\.\d+)?\s*(?:oz|ounce|fl\.?\s*oz|lb|lbs|pound|g|kg|ct|count|pack|pk|qt|pt|gal|liter|l|ml)|\d+\s*[-–]?\s*(?:count|ct)|[A-Za-z]+\s*:\s*\d+|[A-Za-z]+\s*(?:pack|tray|jar|bottle|pouch|can))\b)/i;
    const parts = s.split(',');
    const kept = [];
    for (const part of parts) {
      if (stopSeg.test(part)) break;
      const trimmed = part.trim();
      if (trimmed) kept.push(trimmed);
    }
    if (kept.length) s = kept.join(', ');

    // Final trims of trailing units accidentally left at end
    s = s.replace(/\b\d+(?:\.\d+)?\s*(?:oz|ounce|fl\.?\s*oz|lb|lbs|pound|g|kg|ct|count)\b\.?$/i, '').trim();
    s = s.replace(/\s{2,}/g, ' ');
    return s.trim();
  }

  // Site detectors
  function isAmazon() {
    return /amazon\.\w+/.test(location.host);
  }
  function isWalmart() {
    return /walmart\./.test(location.host);
  }

  // Amazon parser — uses cascading selectors for robustness across layout changes
  function parseAmazon() {
    const items = [];

    // Order card selectors (try multiple, Amazon changes these)
    const orders = document.querySelectorAll(
      '.js-order-card, .order-card, .yohtmlc-order, [data-order-id], .order, .a-box-group.order'
    );
    dlog('Amazon: orders found', orders.length);

    orders.forEach((orderEl, oi) => {
      // Order ID: data attribute > yohtmlc class > link param > regex fallback
      let orderId = orderEl.getAttribute('data-order-id');
      if (!orderId) {
        const idEl = orderEl.querySelector('.yohtmlc-order-id span[dir="ltr"]')
                  || orderEl.querySelector('.yohtmlc-order-id');
        orderId = idEl?.textContent?.trim() || null;
      }
      if (!orderId) {
        const link = orderEl.querySelector('a[href*="orderID="]');
        if (link) {
          const m = link.href.match(/orderID=([^&?]*)/);
          orderId = m ? m[1] : null;
        }
      }
      if (!orderId) {
        const m = orderEl.textContent?.match(/\d{3}-\d{7}-\d{7}/);
        orderId = m ? m[0] : `amazon-order-${oi}`;
      }

      // Date: yohtmlc class > order-info secondary text
      const dateEl = orderEl.querySelector('.yohtmlc-order-date')
                  || orderEl.querySelector('.order-date-invoice-item')
                  || orderEl.querySelector('.order-info .a-color-secondary, .a-color-secondary.value');
      const dateText = dateEl?.textContent?.trim() || '';

      // Product titles: data-component (React, most stable) > yohtmlc > product/dp links
      let productRows = orderEl.querySelectorAll(
        '[data-component="itemTitle"] a, .yohtmlc-product-title'
      );
      if (!productRows.length) {
        productRows = orderEl.querySelectorAll(
          'a.a-link-normal[href*="/gp/product/"], a.a-link-normal[href*="/dp/"]'
        );
      }
      if (!productRows.length) {
        productRows = orderEl.querySelectorAll('a[href*="/gp/product/"], a[href*="/dp/"]');
      }
      dlog('Amazon: order', orderId, 'product links', productRows.length);

      // Order-level total (shown on list page): yohtmlc-order-total > .a-color-price in header
      const orderTotalEl = orderEl.querySelector('.yohtmlc-order-total .a-color-price')
                        || orderEl.querySelector('.yohtmlc-order-total')
                        || orderEl.querySelector('.yo-ac-order-total');
      const orderTotal = parsePrice(orderTotalEl?.textContent || '');
      const itemCount = productRows.length || 1;

      productRows.forEach((a, i) => {
        const container = a.closest('.a-fixed-left-grid, .a-fixed-left-grid-inner, .a-row, .a-spacing-base, .item-box') || orderEl;
        const title = a.textContent?.trim() || 'Item';

        // Price: try item-level first (works on order detail pages)
        let priceEl = container.querySelector(
          '[data-component="unitPrice"] span:not(span span), ' +
          'span[id*="item-total-price"], ' +
          '.a-color-price'
        );

        // If not found in immediate container, try climbing to parent rows
        if (!priceEl || !parsePrice(priceEl.textContent || '').value) {
          let parent = container.parentElement;
          let climb = 0;
          while (parent && parent !== orderEl && climb < 4) {
            priceEl = parent.querySelector(
              '[data-component="unitPrice"] span:not(span span), ' +
              'span[id*="item-total-price"], ' +
              '.a-color-price'
            );
            if (priceEl && parsePrice(priceEl.textContent || '').value) break;
            priceEl = null;
            parent = parent.parentElement;
            climb++;
          }
        }

        // Also try .a-offscreen (screen-reader price text) near the product link
        if (!priceEl || !parsePrice(priceEl.textContent || '').value) {
          const offscreenEls = container.querySelectorAll('.a-offscreen');
          for (const el of offscreenEls) {
            const val = parsePrice(el.textContent || '');
            if (val.value > 0) { priceEl = el; break; }
          }
        }

        let price = parsePrice(priceEl?.textContent || '');

        // Fallback: if still no item price, split the order total evenly
        if (price.value <= 0 && orderTotal.value > 0) {
          price = {
            value: Math.round((orderTotal.value / itemCount) * 100) / 100,
            currency: orderTotal.currency
          };
        }

        // Quantity: data-component > item-view-qty > text regex
        const qtyEl = container.querySelector(
          '[data-component="quantity"], .item-view-qty, .od-item-view-qty span, .product-image__qty'
        );
        let qty = 1;
        if (qtyEl) {
          const qm = qtyEl.textContent?.match(/(\d+)/);
          if (qm) qty = parseInt(qm[1], 10);
        } else {
          const qtyMatch = container.textContent?.match(/Qty[:\s]*([0-9]+)/i);
          if (qtyMatch) qty = parseInt(qtyMatch[1], 10);
        }

        if (title) {
          items.push({
            id: `${orderId}-${i}-${title.slice(0, 20)}`,
            title,
            qty,
            price: price.value,
            currency: price.currency,
            orderId,
            date: dateText,
            meta: { href: a.href }
          });
          if (i < 3) dlog('Amazon: item', { title, qty, price: price.value, currency: price.currency });
        }
      });
    });
    dlog('Amazon: total parsed items', items.length);
    return items;
  }

  // Walmart parser (best-effort)
  function parseWalmart() {
    const items = [];

    // Walmart order sections often look like category accordions
    const accordions = document.querySelectorAll('[data-testid^="category-accordion-"]');
    const roots = accordions.length ? Array.from(accordions) : [document.body];
    dlog('Walmart: accordions found', accordions.length, 'roots used', roots.length);

    // Heuristic: find price nodes, then climb to a container that also has a title
    // Allow prices with or without leading currency symbol
    const priceRe = /(?:₹|\$|£|€)?\s?\d{1,3}(?:[\s,]\d{3})*(?:\.\d{2})/g;
    const priceReTest = /(?:₹|\$|£|€)?\s?\d{1,3}(?:[\s,]\d{3})*(?:\.\d{2})/;
    // Skip non-item sections like returns, refunds, headers, etc.
    const nonItemRe = /(you[’']?re all set|no need to return|return details|\breturn\b|refund|refunded|replacement|cancell?ed|delivered on|delivery window|pickup|order date|order number)/i;

    const processedContainers = new WeakSet();
    const itemKeys = new Set(); // dedupe primarily by href or normalized title

    const findTitleIn = (container) => container.querySelector(
      '[data-testid*="name" i], [data-automation-id*="name" i], [data-testid*="title" i], [data-automation-id*="title" i], [class*="title" i], [class*="name" i], a, h3, h2'
    );

    roots.forEach((acc, ai) => {
      const allNodes = Array.from(acc.querySelectorAll('*'));
      const priceNodes = Array.from(acc.querySelectorAll('[data-testid*="price" i], [data-automation-id*="price" i], [class*="price" i]'));
      // Include any nodes whose text looks like a price (not just class-hinted)
      const extraByRegex = allNodes.filter(el => priceReTest.test(el.textContent || ''));
      const candidates = Array.from(new Set([...priceNodes, ...extraByRegex]));

      dlog('Walmart: price candidates', candidates.length);
      candidates.forEach((priceEl, idx) => {
        // Climb up to a reasonable container that might include the title as a sibling
        let container = priceEl.closest('[data-testid*="item" i], [data-automation-id*="item" i], li, article') || priceEl.parentElement;
        let climb = 0;
        let titleEl = container ? findTitleIn(container) : null;
        while (container && !titleEl && climb < 7) {
          container = container.parentElement;
          titleEl = container ? findTitleIn(container) : null;
          climb++;
        }
        if (!container) return;
        if (processedContainers.has(container)) return; // dedupe

        const text = container.textContent?.trim() || '';
        if (nonItemRe.test(text)) return; // skip non-item blocks like returns/refunds
        // Gather all price-like numbers from either the priceEl or the container
        const priceCandidatesText = [priceEl.textContent || '', text].join(' ');
        const priceMatchesRaw = Array.from(priceCandidatesText.matchAll(priceRe)).map(m => m[0]);
        let priceVals = priceMatchesRaw.map(p => parsePrice(p).value).filter(v => v > 0 && v < 10000);
        if (!priceVals.length) return;
        // Prefer the last occurrence (often the displayed price), but adjust later for unit vs total
        let price = { value: priceVals[priceVals.length - 1], currency: currencyFromText(priceCandidatesText) };
        if (price.value <= 0) return;

        const rawTitle = (titleEl ? titleEl.textContent : '') || text;
        const title = extractCoreName(rawTitle.replace(priceRe, ' '));
        if (!title) return;

        // Quantity from container text
        const qtyMatch = text.match(/Qty[:\s]*([0-9]+)/i) || text.match(/([0-9]+)\s*[x×]/i);
        const qty = qtyMatch ? parseInt(qtyMatch[1], 10) : 1;

        // Skip suggestion tiles that have "Add to cart" but no explicit Qty marker
        if (!qtyMatch && /Add\s*to\s*cart/i.test(text)) return;

        // If both unit and total appear, prefer unit price (smaller one)
        if (qty > 1 && priceVals.length >= 2) {
          const minP = Math.min(...priceVals);
          const maxP = Math.max(...priceVals);
          // If max is close to min * qty, treat min as unit price
          if (Math.abs(maxP - minP * qty) <= Math.max(0.02, 0.01 * minP * qty)) {
            price = { value: minP, currency: price.currency };
          }
        }

        // Build a stable key to avoid duplicate captures of the same item
        const href = (container.querySelector('a[href*="/ip/"]')?.href || '').split('?')[0];
        const key = href || title.toLowerCase();
        if (itemKeys.has(key)) return;

        const orderId = `walmart-${ai}`;
        items.push({
          id: `${orderId}-${idx}-${title.slice(0,20)}`,
          title,
          qty: isNaN(qty) ? 1 : qty,
          price: price.value,
          currency: price.currency,
          orderId: '',
          date: '',
          meta: { href }
        });
        itemKeys.add(key);
        processedContainers.add(container);
      });
    });

    dlog('Walmart: total parsed items', items.length);
    // Fallback pass: if nothing found, try pairing likely titles with prices in their closest containers
    if (!items.length) {
      const titleNodes = Array.from(document.querySelectorAll('[data-testid*="name" i], [data-automation-id*="name" i], [data-testid*="title" i], [data-automation-id*="title" i], [class*="title" i], [class*="name" i], a[href*="/ip/"]'));
      const seenContainers = new WeakSet();
      titleNodes.forEach((tn, i) => {
        let container = tn.closest('[data-testid*="item" i], [data-automation-id*="item" i], li, article, div') || tn.parentElement;
        let climb = 0;
        while (container && climb < 7 && (!priceReTest.test(container.textContent || '') || nonItemRe.test(container.textContent || '') || seenContainers.has(container))) {
          container = container.parentElement;
          climb++;
        }
        if (!container || seenContainers.has(container)) return;
        const text = container.textContent || '';
        if (nonItemRe.test(text)) return;
        const prices = Array.from(text.matchAll(priceRe)).map(m => parsePrice(m[0]).value).filter(v => v > 0 && v < 10000);
        if (!prices.length) return;
        const qtyMatch = text.match(/Qty[:\s]*([0-9]+)/i) || text.match(/([0-9]+)\s*[x×]/i);
        const qty = qtyMatch ? parseInt(qtyMatch[1], 10) : 1;
        const rawTitle = tn.textContent || text;
        const title = extractCoreName(rawTitle);
        if (!title) return;
        let unit = prices[prices.length - 1];
        if (qty > 1) {
          const minP = Math.min(...prices);
          const maxP = Math.max(...prices);
          if (Math.abs(maxP - minP * qty) <= Math.max(0.02, 0.01 * minP * qty)) {
            unit = minP;
          }
        }
        const orderId = `walmart-fallback`;
        items.push({
          id: `${orderId}-${i}-${title.slice(0,20)}`,
          title,
          qty: isNaN(qty) ? 1 : qty,
          price: unit,
          currency: currencyFromText(text),
          orderId: '',
          date: '',
          meta: {}
        });
        seenContainers.add(container);
      });
      dlog('Walmart: fallback parsed items', items.length);
    }
    return items;
  }

  function parseGeneric() {
    const items = [];
    const rows = Array.from(document.querySelectorAll('li, .item, .product, .order-item'));
    rows.forEach((row, i) => {
      const title = row.querySelector('a, .title, .name')?.textContent?.trim();
      const priceEl = row.querySelector('.price, [class*="price" i]');
      const price = parsePrice(priceEl?.textContent || '');
      if (title && price.value > 0) {
        items.push({ id: `row-${i}-${title.slice(0,20)}`, title, qty: 1, price: price.value, currency: price.currency, orderId: '', date: '', meta: {} });
      }
    });
    return items;
  }

  function parsePage() {
    try {
      dlog('Parsing page host', location.host);
      if (isAmazon()) { dlog('Parser selected: Amazon'); return parseAmazon(); }
      if (isWalmart()) { dlog('Parser selected: Walmart'); return parseWalmart(); }
      dlog('Parser selected: Generic');
      return parseGeneric();
    } catch (e) {
      console.warn('Parsing error', e);
      return [];
    }
  }

  // UI overlay
  function ensureRoot() {
    if (document.querySelector(`.${EXT_NS}-root`)) return document.querySelector(`.${EXT_NS}-root`);
    const root = document.createElement('div');
    root.className = `${EXT_NS}-root osz-root`;
    const btn = document.createElement('button');
    btn.className = 'osz-btn';
    btn.textContent = 'Split Orders';
    root.appendChild(btn);

    const panel = document.createElement('div');
    panel.className = 'osz-panel';
    panel.innerHTML = `
      <div class="osz-panel-header">
        <div class="osz-title">Order Splitter</div>
        <button class="osz-close" aria-label="Close">✕</button>
      </div>
      <div class="osz-body">
        <div class="osz-empty">Scanning this page for orders…</div>
      </div>
    `;
    root.appendChild(panel);

    document.documentElement.appendChild(root);
    return root;
  }

  function renderItems(container, items, roommates, annotations) {
    container.innerHTML = '';
    const visibleItems = items.filter(it => !DELETED_IDS.has(it.id));
    if (!visibleItems.length) {
      container.innerHTML = '<div class="osz-empty">No order items found on this page. Try navigating to your order history page.</div>';
      return;
    }

    // Summary header with total count
    const summary = document.createElement('div');
    summary.className = 'osz-summary';
    summary.textContent = `Total items: ${visibleItems.length}`;
    container.appendChild(summary);

    visibleItems.forEach((item) => {
      const ann = annotations[item.id] || { assignee: 'me', split: 1 };
      const div = document.createElement('div');
      div.className = 'osz-item';
      const escapedTitle = escapeHTML(item.title);
      const escapedId = escapeHTML(item.id);
      const escapedOrderId = escapeHTML(item.orderId || '');
      const escapedDate = escapeHTML(item.date || '');
      const total = (Number(item.price || 0) * Number(item.qty || 1)).toFixed(2);
      const isRoommates = ann.assignee === 'roommates' || (typeof ann.assignee === 'string' && ann.assignee.startsWith('roommate:'));
      div.innerHTML = `
        <div class="osz-item-title">${escapedTitle}<button class="osz-delete" title="Delete this item" aria-label="Delete">✕</button></div>
        <div class="osz-row">
          <div>
            <span class="osz-chip">${item.qty}×</span>
            <span class="osz-chip">${escapeHTML(item.currency)}${total}</span>
            ${item.orderId ? `<span class="osz-chip">${escapedOrderId}</span>` : ''}
            ${item.date ? `<span class="osz-chip">${escapedDate}</span>` : ''}
          </div>
        </div>
        <div class="osz-radio" role="radiogroup" aria-label="Assignment">
          <label><input type="radio" name="assignee-${escapedId}" value="me" ${ann.assignee==='me'?'checked':''}/> Mine</label>
          <label><input type="radio" name="assignee-${escapedId}" value="shared" ${ann.assignee==='shared'?'checked':''}/> Shared</label>
          <label><input type="radio" name="assignee-${escapedId}" value="roommates" ${isRoommates?'checked':''}/> Roommates</label>
        </div>
      `;
      const radios = div.querySelectorAll(`input[name="assignee-${CSS.escape(item.id)}"]`);
      radios.forEach(r => r.addEventListener('change', async (e) => {
        const val = e.target.value;
        annotations[item.id] = { ...ann, assignee: val };
        await storage.set('annotations', annotations);
      }));
      const delBtn = div.querySelector('.osz-delete');
      if (delBtn) {
        delBtn.addEventListener('click', async () => {
          DELETED_IDS.add(item.id);
          renderItems(container, items, roommates, annotations);
        });
      }
      container.appendChild(div);
    });

    const footer = document.createElement('div');
    footer.className = 'osz-footer';
    const copyBtn = document.createElement('button');
    copyBtn.className = 'osz-cta';
    copyBtn.textContent = 'Copy Splitwise Text';
    copyBtn.addEventListener('click', () => {
      const text = buildSplitwiseText(items, annotations, roommates);
      navigator.clipboard.writeText(text).then(() => {
        copyBtn.textContent = 'Copied!';
        setTimeout(() => (copyBtn.textContent = 'Copy Splitwise Text'), 1200);
      });
    });

    const csvBtn = document.createElement('button');
    csvBtn.className = 'osz-secondary';
    csvBtn.textContent = 'Download CSV';
    csvBtn.addEventListener('click', () => {
      const csv = buildCSV(items, annotations);
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'orders-split.csv'; a.click();
      URL.revokeObjectURL(url);
    });

    footer.appendChild(copyBtn);
    footer.appendChild(csvBtn);
    container.appendChild(footer);
  }

  function buildSplitwiseText(items, annotations, roommates) {
    // Produces readable lines to paste into Splitwise
    // Format: <title> - $<amount> [Mine|Shared|RoommateName]
    const lines = [];
    items.forEach((it) => {
      if (DELETED_IDS.has(it.id)) return;
      const ann = annotations[it.id] || { assignee: 'me' };
      const label = resolveLabel(ann);
      const total = (it.price || 0) * (it.qty || 1);
      lines.push(`${it.title} - ${it.currency}${total.toFixed(2)} [${label}]`);
    });
    const rmLine = roommates.length ? `\nRoommates: ${roommates.join(', ')}` : '';
    return `Splitwise Entries\n${lines.join('\n')}${rmLine}`;
  }

  function escapeHTML(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  function resolveLabel(ann) {
    if (!ann) return 'Mine';
    const a = ann.assignee;
    if (a === 'me') return 'Mine';
    if (a === 'shared') return 'Shared';
    if (a === 'roommates' || (typeof a === 'string' && a.startsWith('roommate:'))) return 'Roommates';
    return 'Mine';
  }

  function escapeCSV(s) {
    const str = String(s ?? '');
    if (/[",\n]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
    return str;
  }

  function buildCSV(items, annotations) {
    const headers = ['Title', 'Qty', 'Amount', 'Assignment', 'OrderId', 'Date'];
    const rows = [headers.join(',')];
    items.forEach((it) => {
      if (DELETED_IDS.has(it.id)) return;
      const ann = annotations[it.id] || { assignee: 'me' };
      const label = resolveLabel(ann);
      const total = (it.price || 0) * (it.qty || 1);
      rows.push([
        escapeCSV(it.title),
        it.qty,
        total.toFixed(2),
        escapeCSV(label),
        escapeCSV(it.orderId || ''),
        escapeCSV(it.date || '')
      ].join(','));
    });
    return rows.join('\n');
  }

  async function init() {
    try {
      const root = ensureRoot();
      const btn = root.querySelector('.osz-btn');
      const panel = root.querySelector('.osz-panel');
      const close = root.querySelector('.osz-close');
      const body = root.querySelector('.osz-body');

      const roommates = await storage.get('roommates', []);
      const annotations = await storage.get('annotations', {});
      // Remove any persisted 'deleted' flags from older versions
      let cleaned = false;
      Object.keys(annotations || {}).forEach((k) => {
        if (annotations[k] && annotations[k].deleted) {
          delete annotations[k].deleted;
          cleaned = true;
        }
      });
      if (cleaned) await storage.set('annotations', annotations);

      async function refresh() {
        const items = parsePage();
        dlog('Refresh: items found', items.length);
        renderItems(body, items, roommates, annotations);
      }

      btn.addEventListener('click', async () => {
        panel.style.display = 'block';
        await refresh();
      });
      close.addEventListener('click', () => {
        panel.style.display = 'none';
      });

      // Auto-show a subtle button; panel opens on demand
      log('Order Splitter initialized.');

      // Note: Content scripts run in an isolated world. Exposing functions on
      // window won't be callable from the page console. Provide an event-based
      // debug hook that can be triggered from the page context instead:
      document.addEventListener('osz:debug-parse', () => {
        try {
          const items = parsePage();
          console.log('[OrderSplitter] Debug parse items:', items);
        } catch (e) {
          console.warn('[OrderSplitter] Debug parse error', e);
        }
      });

      // Keep internal references for content-script context
      window.__OSZ_FORCE_REFRESH = () => refresh();
      parsePage();
    } catch (e) {
      console.warn('Init error', e);
    }
  }

  // Avoid duplicate injection
  if (!window.__OSZ_INIT__) {
    window.__OSZ_INIT__ = true;
    init();
  }
})();
