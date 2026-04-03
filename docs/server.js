const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 8787;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const LEADS_FILE = path.join(DATA_DIR, 'pilot-leads.jsonl');
const APPOINTMENTS_FILE = path.join(DATA_DIR, 'appointments.json');

function send(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      send(res, 404, 'Not found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const typeMap = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.csv': 'text/csv; charset=utf-8',
      '.txt': 'text/plain; charset=utf-8'
    };

    send(res, 200, data, typeMap[ext] || 'application/octet-stream');
  });
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1e6) {
        req.destroy();
        reject(new Error('Request too large'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  ensureDataDir();
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function normalizeLead(payload, req) {
  const practice = String(payload.practice || '').trim();
  const email = String(payload.email || '').trim();
  const phone = String(payload.phone || '').trim();

  if (!practice) throw new Error('Practice name is required');
  if (!email) throw new Error('Email is required');

  return {
    created_at: new Date().toISOString(),
    practice,
    email,
    phone,
    source: 'scheduleiq-pilot-form',
    user_agent: req.headers['user-agent'] || '',
    ip: req.socket.remoteAddress || ''
  };
}

function toSlug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'appointment';
}

function parseCsvLine(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      cells.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  cells.push(current.trim());
  return cells;
}

function parseAppointmentsCsv(csvText) {
  const rows = String(csvText || '')
    .split(/\r?\n/)
    .map(row => row.trim())
    .filter(Boolean);

  if (rows.length < 2) throw new Error('CSV must include a header row and at least one appointment');

  const headers = parseCsvLine(rows[0]).map(value => value.toLowerCase());
  const required = ['patient_name', 'phone', 'appointment_date', 'appointment_time'];
  const missing = required.filter(key => !headers.includes(key));
  if (missing.length) {
    throw new Error(`CSV is missing required columns: ${missing.join(', ')}`);
  }

  return rows.slice(1).map((line, index) => {
    const values = parseCsvLine(line);
    const record = Object.fromEntries(headers.map((header, idx) => [header, values[idx] || '']));

    const patientName = String(record.patient_name || '').trim();
    const phone = String(record.phone || '').trim();
    const appointmentDate = String(record.appointment_date || '').trim();
    const appointmentTime = String(record.appointment_time || '').trim();

    if (!patientName || !phone || !appointmentDate || !appointmentTime) {
      throw new Error(`Row ${index + 2} is missing required values`);
    }

    const dateTime = new Date(`${appointmentDate} ${appointmentTime}`);

    return {
      id: `${toSlug(patientName)}-${appointmentDate}-${appointmentTime.replace(/[^0-9a-z]/gi, '').toLowerCase()}`,
      patient_name: patientName,
      phone,
      appointment_date: appointmentDate,
      appointment_time: appointmentTime,
      scheduled_for: Number.isNaN(dateTime.getTime()) ? '' : dateTime.toISOString(),
      reminder_48h_status: 'queued',
      reminder_2h_status: 'queued',
      confirmation_status: 'awaiting-response',
      patient_response: '',
      staff_action: 'watch',
      last_updated_at: new Date().toISOString()
    };
  });
}

function readAppointments() {
  return readJson(APPOINTMENTS_FILE, []);
}

function writeAppointments(items) {
  writeJson(APPOINTMENTS_FILE, items);
}

async function handleLeadSubmit(req, res) {
  try {
    const raw = await collectBody(req);
    const payload = raw ? JSON.parse(raw) : {};
    const lead = normalizeLead(payload, req);

    ensureDataDir();
    fs.appendFileSync(LEADS_FILE, JSON.stringify(lead) + '\n');

    send(res, 200, JSON.stringify({ ok: true, lead }), 'application/json; charset=utf-8');
  } catch (error) {
    const status = error.message === 'Request too large' ? 413 : 400;
    send(res, status, JSON.stringify({ ok: false, error: error.message }), 'application/json; charset=utf-8');
  }
}

async function handleAppointmentUpload(req, res) {
  try {
    const raw = await collectBody(req);
    const payload = raw ? JSON.parse(raw) : {};
    const csv = String(payload.csv || '').trim();
    if (!csv) throw new Error('CSV content is required');

    const appointments = parseAppointmentsCsv(csv);
    writeAppointments(appointments);

    send(res, 200, JSON.stringify({ ok: true, count: appointments.length, appointments }, null, 2), 'application/json; charset=utf-8');
  } catch (error) {
    send(res, 400, JSON.stringify({ ok: false, error: error.message }), 'application/json; charset=utf-8');
  }
}

async function handleAppointmentStatusUpdate(req, res, appointmentId) {
  try {
    const raw = await collectBody(req);
    const payload = raw ? JSON.parse(raw) : {};
    const confirmationStatus = String(payload.confirmation_status || '').trim();

    const allowedStatuses = ['awaiting-response', 'confirmed', 'reschedule-requested', 'follow-up-needed', 'no-show-risk'];
    if (!allowedStatuses.includes(confirmationStatus)) {
      throw new Error(`Invalid confirmation_status. Allowed: ${allowedStatuses.join(', ')}`);
    }

    const appointments = readAppointments();
    const index = appointments.findIndex(item => item.id === appointmentId);
    if (index === -1) {
      send(res, 404, JSON.stringify({ ok: false, error: 'Appointment not found' }), 'application/json; charset=utf-8');
      return;
    }

    const next = {
      ...appointments[index],
      confirmation_status: confirmationStatus,
      patient_response: String(payload.patient_response || appointments[index].patient_response || '').trim(),
      staff_action: String(payload.staff_action || appointments[index].staff_action || '').trim(),
      reminder_48h_status: String(payload.reminder_48h_status || appointments[index].reminder_48h_status || '').trim(),
      reminder_2h_status: String(payload.reminder_2h_status || appointments[index].reminder_2h_status || '').trim(),
      last_updated_at: new Date().toISOString()
    };

    appointments[index] = next;
    writeAppointments(appointments);

    send(res, 200, JSON.stringify({ ok: true, appointment: next }, null, 2), 'application/json; charset=utf-8');
  } catch (error) {
    send(res, 400, JSON.stringify({ ok: false, error: error.message }), 'application/json; charset=utf-8');
  }
}

const server = http.createServer(async (req, res) => {
  if (!req.url) return send(res, 400, 'Bad request');

  if (req.method === 'OPTIONS') {
    return send(res, 204, '');
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'POST' && url.pathname === '/api/pilot') {
    return handleLeadSubmit(req, res);
  }

  if (req.method === 'GET' && url.pathname === '/api/pilot/leads') {
    if (!fs.existsSync(LEADS_FILE)) {
      return send(res, 200, '[]', 'application/json; charset=utf-8');
    }
    const rows = fs.readFileSync(LEADS_FILE, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    return send(res, 200, JSON.stringify(rows, null, 2), 'application/json; charset=utf-8');
  }

  if (req.method === 'GET' && url.pathname === '/api/appointments') {
    const appointments = readAppointments();
    return send(res, 200, JSON.stringify(appointments, null, 2), 'application/json; charset=utf-8');
  }

  if (req.method === 'POST' && url.pathname === '/api/appointments/upload') {
    return handleAppointmentUpload(req, res);
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/appointments/') && url.pathname.endsWith('/status')) {
    const parts = url.pathname.split('/').filter(Boolean);
    const appointmentId = parts[2];
    return handleAppointmentStatusUpdate(req, res, appointmentId);
  }

  let filePath = path.join(ROOT, url.pathname === '/' ? '/index.html' : url.pathname);
  if (!filePath.startsWith(ROOT)) {
    return send(res, 403, 'Forbidden');
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    return serveFile(res, filePath);
  }

  return send(res, 404, 'Not found');
});

server.listen(PORT, () => {
  console.log(`ScheduleIQ server running at http://localhost:${PORT}`);
});
