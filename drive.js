// drive.js — Continental Agent 1
// Credential loading priority:
//   1. GOOGLE_CREDENTIALS_JSON env var  (Render.com / production)
//   2. credentials.json file            (local development fallback)

const { google } = require('googleapis');
const fs   = require('fs');
const path = require('path');

let _driveClient         = null;
let _continentalFolderId = null;

// ── Load credentials (env-first, file fallback) ────────────────────────────
function loadCredentials() {
  // Priority 1: Render env var
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    try {
      const parsed = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
      console.log('[Auth] credentials source: GOOGLE_CREDENTIALS_JSON env var');
      return parsed;
    } catch (e) {
      throw new Error('GOOGLE_CREDENTIALS_JSON is not valid JSON: ' + e.message);
    }
  }

  // Priority 2: local credentials.json file
  const credPath = path.join(__dirname, 'credentials.json');
  if (fs.existsSync(credPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(credPath, 'utf8'));
      console.log('[Auth] credentials source: credentials.json (local file)');
      return parsed;
    } catch (e) {
      throw new Error('credentials.json is not valid JSON: ' + e.message);
    }
  }

  throw new Error(
    'No credentials found. Set GOOGLE_CREDENTIALS_JSON env var on Render, ' +
    'or place credentials.json in the project root for local development.'
  );
}

// ── Credential Inspector (safe — never logs secret values) ─────────────────
function inspectCredentials() {
  const report = { ok: false, steps: {} };

  // 1. Check credentials source
  let raw;
  try {
    raw = loadCredentials();
  } catch (e) {
    report.steps.credentials = `✗ ${e.message}`;
    report.error = e.message;
    return report;
  }

  const inner = raw.web || raw.installed || raw;
  const source = process.env.GOOGLE_CREDENTIALS_JSON
    ? 'GOOGLE_CREDENTIALS_JSON (env var)'
    : 'credentials.json (local file)';

  report.steps.credentials = {
    source,
    wrapper_key:   raw.web ? '"web"' : raw.installed ? '"installed"' : '(flat)',
    client_id:     inner.client_id     ? '✓ present' : '✗ MISSING',
    client_secret: inner.client_secret ? '✓ present' : '✗ MISSING',
  };

  if (!inner.client_id || !inner.client_secret) {
    report.error = 'credentials missing client_id or client_secret';
    return report;
  }

  // 2. Check GOOGLE_TOKEN_JSON
  const tokenRaw = process.env.GOOGLE_TOKEN_JSON;
  if (!tokenRaw) {
    report.steps.google_token_json = '✗ Not set';
    report.error = 'GOOGLE_TOKEN_JSON not set';
    return report;
  }

  let tok;
  try { tok = JSON.parse(tokenRaw); }
  catch (e) {
    report.steps.google_token_json = `✗ JSON parse error: ${e.message}`;
    report.error = 'GOOGLE_TOKEN_JSON is not valid JSON';
    return report;
  }

  report.steps.google_token_json = {
    refresh_token: tok.refresh_token ? '✓ present' : '✗ MISSING — required',
    access_token:  tok.access_token  ? '✓ present (will be refreshed)' : '— not present (ok)',
  };

  if (!tok.refresh_token) {
    report.error = 'GOOGLE_TOKEN_JSON has no refresh_token';
    return report;
  }

  // 3. Environment summary
  report.steps.environment = {
    GOOGLE_DRIVE_ACTIVE:    process.env.GOOGLE_DRIVE_ACTIVE || '(not set)',
    GD_PARENT_FOLDER_NAME:  process.env.GD_PARENT_FOLDER_NAME || 'Continental (default)',
    credentials_source:     source,
  };

  report.ok      = true;
  report.summary = 'All credentials present. Auth should succeed.';
  return report;
}

// ── Build Auth Client ───────────────────────────────────────────────────────
async function buildAuth() {
  const raw   = loadCredentials();
  const cred  = raw.web || raw.installed || raw;

  console.log(`[Auth] client_id: ${cred.client_id?.slice(0, 24)}…`);

  const tokenRaw = process.env.GOOGLE_TOKEN_JSON;
  if (!tokenRaw) throw new Error('GOOGLE_TOKEN_JSON is not set');
  const tok = JSON.parse(tokenRaw);
  if (!tok.refresh_token) throw new Error('GOOGLE_TOKEN_JSON has no refresh_token');

  console.log(`[Auth] refresh_token: ${tok.refresh_token.slice(0, 16)}…`);

  const oauth2 = new google.auth.OAuth2(
    cred.client_id,
    cred.client_secret,
    cred.redirect_uris?.[0] || 'urn:ietf:wg:oauth:2.0:oob'
  );
  oauth2.setCredentials({
    refresh_token: tok.refresh_token,
    ...(tok.access_token ? { access_token: tok.access_token } : {}),
  });

  console.log('[Auth] Validating — forcing token refresh…');
  try {
    const result = await oauth2.refreshAccessToken();
    console.log(`[Auth] ✓ Token refresh OK — access_token: ${result.credentials.access_token?.slice(0, 20)}…`);
  } catch (err) {
    const code = err.response?.data?.error;
    if (code === 'invalid_client') throw new Error('Auth: invalid_client — check client_id/client_secret in credentials.');
    if (code === 'invalid_grant')  throw new Error('Auth: invalid_grant — refresh_token expired or revoked. Re-authorise.');
    throw new Error(`Auth: ${code || err.message}`);
  }

  return oauth2;
}

// ── Drive Client (cached) ───────────────────────────────────────────────────
async function getDriveClient() {
  if (_driveClient) return _driveClient;
  const auth = await buildAuth();
  _driveClient = google.drive({ version: 'v3', auth });
  console.log('[Drive] ✓ Drive client ready');
  return _driveClient;
}

// ── Folder Helpers ──────────────────────────────────────────────────────────
async function findOrCreateFolder(drive, name, parentId = null) {
  const parentQuery = parentId ? `'${parentId}' in parents` : `'root' in parents`;
  console.log(`[Drive] Looking for folder: "${name}"…`);
  const res = await drive.files.list({
    q: `mimeType='application/vnd.google-apps.folder' and name='${name}' and ${parentQuery} and trashed=false`,
    fields: 'files(id, name)', spaces: 'drive',
  });
  if (res.data.files.length > 0) {
    console.log(`[Drive] ✓ Found: "${name}" → ${res.data.files[0].id}`);
    return res.data.files[0].id;
  }
  console.log(`[Drive] Creating folder: "${name}"…`);
  const r = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder',
                   ...(parentId ? { parents: [parentId] } : {}) },
    fields: 'id',
  });
  console.log(`[Drive] ✓ Created: "${name}" → ${r.data.id}`);
  return r.data.id;
}

async function getContinentalFolderId() {
  if (_continentalFolderId) return _continentalFolderId;
  const drive = await getDriveClient();
  const name  = process.env.GD_PARENT_FOLDER_NAME || 'Continental';
  _continentalFolderId = await findOrCreateFolder(drive, name, null);
  return _continentalFolderId;
}

// ── Upload ──────────────────────────────────────────────────────────────────
async function uploadToContinental({ buffer, filename, mimeType }) {
  console.log(`[Drive] Upload: ${filename} (${(buffer.length / 1024).toFixed(1)} KB)`);
  const drive    = await getDriveClient();
  const folderId = await getContinentalFolderId();
  const { Readable } = require('stream');
  const res = await drive.files.create({
    requestBody: { name: filename, parents: [folderId] },
    media:       { mimeType, body: Readable.from(buffer) },
    fields:      'id, name, webViewLink, createdTime',
  });
  console.log(`[Drive] ✓ Uploaded → fileId: ${res.data.id}`);
  return { fileId: res.data.id, webViewLink: res.data.webViewLink,
           name: res.data.name, createdTime: res.data.createdTime };
}

module.exports = { uploadToContinental, getContinentalFolderId, inspectCredentials };
