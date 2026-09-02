export const VULNERABLE_SNIPPETS: Record<string, { language: string; code: string }> = {
  sqlInjection: {
    language: 'javascript',
    code: `function getUser(db, req, res) {
  const userId = req.query.id;
  db.query("SELECT * FROM users WHERE id = '" + userId + "'", (err, results) => {
    res.json(results);
  });
}
module.exports = { getUser };
`
  },
  xss: {
    language: 'javascript',
    code: `function renderComment(comment) {
  document.getElementById('comments').innerHTML += '<div>' + comment + '</div>';
}
module.exports = { renderComment };
`
  },
  commandInjection: {
    language: 'javascript',
    code: `const { exec } = require('child_process');
function pingHost(host, cb) {
  exec('ping -c 1 ' + host, (err, stdout) => cb(err, stdout));
}
module.exports = { pingHost };
`
  },
  pathTraversal: {
    language: 'javascript',
    code: `const fs = require('fs');
const path = require('path');
function readUserFile(baseDir, filename) {
  const target = path.join(baseDir, filename);
  return fs.readFileSync(target, 'utf-8');
}
module.exports = { readUserFile };
`
  },
  hardcodedSecret: {
    language: 'javascript',
    code: `const API_KEY = "sk_live_1234567890abcdef";
function callExternalApi() {
  return fetch('https://api.example.com', { headers: { Authorization: API_KEY } });
}
module.exports = { callExternalApi };
`
  },
  weakCrypto: {
    language: 'javascript',
    code: `const crypto = require('crypto');
function hashPassword(password) {
  return crypto.createHash('md5').update(password).digest('hex');
}
module.exports = { hashPassword };
`
  }
};

export const CLEAN_SNIPPET = {
  language: 'javascript',
  code: `function add(a, b) {
  return a + b;
}
module.exports = { add };
`
};
