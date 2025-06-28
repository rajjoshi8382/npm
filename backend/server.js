const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const fs = require('fs-extra');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 5000;

const uploadDir = path.join(__dirname, 'uploads');
const outputDir = path.join(__dirname, 'output');
fs.ensureDirSync(uploadDir);
fs.ensureDirSync(outputDir);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/output', express.static(outputDir));

let globalData = [];

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => cb(null, 'input.xlsx')
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (
      file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      file.mimetype === 'application/vnd.ms-excel'
    ) {
      cb(null, true);
    } else {
      cb(new Error('Only Excel files are allowed!'), false);
    }
  }
});

function extractDateOnly(value) {
  if (!value) return '';
  if (typeof value === 'number') {
    const excelEpoch = new Date(Date.UTC(1899, 11, 30));
    return new Date(excelEpoch.getTime() + (value - 1) * 86400000).toISOString().slice(0, 10);
  }
  if (typeof value === 'string' && /^\d{2}-\d{2}-\d{4}/.test(value)) {
    const [d, m, y] = value.split(' ')[0].split('-');
    const date = new Date(`${y}-${m}-${d}`);
    return isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
  }
  const parsed = new Date(value);
  return isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
}

app.post('/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const filePath = req.file.path;
    const workbook = XLSX.readFile(filePath, { raw: true, cellDates: true });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rawData = XLSX.utils.sheet_to_json(sheet);

    if (!rawData || rawData.length === 0) {
      return res.status(400).json({ error: 'Excel file is empty' });
    }

    const firstRow = rawData[0];
    const requiredColumns = ['Merchant Name', 'Withdrawal Amount', 'Withdrawal Fees'];
    const missingColumns = requiredColumns.filter(col => !firstRow.hasOwnProperty(col));
    const hasDateColumn = Object.keys(firstRow).some(key =>
      ['Date', 'Transaction Date', 'Created At'].includes(key)
    );

    if (missingColumns.length > 0 || !hasDateColumn) {
      return res.status(400).json({
        error: `Missing columns: ${missingColumns.join(', ')}${!hasDateColumn ? ', Date or Transaction Date or Created At' : ''}`
      });
    }

    globalData = rawData.map(row => {
      const dateVal = row['Date'] || row['Transaction Date'] || row['Created At'];
      return {
        ...row,
        DateOnly: extractDateOnly(dateVal)
      };
    });

    const merchants = [...new Set(globalData.map(row => row['Merchant Name']).filter(Boolean))].sort();

    return res.json({ success: true, merchants, count: globalData.length });

  } catch (err) {
    return res.status(500).json({ error: err.message || 'Upload failed' });
  }
});

app.post('/generate', (req, res) => {
  try {
    const { merchantPercents, startDate, endDate } = req.body;

    if (!merchantPercents || !startDate || !endDate) {
      return res.status(400).json({ error: 'Missing filters' });
    }

    const normalizedStart = new Date(startDate).toISOString().slice(0, 10);
    const normalizedEnd = new Date(endDate).toISOString().slice(0, 10);

    if (normalizedStart > normalizedEnd) {
      return res.status(400).json({ error: 'Start date after end date' });
    }

    const dateFiltered = globalData.filter(row =>
      row.DateOnly >= normalizedStart && row.DateOnly <= normalizedEnd
    );

    if (dateFiltered.length === 0) {
      return res.status(404).json({ error: 'No data in date range' });
    }

    const summaryData = [];
    const filteredData = [];
    let grandW = 0, grandF = 0, grandP = 0;

    for (const merchant in merchantPercents) {
      const percent = parseFloat(merchantPercents[merchant]);
      if (isNaN(percent)) continue;

      const rows = dateFiltered.filter(row => row['Merchant Name'] === merchant);
      if (rows.length === 0) continue;

      let totalW = 0, totalF = 0, totalP = 0;

      rows.forEach(row => {
        const withdrawal = parseFloat(row['Withdrawal Amount'] || 0);
        const fee = parseFloat(row['Withdrawal Fees'] || 0);
        const percentAmount = withdrawal * percent / 100;

        row[`${percent}% Amount`] = percentAmount;
        filteredData.push(row);

        totalW += withdrawal;
        totalF += fee;
        totalP += percentAmount;
      });

      summaryData.push({
        'Merchant': merchant,
        'Total Withdrawal Amount': totalW,
        'Total Withdrawal Fees': totalF,
        [`${percent}% Amount`]: totalP
      });

      grandW += totalW;
      grandF += totalF;
      grandP += totalP;
    }

    if (summaryData.length === 0) {
      return res.status(404).json({ error: 'No matching merchant data' });
    }

    summaryData.push({
      'Merchant': 'TOTAL',
      'Total Withdrawal Amount': grandW,
      'Total Withdrawal Fees': grandF,
      [`TOTAL % Amount`]: grandP
    });

    const wb = XLSX.utils.book_new();
    const wsData = XLSX.utils.json_to_sheet(filteredData);
    const wsSummary = XLSX.utils.json_to_sheet(summaryData);
    XLSX.utils.book_append_sheet(wb, wsData, 'Filtered Data');
    XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary');

    const filename = `merchant_report_${Date.now()}.xlsx`;
    const filepath = path.join(outputDir, filename);
    XLSX.writeFile(wb, filepath);

    const formattedSummary = summaryData.map(row => {
      const result = { ...row };
      for (const key in result) {
        if (typeof result[key] === 'number') {
          result[key] = result[key].toFixed(2);
        }
      }
      return result;
    });

    res.json({
      success: true,
      summary: formattedSummary,
      downloadUrl: `/output/${filename}`,
      dateRange: `${normalizedStart} to ${normalizedEnd}`
    });

  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to generate report' });
  }
});

// ✅ Serve React frontend from the build folder
app.use(express.static(path.join(__dirname, '../frontend/build')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/build', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
