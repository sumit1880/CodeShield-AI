export interface TestCase {
  id: string;
  name: string;
  language: string;
  expectedCwes: string[]; // e.g. ['CWE-89']
  code: string;
}

export const EVAL_DATASET: TestCase[] = [
  {
    id: 'eval-sqli-01',
    name: 'OWASP Benchmark - Node SQL Injection via concatenation',
    language: 'javascript',
    expectedCwes: ['CWE-89'],
    code: `
function findUser(req, res, db) {
  const query = "SELECT * FROM accounts WHERE id = '" + req.query.id + "'";
  db.query(query, (err, rows) => {
    res.json(rows);
  });
}
`
  },
  {
    id: 'eval-xss-01',
    name: 'Juice Shop - Reflected XSS through innerHTML',
    language: 'javascript',
    expectedCwes: ['CWE-79'],
    code: `
function displayGreeting(userInput) {
  const container = document.getElementById('welcome-message');
  container.innerHTML = '<h1>Welcome, ' + userInput + '!</h1>';
}
`
  },
  {
    id: 'eval-cmdi-01',
    name: 'NodeGoat - OS Command Injection in ping utility',
    language: 'javascript',
    expectedCwes: ['CWE-78'],
    code: `
const { exec } = require('child_process');
function pingServer(req, res) {
  const target = req.body.target;
  exec("ping -c 2 " + target, (err, stdout) => {
    res.send(stdout);
  });
}
`
  },
  {
    id: 'eval-pt-01',
    name: 'OWASP Benchmark - Path Traversal reading file',
    language: 'javascript',
    expectedCwes: ['CWE-22'],
    code: `
const fs = require('fs');
const path = require('path');
function fetchReport(req, res) {
  const userFile = req.query.file;
  const filePath = path.join('/var/data/reports', userFile);
  const data = fs.readFileSync(filePath, 'utf8');
  res.send(data);
}
`
  },
  {
    id: 'eval-crypto-01',
    name: 'NodeGoat - Broken Cryptographic Hash (MD5)',
    language: 'javascript',
    expectedCwes: ['CWE-327'],
    code: `
const crypto = require('crypto');
function storePassword(password) {
  return crypto.createHash('md5').update(password).digest('hex');
}
`
  },
  {
    id: 'eval-clean-01',
    name: 'Clean - Safe parameterized database query',
    language: 'javascript',
    expectedCwes: [],
    code: `
function getUserSafe(req, res, db) {
  db.query("SELECT * FROM accounts WHERE id = $1", [req.query.id], (err, rows) => {
    if (err) return res.status(500).send("Error");
    res.json(rows);
  });
}
`
  },
  {
    id: 'eval-clean-02',
    name: 'Clean - Safe sanitized text insertion',
    language: 'javascript',
    expectedCwes: [],
    code: `
function displaySafeGreeting(userInput) {
  const container = document.getElementById('welcome-message');
  container.textContent = 'Welcome, ' + userInput + '!';
}
`
  }
];
