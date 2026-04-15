const path = require('path');
const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
const RESULTS_BASE = process.env.TEST_RESULTS_DIR || '/storage/test-results/blueprint';

module.exports = {
  testDir: '.',
  timeout: 60000,
  use: {
    baseURL: process.env.BLUEPRINT_TEST_URL || 'http://localhost:7867',
    viewport: { width: 1280, height: 720 },
    screenshot: 'on',
    trace: 'retain-on-failure',
  },
  outputDir: path.join(RESULTS_BASE, timestamp, 'ui'),
};
