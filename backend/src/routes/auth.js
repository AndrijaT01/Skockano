const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db, uuidv4, saveDb, ensurePg, getDbMeta, storeRefreshToken, consumeRefreshToken, revokeAllRefreshTokensForUser, logAuditEvent } = require('../db/inMemoryDb');
const { JWT_SECRET } = require('../middleware/auth');
const { validateRegister, validateLogin } = require('../middleware/validation');
const { config } = require('../config');

function useDirectPg() {
  const meta = getDbMeta();
  return meta.driver === 'postgres' && meta.schemaMode === 'postgres-normalized';
}

function toSafeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    location: row.location,
    createdAt: row.created_at || row.createdAt,
  };
}

function issueAccessToken(user) {
  return jwt.sign({ id: user.id, email: user.email, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: config.accessTokenTtl || '30d' });
}

async function issueRefreshToken(user) {
  const refreshToken = jwt.sign({ id: user.id, type: 'refresh' }, config.refreshTokenSecret, { expiresIn: `${config.refreshTokenTtlDays || 30}d` });
  const expiresAt = new Date(Date.now() + (config.refreshTokenTtlDays || 30) * 24 * 60 * 60 * 1000);
  await storeRefreshToken({ userId: user.id, token: refreshToken, expiresAt });
  return refreshToken;
}

async function buildAuthResponse(user, requestId) {
  const safeUser = toSafeUser(user);
  return {
    token: issueAccessToken(user),
    refreshToken: await issueRefreshToken(user),
    user: safeUser,
    session: {
      accessTokenTtl: config.accessTokenTtl,
      refreshTokenTtlDays: config.refreshTokenTtlDays,
      requestId,
    },
  };
}

async function findProviderByUserIdPg(userId) {
  const pg = await ensurePg();
  if (!pg) return null;
  const result = await pg.query(
    `SELECT p.*, 
            COALESCE(json_agg(ps.service_name ORDER BY ps.sort_order) FILTER (WHERE ps.service_name IS NOT NULL), '[]'::json) AS services,
            COALESCE(json_agg(pg.image_url ORDER BY pg.sort_order) FILTER (WHERE pg.image_url IS NOT NULL), '[]'::json) AS gallery,
            COALESCE(json_agg(pad.day_of_month ORDER BY pad.day_of_month) FILTER (WHERE pad.day_of_month IS NOT NULL), '[]'::json) AS available_dates
     FROM providers p
     LEFT JOIN provider_services ps ON ps.provider_id = p.id
     LEFT JOIN provider_gallery pg ON pg.provider_id = p.id
     LEFT JOIN provider_available_dates pad ON pad.provider_id = p.id
     WHERE p.user_id = $1
     GROUP BY p.id`,
    [userId]
  );
  return result.rows[0] || null;
}

router.post('/register', validateRegister, async (req, res) => {
  try {
    let { name, email, password, role = 'client', location = 'Beograd' } = req.body;
    if (role === 'admin') role = 'client';
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Sva polja su obavezna' });
    }

    if (useDirectPg()) {
      const pg = await ensurePg();
      const existing = await pg.query('SELECT id FROM users WHERE email = $1 LIMIT 1', [email]);
      if (existing.rows[0]) return res.status(400).json({ error: 'Email već postoji' });

      const settingsRes = await pg.query('SELECT payload FROM app_settings WHERE id = 1');
      const settings = settingsRes.rows[0]?.payload || {};
      if (role === 'provider' && settings?.allowNewProviders === false) {
        return res.status(403).json({ error: 'Registracija novih pružalaca je privremeno isključena' });
      }

      const hashed = await bcrypt.hash(password, 10);
      const userId = uuidv4();
      await pg.query(
        `INSERT INTO users (id, name, email, password_hash, role, location, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,NOW())`,
        [userId, name, email, hashed, role, location]
      );

      if (role === 'provider') {
        const providerId = uuidv4();
        const initials = name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
        await pg.query(
          `INSERT INTO providers
           (id, user_id, name, initials, location, rating, review_count, price_per_hour, verified, online, bio, color, text_color, avatar_url, stats)
           VALUES ($1,$2,$3,$4,$5,0,0,1500,false,false,'','#E1F5EE','#085041','',$6::jsonb)`,
          [providerId, userId, name, initials, location, JSON.stringify({ rating: 0, reviews: 0, jobs: 0, response: 100 })]
        );
      }
      const user = { id: userId, name, email, role, location, created_at: new Date().toISOString() };
      await logAuditEvent({ actorUserId: userId, actorRole: role, action: 'auth.register', entityType: 'user', entityId: userId, payload: { role, email }, requestId: req.requestId });
      return res.status(201).json(await buildAuthResponse(user, req.requestId));
    }

    if (db.users.find(u => u.email === email)) return res.status(400).json({ error: 'Email već postoji' });
    if (role === 'provider' && db.settings?.allowNewProviders === false) return res.status(403).json({ error: 'Registracija novih pružalaca je privremeno isključena' });

    const hashed = await bcrypt.hash(password, 10);
    const user = { id: uuidv4(), name, email, password: hashed, role, location, createdAt: new Date() };
    db.users.push(user);

    if (role === 'provider') {
      db.providers.push({
        id: uuidv4(), userId: user.id, name, initials: name.split(' ').map(n => n[0]).join('').toUpperCase(),
        location, rating: 0, reviewCount: 0, pricePerHour: 1500,
        verified: false, online: false, bio: '', services: [],
        color: '#E1F5EE', textColor: '#085041',
        availableDates: [], stats: { rating: 0, reviews: 0, jobs: 0, response: 100 },
      });
    }
    await saveDb();
    await logAuditEvent({ actorUserId: user.id, actorRole: role, action: 'auth.register', entityType: 'user', entityId: user.id, payload: { role, email }, requestId: req.requestId });
    return res.status(201).json(await buildAuthResponse(user, req.requestId));
  } catch (e) {
    console.error('Register error:', e);
    res.status(500).json({ error: 'Greška na serveru' });
  }
});

router.post('/login', validateLogin, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (useDirectPg()) {
      const pg = await ensurePg();
      const result = await pg.query(
        'SELECT id, name, email, password_hash, role, location, created_at FROM users WHERE email = $1 LIMIT 1',
        [email]
      );
      const user = result.rows[0];
      if (!user) return res.status(400).json({ error: 'Pogrešan email ili lozinka' });

      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) return res.status(400).json({ error: 'Pogrešan email ili lozinka' });

      await logAuditEvent({ actorUserId: user.id, actorRole: user.role, action: 'auth.login', entityType: 'user', entityId: user.id, payload: { email }, requestId: req.requestId });
      return res.json(await buildAuthResponse(user, req.requestId));
    }

    const user = db.users.find(u => u.email === email);
    if (!user) return res.status(400).json({ error: 'Pogrešan email ili lozinka' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: 'Pogrešan email ili lozinka' });

    await logAuditEvent({ actorUserId: user.id, actorRole: user.role, action: 'auth.login', entityType: 'user', entityId: user.id, payload: { email }, requestId: req.requestId });
    return res.json(await buildAuthResponse(user, req.requestId));
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: 'Greška na serveru' });
  }
});

router.post('/refresh', async (req, res) => {
  try {
    const refreshToken = String(req.body?.refreshToken || '');
    if (!refreshToken) return res.status(400).json({ error: 'Refresh token je obavezan' });
    let decoded;
    try {
      decoded = jwt.verify(refreshToken, config.refreshTokenSecret);
    } catch {
      return res.status(401).json({ error: 'Refresh token nije validan' });
    }
    if (decoded?.type !== 'refresh' || !decoded?.id) return res.status(401).json({ error: 'Refresh token nije validan' });
    const consumed = await consumeRefreshToken(refreshToken);
    if (!consumed?.userId || consumed.userId !== decoded.id) return res.status(401).json({ error: 'Refresh token je istekao ili je opozvan' });

    if (useDirectPg()) {
      const pg = await ensurePg();
      const result = await pg.query('SELECT id, name, email, role, location, created_at FROM users WHERE id = $1 LIMIT 1', [decoded.id]);
      const user = result.rows[0];
      if (!user) return res.status(404).json({ error: 'Korisnik nije pronađen' });
      await logAuditEvent({ actorUserId: user.id, actorRole: user.role, action: 'auth.refresh', entityType: 'session', entityId: user.id, payload: {}, requestId: req.requestId });
      return res.json(await buildAuthResponse(user, req.requestId));
    }

    const user = db.users.find(u => u.id === decoded.id);
    if (!user) return res.status(404).json({ error: 'Korisnik nije pronađen' });
    await logAuditEvent({ actorUserId: user.id, actorRole: user.role, action: 'auth.refresh', entityType: 'session', entityId: user.id, payload: {}, requestId: req.requestId });
    return res.json(await buildAuthResponse(user, req.requestId));
  } catch (e) {
    console.error('Refresh error:', e);
    res.status(500).json({ error: 'Greška na serveru' });
  }
});

router.post('/logout', require('../middleware/auth').authMiddleware, async (req, res) => {
  try {
    await revokeAllRefreshTokensForUser(req.user.id);
    await logAuditEvent({ actorUserId: req.user.id, actorRole: req.user.role, action: 'auth.logout', entityType: 'session', entityId: req.user.id, payload: {}, requestId: req.requestId });
    res.json({ success: true });
  } catch (e) {
    console.error('Logout error:', e);
    res.status(500).json({ error: 'Greška na serveru' });
  }
});

router.get('/me', require('../middleware/auth').authMiddleware, async (req, res) => {
  try {
    if (useDirectPg()) {
      const pg = await ensurePg();
      const result = await pg.query(
        'SELECT id, name, email, role, location, created_at FROM users WHERE id = $1 LIMIT 1',
        [req.user.id]
      );
      const user = result.rows[0];
      if (!user) return res.status(404).json({ error: 'Korisnik nije pronađen' });

      const safeUser = toSafeUser(user);
      if (safeUser.role === 'provider') {
        const provider = await findProviderByUserIdPg(safeUser.id);
        if (provider) safeUser.providerId = provider.id;
      }
      return res.json(safeUser);
    }

    const user = db.users.find(u => u.id === req.user.id);
    if (!user) return res.status(404).json({ error: 'Korisnik nije pronađen' });
    const { password: _, ...safeUser } = user;
    res.json(safeUser);
  } catch (e) {
    console.error('Me error:', e);
    res.status(500).json({ error: 'Greška na serveru' });
  }
});

module.exports = router;
