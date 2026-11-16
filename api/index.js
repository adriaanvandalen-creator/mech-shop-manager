// Vercel serverless entrypoint.
// The Express app in server/index.js is exported and used directly as the
// serverless function handler (Express apps are (req, res) compatible).
module.exports = require('../server/index.js');
