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
  Center_Tin: { label: 'Center — Tin', unitPrice: 25.00, caseSize: 32 },
  Center_Singles: { label: 'Center — Singles', unitPrice: 5.50, caseSize: 32 },
  Uplift_Tin: { label: 'Uplift — Tin', unitPrice: 25.00, caseSize: 32 },
  Uplift_Singles: { label: 'Uplift — Singles', unitPrice: 5.50, caseSize: 32 },
  Unwind_Tin: { label: 'Unwind — Tin', unitPrice: 25.00, caseSize: 32 },
  Unwind_Singles: { label: 'Unwind — Singles', unitPrice: 5.50, caseSize: 32 },
  Transcend_Tin: { label: 'Transcend — Tin', unitPrice: 31.00, caseSize: 32 },
};

const COD_DISCOUNT_RATE = 0.10;

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

  // --- Server-side validation — everything required except deliveryHours and notes ---
  const requiredFields = ['dispensaryName', 'dispensaryLicense', 'dispensaryAddress', 'buyerName', 'buyerEmail', 'buyerPhone'];
  const missing = requiredFields.filter((f) => !data[f] || String(data[f]).trim() === '');
  if (missing.length) {
    return jsonResponse(400, { error: `Missing required field(s): ${missing.join(', ')}` });
  }

  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailPattern.test(data.buyerEmail.trim())) {
    return jsonResponse(400, { error: 'Buyer email looks invalid' });
  }

  const licensePattern = /^OCM-[A-Z]+-\d{2}-\d{5,6}$/i;
  if (!licensePattern.test(data.dispensaryLicense.trim())) {
    return jsonResponse(400, {
      error: 'Dispensary license number doesn\'t look right (expected format like OCM-DIST-25-000191)',
    });
  }

  const rawItems = data.items && typeof data.items === 'object' ? data.items : {};

  // --- Recompute everything server-side from the PRODUCTS table ---
  const lines = [];
  let subtotal = 0;
  let totalUnits = 0;

  for (const key of Object.keys(PRODUCTS)) {
    const caseQty = Number(rawItems[key]);
    if (!Number.isInteger(caseQty) || caseQty < 0 || caseQty > 10) {
      return jsonResponse(400, { error: `Invalid case quantity for ${key} (must be a whole number 0–10)` });
    }
    if (caseQty === 0) continue;

    const product = PRODUCTS[key];
    const units = caseQty * product.caseSize;
    const lineTotal = units * product.unitPrice;
    subtotal += lineTotal;
    totalUnits += units;
    lines.push({ key, label: product.label, caseQty, units, lineTotal });
  }

  if (lines.length === 0) {
    return jsonResponse(400, { error: 'Order must include at least one item with a case quantity greater than 0' });
  }

  const codTotal = subtotal * (1 - COD_DISCOUNT_RATE);
  const summaryLine = lines.map((l) => `${l.label}: ${l.caseQty} case${l.caseQty > 1 ? 's' : ''} (${l.units} units)`).join(', ');
  const submittedAt = new Date().toISOString();

  const order = {
    dispensaryName: data.dispensaryName.trim(),
    dispensaryLicense: data.dispensaryLicense.trim(),
    dispensaryAddress: data.dispensaryAddress.trim(),
    buyerName: data.buyerName.trim(),
    buyerEmail: data.buyerEmail.trim(),
    buyerPhone: data.buyerPhone.trim(),
    deliveryHours: (data.deliveryHours || '').trim(),
    notes: (data.notes || '').trim(),
    summaryLine,
    itemsJson: JSON.stringify(Object.fromEntries(lines.map((l) => [l.key, l.caseQty]))),
    totalUnits,
    subtotal,
    codTotal,
    submittedAt,
  };

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
  });
};

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
      text: [
        `Dispensary: ${order.dispensaryName}`,
        `Dispensary License: ${order.dispensaryLicense}`,
        `Dispensary Address: ${order.dispensaryAddress}`,
        `Buyer: ${order.buyerName} (${order.buyerEmail}, ${order.buyerPhone})`,
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
