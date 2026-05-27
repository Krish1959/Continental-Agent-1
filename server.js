// server.js — Continental Agent 1  (verbose diagnostic version)

require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const path    = require('path');
const { v4: uuidv4 } = require('uuid');

const { uploadToContinental, inspectCredentials } = require('./drive');
const { appendLedgerRow }                         = require('./ledger');

const app     = express();
const PORT    = process.env.PORT || 3000;
const DRY_RUN = process.env.GOOGLE_DRIVE_ACTIVE !== 'true';

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];
    allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error(`Unsupported type: ${file.mimetype}`));
  },
});

// ── Structured logger (also returned to frontend) ──────────────────────────
function makeLog() {
  const entries = [];
  const log = (level, msg) => {
    const ts = new Date().toISOString().slice(11,23); // HH:MM:SS.mmm
    const line = `[${ts}] ${level.toUpperCase().padEnd(5)} ${msg}`;
    console.log(line);
    entries.push({ ts, level, msg });
  };
  return {
    info:  (m) => log('info',  m),
    ok:    (m) => log('ok',    m),
    warn:  (m) => log('warn',  m),
    error: (m) => log('error', m),
    step:  (m) => log('step',  m),
    entries,
  };
}

// ── /health ─────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  status: 'ok',
  agent: 'Continental Agent 1',
  driveActive: !DRY_RUN,
  timestamp: new Date().toISOString(),
}));

// ── /debug/auth  ← KEY DIAGNOSTIC ENDPOINT ──────────────────────────────────
// Shows exactly what token type is detected and which fields are present/missing.
// Never exposes secret values — only presence/absence.
app.get('/debug/auth', (req, res) => {
  const report = inspectCredentials();
  const raw    = process.env.GOOGLE_TOKEN_JSON || '';

  // Extra shape hints
  const isWrappedInQuotes = raw.startsWith('"') && raw.endsWith('"');
  const looksLikeArray    = raw.trimStart().startsWith('[');

  report.envHints = {
    token_length:         raw.length,
    starts_with:          raw.slice(0, 30) + '…',
    wrapped_in_quotes:    isWrappedInQuotes,
    looks_like_array:     looksLikeArray,
    drive_active_flag:    process.env.GOOGLE_DRIVE_ACTIVE,
    gd_folder_name:       process.env.GD_PARENT_FOLDER_NAME || 'Continental',
  };

  report.guidance = report.ok
    ? 'Credentials look structurally valid. If upload still fails, the token may be expired or revoked.'
    : 'Fix the issues above, then retry /debug/auth.';

  res.json(report);
});

// ── /upload ──────────────────────────────────────────────────────────────────
app.post('/upload', upload.single('photo'), async (req, res) => {
  const log = makeLog();

  log.step('--- NEW UPLOAD REQUEST ---');

  if (!req.file) {
    log.error('No photo file in request');
    return res.status(400).json({ success: false, error: 'No photo file received.', log: log.entries });
  }

  const rowId    = uuidv4();
  const ext      = (req.file.originalname.split('.').pop() || 'jpg').toLowerCase();
  const uploadTs = new Date().toISOString();
  const fileName = `receipt_${uploadTs.replace(/[:.]/g, '-')}_${rowId.slice(0,8)}.${ext}`;

  log.info(`File received: ${req.file.originalname}`);
  log.info(`Size: ${(req.file.size / 1024).toFixed(1)} KB  |  MIME: ${req.file.mimetype}`);
  log.info(`Target name: ${fileName}`);
  log.info(`Row ID: ${rowId}`);
  log.info(`Drive active: ${!DRY_RUN}`);

  // ── DRY RUN ───────────────────────────────────────────────────────────────
  if (DRY_RUN) {
    log.warn('GOOGLE_DRIVE_ACTIVE=false → dry-run, skipping real upload');
    return res.json({ success: true, dryRun: true, rowId, fileId: 'DRY_RUN', fileName, log: log.entries });
  }

  // ── LIVE UPLOAD ───────────────────────────────────────────────────────────
  try {
    log.step('STEP 1 — Authenticating with Google…');
    // Drive client init (auth + token refresh) happens inside uploadToContinental
    // We check credentials shape first for fast feedback
    const credCheck = inspectCredentials();
    if (!credCheck.ok) {
      log.error(`Credential check failed: ${credCheck.error}`);
      return res.status(500).json({ success: false, error: credCheck.error, credentialReport: credCheck, log: log.entries });
    }
    log.ok(`Credential type: ${credCheck.type} — all required fields present`);

    log.step('STEP 2 — Uploading to Google Drive /Continental/…');
    const driveResult = await uploadToContinental({
      buffer:   req.file.buffer,
      filename: fileName,
      mimeType: req.file.mimetype,
    });
    log.ok(`Drive upload done → fileId: ${driveResult.fileId}`);
    log.ok(`View link: ${driveResult.webViewLink}`);

    log.step('STEP 3 — Appending row to Bills ledger…');
    const ledgerSheetId = await appendLedgerRow({ rowId, fileId: driveResult.fileId, fileName, uploadTs });
    log.ok(`Ledger row appended → sheetId: ${ledgerSheetId}`);

    log.ok('=== UPLOAD COMPLETE ===');

    return res.json({
      success: true,
      dryRun: false,
      rowId,
      fileId:       driveResult.fileId,
      fileName:     driveResult.name,
      webViewLink:  driveResult.webViewLink,
      ledgerSheetId,
      message: 'Receipt uploaded and logged as PENDING.',
      log: log.entries,
    });

  } catch (err) {
    log.error(`FAILED at: ${err.message}`);

    // Friendly hint based on error keyword
    let hint = 'Check server terminal for full stack trace.';
    const m = err.message || '';
    if (m.includes('invalid_grant'))   hint = 'Refresh token expired/revoked. Get a fresh token from Gmail-to-PDF project.';
    if (m.includes('invalid_client'))  hint = 'client_id or client_secret is wrong.';
    if (m.includes('invalid_request')) hint = 'Token request malformed — check GOOGLE_TOKEN_JSON structure at /debug/auth';
    if (m.includes('401'))             hint = 'Unauthorised — token rejected by Google.';
    if (m.includes('403'))             hint = 'Forbidden — Drive API may not be enabled for this project in Google Cloud Console.';
    if (m.includes('404'))             hint = 'Folder not found — share /Continental with the service account email, or use OAuth2.';

    console.error('[Agent 1] Full error:', err);

    return res.status(500).json({ success: false, error: m, hint, log: log.entries });
  }
});

// ── Error handler ────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ success: false, error: `Upload error: ${err.message}` });
  }
  res.status(500).json({ success: false, error: err.message });
});

// ── Boot ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('┌──────────────────────────────────────────────────────┐');
  console.log('│       CONTINENTAL PROJECT — AGENT 1  (verbose)       │');
  console.log('├──────────────────────────────────────────────────────┤');
  console.log(`│  http://localhost:${PORT}                                 │`);
  console.log(`│  Drive  : ${DRY_RUN ? '⚠  DRY RUN (set GOOGLE_DRIVE_ACTIVE=true)' : '✓  LIVE'}              │`);
  console.log('│  Debug  : http://localhost:' + PORT + '/debug/auth           │');
  console.log('└──────────────────────────────────────────────────────┘');
  console.log('');

  // Print credential shape at boot for instant diagnosis
  const check = inspectCredentials();
  console.log('[Boot] Credential check:');
  console.log(JSON.stringify(check, null, 2));
  console.log('');
});
