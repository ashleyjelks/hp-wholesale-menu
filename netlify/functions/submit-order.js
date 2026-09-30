// netlify/functions/submit-order.js
//
// Receives a wholesale order from the form on hpw-ny.com, validates it,
// independently recomputes units/pricing server-side (never trusts client
// math), writes it to Airtable (source of truth), then fires two
// independent notification channels (email + Slack) . Payment is NOT
// handled here — orders are invoiced/collected manually (COD/check/ACH).
//

const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE_ID = process.env.AIRTABLE_TABLE_ID;
const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME || 'OnlineOrders';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL;
// const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

// Source of truth for pricing/case size — the front-end has its own copy for
// the live preview, but every dollar figure that gets saved or emailed is
// computed from THIS table, not from anything the client submitted.
const PRODUCTS = {
  Center_Tin:        { label: 'Center — 7pk Tin (3.5g)', unitPrice: 23.00, caseSize: 32 },
  Uplift_Tin:        { label: 'Uplift — 7pk Tin (3.5g)', unitPrice: 23.00, caseSize: 32 },
  Unwind_Tin:        { label: 'Unwind — 7pk Tin (3.5g)', unitPrice: 23.00, caseSize: 32 },
  Transcend_Tin:     { label: 'Transcend — 7pk Hash-Infused Tin (3.5g)', unitPrice: 29.00, caseSize: 32 },
  Center_Singles:    { label: 'Center — Single (0.5g)', unitPrice: 4.50, caseSize: 40 },
  Uplift_Singles:    { label: 'Uplift — Single (0.5g)', unitPrice: 4.50, caseSize: 40 },
  Unwind_Singles:    { label: 'Unwind — Single (0.5g)', unitPrice: 4.50, caseSize: 40 },
  Transcend_Singles: { label: 'Transcend — Hash-Infused Single (0.5g)', unitPrice: 6.00, caseSize: 40 },
  NYKC_Vape:         { label: 'Live Rosin Vape — New York Kush Cake (Sativa-Leaning Hybrid · 0.5g All in One)', unitPrice: 29.00, caseSize: 24 },
  Papaya_Vape:       { label: 'Live Rosin Vape — Papaya Bomb (Indica · 0.5g All in One)', unitPrice: 29.00, caseSize: 24 },
  Center_Jar:        { label: 'Center — Eighth Jar (3.5g)', unitPrice: 27.50, caseSize: 12 },
  Uplift_Jar:        { label: 'Uplift — Eighth Jar (3.5g)', unitPrice: 27.50, caseSize: 12 },
  Unwind_Jar:        { label: 'Unwind — Eighth Jar (3.5g)', unitPrice: 27.50, caseSize: 12 },
};

const COD_DISCOUNT_RATE = 0.10;
const CASE_LIMIT = 8;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch (err) {
    return jsonResponse(400, { error: 'Invalid request body' });
  }

  // --- Server-side validation — only dispensary name, buyer name, and buyer email are required ---
  const requiredFields = ['dispensaryName', 'buyerName', 'buyerEmail'];
  const missing = requiredFields.filter((f) => !data[f] || String(data[f]).trim() === '');
  if (missing.length) {
    return jsonResponse(400, { error: `Missing required field(s): ${missing.join(', ')}` });
  }

  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailPattern.test(data.buyerEmail.trim())) {
    return jsonResponse(400, { error: 'Buyer email looks invalid' });
  }

  const rawItems = data.items && typeof data.items === 'object' ? data.items : {};

  // --- Recompute everything server-side from the PRODUCTS table ---
  const lines = [];
  let subtotal = 0;
  let totalUnits = 0;

  for (const key of Object.keys(PRODUCTS)) {
    const caseQty = Number(rawItems[key]);
    if (!Number.isInteger(caseQty) || caseQty < 0 || caseQty > CASE_LIMIT) {
      return jsonResponse(400, { error: `Invalid case quantity for ${key} (must be a whole number 0–${CASE_LIMIT})` });
    }
    if (caseQty === 0) continue;

    const product = PRODUCTS[key];
    const units = caseQty * product.caseSize;
    const lineTotal = units * product.unitPrice;
    subtotal += lineTotal;
    totalUnits += units;
    lines.push({ key, label: product.label, caseQty, units, unitPrice: product.unitPrice, lineTotal });
  }

  if (lines.length === 0) {
    return jsonResponse(400, { error: 'Order must include at least one item with a case quantity greater than 0' });
  }

  const totalCases = lines.reduce((t, l) => t + l.caseQty, 0);
  if (totalCases > CASE_LIMIT) {
    return jsonResponse(400, { error: `Order limit is ${CASE_LIMIT} cases per purchase (you submitted ${totalCases})` });
  }

  const codTotal = subtotal * (1 - COD_DISCOUNT_RATE);
  const summaryLine = lines.map((l) => `${l.label}: ${l.caseQty} case${l.caseQty > 1 ? 's' : ''} (${l.units} units)`).join(', ');
  const submittedAt = new Date().toISOString();

  const order = {
    dispensaryName: data.dispensaryName.trim(),
    dispensaryLicense: (data.dispensaryLicense || '').trim(),
    dispensaryAddress: (data.dispensaryAddress || '').trim(),
    buyerName: data.buyerName.trim(),
    buyerEmail: data.buyerEmail.trim(),
    buyerPhone: (data.buyerPhone || '').trim(),
    deliveryHours: (data.deliveryHours || '').trim(),
    notes: (data.notes || '').trim(),
    summaryLine,
    itemsJson: JSON.stringify(Object.fromEntries(lines.map((l) => [l.key, l.caseQty]))),
    totalUnits,
    subtotal,
    codTotal,
    submittedAt,
  };

  // --- Fold request metadata into Notes (no new Airtable field needed) ---
  const metadata = extractRequestMetadata(event);
  const metadataBlock = formatMetadataBlock(metadata);
  order.notes = order.notes ? `${order.notes}\n\n${metadataBlock}` : metadataBlock;


  // --- Step 1: write to Airtable. This is the record of truth — if this fails, the order fails. ---
  let airtableRecordId;
  try {
    airtableRecordId = await writeToAirtable(order);
  } catch (err) {
    console.error('AIRTABLE WRITE FAILED', err, JSON.stringify(order));

    // await bestEffortSlackAlert(
    //   `🚨 ORDER FAILED TO SAVE (Airtable error)\nDispensary: ${order.dispensaryName}\nBuyer: ${order.buyerName} (${order.buyerEmail})\nLicense: ${order.dispensaryLicense}\nError: ${err.message}\nCheck Netlify function logs.`
    // );
    return jsonResponse(502, {
      error: 'Something went wrong saving your order. Please email orders@highpriestess.life directly so nothing is lost.',
    });
  }

  // --- Build the editable invoice (.doc = HTML that opens and edits in Word / Google Docs) ---
  const invoiceNumber = `HPWE-${order.submittedAt.slice(0, 10).replace(/-/g, '')}-${(String(airtableRecordId || '').replace(/[^a-zA-Z0-9]/g, '').slice(-5) || String(Math.floor(Math.random() * 90000) + 10000)).toUpperCase()}`;
  const invoiceHtml = buildInvoiceDoc(order, lines, invoiceNumber);
  order.invoiceFilename = `HighPriestess-Invoice-${invoiceNumber}.doc`;

  // --- Step 2: redundant notifications. Best-effort — a notification failure does NOT fail the order. ---
  const notificationErrors = [];

  try {
    await sendEmailNotification(order);
  } catch (err) {
    notificationErrors.push(`email: ${err.message}`);
  }

  // try {
  //   await sendSlackNotification(order);
  // } catch (err) {
  //   notificationErrors.push(`slack: ${err.message}`);
  // }

  if (notificationErrors.length) {
    console.error('Order saved but notification(s) failed:', notificationErrors.join(' | '), '| recordId:', airtableRecordId);
  }

  return jsonResponse(200, {
    success: true,
    message: `Order received — ${order.totalUnits} units, ${formatUSD(order.codTotal)} COD total (10% off). We will confirm shortly.`,
    recordId: airtableRecordId,
    invoice: { number: invoiceNumber, filename: order.invoiceFilename, html: invoiceHtml },
  });
};

// --- Request metadata (anti-abuse / threat context) ---
//
// Pulled entirely from headers Netlify already attaches to every request —
// no client-side fingerprinting script, nothing beyond what any server
// naturally sees. IP and geo are approximate (city-level via Netlify's edge,
// not precise location); user-agent is self-reported by the browser and can
// be spoofed, but is still useful signal in aggregate (repeated identical
// UA + rapid submissions = likely a bot, not a real buyer).
function extractRequestMetadata(event) {
  const headers = event.headers || {};

  const ip = headers['x-nf-client-connection-ip'] || headers['x-forwarded-for'] || 'unknown';
  const userAgent = headers['user-agent'] || 'unknown';
  const referer = headers['referer'] || 'unknown';
  const acceptLanguage = headers['accept-language'] || 'unknown';
  const requestId = headers['x-nf-request-id'] || 'unknown';

  const platformRaw = headers['sec-ch-ua-platform'] || '';
  const platform = platformRaw.replace(/"/g, '') || 'unknown';
  const deviceType = headers['sec-ch-ua-mobile'] === '?1' ? 'mobile' : headers['sec-ch-ua-mobile'] === '?0' ? 'desktop' : 'unknown';

  let location = 'unknown';
  try {
    if (headers['x-nf-geo']) {
      const geo = JSON.parse(Buffer.from(headers['x-nf-geo'], 'base64').toString('utf8'));
      const parts = [geo.city, geo.subdivision && geo.subdivision.name, geo.country && geo.country.name].filter(Boolean);
      if (parts.length) location = parts.join(', ');
    }
  } catch (_) {
    location = 'unknown';
  }

  return { ip, userAgent, referer, acceptLanguage, requestId, platform, deviceType, location };
}

function formatMetadataBlock(meta) {
  return [
    '— Submission metadata —',
    `IP: ${meta.ip}`,
    `Approx. location: ${meta.location}`,
    `Device: ${meta.deviceType} · ${meta.platform}`,
    `Browser: ${meta.userAgent}`,
    `Language: ${meta.acceptLanguage}`,
    `Referrer: ${meta.referer}`,
    `Netlify request ID: ${meta.requestId}`,
  ].join('\n');
}

function formatUSD(n) {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

async function writeToAirtable(order) {
  if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID) {
    throw new Error('Airtable is not configured (missing AIRTABLE_TOKEN or AIRTABLE_BASE_ID)');
  }



  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_ID}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      fields: {
        'Dispensary Name': order.dispensaryName,
        'Dispensary License Number': order.dispensaryLicense,
        'Dispensary Address': order.dispensaryAddress,
        'Buyer Name': order.buyerName,
        'Buyer Email': order.buyerEmail,
        'Buyer Phone': order.buyerPhone,
        'Delivery Hours': order.deliveryHours,
        'Order Summary': order.summaryLine,
        'Order Items (JSON)': order.itemsJson,
        'Total Units': order.totalUnits,
        'Subtotal (Pre-Tax)': Number(order.subtotal.toFixed(2)),
        'COD Total (10% Discount)': Number(order.codTotal.toFixed(2)),
        Notes: order.notes,
        Status: 'New',
        'Submitted At': order.submittedAt,
      },
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Airtable ${res.status}: ${errBody}`);
  }

  const json = await res.json();
  return json.id;
}

async function sendEmailNotification(order) {
  if (!RESEND_API_KEY || !FROM_EMAIL || !NOTIFY_EMAIL) return;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: NOTIFY_EMAIL,
      reply_to: order.buyerEmail,
      subject: `New wholesale order — ${order.dispensaryName}`,
      attachments: order.invoiceHtml
        ? [{ filename: order.invoiceFilename, content: Buffer.from(order.invoiceHtml).toString('base64') }]
        : [],
      text: [
        `Dispensary: ${order.dispensaryName}`,
        order.dispensaryLicense ? `Dispensary License: ${order.dispensaryLicense}` : null,
        order.dispensaryAddress ? `Dispensary Address: ${order.dispensaryAddress}` : null,
        `Buyer: ${order.buyerName} (${[order.buyerEmail, order.buyerPhone].filter(Boolean).join(', ')})`,
        order.deliveryHours ? `Delivery hours: ${order.deliveryHours}` : null,
        '',
        `Order: ${order.summaryLine}`,
        `Total units: ${order.totalUnits}`,
        `Subtotal (pre-tax): ${formatUSD(order.subtotal)}`,
        `COD total (10% discount applied): ${formatUSD(order.codTotal)}`,
        '',
        order.notes ? `Notes: ${order.notes}` : null,
        `Submitted: ${order.submittedAt}`,
      ].filter((l) => l !== null).join('\n'),
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Resend ${res.status}: ${errBody}`);
  }
}

async function sendSlackNotification(order) {
}

async function bestEffortSlackAlert(text) {
}

// --- Editable invoice generator ---
// Returns Word-compatible HTML (saved/downloaded as .doc). Opens fully editable
// in Microsoft Word and Google Docs. User-entered fields are HTML-escaped.

function escapeHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildInvoiceDoc(order, lines, invoiceNumber) {
  const dateStr = new Date(order.submittedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const rows = lines.map((l) => `
      <tr>
        <td>${escapeHtml(l.label)}</td>
        <td style="text-align:center">${l.caseQty}</td>
        <td style="text-align:center">${l.units}</td>
        <td style="text-align:right">${formatUSD(l.unitPrice)}</td>
        <td style="text-align:right">${formatUSD(l.lineTotal)}</td>
      </tr>`).join('');

  return `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8">
<title>High Priestess Invoice ${escapeHtml(invoiceNumber)}</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View></w:WordDocument></xml><![endif]-->
<style>
  body { font-family: Georgia, serif; color: #371F1D; margin: 40px; }
  .brand { font-size: 11px; letter-spacing: 3px; text-transform: uppercase; color: #8EA4A8; font-family: Arial, sans-serif; }
  h1 { font-family: Georgia, serif; font-size: 28px; font-weight: normal; letter-spacing: 2px; margin: 4px 0 2px; }
  .meta { font-size: 12px; color: #857a6e; }
  table { border-collapse: collapse; font-size: 13px; }
  th { border-bottom: 2px solid #371F1D; text-align: left; padding: 6px 10px; font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase; font-family: Arial, sans-serif; }
  td { border-bottom: 1px solid #DFD8CF; padding: 8px 10px; }
  .totals { margin-top: 12px; }
  .totals td { border: none; padding: 4px 10px; text-align: right; }
  .totals .grand td { border-top: 2px solid #371F1D; font-weight: bold; font-size: 15px; }
  .fine { margin-top: 28px; font-size: 11px; color: #857a6e; line-height: 1.7; }
</style>
</head>
<body>
<div class="brand">High Priestess Herbal Wellness</div>
<h1>Wholesale Invoice</h1>
<div class="meta">${escapeHtml(invoiceNumber)} &nbsp;·&nbsp; ${escapeHtml(dateStr)}</div>

<table style="margin-top: 24px;">
  <tr>
    <td style="border: none; padding: 2px 24px 2px 0; vertical-align: top;">
      <strong>Bill to</strong><br>
      ${escapeHtml(order.dispensaryName)}<br>
      ${order.dispensaryLicense ? 'License: ' + escapeHtml(order.dispensaryLicense) + '<br>' : ''}
      ${order.dispensaryAddress ? escapeHtml(order.dispensaryAddress) + '<br>' : ''}
      ${escapeHtml(order.buyerName)} · ${escapeHtml(order.buyerEmail)}${order.buyerPhone ? ' · ' + escapeHtml(order.buyerPhone) : ''}
    </td>
    <td style="border: none; padding: 2px 0 2px 24px; vertical-align: top;">
      <strong>From</strong><br>
      High Priestess Herbal Wellness<br>
      OCM-PROC-24-000215<br>
      highpriestess.life · orders@highpriestess.life
    </td>
  </tr>
</table>

<table style="width: 100%; margin-top: 20px;">
  <tr><th>Item</th><th style="text-align:center;">Cases</th><th style="text-align:center;">Units</th><th style="text-align:right;">Unit price</th><th style="text-align:right;">Line total</th></tr>
  ${rows}
</table>

<table class="totals" style="width: 100%;">
  <tr><td colspan="2">Subtotal (Net 30 standard): ${formatUSD(order.subtotal)}</td></tr>
  <tr><td colspan="2">Net 15 payment (5% off): ${formatUSD(order.subtotal * 0.95)}</td></tr>
  <tr><td colspan="2">COD discount (10%): −${formatUSD(order.subtotal - order.codTotal)}</td></tr>
  <tr class="grand"><td colspan="2">Total due on delivery (COD): ${formatUSD(order.codTotal)}</td></tr>
  <tr><td colspan="2" style="font-weight: 700; color: #2E5A47;">You save ${formatUSD(order.subtotal - order.codTotal)} with COD vs Net 30.</td></tr>
</table>

<p class="fine">Payment terms: COD saves 10% vs standard Net 30; Net 15 saves 5%; first orders save 5%. Payment due on delivery — cash, check, or ACH. This invoice was generated from the hpw-ny.com order form; review and edit before sending. Delivery notes: ${escapeHtml(order.deliveryHours || '—')}</p>
</body>
</html>`;
}
