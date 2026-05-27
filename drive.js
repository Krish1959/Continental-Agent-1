// drive.js — Continental Agent 1
// Auth pattern: credentials.json (client_id/secret) + GOOGLE_TOKEN_JSON (refresh_token)
// This matches the standard Google OAuth2 quickstart pattern used in Gmail-to-PDF.

const { google } = require('googleapis');
const fs   = require('fs');
const path = require('path');

let _driveClient         = null;
let _continentalFolderId = null;

// ── Credential Inspector (safe — never logs secret values) ─────────────────
function inspectCredentials() {
  const report = { ok: false, steps: {} };

  // 1. Check credentials.json
  const credPath = path.join(__dirname, 'credentials.json');
  if (!fs.existsSync(credPath)) {
    report.steps.credentials_json = '✗ MISSING — place credentials.json in project root';
    report.error = 'credentials.json not found';
    return report;
  }
  let creds;
  try {
    creds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  } catch(e) {
    report.steps.credentials_json = `✗ JSON parse error: ${e.message}`;
    report.error = 'credentials.json is not valid JSON';
    return report;
  }

  // credentials.json can be wrapped in a "web" or "installed" key
  const inner = creds.web || creds.installed || creds;
  report.steps.credentials_json = {
    found:         '✓',
    client_id:     inner.client_id     ? '✓ present' : '✗ MISSING',
    client_secret: inner.client_secret ? '✓ present' : '✗ MISSING',
    wrapper_key:   creds.web ? '"web"' : creds.installed ? '"installed"' : '(flat)',
  };

  if (!inner.client_id || !inner.client_secret) {
    report.error = 'credentials.json is missing client_id or client_secret';
    return report;
  }

  // 2. Check GOOGLE_TOKEN_JSON
  const raw = process.env.GOOGLE_TOKEN_JSON;
  if (!raw) {
    report.steps.google_token_json = '✗ Not set in .env';
    report.error = 'GOOGLE_TOKEN_JSON not set';
    return report;
  }
  let tok;
  try { tok = JSON.parse(raw); }
  catch(e) {
    report.steps.google_token_json = `✗ JSON parse error: ${e.message}`;
    report.error = 'GOOGLE_TOKEN_JSON is not valid JSON';
    return report;
  }

  report.steps.google_token_json = {
    refresh_token: tok.refresh_token ? '✓ present' : '✗ MISSING — this is required',
    access_token:  tok.access_token  ? '✓ present (bonus, will be refreshed)' : '— not present (ok)',
    type_field:    tok.type          ? `"${tok.type}"` : '— not present (ok, not needed here)',
  };

  if (!tok.refresh_token) {
    report.error = 'GOOGLE_TOKEN_JSON has no refresh_token';
    return report;
  }

  report.ok      = true;
  report.summary = 'Both credentials.json and GOOGLE_TOKEN_JSON look good. Auth should work.';
  return report;
}

// ── Build Auth Client ───────────────────────────────────────────────────────
async function buildAuth() {
  // Load client_id + client_secret from credentials.json
  const credPath = path.join(__dirname, 'credentials.json');
  if (!fs.existsSync(credPath)) {
    throw new Error('credentials.json not found in project root. Copy it from Google Cloud Console.');
  }
  const raw  = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  const cred = raw.web || raw.installed || raw; // handle wrapped or flat format

  console.log(`[Auth] credentials.json loaded — client_id: ${cred.client_id?.slice(0, 24)}…`);

  // Load refresh_token from GOOGLE_TOKEN_JSON env var
  const tokenRaw = process.env.GOOGLE_TOKEN_JSON;
  if (!tokenRaw) throw new Error('GOOGLE_TOKEN_JSON is not set in .env');
  const tok = JSON.parse(tokenRaw);
  if (!tok.refresh_token) throw new Error('GOOGLE_TOKEN_JSON has no refresh_token field');

  console.log(`[Auth] Token loaded — refresh_token: ${tok.refresh_token.slice(0, 16)}…`);

  // Build OAuth2 client
  const oauth2 = new google.auth.OAuth2(
    cred.client_id,
    cred.client_secret,
    cred.redirect_uris?.[0] || 'urn:ietf:wg:oauth:2.0:oob'
  );
  oauth2.setCredentials({
    refresh_token: tok.refresh_token,
    ...(tok.access_token ? { access_token: tok.access_token } : {}),
  });

  // Force a token refresh NOW — fail fast if credentials are wrong
  console.log('[Auth] Validating — forcing token refresh…');
  try {
    const result = await oauth2.refreshAccessToken();
    console.log(`[Auth] ✓ Token refresh OK — access_token: ${result.credentials.access_token?.slice(0, 20)}…`);
  } catch(err) {
    const code = err.response?.data?.error;
    console.error(`[Auth] ✗ Token refresh FAILED: ${code || err.message}`);
    if (code === 'invalid_client') {
      throw new Error('Auth failed: invalid_client — client_id or client_secret in credentials.json is wrong or the OAuth app was deleted.');
    }
    if (code === 'invalid_grant') {
      throw new Error('Auth failed: invalid_grant — refresh_token has expired or been revoked. Re-run the OAuth flow to get a new token.');
    }
    throw new Error(`Auth failed: ${code || err.message}`);
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
    fields: 'files(id, name)',
    spaces: 'drive',
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
  console.log(`[Drive] Upload: ${filename} (${(buffer.length/1024).toFixed(1)} KB)`);
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
