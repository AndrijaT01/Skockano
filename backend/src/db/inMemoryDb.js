const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { Pool } = require('pg');
const { config } = require('../config');

const dataDir = path.join(__dirname, '../../../data');
const dbFile = path.join(dataDir, 'db.json');
const uploadsDir = path.join(__dirname, '../../../frontend/uploads');

const db = {
  users: [],
  providers: [],
  bookings: [],
  messages: [],
  conversations: [],
  reviews: [],
  payments: [],
  settings: {},
};

const memoryRefreshTokens = new Map();
const memoryAuditLogs = [];

let pool = null;
let postgresConnected = false;
let schemaMode = 'json';

function ensureDirs() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(uploadsDir, { recursive: true });
}

function reviveDates(value) {
  if (Array.isArray(value)) return value.map(reviveDates);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k.toLowerCase().includes('at') && typeof v === 'string' && !Number.isNaN(Date.parse(v))) {
        out[k] = new Date(v);
      } else {
        out[k] = reviveDates(v);
      }
    }
    return out;
  }
  return value;
}

function toIsoOrNull(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function loadJsonDb() {
  ensureDirs();
  if (!fs.existsSync(dbFile)) return false;
  const parsed = reviveDates(JSON.parse(fs.readFileSync(dbFile, 'utf8')));
  for (const key of Object.keys(db)) {
    if (Array.isArray(db[key])) db[key] = Array.isArray(parsed[key]) ? parsed[key] : [];
    else db[key] = parsed[key] && typeof parsed[key] === 'object' ? parsed[key] : {};
  }
  schemaMode = 'json';
  return true;
}

function saveJsonDb() {
  ensureDirs();
  fs.writeFileSync(dbFile, JSON.stringify(db, null, 2), 'utf8');
}

function wantsPostgres() {
  return Boolean(config.databaseUrl) || config.dataMode === 'postgres';
}

async function ensurePg() {
  if (!wantsPostgres()) return null;
  if (pool) return pool;
  pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
  });
  await pool.query('SELECT 1');
  postgresConnected = true;
  return pool;
}

async function tableHasRows(client, tableName) {
  const result = await client.query(`SELECT EXISTS (SELECT 1 FROM ${tableName} LIMIT 1) AS has_rows`);
  return !!result.rows[0]?.has_rows;
}

async function initPgSchema() {
  const pg = await ensurePg();
  if (!pg) return;
  await pg.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('client', 'provider', 'admin')),
      location TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      initials TEXT,
      location TEXT,
      rating NUMERIC(3,1) NOT NULL DEFAULT 0,
      review_count INTEGER NOT NULL DEFAULT 0,
      price_per_hour NUMERIC(10,2) NOT NULL DEFAULT 0,
      verified BOOLEAN NOT NULL DEFAULT FALSE,
      online BOOLEAN NOT NULL DEFAULT FALSE,
      bio TEXT,
      color TEXT,
      text_color TEXT,
      avatar_url TEXT,
      stats JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS provider_services (
      provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
      service_name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (provider_id, service_name)
    );

    CREATE TABLE IF NOT EXISTS provider_gallery (
      provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
      image_url TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (provider_id, image_url)
    );

    CREATE TABLE IF NOT EXISTS provider_available_dates (
      provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
      day_of_month INTEGER NOT NULL,
      PRIMARY KEY (provider_id, day_of_month)
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
      service TEXT NOT NULL,
      service_name TEXT,
      booking_date DATE NOT NULL,
      booking_time TEXT NOT NULL,
      price NUMERIC(10,2) NOT NULL DEFAULT 0,
      commission NUMERIC(10,2) NOT NULL DEFAULT 0,
      provider_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      payment_method TEXT,
      payment_status TEXT NOT NULL DEFAULT 'pending',
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
      last_message TEXT,
      last_time TEXT,
      unread INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender_role TEXT NOT NULL,
      message_text TEXT NOT NULL,
      time_label TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
      client_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      client_name TEXT NOT NULL,
      initials TEXT,
      rating INTEGER NOT NULL,
      review_text TEXT,
      tip NUMERIC(10,2) NOT NULL DEFAULT 0,
      review_date TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      client_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
      amount NUMERIC(10,2) NOT NULL DEFAULT 0,
      method TEXT NOT NULL,
      status TEXT NOT NULL,
      reference TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      id INTEGER PRIMARY KEY,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS app_state (
      collection_name TEXT PRIMARY KEY,
      payload JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      actor_role TEXT,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      request_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_bookings_client_id ON bookings(client_id);
    CREATE INDEX IF NOT EXISTS idx_bookings_provider_id ON bookings(provider_id);
    CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_reviews_provider_id ON reviews(provider_id);
    CREATE INDEX IF NOT EXISTS idx_payments_booking_id ON payments(booking_id);
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_bookings_date_status ON bookings(booking_date, status);
    CREATE INDEX IF NOT EXISTS idx_payments_status_created_at ON payments(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_conversations_client_provider ON conversations(client_id, provider_id);
    CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);
    CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires_at ON refresh_tokens(expires_at);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_user_id ON audit_logs(actor_user_id);

    INSERT INTO schema_meta (key, value, updated_at)
    VALUES ('schema_version', '{"version":"phase6-finalization"}'::jsonb, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
  `);
}

function applyState(state) {
  for (const key of Object.keys(db)) {
    if (Array.isArray(db[key])) db[key] = Array.isArray(state[key]) ? state[key] : [];
    else db[key] = state[key] && typeof state[key] === 'object' ? state[key] : {};
  }
}

async function loadLegacyAppState(client) {
  const result = await client.query('SELECT collection_name, payload FROM app_state');
  const byName = Object.fromEntries(result.rows.map(r => [r.collection_name, reviveDates(r.payload)]));
  if (!Object.keys(byName).length) return false;
  const candidate = {};
  for (const key of Object.keys(db)) {
    candidate[key] = byName[key] !== undefined ? byName[key] : Array.isArray(db[key]) ? [] : {};
  }
  applyState(candidate);
  return true;
}

async function writeNormalizedTablesFromDb(client) {
  await client.query('BEGIN');
  try {
    await client.query('DELETE FROM payments');
    await client.query('DELETE FROM messages');
    await client.query('DELETE FROM conversations');
    await client.query('DELETE FROM reviews');
    await client.query('DELETE FROM bookings');
    await client.query('DELETE FROM provider_gallery');
    await client.query('DELETE FROM provider_available_dates');
    await client.query('DELETE FROM provider_services');
    await client.query('DELETE FROM providers');
    await client.query('DELETE FROM users');
    await client.query('DELETE FROM app_settings');

    for (const user of db.users) {
      await client.query(
        `INSERT INTO users (id, name, email, password_hash, role, location, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, NOW()))`,
        [user.id, user.name, user.email, user.password, user.role, user.location || null, toIsoOrNull(user.createdAt)]
      );
    }

    for (const provider of db.providers) {
      await client.query(
        `INSERT INTO providers
         (id, user_id, name, initials, location, rating, review_count, price_per_hour, verified, online, bio, color, text_color, avatar_url, stats)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)`,
        [
          provider.id,
          provider.userId,
          provider.name,
          provider.initials || null,
          provider.location || null,
          Number(provider.rating || 0),
          Number(provider.reviewCount || 0),
          Number(provider.pricePerHour || 0),
          !!provider.verified,
          !!provider.online,
          provider.bio || '',
          provider.color || null,
          provider.textColor || null,
          provider.avatarUrl || null,
          JSON.stringify(provider.stats || {}),
        ]
      );
      for (const [index, serviceName] of (provider.services || []).entries()) {
        await client.query(
          'INSERT INTO provider_services (provider_id, service_name, sort_order) VALUES ($1,$2,$3)',
          [provider.id, serviceName, index]
        );
      }
      for (const [index, imageUrl] of (provider.gallery || []).entries()) {
        await client.query(
          'INSERT INTO provider_gallery (provider_id, image_url, sort_order) VALUES ($1,$2,$3)',
          [provider.id, imageUrl, index]
        );
      }
      for (const day of provider.availableDates || []) {
        await client.query(
          'INSERT INTO provider_available_dates (provider_id, day_of_month) VALUES ($1,$2)',
          [provider.id, Number(day)]
        );
      }
    }

    for (const booking of db.bookings) {
      await client.query(
        `INSERT INTO bookings
         (id, client_id, provider_id, service, service_name, booking_date, booking_time, price, commission, provider_amount, status, payment_method, payment_status, notes, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,COALESCE($15::timestamptz, NOW()))`,
        [
          booking.id, booking.clientId, booking.providerId, booking.service, booking.serviceName || null,
          booking.date, booking.time, Number(booking.price || 0), Number(booking.commission || 0), Number(booking.providerAmount || 0),
          booking.status || 'pending', booking.paymentMethod || null, booking.paymentStatus || 'pending', booking.notes || null,
          toIsoOrNull(booking.createdAt),
        ]
      );
    }

    for (const conv of db.conversations) {
      await client.query(
        `INSERT INTO conversations (id, client_id, provider_id, last_message, last_time, unread, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz, NOW()))`,
        [conv.id, conv.clientId, conv.providerId, conv.lastMessage || null, conv.lastTime || null, Number(conv.unread || 0), toIsoOrNull(conv.createdAt)]
      );
    }

    for (const msg of db.messages) {
      await client.query(
        `INSERT INTO messages (id, conversation_id, sender_role, message_text, time_label, created_at)
         VALUES ($1,$2,$3,$4,$5,COALESCE($6::timestamptz, NOW()))`,
        [msg.id, msg.conversationId, msg.from || 'system', msg.text, msg.time || null, toIsoOrNull(msg.createdAt)]
      );
    }

    for (const review of db.reviews) {
      await client.query(
        `INSERT INTO reviews (id, provider_id, client_id, client_name, initials, rating, review_text, tip, review_date, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10::timestamptz, NOW()))`,
        [
          review.id, review.providerId, review.clientId || null, review.clientName, review.initials || null,
          Number(review.rating || 0), review.text || '', Number(review.tip || 0), review.date || null, toIsoOrNull(review.createdAt),
        ]
      );
    }

    for (const payment of db.payments) {
      await client.query(
        `INSERT INTO payments (id, booking_id, client_id, provider_id, amount, method, status, reference, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::timestamptz, NOW()))`,
        [payment.id, payment.bookingId, payment.clientId, payment.providerId, Number(payment.amount || 0), payment.method, payment.status, payment.reference || null, toIsoOrNull(payment.createdAt)]
      );
    }

    await client.query(
      `INSERT INTO app_settings (id, payload, updated_at)
       VALUES (1, $1::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`,
      [JSON.stringify(db.settings || {})]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function saveLegacyAppState(client) {
  for (const key of Object.keys(db)) {
    await client.query(
      `INSERT INTO app_state (collection_name, payload, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (collection_name)
       DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`,
      [key, JSON.stringify(db[key])]
    );
  }
}

async function loadNormalizedDb() {
  const pg = await ensurePg();
  if (!pg) return false;
  await initPgSchema();
  const client = await pg.connect();
  try {
    const hasUsers = await tableHasRows(client, 'users');
    if (!hasUsers) {
      const migrated = await loadLegacyAppState(client);
      if (migrated && db.users.length) {
        await writeNormalizedTablesFromDb(client);
        await saveLegacyAppState(client);
        schemaMode = 'postgres-normalized';
        return true;
      }
      return false;
    }

    const [usersRes, providersRes, servicesRes, galleryRes, availableRes, bookingsRes, convRes, msgRes, reviewsRes, paymentsRes, settingsRes] = await Promise.all([
      pg.query('SELECT id, name, email, password_hash, role, location, created_at FROM users ORDER BY created_at ASC'),
      pg.query('SELECT * FROM providers ORDER BY created_at ASC, name ASC'),
      pg.query('SELECT provider_id, service_name, sort_order FROM provider_services ORDER BY provider_id, sort_order, service_name'),
      pg.query('SELECT provider_id, image_url, sort_order FROM provider_gallery ORDER BY provider_id, sort_order, image_url'),
      pg.query('SELECT provider_id, day_of_month FROM provider_available_dates ORDER BY provider_id, day_of_month'),
      pg.query('SELECT * FROM bookings ORDER BY created_at ASC'),
      pg.query('SELECT * FROM conversations ORDER BY created_at ASC'),
      pg.query('SELECT * FROM messages ORDER BY created_at ASC'),
      pg.query('SELECT * FROM reviews ORDER BY created_at ASC'),
      pg.query('SELECT * FROM payments ORDER BY created_at ASC'),
      pg.query('SELECT payload FROM app_settings WHERE id = 1'),
    ]);

    const servicesByProvider = new Map();
    for (const row of servicesRes.rows) {
      const list = servicesByProvider.get(row.provider_id) || [];
      list.push(row.service_name);
      servicesByProvider.set(row.provider_id, list);
    }

    const galleryByProvider = new Map();
    for (const row of galleryRes.rows) {
      const list = galleryByProvider.get(row.provider_id) || [];
      list.push(row.image_url);
      galleryByProvider.set(row.provider_id, list);
    }

    const availableByProvider = new Map();
    for (const row of availableRes.rows) {
      const list = availableByProvider.get(row.provider_id) || [];
      list.push(Number(row.day_of_month));
      availableByProvider.set(row.provider_id, list);
    }

    db.users = usersRes.rows.map(row => ({
      id: row.id,
      name: row.name,
      email: row.email,
      password: row.password_hash,
      role: row.role,
      location: row.location,
      createdAt: row.created_at,
    }));

    db.providers = providersRes.rows.map(row => ({
      id: row.id,
      userId: row.user_id,
      name: row.name,
      initials: row.initials,
      location: row.location,
      rating: Number(row.rating || 0),
      reviewCount: Number(row.review_count || 0),
      pricePerHour: Number(row.price_per_hour || 0),
      verified: !!row.verified,
      online: !!row.online,
      bio: row.bio || '',
      services: servicesByProvider.get(row.id) || [],
      color: row.color || '#E1F5EE',
      textColor: row.text_color || '#085041',
      avatarUrl: row.avatar_url || '',
      gallery: galleryByProvider.get(row.id) || [],
      availableDates: availableByProvider.get(row.id) || [],
      stats: reviveDates(row.stats || {}),
      createdAt: row.created_at,
    }));

    db.bookings = bookingsRes.rows.map(row => ({
      id: row.id,
      clientId: row.client_id,
      providerId: row.provider_id,
      service: row.service,
      serviceName: row.service_name,
      date: row.booking_date instanceof Date ? row.booking_date.toISOString().slice(0, 10) : row.booking_date,
      time: row.booking_time,
      price: Number(row.price || 0),
      commission: Number(row.commission || 0),
      providerAmount: Number(row.provider_amount || 0),
      status: row.status,
      paymentMethod: row.payment_method,
      paymentStatus: row.payment_status,
      notes: row.notes,
      createdAt: row.created_at,
    }));

    db.conversations = convRes.rows.map(row => ({
      id: row.id,
      clientId: row.client_id,
      providerId: row.provider_id,
      lastMessage: row.last_message,
      lastTime: row.last_time,
      unread: Number(row.unread || 0),
      createdAt: row.created_at,
    }));

    db.messages = msgRes.rows.map(row => ({
      id: row.id,
      conversationId: row.conversation_id,
      from: row.sender_role,
      text: row.message_text,
      time: row.time_label,
      createdAt: row.created_at,
    }));

    db.reviews = reviewsRes.rows.map(row => ({
      id: row.id,
      providerId: row.provider_id,
      clientId: row.client_id,
      clientName: row.client_name,
      initials: row.initials,
      rating: Number(row.rating || 0),
      text: row.review_text || '',
      tip: Number(row.tip || 0),
      date: row.review_date,
      createdAt: row.created_at,
    }));

    db.payments = paymentsRes.rows.map(row => ({
      id: row.id,
      bookingId: row.booking_id,
      clientId: row.client_id,
      providerId: row.provider_id,
      amount: Number(row.amount || 0),
      method: row.method,
      status: row.status,
      reference: row.reference,
      createdAt: row.created_at,
    }));

    db.settings = reviveDates(settingsRes.rows[0]?.payload || {});
    schemaMode = 'postgres-normalized';
    return db.users.length > 0;
  } finally {
    client.release();
  }
}

function cloneSeedData(pass, adminPass) {
  return {
    users: [
      { id: 'u1', name: 'Milan Nikolić', email: 'milan@test.com', password: pass, role: 'client', location: 'Zemun', createdAt: new Date() },
      { id: 'u2', name: 'Marija Jovanović', email: 'marija@test.com', password: pass, role: 'provider', location: 'Novi Beograd', createdAt: new Date() },
      { id: 'u3', name: 'Dragan Simić', email: 'dragan@test.com', password: pass, role: 'provider', location: 'Zemun', createdAt: new Date() },
      { id: 'u4', name: 'Ana Petrović', email: 'ana@test.com', password: pass, role: 'provider', location: 'Vračar', createdAt: new Date() },
      { id: 'u5', name: 'Nikoleta Kovač', email: 'nikoleta@test.com', password: pass, role: 'provider', location: 'Palilula', createdAt: new Date() },
      { id: 'u6', name: 'Admin Čisto', email: 'admin@test.com', password: adminPass, role: 'admin', location: 'Beograd', createdAt: new Date() },
    ],
    providers: [
      {
        id: 'p1', userId: 'u2', name: 'Marija Jovanović', initials: 'MJ', location: 'Novi Beograd', rating: 4.9, reviewCount: 84, pricePerHour: 1800,
        verified: true, online: true, bio: 'Iskusna domaćica sa 8+ godina iskustva. Specijalizovana za redovno i generalno čišćenje stanova i kuća. Tačna, uredna i pouzdana.',
        services: ['Čišćenje stana', 'Peglanje', 'Organizacija', 'Prozori'], color: '#E1F5EE', textColor: '#085041', avatarUrl: '', gallery: [],
        availableDates: [2,3,5,8,9,11,12,16,17,18,22,23,25,26,29,30], stats: { rating: 4.9, reviews: 84, jobs: 312, response: 98 },
      },
      {
        id: 'p2', userId: 'u3', name: 'Dragan Simić', initials: 'DS', location: 'Zemun', rating: 5.0, reviewCount: 51, pricePerHour: 2500,
        verified: true, online: false, bio: 'Profesionalna ekipa za dubinsko čišćenje poslovnih prostora i stanova posle renovacije. Radimo i vikendom.',
        services: ['Poslovni prostori', 'Posle gradnje', 'Dubinsko čišćenje'], color: '#FAEEDA', textColor: '#854F0B', avatarUrl: '', gallery: [],
        availableDates: [1,4,7,8,11,14,15,18,21,22,25,28,29], stats: { rating: 5.0, reviews: 51, jobs: 198, response: 95 },
      },
      {
        id: 'p3', userId: 'u4', name: 'Ana Petrović', initials: 'AP', location: 'Vračar', rating: 4.7, reviewCount: 32, pricePerHour: 1500,
        verified: false, online: false, bio: 'Specijalizovana za pranje prozora i čišćenje tepiha. Vlastita profesionalna oprema za dubinsko usisavanje.',
        services: ['Prozori', 'Tepisi', 'Čišćenje stana'], color: '#FAECE7', textColor: '#4A1B0C', avatarUrl: '', gallery: [],
        availableDates: [3,5,6,9,10,13,17,18,20,24,27,28], stats: { rating: 4.7, reviews: 32, jobs: 89, response: 91 },
      },
      {
        id: 'p4', userId: 'u5', name: 'Nikoleta Kovač', initials: 'NK', location: 'Palilula', rating: 4.8, reviewCount: 40, pricePerHour: 1600,
        verified: true, online: true, bio: 'Brza, pouzdana, preporučena od strane 40+ zadovoljnih klijenata. Fleksibilni termini uključujući vikende.',
        services: ['Čišćenje stana', 'Dubinsko čišćenje', 'Peglanje'], color: '#EEEDFE', textColor: '#3C3489', avatarUrl: '', gallery: [],
        availableDates: [1,2,4,5,8,9,12,15,16,19,22,23,26,29,30], stats: { rating: 4.8, reviews: 40, jobs: 145, response: 97 },
      },
    ],
    reviews: [
      { id: 'r1', providerId: 'p1', clientName: 'Jovana M.', initials: 'JM', rating: 5, date: '18. mart 2025.', text: 'Marija je odradila generalno čišćenje za 4 sata. Stan je blistao! Tačna, ljubazna i veoma temeljita.' },
      { id: 'r2', providerId: 'p1', clientName: 'Branko T.', initials: 'BT', rating: 5, date: '5. mart 2025.', text: 'Odlična i profesionalna. Sve po dogovoru, bez ikakvih iznenadjenja. Preporučujem svima!' },
      { id: 'r3', providerId: 'p2', clientName: 'Stefan M.', initials: 'SM', rating: 5, date: '20. mart 2025.', text: 'Dragan i ekipa su očistili lokal posle renovacije. Profesionalno, brzo i po dogovorenoj ceni.' },
      { id: 'r4', providerId: 'p3', clientName: 'Milena R.', initials: 'MR', rating: 5, date: '12. mart 2025.', text: 'Ana je operala sve prozore u stanu, sjaje se kao ogledalo. Brza i efikasna!' },
      { id: 'r5', providerId: 'p4', clientName: 'Dragana P.', initials: 'DP', rating: 5, date: '25. mart 2025.', text: 'Nikoleta je super! Uvek tačna i temeljita. Koristim je svake dve nedelje.' },
    ],
    conversations: [
      { id: 'c1', clientId: 'u1', providerId: 'p1', lastMessage: 'Vidimo se sutra u 10! 🙂', lastTime: '9:38', unread: 2 },
      { id: 'c2', clientId: 'u1', providerId: 'p2', lastMessage: 'Hvala na recenziji, drago mi je!', lastTime: 'Juče', unread: 0 },
      { id: 'c3', clientId: 'u1', providerId: 'p3', lastMessage: 'Da, mogu u sredu posle 14h', lastTime: 'Pon', unread: 0 },
    ],
    messages: [
      { id: 'm1', conversationId: 'c1', from: 'provider', text: 'Zdravo! Videla sam da ste zakazali redovno čišćenje za sutra. 🙂', time: '16:20', createdAt: new Date() },
      { id: 'm2', conversationId: 'c1', from: 'client', text: 'Da, tačno! Imam dvosoban stan, oko 55m².', time: '16:22', createdAt: new Date() },
      { id: 'm3', conversationId: 'c1', from: 'provider', text: 'Odlično! Hoćete li i frižider iznutra?', time: '16:23', createdAt: new Date() },
      { id: 'm4', conversationId: 'c1', from: 'client', text: 'Da, molim vas! I mikrotalasna ako ima vremena.', time: '16:25', createdAt: new Date() },
      { id: 'm5', conversationId: 'c1', from: 'provider', text: 'Vidimo se sutra u 10! 🙂', time: '9:38', createdAt: new Date() },
      { id: 'm6', conversationId: 'c2', from: 'client', text: 'Dragan, posao je bio odlično urađen. Ostavljam 5 zvezdica!', time: '18:10', createdAt: new Date() },
      { id: 'm7', conversationId: 'c2', from: 'provider', text: 'Hvala na recenziji, drago mi je! Uvek smo na usluzi. 🤝', time: '19:45', createdAt: new Date() },
      { id: 'm8', conversationId: 'c3', from: 'client', text: 'Ana, da li ste slobodni u sredu?', time: '10:00', createdAt: new Date() },
      { id: 'm9', conversationId: 'c3', from: 'provider', text: 'Da, mogu u sredu posle 14h', time: '10:15', createdAt: new Date() },
    ],
    bookings: [
      { id: 'b1', clientId: 'u1', providerId: 'p1', service: 'regular', serviceName: 'Redovno čišćenje', date: '2026-04-27', time: '10:00', price: 3600, commission: 360, providerAmount: 3240, status: 'confirmed', paymentMethod: 'cash', paymentStatus: 'pending', createdAt: new Date() },
    ],
    payments: [],
    settings: {
      platformName: 'Čisto', supportEmail: 'podrska@cisto.test', bookingFeePercent: 10, defaultCurrency: 'RSD', maintenanceMode: false,
      allowNewProviders: true, featuredProviderIds: ['p1', 'p4'], lastBackupAt: null, deployTarget: 'local',
    },
  };
}

async function seedData(force = false) {
  ensureDirs();
  if (!force) {
    if (wantsPostgres()) {
      try {
        if (await loadNormalizedDb() && db.users.length) {
          console.log('✅ Učitana postojeća baza iz PostgreSQL-a');
          saveJsonDb();
          return;
        }
      } catch (err) {
        console.error('❌ Greška pri učitavanju PostgreSQL baze:', err.message);
        throw err;
      }
    } else if (loadJsonDb() && db.users.length) {
      console.log('✅ Učitana postojeća baza iz data/db.json');
      return;
    }
  }

  const pass = await bcrypt.hash('lozinka123', 10);
  const adminPass = await bcrypt.hash('admin123', 10);
  const seeded = cloneSeedData(pass, adminPass);
  Object.assign(db, seeded);
  await saveDb();
  console.log(wantsPostgres() ? '✅ PostgreSQL baza popunjena test podacima' : '✅ Baza podataka popunjena test podacima');
}

async function savePgDb() {
  const pg = await ensurePg();
  if (!pg) return;
  await initPgSchema();
  const client = await pg.connect();
  try {
    await writeNormalizedTablesFromDb(client);
    await saveLegacyAppState(client);
    schemaMode = 'postgres-normalized';
  } finally {
    client.release();
  }
}

async function saveDb() {
  if (wantsPostgres()) {
    await savePgDb();
    saveJsonDb();
    return;
  }
  saveJsonDb();
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

async function storeRefreshToken({ userId, token, expiresAt }) {
  const hashed = hashToken(token);
  const expiresIso = expiresAt instanceof Date ? expiresAt.toISOString() : new Date(expiresAt).toISOString();
  if (wantsPostgres()) {
    const pg = await ensurePg();
    if (pg) {
      await initPgSchema();
      await pg.query(
        `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at)
         VALUES ($1,$2,$3,$4::timestamptz,NOW())`,
        [uuidv4(), userId, hashed, expiresIso]
      );
      return;
    }
  }
  memoryRefreshTokens.set(hashed, { userId, expiresAt: expiresIso, revokedAt: null });
}

async function consumeRefreshToken(token) {
  const hashed = hashToken(token);
  const now = new Date();
  if (wantsPostgres()) {
    const pg = await ensurePg();
    if (pg) {
      await initPgSchema();
      const rowRes = await pg.query(
        `SELECT * FROM refresh_tokens
         WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > NOW()
         ORDER BY created_at DESC LIMIT 1`,
        [hashed]
      );
      const row = rowRes.rows[0];
      if (!row) return null;
      await pg.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = $1', [row.id]);
      return { userId: row.user_id };
    }
  }
  const row = memoryRefreshTokens.get(hashed);
  if (!row || row.revokedAt || new Date(row.expiresAt) <= now) return null;
  row.revokedAt = now.toISOString();
  memoryRefreshTokens.set(hashed, row);
  return { userId: row.userId };
}

async function revokeAllRefreshTokensForUser(userId) {
  if (wantsPostgres()) {
    const pg = await ensurePg();
    if (pg) {
      await initPgSchema();
      await pg.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
      return;
    }
  }
  for (const [key, value] of memoryRefreshTokens.entries()) {
    if (value.userId === userId && !value.revokedAt) {
      value.revokedAt = new Date().toISOString();
      memoryRefreshTokens.set(key, value);
    }
  }
}

async function logAuditEvent({ actorUserId = null, actorRole = null, action, entityType, entityId = null, payload = {}, requestId = null }) {
  if (!action || !entityType) return null;
  const entry = {
    id: uuidv4(),
    actorUserId,
    actorRole,
    action,
    entityType,
    entityId,
    payload,
    requestId,
    createdAt: new Date().toISOString(),
  };
  if (wantsPostgres()) {
    const pg = await ensurePg();
    if (pg) {
      await initPgSchema();
      await pg.query(
        `INSERT INTO audit_logs (id, actor_user_id, actor_role, action, entity_type, entity_id, payload, request_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::timestamptz)`,
        [entry.id, actorUserId, actorRole, action, entityType, entityId, JSON.stringify(payload || {}), requestId, entry.createdAt]
      );
      return entry;
    }
  }
  memoryAuditLogs.unshift(entry);
  if (memoryAuditLogs.length > 500) memoryAuditLogs.length = 500;
  return entry;
}

async function getAuditLogs({ limit = 100, offset = 0 } = {}) {
  if (wantsPostgres()) {
    const pg = await ensurePg();
    if (pg) {
      await initPgSchema();
      const result = await pg.query(
        `SELECT id, actor_user_id, actor_role, action, entity_type, entity_id, payload, request_id, created_at
         FROM audit_logs
         ORDER BY created_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
      return result.rows.map(r => ({
        id: r.id,
        actorUserId: r.actor_user_id,
        actorRole: r.actor_role,
        action: r.action,
        entityType: r.entity_type,
        entityId: r.entity_id,
        payload: r.payload || {},
        requestId: r.request_id,
        createdAt: r.created_at,
      }));
    }
  }
  return memoryAuditLogs.slice(offset, offset + limit);
}

async function getSchemaVersion() {
  if (!wantsPostgres()) return 'json';
  const pg = await ensurePg();
  if (!pg) return 'json';
  await initPgSchema();
  const result = await pg.query("SELECT value FROM schema_meta WHERE key = 'schema_version' LIMIT 1");
  return result.rows[0]?.value?.version || 'postgres-normalized';
}

function getDbMeta() {
  return {
    driver: wantsPostgres() ? 'postgres' : 'json',
    postgresConnected,
    localMirrorFile: dbFile,
    schemaMode,
  };
}

module.exports = { db, seedData, uuidv4, saveDb, uploadsDir, getDbMeta, ensurePg, storeRefreshToken, consumeRefreshToken, revokeAllRefreshTokensForUser, logAuditEvent, getAuditLogs, getSchemaVersion };
