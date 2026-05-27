// ledger.js — Bills.csv ledger manager for Continental Agent 1
// Appends a new PENDING row to Google Drive /Continental/Bills.csv
// after each successful receipt upload.

const { google } = require('googleapis');
const { getContinentalFolderId } = require('./drive');

// CSV column headers matching the full Xero schema
const HEADERS = [
  'Row_ID',
  'File_Drive_ID',
  'File_Name',
  'Upload_Timestamp',
  'Contact',
  'Date',
  'Due_Date',
  'Invoice_Ref',
  'Currency',
  'Amounts_Are',
  'Line_Description',
  'Line_Qty',
  'Line_Unit_Price',
  'Line_Account_Code',
  'Line_Tax_Rate',
  'Tracking_Employee',
  'Gemini_Status',
  'OpenAI_Status',
  'Consensus_Match',
  'Xero_Sync_Status',
  'Xero_Invoice_ID',
];

let _sheetsClient = null;
let _spreadsheetId = null;

async function getAuth() {
  const { google } = require('googleapis');
  const tokenJson = process.env.GOOGLE_TOKEN_JSON;
  const credentials = JSON.parse(tokenJson);

  if (credentials.type === 'service_account') {
    return new google.auth.GoogleAuth({
      credentials,
      scopes: [
        'https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/spreadsheets',
      ],
    });
  }
  // OAuth2 / authorized_user
  const oauth2Client = new google.auth.OAuth2(
    credentials.client_id,
    credentials.client_secret
  );
  oauth2Client.setCredentials({ refresh_token: credentials.refresh_token });
  return oauth2Client;
}

/**
 * Find or create Bills.csv (as a Google Sheet) in /Continental/
 * Returns the spreadsheet ID.
 */
async function getOrCreateLedger(drive, folderId) {
  if (_spreadsheetId) return _spreadsheetId;

  // Search for existing Bills sheet
  const res = await drive.files.list({
    q: `name='Bills' and '${folderId}' in parents and trashed=false and mimeType='application/vnd.google-apps.spreadsheet'`,
    fields: 'files(id, name)',
  });

  if (res.data.files.length > 0) {
    _spreadsheetId = res.data.files[0].id;
    console.log(`[Ledger] Found existing Bills sheet: ${_spreadsheetId}`);
    return _spreadsheetId;
  }

  // Create new Google Sheet named "Bills"
  const auth = await getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const createRes = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title: 'Bills' },
      sheets: [{ properties: { title: 'Ledger' } }],
    },
  });

  _spreadsheetId = createRes.data.spreadsheetId;
  console.log(`[Ledger] Created Bills sheet: ${_spreadsheetId}`);

  // Move the new sheet into /Continental/ folder
  await drive.files.update({
    fileId: _spreadsheetId,
    addParents: folderId,
    removeParents: 'root',
    fields: 'id, parents',
  });

  // Write the header row
  await sheets.spreadsheets.values.append({
    spreadsheetId: _spreadsheetId,
    range: 'Ledger!A1',
    valueInputOption: 'RAW',
    requestBody: { values: [HEADERS] },
  });

  return _spreadsheetId;
}

/**
 * Append a new PENDING row to the Bills ledger.
 * @param {object} params
 * @param {string} params.rowId         - UUID for this record
 * @param {string} params.fileId        - Google Drive file ID
 * @param {string} params.fileName      - Original filename
 * @param {string} params.uploadTs      - ISO timestamp
 */
async function appendLedgerRow({ rowId, fileId, fileName, uploadTs }) {
  const auth = await getAuth();
  const drive = google.drive({ version: 'v3', auth });
  const sheets = google.sheets({ version: 'v4', auth });

  const folderId = await getContinentalFolderId();
  const spreadsheetId = await getOrCreateLedger(drive, folderId);

  const row = [
    rowId,       // Row_ID
    fileId,      // File_Drive_ID
    fileName,    // File_Name
    uploadTs,    // Upload_Timestamp
    'xxx',       // Contact          — to be parsed by Agent 2
    'xxx',       // Date
    'n.a.',      // Due_Date
    'xxx',       // Invoice_Ref
    'SGD',       // Currency
    'Tax Inclusive', // Amounts_Are
    'xxx',       // Line_Description
    '1',         // Line_Qty
    'xxx',       // Line_Unit_Price
    'xxx',       // Line_Account_Code
    'xxx',       // Line_Tax_Rate
    'xxx',       // Tracking_Employee
    'PENDING',   // Gemini_Status
    'PENDING',   // OpenAI_Status
    'FALSE',     // Consensus_Match
    'UNVERIFIED',// Xero_Sync_Status
    '',          // Xero_Invoice_ID
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: 'Ledger!A1',
    valueInputOption: 'RAW',
    requestBody: { values: [row] },
  });

  console.log(`[Ledger] Appended row ${rowId} → PENDING`);
  return spreadsheetId;
}

module.exports = { appendLedgerRow };
