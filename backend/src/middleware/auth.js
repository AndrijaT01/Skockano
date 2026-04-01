const jwt = require('jsonwebtoken');
const { config } = require('../config');
const JWT_SECRET = config.jwtSecret;

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Niste prijavljeni' });
  }
  try {
    const token = header.split(' ')[1];
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Token nije validan' });
  }
}

module.exports = { authMiddleware, JWT_SECRET };
