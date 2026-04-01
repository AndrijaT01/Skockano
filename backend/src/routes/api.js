const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const { db, uuidv4, saveDb, uploadsDir, ensurePg, getDbMeta, logAuditEvent, getAuditLogs, getSchemaVersion } = require('../db/inMemoryDb');
const { authMiddleware } = require('../middleware/auth');
const { config } = require('../config');
const { createMemoryRateLimiter } = require('../middleware/security');
const { validateProviderUpdate, validateBookingCreate, validateBookingStatus, validatePaymentCheckout, validateMessageCreate, validateReviewCreate, validateAdminSettings, validateImageUpload } = require('../middleware/validation');

const writeLimiter = createMemoryRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 120,
  keyGenerator: (req) => req.user?.id || req.ip,
});
const adminLimiter = createMemoryRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 200,
  keyGenerator: (req) => req.user?.id || req.ip,
});

function getProviderByUserId(userId) {
  return db.providers.find(p => p.userId === userId) || null;
}
function useDirectPg() {
  const meta = getDbMeta();
  return meta.driver === 'postgres' && meta.schemaMode === 'postgres-normalized';
}
async function queryOne(sql, params = []) {
  const pg = await ensurePg();
  const result = await pg.query(sql, params);
  return result.rows[0] || null;
}
async function queryMany(sql, params = []) {
  const pg = await ensurePg();
  const result = await pg.query(sql, params);
  return result.rows;
}

function toInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}
function getPagination(req, defaults = {}) {
  const page = Math.max(1, toInt(req.query.page, defaults.page || 1));
  const limit = Math.min(defaults.maxLimit || 50, Math.max(1, toInt(req.query.limit, defaults.limit || 20)));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}
function shouldReturnMeta(req) {
  return ['1', 'true', 'yes'].includes(String(req.query.includeMeta || req.query.paginated || '').toLowerCase()) || req.query.page !== undefined || req.query.limit !== undefined || req.query.sort !== undefined;
}
function wrapListResponse(req, items, pagination, extra = {}) {
  if (!shouldReturnMeta(req)) return items;
  return { items, pagination, ...extra };
}
async function queryCount(sql, params = []) {
  const row = await queryOne(sql, params);
  const raw = row?.total_count ?? row?.count ?? Object.values(row || {})[0] ?? 0;
  return Number(raw || 0);
}
async function uploadImageFromBase64(imageData, filename, providerId, kind = 'gallery') {
  const match = imageData.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/);
  if (!match) throw new Error('Nepodržan format slike');
  const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
  const clean = (filename || 'image').replace(/[^a-zA-Z0-9-_]/g, '').slice(0, 24) || 'image';
  const file = `${providerId}-${kind}-${Date.now()}-${clean}.${ext}`;
  if (config.storageMode === 'cloudinary' && config.cloudinaryCloudName && config.cloudinaryUploadPreset) {
    const form = new FormData();
    form.append('file', imageData);
    form.append('upload_preset', config.cloudinaryUploadPreset);
    form.append('folder', config.cloudinaryFolder);
    form.append('public_id', file.replace(/\.[^.]+$/, ''));
    const response = await fetch(`https://api.cloudinary.com/v1_1/${config.cloudinaryCloudName}/image/upload`, { method: 'POST', body: form });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error?.message || 'Cloud upload nije uspeo');
    return { publicPath: data.secure_url, fileName: file, storage: 'cloudinary' };
  }
  const abs = path.join(uploadsDir, file);
  fs.writeFileSync(abs, Buffer.from(match[2], 'base64'));
  return { publicPath: `/uploads/${file}`, fileName: file, storage: 'local' };
}
async function createStripePaymentIntent({ amount, bookingId, customerEmail, metadata = {} }) {
  const body = new URLSearchParams();
  body.set('amount', String(Math.round(Number(amount) * 100)));
  body.set('currency', 'rsd');
  body.set('automatic_payment_methods[enabled]', 'true');
  if (customerEmail) body.set('receipt_email', customerEmail);
  body.set('metadata[bookingId]', bookingId);
  for (const [key, value] of Object.entries(metadata || {})) {
    if (value !== undefined && value !== null) body.set(`metadata[${key}]`, String(value));
  }
  const response = await fetch('https://api.stripe.com/v1/payment_intents', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.stripeSecretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || 'Stripe payment intent nije uspeo');
  return data;
}
function mapProviderRow(row) {
  if (!row) return null;
  return {
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
    services: row.services || [],
    color: row.color || '#E1F5EE',
    textColor: row.text_color || '#085041',
    avatarUrl: row.avatar_url || '',
    gallery: row.gallery || [],
    availableDates: (row.available_dates || []).map(Number),
    stats: row.stats || {},
  };
}
async function getProviderByUserIdPg(userId) {
  const row = await queryOne(
    `SELECT p.*,
            COALESCE(ARRAY_AGG(DISTINCT ps.service_name ORDER BY ps.service_name) FILTER (WHERE ps.service_name IS NOT NULL), ARRAY[]::text[]) AS services,
            COALESCE(ARRAY_AGG(DISTINCT pg.image_url ORDER BY pg.image_url) FILTER (WHERE pg.image_url IS NOT NULL), ARRAY[]::text[]) AS gallery,
            COALESCE(ARRAY_AGG(DISTINCT pad.day_of_month ORDER BY pad.day_of_month) FILTER (WHERE pad.day_of_month IS NOT NULL), ARRAY[]::int[]) AS available_dates
     FROM providers p
     LEFT JOIN provider_services ps ON ps.provider_id = p.id
     LEFT JOIN provider_gallery pg ON pg.provider_id = p.id
     LEFT JOIN provider_available_dates pad ON pad.provider_id = p.id
     WHERE p.user_id = $1
     GROUP BY p.id`,
    [userId]
  );
  return mapProviderRow(row);
}
async function getProviderByIdPg(providerId) {
  const row = await queryOne(
    `SELECT p.*,
            COALESCE(ARRAY_AGG(DISTINCT ps.service_name ORDER BY ps.service_name) FILTER (WHERE ps.service_name IS NOT NULL), ARRAY[]::text[]) AS services,
            COALESCE(ARRAY_AGG(DISTINCT pg.image_url ORDER BY pg.image_url) FILTER (WHERE pg.image_url IS NOT NULL), ARRAY[]::text[]) AS gallery,
            COALESCE(ARRAY_AGG(DISTINCT pad.day_of_month ORDER BY pad.day_of_month) FILTER (WHERE pad.day_of_month IS NOT NULL), ARRAY[]::int[]) AS available_dates
     FROM providers p
     LEFT JOIN provider_services ps ON ps.provider_id = p.id
     LEFT JOIN provider_gallery pg ON pg.provider_id = p.id
     LEFT JOIN provider_available_dates pad ON pad.provider_id = p.id
     WHERE p.id = $1
     GROUP BY p.id`,
    [providerId]
  );
  return mapProviderRow(row);
}
async function getReviewsForProviderPg(providerId) {
  const rows = await queryMany(
    `SELECT id, provider_id, client_id, client_name, initials, rating, review_text, tip, review_date, created_at
     FROM reviews WHERE provider_id = $1 ORDER BY created_at DESC`,
    [providerId]
  );
  return rows.map(r => ({
    id: r.id,
    providerId: r.provider_id,
    clientId: r.client_id,
    clientName: r.client_name,
    initials: r.initials,
    rating: Number(r.rating || 0),
    text: r.review_text || '',
    tip: Number(r.tip || 0),
    date: r.review_date,
    createdAt: r.created_at,
  }));
}
async function enrichProviderPg(provider) {
  if (!provider) return null;
  const reviews = await getReviewsForProviderPg(provider.id);
  return { ...provider, reviews };
}
async function hydrateBookingPg(row) {
  if (!row) return null;
  const provider = await getProviderByIdPg(row.provider_id);
  const client = await queryOne('SELECT id, name, email, role, location, created_at FROM users WHERE id = $1', [row.client_id]);
  const payment = await queryOne('SELECT * FROM payments WHERE booking_id = $1 ORDER BY created_at DESC LIMIT 1', [row.id]);
  return {
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
    provider,
    client: client ? { id: client.id, name: client.name, email: client.email, role: client.role, location: client.location, createdAt: client.created_at } : null,
    payment: payment ? {
      id: payment.id, bookingId: payment.booking_id, clientId: payment.client_id, providerId: payment.provider_id,
      amount: Number(payment.amount || 0), method: payment.method, status: payment.status, reference: payment.reference, createdAt: payment.created_at,
    } : null,
  };
}

function mapConversationRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    clientId: row.client_id,
    providerId: row.provider_id,
    lastMessage: row.last_message || '',
    lastTime: row.last_time || '',
    unread: Number(row.unread || 0),
    createdAt: row.created_at,
  };
}
function mapMessageRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    from: row.sender_role,
    text: row.message_text,
    time: row.time_label,
    createdAt: row.created_at,
  };
}
function mapPaymentRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    bookingId: row.booking_id,
    clientId: row.client_id,
    providerId: row.provider_id,
    amount: Number(row.amount || 0),
    method: row.method,
    status: row.status,
    reference: row.reference,
    createdAt: row.created_at,
  };
}
async function hydrateConversationPg(row) {
  const conv = mapConversationRow(row);
  if (!conv) return null;
  conv.provider = await getProviderByIdPg(conv.providerId);
  const client = await queryOne('SELECT id, name, email, role, location, created_at FROM users WHERE id = $1', [conv.clientId]);
  conv.client = client ? { id: client.id, name: client.name, email: client.email, role: client.role, location: client.location, createdAt: client.created_at } : null;
  return conv;
}
async function getSettingsPg() {
  const row = await queryOne('SELECT payload FROM app_settings WHERE id = 1');
  return row?.payload || {};
}
async function saveSettingsPg(nextSettings) {
  const pg = await ensurePg();
  const result = await pg.query(
    `INSERT INTO app_settings (id, payload, updated_at)
     VALUES (1, $1::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()
     RETURNING payload`,
    [JSON.stringify(nextSettings || {})]
  );
  return result.rows[0]?.payload || nextSettings || {};
}
function getSafeUser(user) {
  if (!user) return null;
  const { password, ...safe } = user;
  return safe;
}
function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Samo admin ima pristup' });
  next();
}
function enrichProvider(provider) {
  const reviews = db.reviews.filter(r => r.providerId === provider.id);
  return { ...provider, reviews };
}
function hydrateBooking(booking) {
  const provider = db.providers.find(p => p.id === booking.providerId) || null;
  const client = db.users.find(u => u.id === booking.clientId) || null;
  const payment = db.payments.find(p => p.bookingId === booking.id) || null;
  return { ...booking, provider, client: getSafeUser(client), payment };
}

function persistAndSend(res, payload, code=200) {
  saveDb();
  return res.status(code).json(payload);
}
function getAppMeta() {
  return {
    appName: db.settings?.platformName || config.appName,
    supportEmail: db.settings?.supportEmail || 'podrska@cisto.test',
    bookingFeePercent: Number(db.settings?.bookingFeePercent || 10),
    defaultCurrency: db.settings?.defaultCurrency || 'RSD',
    maintenanceMode: !!db.settings?.maintenanceMode,
    allowNewProviders: db.settings?.allowNewProviders !== false,
    featuredProviderIds: db.settings?.featuredProviderIds || [],
    deployTarget: db.settings?.deployTarget || 'local',
    paymentMode: config.paymentMode,
    dataMode: config.dataMode,
    stripePublicKey: config.stripePublicKey || '',
    storageMode: config.storageMode,
    schemaVersion: null,
    cloudinaryConfigured: !!(config.cloudinaryCloudName && config.cloudinaryUploadPreset),
    stripeConfigured: !!config.stripeSecretKey,
  };
}

router.get('/meta/config', (req, res) => {
  res.json(getAppMeta());
});
router.get('/payments/config', (req, res) => {
  res.json({
    mode: config.paymentMode,
    stripePublishableKey: config.stripePublicKey || '',
    stripeConfigured: !!config.stripeSecretKey,
    storageMode: config.storageMode,
  });
});


router.get('/providers', async (req, res) => {
  const { search, minRating, maxPrice, verified, online, service, sort } = req.query;
  const pagination = getPagination(req, { page: 1, limit: 12, maxLimit: 50 });

  if (useDirectPg()) {
    const params = [];
    const where = ['1=1'];
    if (search) {
      params.push(`%${String(search).toLowerCase()}%`);
      where.push(`(LOWER(p.name) LIKE $${params.length} OR LOWER(COALESCE(p.location, '')) LIKE $${params.length} OR EXISTS (
        SELECT 1 FROM provider_services pss WHERE pss.provider_id = p.id AND LOWER(pss.service_name) LIKE $${params.length}
      ))`);
    }
    if (minRating) {
      params.push(Number(minRating));
      where.push(`p.rating >= $${params.length}`);
    }
    if (maxPrice) {
      params.push(Number(maxPrice));
      where.push(`p.price_per_hour <= $${params.length}`);
    }
    if (verified === 'true') where.push(`p.verified = true`);
    if (online === 'true') where.push(`p.online = true`);
    if (service) {
      params.push(String(service).toLowerCase());
      where.push(`EXISTS (SELECT 1 FROM provider_services pss WHERE pss.provider_id = p.id AND LOWER(pss.service_name) = $${params.length})`);
    }
    const sortMap = {
      rating_desc: 'p.rating DESC, p.review_count DESC, p.name ASC',
      price_asc: 'p.price_per_hour ASC, p.rating DESC, p.name ASC',
      price_desc: 'p.price_per_hour DESC, p.rating DESC, p.name ASC',
      reviews_desc: 'p.review_count DESC, p.rating DESC, p.name ASC',
      newest: 'p.created_at DESC, p.name ASC',
      name_asc: 'p.name ASC',
    };
    const orderBy = sortMap[String(sort || '')] || 'p.verified DESC, p.online DESC, p.rating DESC, p.name ASC';
    const total = await queryCount(`SELECT COUNT(*)::int AS total_count FROM providers p WHERE ${where.join(' AND ')}`, params);
    params.push(pagination.limit);
    params.push(pagination.offset);
    const sql = `
  SELECT p.*,
         COALESCE((
           SELECT ARRAY_AGG(s.service_name ORDER BY s.sort_order, s.service_name)
           FROM (
             SELECT DISTINCT ON (ps.service_name) ps.service_name, ps.sort_order
             FROM provider_services ps
             WHERE ps.provider_id = p.id
               AND ps.service_name IS NOT NULL
             ORDER BY ps.service_name, ps.sort_order
           ) s
         ), ARRAY[]::text[]) AS services,
         COALESCE((
           SELECT ARRAY_AGG(g.image_url ORDER BY g.sort_order, g.image_url)
           FROM (
             SELECT DISTINCT ON (pg.image_url) pg.image_url, pg.sort_order
             FROM provider_gallery pg
             WHERE pg.provider_id = p.id
               AND pg.image_url IS NOT NULL
             ORDER BY pg.image_url, pg.sort_order
           ) g
         ), ARRAY[]::text[]) AS gallery,
         COALESCE((
           SELECT ARRAY_AGG(d.day_of_month ORDER BY d.day_of_month)
           FROM (
             SELECT DISTINCT pad.day_of_month
             FROM provider_available_dates pad
             WHERE pad.provider_id = p.id
               AND pad.day_of_month IS NOT NULL
           ) d
         ), ARRAY[]::int[]) AS available_dates
  FROM providers p
  WHERE ${where.join(' AND ')}
  ORDER BY ${orderBy}
  LIMIT $${params.length - 1} OFFSET $${params.length}`;
    // const sql = `
    //   SELECT p.*,
    //          COALESCE(ARRAY_AGG(DISTINCT ps.service_name ORDER BY ps.sort_order, ps.service_name) FILTER (WHERE ps.service_name IS NOT NULL), ARRAY[]::text[]) AS services,
    //          COALESCE(ARRAY_AGG(DISTINCT pg.image_url ORDER BY pg.sort_order, pg.image_url) FILTER (WHERE pg.image_url IS NOT NULL), ARRAY[]::text[]) AS gallery,
    //          COALESCE(ARRAY_AGG(DISTINCT pad.day_of_month ORDER BY pad.day_of_month) FILTER (WHERE pad.day_of_month IS NOT NULL), ARRAY[]::int[]) AS available_dates
    //   FROM providers p
    //   LEFT JOIN provider_services ps ON ps.provider_id = p.id
    //   LEFT JOIN provider_gallery pg ON pg.provider_id = p.id
    //   LEFT JOIN provider_available_dates pad ON pad.provider_id = p.id
    //   WHERE ${where.join(' AND ')}
    //   GROUP BY p.id
    //   ORDER BY ${orderBy}
    //   LIMIT $${params.length - 1} OFFSET $${params.length}`;
    const rows = await queryMany(sql, params);
    const items = await Promise.all(rows.map(r => enrichProviderPg(mapProviderRow(r))));
    return res.json(wrapListResponse(req, items, {
      ...pagination,
      total,
      totalPages: Math.max(1, Math.ceil(total / pagination.limit)),
      sort: String(sort || 'default'),
    }));
  }

  let list = db.providers.map(enrichProvider);
  if (search) {
    const q = search.toLowerCase();
    list = list.filter(p => p.name.toLowerCase().includes(q) || p.services.some(s => s.toLowerCase().includes(q)) || p.location.toLowerCase().includes(q));
  }
  if (minRating) list = list.filter(p => p.rating >= parseFloat(minRating));
  if (maxPrice) list = list.filter(p => p.pricePerHour <= parseInt(maxPrice, 10));
  if (verified === 'true') list = list.filter(p => p.verified);
  if (online === 'true') list = list.filter(p => p.online);
  if (service) list = list.filter(p => (p.services || []).map(s => s.toLowerCase()).includes(String(service).toLowerCase()));
  const sorter = String(sort || '');
  if (sorter === 'price_asc') list.sort((a,b)=>a.pricePerHour-b.pricePerHour || b.rating-a.rating);
  else if (sorter === 'price_desc') list.sort((a,b)=>b.pricePerHour-a.pricePerHour || b.rating-a.rating);
  else if (sorter === 'reviews_desc') list.sort((a,b)=>b.reviewCount-a.reviewCount || b.rating-a.rating);
  else if (sorter === 'name_asc') list.sort((a,b)=>String(a.name).localeCompare(String(b.name)));
  else list.sort((a,b)=>Number(b.verified)-Number(a.verified) || Number(b.online)-Number(a.online) || b.rating-a.rating || String(a.name).localeCompare(String(b.name)));
  const total = list.length;
  const items = list.slice(pagination.offset, pagination.offset + pagination.limit);
  res.json(wrapListResponse(req, items, {
    ...pagination,
    total,
    totalPages: Math.max(1, Math.ceil(total / pagination.limit)),
    sort: sorter || 'default',
  }));
});
router.get('/providers/:id', async (req, res) => {
  if (!String(req.params.id || '').trim()) return res.status(400).json({ error: 'Provider ID je obavezan.' });
  if (useDirectPg()) {
    const provider = await getProviderByIdPg(req.params.id);
    if (!provider) return res.status(404).json({ error: 'Pružalac nije pronađen' });
    return res.json(await enrichProviderPg(provider));
  }
  const provider = db.providers.find(p => p.id === req.params.id);
  if (!provider) return res.status(404).json({ error: 'Pružalac nije pronađen' });
  res.json(enrichProvider(provider));
});
router.get('/analytics/overview', async (req, res) => {
  if (useDirectPg()) {
    const [usersAgg, providersAgg, bookingsAgg, revenueAgg, settings] = await Promise.all([
      queryOne(`SELECT COUNT(*)::int AS total_users FROM users`),
      queryOne(`SELECT
                  COUNT(*)::int AS total_providers,
                  COUNT(*) FILTER (WHERE online = true)::int AS online_providers,
                  COUNT(*) FILTER (WHERE verified = true)::int AS verified_providers,
                  COUNT(*) FILTER (WHERE verified = false)::int AS pending_verification
                FROM providers`),
      queryOne(`SELECT
                  COUNT(*)::int AS total_bookings,
                  COUNT(*) FILTER (WHERE status = 'confirmed')::int AS confirmed_bookings,
                  COUNT(*) FILTER (WHERE status = 'reviewed')::int AS reviewed_bookings
                FROM bookings`),
      queryOne(`SELECT COALESCE(SUM(amount), 0)::numeric AS revenue FROM payments WHERE status = 'paid'`),
      getSettingsPg(),
    ]);
    return res.json({
      totalUsers: Number(usersAgg?.total_users || 0),
      totalProviders: Number(providersAgg?.total_providers || 0),
      totalBookings: Number(bookingsAgg?.total_bookings || 0),
      confirmedBookings: Number(bookingsAgg?.confirmed_bookings || 0),
      reviewedBookings: Number(bookingsAgg?.reviewed_bookings || 0),
      revenue: Number(revenueAgg?.revenue || 0),
      onlineProviders: Number(providersAgg?.online_providers || 0),
      verifiedProviders: Number(providersAgg?.verified_providers || 0),
      pendingVerification: Number(providersAgg?.pending_verification || 0),
      bookingFeePercent: Number(settings?.bookingFeePercent || 10),
      maintenanceMode: !!settings?.maintenanceMode,
    });
  }
  const totalBookings = db.bookings.length;
  const confirmedBookings = db.bookings.filter(b => b.status === 'confirmed').length;
  const reviewedBookings = db.bookings.filter(b => b.status === 'reviewed').length;
  const revenue = db.payments.filter(p => p.status === 'paid').reduce((sum, p) => sum + Number(p.amount || 0), 0);
  res.json({
    totalUsers: db.users.length,
    totalProviders: db.providers.length,
    totalBookings,
    confirmedBookings,
    reviewedBookings,
    revenue,
    onlineProviders: db.providers.filter(p => p.online).length,
    verifiedProviders: db.providers.filter(p => p.verified).length,
    pendingVerification: db.providers.filter(p => !p.verified).length,
    bookingFeePercent: Number(db.settings?.bookingFeePercent || 10),
    maintenanceMode: !!db.settings?.maintenanceMode,
  });
});

router.get('/provider/me', authMiddleware, async (req, res) => {
  if (useDirectPg()) {
    const provider = await getProviderByUserIdPg(req.user.id);
    if (!provider) return res.status(404).json({ error: 'Provider profil nije pronađen' });
    return res.json(await enrichProviderPg(provider));
  }
  const provider = getProviderByUserId(req.user.id);
  if (!provider) return res.status(404).json({ error: 'Provider profil nije pronađen' });
  res.json(enrichProvider(provider));
});
router.patch('/provider/me', authMiddleware, writeLimiter, validateProviderUpdate, async (req, res) => {
  const { bio, pricePerHour, location, services, online } = req.body;

  if (useDirectPg()) {
    const provider = await getProviderByUserIdPg(req.user.id);
    if (!provider) return res.status(404).json({ error: 'Provider profil nije pronađen' });

    const nextLocation = location ? String(location).trim() : provider.location;
    const nextBio = typeof bio === 'string' ? bio.trim() : provider.bio;
    const nextPrice = pricePerHour !== undefined ? (Number(pricePerHour) || provider.pricePerHour) : provider.pricePerHour;
    const nextOnline = typeof online === 'boolean' ? online : provider.online;
    const nextServices = Array.isArray(services) ? services.map(item => String(item).trim()).filter(Boolean).slice(0, 8) : provider.services;

    const pg = await ensurePg();
    await pg.query(
      `UPDATE providers
       SET bio = $1, price_per_hour = $2, location = $3, online = $4, initials = $5
       WHERE id = $6`,
      [nextBio, nextPrice, nextLocation, nextOnline, provider.name.split(' ').map(n => n[0]).join('').slice(0,2).toUpperCase(), provider.id]
    );
    await pg.query('UPDATE users SET location = $1 WHERE id = $2', [nextLocation, req.user.id]);
    await pg.query('DELETE FROM provider_services WHERE provider_id = $1', [provider.id]);
    for (const [index, serviceName] of nextServices.entries()) {
      await pg.query('INSERT INTO provider_services (provider_id, service_name, sort_order) VALUES ($1,$2,$3)', [provider.id, serviceName, index]);
    }
    return res.json(await enrichProviderPg(await getProviderByUserIdPg(req.user.id)));
  }

  const provider = getProviderByUserId(req.user.id);
  const user = db.users.find(u => u.id === req.user.id);
  if (!provider || !user) return res.status(404).json({ error: 'Provider profil nije pronađen' });
  if (typeof bio === 'string') provider.bio = bio.trim();
  if (location) { provider.location = String(location).trim(); user.location = String(location).trim(); }
  if (pricePerHour !== undefined) provider.pricePerHour = Number(pricePerHour) || provider.pricePerHour;
  if (Array.isArray(services)) provider.services = services.map(item => String(item).trim()).filter(Boolean).slice(0, 8);
  if (typeof online === 'boolean') provider.online = online;
  provider.initials = provider.name.split(' ').map(n => n[0]).join('').slice(0,2).toUpperCase();
  return persistAndSend(res, enrichProvider(provider));
});

router.post('/provider/upload-image', authMiddleware, writeLimiter, validateImageUpload, async (req, res) => {
  const { imageData, filename, kind = 'gallery' } = req.body;
  if (!imageData || typeof imageData !== 'string' || !imageData.startsWith('data:image/')) return res.status(400).json({ error: 'Pošalji validnu sliku' });

  if (useDirectPg()) {
    const provider = await getProviderByUserIdPg(req.user.id);
    if (!provider) return res.status(404).json({ error: 'Provider profil nije pronađen' });
    try {
      const upload = await uploadImageFromBase64(imageData, filename, provider.id, kind);
      const pg = await ensurePg();
      if (kind === 'avatar') {
        await pg.query('UPDATE providers SET avatar_url = $1 WHERE id = $2', [upload.publicPath, provider.id]);
      } else {
        const existingCount = await queryCount('SELECT COUNT(*)::int AS total_count FROM provider_gallery WHERE provider_id = $1', [provider.id]);
        if (existingCount >= 6) return res.status(400).json({ error: 'Maksimalno 6 slika u galeriji' });
        await pg.query('INSERT INTO provider_gallery (provider_id, image_url, sort_order) VALUES ($1,$2,$3)', [provider.id, upload.publicPath, existingCount]);
      }
      const refreshed = await enrichProviderPg(await getProviderByUserIdPg(req.user.id));
      return res.status(201).json({ ...refreshed, uploadStorage: upload.storage });
    } catch (err) {
      return res.status(400).json({ error: err.message || 'Upload nije uspeo' });
    }
  }

  const provider = getProviderByUserId(req.user.id);
  if (!provider) return res.status(404).json({ error: 'Provider profil nije pronađen' });
  try {
    const upload = await uploadImageFromBase64(imageData, filename, provider.id, kind);
    if (kind === 'avatar') provider.avatarUrl = upload.publicPath; else provider.gallery = [upload.publicPath, ...(provider.gallery || [])].slice(0, 6);
    return persistAndSend(res, { ...enrichProvider(provider), uploadStorage: upload.storage }, 201);
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Upload nije uspeo' });
  }
});
router.delete('/provider/gallery/:index', authMiddleware, async (req, res) => {
  const index = Number(req.params.index);
  if (Number.isNaN(index) || index < 0) return res.status(404).json({ error: 'Slika nije pronađena' });
  if (useDirectPg()) {
    const provider = await getProviderByUserIdPg(req.user.id);
    if (!provider) return res.status(404).json({ error: 'Provider profil nije pronađen' });
    if (index >= (provider.gallery || []).length) return res.status(404).json({ error: 'Slika nije pronađena' });
    const imageUrl = provider.gallery[index];
    const pg = await ensurePg();
    await pg.query('DELETE FROM provider_gallery WHERE provider_id = $1 AND image_url = $2', [provider.id, imageUrl]);
    const refreshed = await enrichProviderPg(await getProviderByUserIdPg(req.user.id));
    return res.json(refreshed);
  }
  const provider = getProviderByUserId(req.user.id);
  if (!provider) return res.status(404).json({ error: 'Provider profil nije pronađen' });
  if (index >= (provider.gallery || []).length) return res.status(404).json({ error: 'Slika nije pronađena' });
  provider.gallery.splice(index, 1);
  return persistAndSend(res, enrichProvider(provider));
});

router.get('/bookings/my', authMiddleware, async (req, res) => {
  const { status, search, sort } = req.query;
  const pagination = getPagination(req, { page: 1, limit: 10, maxLimit: 50 });
  if (useDirectPg()) {
    const providerProfile = await getProviderByUserIdPg(req.user.id);
    const providerId = providerProfile?.id || '';
    const params = [req.user.id, providerId];
    const where = ['(client_id = $1 OR provider_id = $2)'];
    if (status) {
      params.push(String(status));
      where.push(`status = $${params.length}`);
    }
    if (search) {
      params.push(`%${String(search).toLowerCase()}%`);
      where.push(`(LOWER(service_name) LIKE $${params.length} OR LOWER(service) LIKE $${params.length} OR LOWER(COALESCE(notes,'')) LIKE $${params.length})`);
    }
    const sortMap = {
      newest: 'created_at DESC',
      oldest: 'created_at ASC',
      date_asc: 'booking_date ASC, booking_time ASC',
      date_desc: 'booking_date DESC, booking_time DESC',
      price_desc: 'price DESC, created_at DESC',
      price_asc: 'price ASC, created_at DESC',
    };
    const orderBy = sortMap[String(sort || '')] || 'created_at DESC';
    const total = await queryCount(`SELECT COUNT(*)::int AS total_count FROM bookings WHERE ${where.join(' AND ')}`, params);
    params.push(pagination.limit, pagination.offset);
    const rows = await queryMany(`SELECT * FROM bookings WHERE ${where.join(' AND ')} ORDER BY ${orderBy} LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    const items = await Promise.all(rows.map(hydrateBookingPg));
    return res.json(wrapListResponse(req, items, { ...pagination, total, totalPages: Math.max(1, Math.ceil(total / pagination.limit)), sort: String(sort || 'newest') }));
  }
  const providerProfile = getProviderByUserId(req.user.id);
  const providerId = providerProfile?.id;
  let bookings = db.bookings.filter(b => b.clientId === req.user.id || b.providerId === providerId).map(hydrateBooking);
  if (status) bookings = bookings.filter(b => b.status === status);
  if (search) {
    const q = String(search).toLowerCase();
    bookings = bookings.filter(b => String(b.serviceName || b.service).toLowerCase().includes(q) || String(b.notes || '').toLowerCase().includes(q));
  }
  const sorter = String(sort || '');
  if (sorter === 'oldest') bookings.sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt));
  else if (sorter === 'date_asc') bookings.sort((a,b)=>`${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
  else if (sorter === 'date_desc') bookings.sort((a,b)=>`${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`));
  else if (sorter === 'price_desc') bookings.sort((a,b)=>b.price-a.price || new Date(b.createdAt)-new Date(a.createdAt));
  else if (sorter === 'price_asc') bookings.sort((a,b)=>a.price-b.price || new Date(b.createdAt)-new Date(a.createdAt));
  else bookings.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  const total = bookings.length;
  const items = bookings.slice(pagination.offset, pagination.offset + pagination.limit);
  res.json(wrapListResponse(req, items, { ...pagination, total, totalPages: Math.max(1, Math.ceil(total / pagination.limit)), sort: sorter || 'newest' }));
});
router.post('/bookings', authMiddleware, writeLimiter, validateBookingCreate, async (req, res) => {
  const { providerId, service, serviceName, date, time, price, note, paymentMethod = 'cash' } = req.body;
  if (!providerId || !service || !date || !time || !price) return res.status(400).json({ error: 'Sva polja su obavezna' });

  if (useDirectPg()) {
    const provider = await getProviderByIdPg(providerId);
    if (!provider) return res.status(404).json({ error: 'Pružalac nije pronađen' });

    const settings = await queryOne('SELECT payload FROM app_settings WHERE id = 1');
    const bookingFeePercent = Number(settings?.payload?.bookingFeePercent || 10);
    const commissionRate = bookingFeePercent / 100;
    const commission = Math.round(Number(price) * commissionRate);
    const bookingId = uuidv4();
    await queryOne(
      `INSERT INTO bookings
       (id, client_id, provider_id, service, service_name, booking_date, booking_time, price, commission, provider_amount, status, payment_method, payment_status, notes, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'confirmed',$11,$12,$13,NOW())
       RETURNING id`,
      [bookingId, req.user.id, providerId, service, serviceName || null, date, time, Number(price), commission, Number(price)-commission, paymentMethod, paymentMethod === 'card' ? 'paid' : 'pending', note || '']
    );

    if (paymentMethod === 'card') {
      await queryOne(
        `INSERT INTO payments (id, booking_id, client_id, provider_id, amount, method, status, reference, created_at)
         VALUES ($1,$2,$3,$4,$5,'card','paid',$6,NOW())
         RETURNING id`,
        [uuidv4(), bookingId, req.user.id, providerId, Number(price), `PAY-${Date.now()}`]
      );
    }

    let conv = await queryOne('SELECT * FROM conversations WHERE client_id = $1 AND provider_id = $2 LIMIT 1', [req.user.id, providerId]);
    const nowTime = new Date().toLocaleTimeString('sr-RS', { hour:'2-digit', minute:'2-digit' });
    if (!conv) {
      conv = await queryOne(
        `INSERT INTO conversations (id, client_id, provider_id, last_message, last_time, unread, created_at)
         VALUES ($1,$2,$3,$4,$5,0,NOW())
         RETURNING *`,
        [uuidv4(), req.user.id, providerId, 'Nova rezervacija je poslata.', nowTime]
      );
    }
    const autoMsgText = `Rezervacija potvrđena za ${date} u ${time} — ${serviceName || service}.`;
    await queryOne(
      `INSERT INTO messages (id, conversation_id, sender_role, message_text, time_label, created_at)
       VALUES ($1,$2,'system',$3,$4,NOW()) RETURNING id`,
      [uuidv4(), conv.id, autoMsgText, nowTime]
    );
    await queryOne('UPDATE conversations SET last_message = $1, last_time = $2 WHERE id = $3 RETURNING id', [autoMsgText, nowTime, conv.id]);

    const row = await queryOne('SELECT * FROM bookings WHERE id = $1', [bookingId]);
    return res.status(201).json(await hydrateBookingPg(row));
  }

  const provider = db.providers.find(p => p.id === providerId);
  if (!provider) return res.status(404).json({ error: 'Pružalac nije pronađen' });
  const commissionRate = Number(db.settings?.bookingFeePercent || 10) / 100;
  const commission = Math.round(Number(price) * commissionRate);
  const booking = { id: uuidv4(), clientId: req.user.id, providerId, service, serviceName, date, time, price: Number(price), commission, providerAmount: Number(price)-commission, note: note || '', status: 'confirmed', paymentMethod, paymentStatus: paymentMethod === 'card' ? 'paid' : 'pending', createdAt: new Date() };
  db.bookings.push(booking);
  if (paymentMethod === 'card') {
    db.payments.push({ id: uuidv4(), bookingId: booking.id, clientId: req.user.id, providerId, amount: Number(price), method: 'card', status: 'paid', reference: `PAY-${Date.now()}`, createdAt: new Date() });
  }
  let conv = db.conversations.find(c => c.clientId === req.user.id && c.providerId === providerId);
  if (!conv) {
    conv = { id: uuidv4(), clientId: req.user.id, providerId, lastMessage: 'Nova rezervacija je poslata.', lastTime: new Date().toLocaleTimeString('sr-RS', { hour:'2-digit', minute:'2-digit' }), unread: 0 };
    db.conversations.push(conv);
  }
  const autoMsg = { id: uuidv4(), conversationId: conv.id, from: 'system', text: `Rezervacija potvrđena za ${date} u ${time} — ${serviceName || service}.`, time: new Date().toLocaleTimeString('sr-RS', { hour:'2-digit', minute:'2-digit' }), createdAt: new Date() };
  db.messages.push(autoMsg); conv.lastMessage = autoMsg.text; conv.lastTime = autoMsg.time;
  return persistAndSend(res, hydrateBooking(booking), 201);
});
router.patch('/bookings/:id/status', authMiddleware, writeLimiter, validateBookingStatus, async (req, res) => {
  const allowedStatuses = ['confirmed', 'completed', 'reviewed', 'cancelled'];
  const newStatus = req.body.status;
  if (!allowedStatuses.includes(newStatus)) return res.status(400).json({ error: 'Nepodržan status' });

  if (useDirectPg()) {
    const booking = await queryOne('SELECT * FROM bookings WHERE id = $1', [req.params.id]);
    if (!booking) return res.status(404).json({ error: 'Rezervacija nije pronađena' });
    const providerProfile = await getProviderByUserIdPg(req.user.id);
    const isClient = booking.client_id === req.user.id;
    const isProvider = providerProfile?.id === booking.provider_id;
    const isAdmin = req.user.role === 'admin';
    if (!isClient && !isProvider && !isAdmin) return res.status(403).json({ error: 'Nemate pristup ovoj rezervaciji' });
    if (isClient && !['cancelled'].includes(newStatus)) return res.status(403).json({ error: 'Klijent može samo da otkaže rezervaciju' });

    await queryOne('UPDATE bookings SET status = $1 WHERE id = $2 RETURNING id', [newStatus, booking.id]);
    const conv = await queryOne('SELECT * FROM conversations WHERE client_id = $1 AND provider_id = $2 LIMIT 1', [booking.client_id, booking.provider_id]);
    if (conv) {
      const text = `Status rezervacije je promenjen na: ${newStatus}.`;
      const time = new Date().toLocaleTimeString('sr-RS', { hour: '2-digit', minute: '2-digit' });
      await queryOne(
        `INSERT INTO messages (id, conversation_id, sender_role, message_text, time_label, created_at)
         VALUES ($1,$2,$3,$4,$5,NOW()) RETURNING id`,
        [uuidv4(), conv.id, isProvider ? 'provider' : 'system', text, time]
      );
      await queryOne('UPDATE conversations SET last_message = $1, last_time = $2 WHERE id = $3 RETURNING id', [text, time, conv.id]);
    }
    const updated = await queryOne('SELECT * FROM bookings WHERE id = $1', [booking.id]);
    return res.json(await hydrateBookingPg(updated));
  }

  const booking = db.bookings.find(b => b.id === req.params.id);
  if (!booking) return res.status(404).json({ error: 'Rezervacija nije pronađena' });
  const providerProfile = getProviderByUserId(req.user.id);
  const isClient = booking.clientId === req.user.id;
  const isProvider = providerProfile?.id === booking.providerId;
  const isAdmin = req.user.role === 'admin';
  if (!isClient && !isProvider && !isAdmin) return res.status(403).json({ error: 'Nemate pristup ovoj rezervaciji' });
  if (isClient && !['cancelled'].includes(newStatus)) return res.status(403).json({ error: 'Klijent može samo da otkaže rezervaciju' });
  booking.status = newStatus;
  const conv = db.conversations.find(c => c.clientId === booking.clientId && c.providerId === booking.providerId);
  if (conv) {
    const text = `Status rezervacije je promenjen na: ${newStatus}.`;
    const time = new Date().toLocaleTimeString('sr-RS', { hour: '2-digit', minute: '2-digit' });
    const msg = { id: uuidv4(), conversationId: conv.id, from: isProvider ? 'provider' : 'system', text, time, createdAt: new Date() };
    db.messages.push(msg); conv.lastMessage = text; conv.lastTime = time;
  }
  return persistAndSend(res, hydrateBooking(booking));
});

router.post('/payments/checkout', authMiddleware, writeLimiter, validatePaymentCheckout, async (req, res) => {
  const { bookingId, amount, providerId, method = 'card' } = req.body;
  if (!bookingId || !amount || !providerId) return res.status(400).json({ error: 'Nedostaju podaci za naplatu' });

  if (useDirectPg()) {
    const booking = await queryOne('SELECT * FROM bookings WHERE id = $1 AND client_id = $2', [bookingId, req.user.id]);
    if (!booking) return res.status(404).json({ error: 'Rezervacija nije pronađena' });
    const user = await queryOne('SELECT email FROM users WHERE id = $1', [req.user.id]);
    const existing = await queryOne('SELECT * FROM payments WHERE booking_id = $1 AND status = $2 LIMIT 1', [bookingId, 'paid']);
    if (existing) return res.status(400).json({ error: 'Rezervacija je već plaćena' });

    if (config.paymentMode === 'stripe' && config.stripeSecretKey && method === 'card') {
      try {
        const intent = await createStripePaymentIntent({ amount: Number(amount), bookingId, customerEmail: user?.email, metadata: { providerId, clientId: req.user.id } });
        await queryOne('DELETE FROM payments WHERE booking_id = $1', [bookingId]);
        const paymentRow = await queryOne(`INSERT INTO payments (id, booking_id, client_id, provider_id, amount, method, status, reference, created_at) VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,NOW()) RETURNING *`, [uuidv4(), bookingId, req.user.id, providerId, Number(amount), 'stripe', intent.id]);
        await queryOne(`UPDATE bookings SET payment_method = 'stripe', payment_status = 'pending' WHERE id = $1 RETURNING id`, [bookingId]);
        return res.status(201).json({ ...mapPaymentRow(paymentRow), provider: 'stripe', clientSecret: intent.client_secret, publishableKey: config.stripePublicKey || '', paymentIntentId: intent.id, mode: 'stripe' });
      } catch (err) {
        return res.status(400).json({ error: err.message || 'Stripe checkout nije uspeo' });
      }
    }

    await queryOne('DELETE FROM payments WHERE booking_id = $1', [bookingId]);
    const reference = `PAY-${Date.now()}`;
    const paymentRow = await queryOne(`INSERT INTO payments (id, booking_id, client_id, provider_id, amount, method, status, reference, created_at) VALUES ($1,$2,$3,$4,$5,$6,'paid',$7,NOW()) RETURNING *`, [uuidv4(), bookingId, req.user.id, providerId, Number(amount), method, reference]);
    await queryOne(`UPDATE bookings SET payment_method = $1, payment_status = 'paid' WHERE id = $2 RETURNING id`, [method, bookingId]);
    return res.status(201).json({ ...mapPaymentRow(paymentRow), mode: 'simulation' });
  }

  const booking = db.bookings.find(b => b.id === bookingId && b.clientId === req.user.id);
  if (!booking) return res.status(404).json({ error: 'Rezervacija nije pronađena' });
  let payment = db.payments.find(p => p.bookingId === bookingId);
  if (payment?.status === 'paid') return res.status(400).json({ error: 'Rezervacija je već plaćena' });
  payment = { id: uuidv4(), bookingId, clientId: req.user.id, providerId, amount: Number(amount), method, status: 'paid', reference: `PAY-${Date.now()}`, createdAt: new Date() };
  db.payments = db.payments.filter(p => p.bookingId !== bookingId);
  db.payments.push(payment);
  booking.paymentMethod = method;
  booking.paymentStatus = 'paid';
  return persistAndSend(res, { ...payment, mode: 'simulation' }, 201);
});
router.get('/payments/my', authMiddleware, async (req, res) => {
  const { status, method, sort } = req.query;
  const pagination = getPagination(req, { page: 1, limit: 10, maxLimit: 50 });
  if (useDirectPg()) {
    const providerProfile = await getProviderByUserIdPg(req.user.id);
    const providerId = providerProfile?.id || '';
    const params = [req.user.id, providerId, req.user.role];
    const where = ["(client_id = $1 OR provider_id = $2 OR $3 = 'admin')"];
    if (status) { params.push(String(status)); where.push(`status = $${params.length}`); }
    if (method) { params.push(String(method)); where.push(`method = $${params.length}`); }
    const orderBy = String(sort || '') === 'amount_asc' ? 'amount ASC, created_at DESC' : String(sort || '') === 'amount_desc' ? 'amount DESC, created_at DESC' : 'created_at DESC';
    const total = await queryCount(`SELECT COUNT(*)::int AS total_count FROM payments WHERE ${where.join(' AND ')}`, params);
    params.push(pagination.limit, pagination.offset);
    const rows = await queryMany(`SELECT * FROM payments WHERE ${where.join(' AND ')} ORDER BY ${orderBy} LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return res.json(wrapListResponse(req, rows.map(mapPaymentRow), { ...pagination, total, totalPages: Math.max(1, Math.ceil(total / pagination.limit)), sort: String(sort || 'newest') }));
  }
  const providerProfile = getProviderByUserId(req.user.id);
  const providerId = providerProfile?.id;
  let payments = db.payments.filter(p => p.clientId === req.user.id || p.providerId === providerId || req.user.role === 'admin');
  if (status) payments = payments.filter(p => p.status === status);
  if (method) payments = payments.filter(p => p.method === method);
  const sorter = String(sort || '');
  if (sorter === 'amount_asc') payments.sort((a,b)=>a.amount-b.amount || new Date(b.createdAt)-new Date(a.createdAt));
  else if (sorter === 'amount_desc') payments.sort((a,b)=>b.amount-a.amount || new Date(b.createdAt)-new Date(a.createdAt));
  else payments.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  const total = payments.length;
  const items = payments.slice(pagination.offset, pagination.offset + pagination.limit);
  res.json(wrapListResponse(req, items, { ...pagination, total, totalPages: Math.max(1, Math.ceil(total / pagination.limit)), sort: sorter || 'newest' }));
});
router.get('/conversations/all', authMiddleware, async (req, res) => {
  const { search } = req.query;
  const pagination = getPagination(req, { page: 1, limit: 20, maxLimit: 100 });
  if (useDirectPg()) {
    const providerProfile = await getProviderByUserIdPg(req.user.id);
    const providerId = providerProfile?.id || '';
    const params = [req.user.id, providerId];
    let baseWhere = '(client_id = $1 OR provider_id = $2)';
    if (search) {
      params.push(`%${String(search).toLowerCase()}%`);
      baseWhere += ` AND (LOWER(COALESCE(last_message,'')) LIKE $${params.length} OR EXISTS (SELECT 1 FROM providers p WHERE p.id = conversations.provider_id AND LOWER(p.name) LIKE $${params.length}))`;
    }
    const total = await queryCount(`SELECT COUNT(*)::int AS total_count FROM conversations WHERE ${baseWhere}`, params);
    params.push(pagination.limit, pagination.offset);
    const rows = await queryMany(`SELECT * FROM conversations WHERE ${baseWhere} ORDER BY created_at DESC, last_time DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    const items = await Promise.all(rows.map(hydrateConversationPg));
    return res.json(wrapListResponse(req, items, { ...pagination, total, totalPages: Math.max(1, Math.ceil(total / pagination.limit)) }));
  }
  const providerProfile = getProviderByUserId(req.user.id);
  const providerId = providerProfile?.id;
  let convs = db.conversations.filter(c => c.clientId === req.user.id || c.providerId === providerId).map(c => ({ ...c, provider: db.providers.find(p => p.id === c.providerId) || null, client: getSafeUser(db.users.find(u => u.id === c.clientId) || null) })).sort((a,b)=>String(b.lastTime).localeCompare(String(a.lastTime)));
  if (search) {
    const q = String(search).toLowerCase();
    convs = convs.filter(c => String(c.lastMessage || '').toLowerCase().includes(q) || String(c.provider?.name || '').toLowerCase().includes(q));
  }
  const total = convs.length;
  const items = convs.slice(pagination.offset, pagination.offset + pagination.limit);
  res.json(wrapListResponse(req, items, { ...pagination, total, totalPages: Math.max(1, Math.ceil(total / pagination.limit)) }));
});
router.get('/messages/:conversationId', authMiddleware, async (req, res) => {
  if (!String(req.params.conversationId || '').trim()) return res.status(400).json({ error: 'Conversation ID je obavezan.' });
  const pagination = getPagination(req, { page: 1, limit: 50, maxLimit: 200 });
  if (useDirectPg()) {
    const conv = await queryOne('SELECT * FROM conversations WHERE id = $1', [req.params.conversationId]);
    if (!conv) return res.status(404).json({ error: 'Razgovor nije pronađen' });
    const providerProfile = await getProviderByUserIdPg(req.user.id);
    const hasAccess = conv.client_id === req.user.id || conv.provider_id === providerProfile?.id;
    if (!hasAccess) return res.status(403).json({ error: 'Nemate pristup ovom razgovoru' });
    const total = await queryCount('SELECT COUNT(*)::int AS total_count FROM messages WHERE conversation_id = $1', [req.params.conversationId]);
    const rows = await queryMany(`SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT $2 OFFSET $3`, [req.params.conversationId, pagination.limit, pagination.offset]);
    return res.json(wrapListResponse(req, rows.map(mapMessageRow), { ...pagination, total, totalPages: Math.max(1, Math.ceil(total / pagination.limit)) }));
  }
  const conv = db.conversations.find(c => c.id === req.params.conversationId);
  if (!conv) return res.status(404).json({ error: 'Razgovor nije pronađen' });
  const providerProfile = getProviderByUserId(req.user.id);
  const hasAccess = conv.clientId === req.user.id || conv.providerId === providerProfile?.id;
  if (!hasAccess) return res.status(403).json({ error: 'Nemate pristup ovom razgovoru' });
  const msgs = db.messages.filter(m => m.conversationId === req.params.conversationId).sort((a,b)=>new Date(a.createdAt||0)-new Date(b.createdAt||0));
  const total = msgs.length;
  const items = msgs.slice(pagination.offset, pagination.offset + pagination.limit);
  res.json(wrapListResponse(req, items, { ...pagination, total, totalPages: Math.max(1, Math.ceil(total / pagination.limit)) }));
});
router.post('/messages', authMiddleware, writeLimiter, validateMessageCreate, async (req, res) => {
  const { conversationId, text } = req.body;
  if (!conversationId || !text) return res.status(400).json({ error: 'Nedostaju podaci' });

  if (useDirectPg()) {
    const conv = await queryOne('SELECT * FROM conversations WHERE id = $1', [conversationId]);
    if (!conv) return res.status(404).json({ error: 'Razgovor nije pronađen' });
    const providerProfile = await getProviderByUserIdPg(req.user.id);
    const hasAccess = conv.client_id === req.user.id || conv.provider_id === providerProfile?.id;
    if (!hasAccess) return res.status(403).json({ error: 'Nemate pristup ovom razgovoru' });
    const from = providerProfile?.id === conv.provider_id ? 'provider' : 'client';
    const now = new Date();
    const time = now.toLocaleTimeString('sr-RS', { hour:'2-digit', minute:'2-digit' });
    const row = await queryOne(
      `INSERT INTO messages (id, conversation_id, sender_role, message_text, time_label, created_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       RETURNING *`,
      [uuidv4(), conversationId, from, text, time]
    );
    const nextUnread = from === 'provider' ? Number(conv.unread || 0) + 1 : Number(conv.unread || 0);
    await queryOne(
      `UPDATE conversations SET last_message = $1, last_time = $2, unread = $3 WHERE id = $4 RETURNING id`,
      [text, time, nextUnread, conversationId]
    );
    return res.status(201).json(mapMessageRow(row));
  }

  const conv = db.conversations.find(c => c.id === conversationId);
  if (!conv) return res.status(404).json({ error: 'Razgovor nije pronađen' });
  const providerProfile = getProviderByUserId(req.user.id);
  const hasAccess = conv.clientId === req.user.id || conv.providerId === providerProfile?.id;
  if (!hasAccess) return res.status(403).json({ error: 'Nemate pristup ovom razgovoru' });
  const from = providerProfile?.id === conv.providerId ? 'provider' : 'client';
  const now = new Date();
  const time = now.toLocaleTimeString('sr-RS', { hour:'2-digit', minute:'2-digit' });
  const msg = { id: uuidv4(), conversationId, from, text, time, createdAt: now };
  db.messages.push(msg); conv.lastMessage = text; conv.lastTime = time; if (from === 'provider') conv.unread = (conv.unread || 0) + 1;
  return persistAndSend(res, msg, 201);
});

router.get('/reviews/provider/:providerId', async (req, res) => {
  if (!String(req.params.providerId || '').trim()) return res.status(400).json({ error: 'Provider ID je obavezan.' });
  const pagination = getPagination(req, { page: 1, limit: 10, maxLimit: 50 });
  if (useDirectPg()) {
    const total = await queryCount('SELECT COUNT(*)::int AS total_count FROM reviews WHERE provider_id = $1', [req.params.providerId]);
    const rows = await queryMany(`SELECT id, provider_id, client_id, client_name, initials, rating, review_text, tip, review_date, created_at FROM reviews WHERE provider_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`, [req.params.providerId, pagination.limit, pagination.offset]);
    const items = rows.map(r => ({ id: r.id, providerId: r.provider_id, clientId: r.client_id, clientName: r.client_name, initials: r.initials, rating: Number(r.rating || 0), text: r.review_text || '', tip: Number(r.tip || 0), date: r.review_date, createdAt: r.created_at }));
    return res.json(wrapListResponse(req, items, { ...pagination, total, totalPages: Math.max(1, Math.ceil(total / pagination.limit)) }));
  }
  const reviews = db.reviews.filter(r => r.providerId === req.params.providerId).sort((a,b)=>new Date(b.createdAt||0)-new Date(a.createdAt||0));
  const total = reviews.length;
  const items = reviews.slice(pagination.offset, pagination.offset + pagination.limit);
  res.json(wrapListResponse(req, items, { ...pagination, total, totalPages: Math.max(1, Math.ceil(total / pagination.limit)) }));
});

router.post('/reviews', authMiddleware, writeLimiter, validateReviewCreate, async (req, res) => {
  const { providerId, bookingId, rating, text, tip = 0 } = req.body;
  if (!providerId || !rating) return res.status(400).json({ error: 'Nedostaju podaci' });

  if (useDirectPg()) {
    const user = await queryOne('SELECT id, name FROM users WHERE id = $1', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'Korisnik nije pronađen' });
    const initials = String(user.name || '').split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
    const reviewDate = new Date().toLocaleDateString('sr-RS');
    const row = await queryOne(
      `INSERT INTO reviews (id, provider_id, client_id, client_name, initials, rating, review_text, tip, review_date, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
       RETURNING *`,
      [uuidv4(), providerId, req.user.id, user.name, initials, Number(rating), text || '', Number(tip) || 0, reviewDate]
    );
    const agg = await queryOne(
      `SELECT COUNT(*)::int AS review_count, COALESCE(AVG(rating), 0)::numeric AS rating_avg
       FROM reviews WHERE provider_id = $1`,
      [providerId]
    );
    const nextRating = Math.round(Number(agg?.rating_avg || 0) * 10) / 10;
    await queryOne(
      `UPDATE providers
       SET review_count = $1, rating = $2,
           stats = jsonb_set(jsonb_set(COALESCE(stats, '{}'::jsonb), '{reviews}', to_jsonb($1::int), true), '{rating}', to_jsonb($2::numeric), true)
       WHERE id = $3
       RETURNING id`,
      [Number(agg?.review_count || 0), nextRating, providerId]
    );
    if (bookingId) {
      await queryOne(`UPDATE bookings SET status = 'reviewed' WHERE id = $1 RETURNING id`, [bookingId]);
    }
    return res.status(201).json({
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
    });
  }

  const user = db.users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'Korisnik nije pronađen' });
  const review = { id: uuidv4(), providerId, clientId: req.user.id, clientName: user.name, initials: user.name.split(' ').map(n => n[0]).join('').toUpperCase(), rating: Number(rating), text: text || '', tip: Number(tip) || 0, date: new Date().toLocaleDateString('sr-RS') };
  db.reviews.push(review);
  const provider = db.providers.find(p => p.id === providerId);
  if (provider) {
    const reviews = db.reviews.filter(r => r.providerId === providerId);
    provider.rating = Math.round((reviews.reduce((sum,item)=>sum+item.rating,0)/reviews.length)*10)/10;
    provider.reviewCount = reviews.length;
    provider.stats.reviews = reviews.length;
    provider.stats.rating = provider.rating;
  }
  if (bookingId) {
    const booking = db.bookings.find(b => b.id === bookingId);
    if (booking) booking.status = 'reviewed';
  }
  return persistAndSend(res, review, 201);
});



router.get('/admin/audit-logs', authMiddleware, adminOnly, async (req, res) => {
  const pagination = getPagination(req, { page: 1, limit: 50, maxLimit: 200 });
  const items = await getAuditLogs({ limit: pagination.limit, offset: pagination.offset });
  return res.json(wrapListResponse(req, items, { ...pagination, total: items.length < pagination.limit ? pagination.offset + items.length : pagination.offset + pagination.limit + 1, totalPages: pagination.page + (items.length === pagination.limit ? 1 : 0) }));
});

router.get('/admin/users', authMiddleware, adminOnly, async (req, res) => {
  const { search, role, sort } = req.query;
  const pagination = getPagination(req, { page: 1, limit: 20, maxLimit: 100 });
  if (useDirectPg()) {
    const params = [];
    const where = ['1=1'];
    if (search) { params.push(`%${String(search).toLowerCase()}%`); where.push(`(LOWER(name) LIKE $${params.length} OR LOWER(email) LIKE $${params.length} OR LOWER(COALESCE(location,'')) LIKE $${params.length})`); }
    if (role) { params.push(String(role)); where.push(`role = $${params.length}`); }
    const orderBy = String(sort || '') === 'name_asc' ? 'name ASC' : 'created_at DESC';
    const total = await queryCount(`SELECT COUNT(*)::int AS total_count FROM users WHERE ${where.join(' AND ')}`, params);
    params.push(pagination.limit, pagination.offset);
    const rows = await queryMany(`SELECT id, name, email, role, location, created_at FROM users WHERE ${where.join(' AND ')} ORDER BY ${orderBy} LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    const items = rows.map(u => ({ id: u.id, name: u.name, email: u.email, role: u.role, location: u.location, createdAt: u.created_at }));
    return res.json(wrapListResponse(req, items, { ...pagination, total, totalPages: Math.max(1, Math.ceil(total / pagination.limit)) }));
  }
  let users = db.users.map(getSafeUser);
  if (search) { const q = String(search).toLowerCase(); users = users.filter(u => String(u.name).toLowerCase().includes(q) || String(u.email).toLowerCase().includes(q) || String(u.location || '').toLowerCase().includes(q)); }
  if (role) users = users.filter(u => u.role === role);
  if (String(sort || '') === 'name_asc') users.sort((a,b)=>String(a.name).localeCompare(String(b.name)));
  else users.sort((a,b)=>new Date(b.createdAt||0)-new Date(a.createdAt||0));
  const total = users.length;
  const items = users.slice(pagination.offset, pagination.offset + pagination.limit);
  res.json(wrapListResponse(req, items, { ...pagination, total, totalPages: Math.max(1, Math.ceil(total / pagination.limit)) }));
});

router.get('/admin/analytics', authMiddleware, adminOnly, async (req, res) => {
  if (useDirectPg()) {
    const [usersAgg, providersAgg, bookingsAgg, paymentsAgg] = await Promise.all([
      queryOne(`SELECT COUNT(*)::int AS total_users, COUNT(*) FILTER (WHERE role = 'client')::int AS clients, COUNT(*) FILTER (WHERE role = 'provider')::int AS providers, COUNT(*) FILTER (WHERE role = 'admin')::int AS admins FROM users`),
      queryOne(`SELECT COUNT(*)::int AS total_providers, COUNT(*) FILTER (WHERE verified = true)::int AS verified, COUNT(*) FILTER (WHERE online = true)::int AS online, AVG(rating)::numeric AS avg_rating FROM providers`),
      queryOne(`SELECT COUNT(*)::int AS total_bookings, COUNT(*) FILTER (WHERE status = 'confirmed')::int AS confirmed, COUNT(*) FILTER (WHERE status = 'completed')::int AS completed, COUNT(*) FILTER (WHERE status = 'reviewed')::int AS reviewed FROM bookings`),
      queryOne(`SELECT COALESCE(SUM(amount),0)::numeric AS revenue, COUNT(*)::int AS total_payments, COUNT(*) FILTER (WHERE status = 'paid')::int AS paid_payments FROM payments`),
    ]);
    return res.json({ users: usersAgg, providers: { ...providersAgg, avg_rating: Number(providersAgg?.avg_rating || 0) }, bookings: bookingsAgg, payments: { ...paymentsAgg, revenue: Number(paymentsAgg?.revenue || 0) } });
  }
  return res.json({
    users: { total_users: db.users.length, clients: db.users.filter(u=>u.role==='client').length, providers: db.users.filter(u=>u.role==='provider').length, admins: db.users.filter(u=>u.role==='admin').length },
    providers: { total_providers: db.providers.length, verified: db.providers.filter(p=>p.verified).length, online: db.providers.filter(p=>p.online).length, avg_rating: db.providers.reduce((s,p)=>s+Number(p.rating||0),0)/(db.providers.length||1) },
    bookings: { total_bookings: db.bookings.length, confirmed: db.bookings.filter(b=>b.status==='confirmed').length, completed: db.bookings.filter(b=>b.status==='completed').length, reviewed: db.bookings.filter(b=>b.status==='reviewed').length },
    payments: { revenue: db.payments.reduce((s,p)=>s+Number(p.amount||0),0), total_payments: db.payments.length, paid_payments: db.payments.filter(p=>p.status==='paid').length },
  });
});

router.get('/admin/overview', authMiddleware, adminOnly, async (req, res) => {
  if (useDirectPg()) {
    const [users, providerRows, bookingRows, paymentRows, settings] = await Promise.all([
      queryMany(`SELECT id, name, email, role, location, created_at FROM users ORDER BY created_at DESC`),
      queryMany(`SELECT p.*,
                        COALESCE(ARRAY_AGG(DISTINCT ps.service_name ORDER BY ps.service_name) FILTER (WHERE ps.service_name IS NOT NULL), ARRAY[]::text[]) AS services,
                        COALESCE(ARRAY_AGG(DISTINCT pg.image_url ORDER BY pg.image_url) FILTER (WHERE pg.image_url IS NOT NULL), ARRAY[]::text[]) AS gallery,
                        COALESCE(ARRAY_AGG(DISTINCT pad.day_of_month ORDER BY pad.day_of_month) FILTER (WHERE pad.day_of_month IS NOT NULL), ARRAY[]::int[]) AS available_dates
                 FROM providers p
                 LEFT JOIN provider_services ps ON ps.provider_id = p.id
                 LEFT JOIN provider_gallery pg ON pg.provider_id = p.id
                 LEFT JOIN provider_available_dates pad ON pad.provider_id = p.id
                 GROUP BY p.id
                 ORDER BY p.created_at DESC`),
      queryMany(`SELECT * FROM bookings ORDER BY created_at DESC`),
      queryMany(`SELECT * FROM payments ORDER BY created_at DESC`),
      getSettingsPg(),
    ]);
    const providers = await Promise.all(providerRows.map(r => enrichProviderPg(mapProviderRow(r))));
    const bookings = await Promise.all(bookingRows.map(hydrateBookingPg));
    return res.json({
      users: users.map(u => ({ id: u.id, name: u.name, email: u.email, role: u.role, location: u.location, createdAt: u.created_at })),
      providers,
      bookings,
      payments: paymentRows.map(mapPaymentRow),
      settings,
      meta: {
        appName: settings?.platformName || config.appName,
        supportEmail: settings?.supportEmail || 'podrska@cisto.test',
        bookingFeePercent: Number(settings?.bookingFeePercent || 10),
        defaultCurrency: settings?.defaultCurrency || 'RSD',
        maintenanceMode: !!settings?.maintenanceMode,
        allowNewProviders: settings?.allowNewProviders !== false,
        featuredProviderIds: settings?.featuredProviderIds || [],
        deployTarget: settings?.deployTarget || 'local',
        paymentMode: config.paymentMode,
        dataMode: config.dataMode,
        stripePublicKey: config.stripePublicKey || '',
      },
    });
  }
  res.json({
    users: db.users.map(getSafeUser),
    providers: db.providers.map(enrichProvider),
    bookings: db.bookings.map(hydrateBooking),
    payments: db.payments,
    settings: db.settings,
    meta: getAppMeta(),
  });
});

router.patch('/admin/providers/:id/verify', authMiddleware, adminOnly, adminLimiter, async (req, res) => {
  if (useDirectPg()) {
    const row = await queryOne('UPDATE providers SET verified = $1 WHERE id = $2 RETURNING id', [!!req.body.verified, req.params.id]);
    if (!row) return res.status(404).json({ error: 'Pružalac nije pronađen' });
    await logAuditEvent({ actorUserId: req.user.id, actorRole: req.user.role, action: 'admin.provider.verify', entityType: 'provider', entityId: req.params.id, payload: { verified: !!req.body.verified }, requestId: req.requestId });
    return res.json(await enrichProviderPg(await getProviderByIdPg(req.params.id)));
  }
  const provider = db.providers.find(p => p.id === req.params.id);
  if (!provider) return res.status(404).json({ error: 'Pružalac nije pronađen' });
  provider.verified = !!req.body.verified;
  await logAuditEvent({ actorUserId: req.user.id, actorRole: req.user.role, action: 'admin.provider.verify', entityType: 'provider', entityId: req.params.id, payload: { verified: !!req.body.verified }, requestId: req.requestId });
  return persistAndSend(res, enrichProvider(provider));
});
router.patch('/admin/users/:id/role', authMiddleware, adminOnly, adminLimiter, async (req, res) => {
  const allowed = ['client','provider','admin'];
  if (!allowed.includes(req.body.role)) return res.status(400).json({ error: 'Nepodržana uloga' });

  if (useDirectPg()) {
    const user = await queryOne(
      `UPDATE users SET role = $1 WHERE id = $2 RETURNING id, name, email, role, location, created_at`,
      [req.body.role, req.params.id]
    );
    if (!user) return res.status(404).json({ error: 'Korisnik nije pronađen' });
    await logAuditEvent({ actorUserId: req.user.id, actorRole: req.user.role, action: 'admin.user.role', entityType: 'user', entityId: req.params.id, payload: { role: req.body.role }, requestId: req.requestId });
    return res.json({ id: user.id, name: user.name, email: user.email, role: user.role, location: user.location, createdAt: user.created_at });
  }

  const user = db.users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'Korisnik nije pronađen' });
  user.role = req.body.role;
  await logAuditEvent({ actorUserId: req.user.id, actorRole: req.user.role, action: 'admin.user.role', entityType: 'user', entityId: req.params.id, payload: { role: req.body.role }, requestId: req.requestId });
  return persistAndSend(res, getSafeUser(user));
});


router.get('/admin/settings', authMiddleware, adminOnly, async (req, res) => {
  if (useDirectPg()) return res.json(await getSettingsPg());
  res.json(db.settings || {});
});

router.patch('/admin/settings', authMiddleware, adminOnly, adminLimiter, validateAdminSettings, async (req, res) => {
  const updates = req.body || {};
  const current = useDirectPg() ? await getSettingsPg() : (db.settings || {});
  const next = {
    ...current,
    platformName: typeof updates.platformName === 'string' ? updates.platformName.trim() || (current?.platformName || config.appName) : (current?.platformName || config.appName),
    supportEmail: typeof updates.supportEmail === 'string' ? updates.supportEmail.trim() || (current?.supportEmail || 'podrska@cisto.test') : (current?.supportEmail || 'podrska@cisto.test'),
    bookingFeePercent: Number.isFinite(Number(updates.bookingFeePercent)) ? Math.max(0, Math.min(25, Number(updates.bookingFeePercent))) : Number(current?.bookingFeePercent || 10),
    defaultCurrency: typeof updates.defaultCurrency === 'string' ? updates.defaultCurrency.trim().toUpperCase().slice(0, 5) || 'RSD' : (current?.defaultCurrency || 'RSD'),
    maintenanceMode: typeof updates.maintenanceMode === 'boolean' ? updates.maintenanceMode : !!current?.maintenanceMode,
    allowNewProviders: typeof updates.allowNewProviders === 'boolean' ? updates.allowNewProviders : current?.allowNewProviders !== false,
    featuredProviderIds: Array.isArray(updates.featuredProviderIds) ? updates.featuredProviderIds.map(String).slice(0, 6) : (current?.featuredProviderIds || []),
    deployTarget: typeof updates.deployTarget === 'string' ? updates.deployTarget.trim() || 'local' : (current?.deployTarget || 'local'),
    lastBackupAt: current?.lastBackupAt || null,
  };
  if (useDirectPg()) {
    const saved = await saveSettingsPg(next);
    await logAuditEvent({ actorUserId: req.user.id, actorRole: req.user.role, action: 'admin.settings.update', entityType: 'settings', entityId: 'app', payload: next, requestId: req.requestId });
    return res.json(saved);
  }
  db.settings = next;
  await logAuditEvent({ actorUserId: req.user.id, actorRole: req.user.role, action: 'admin.settings.update', entityType: 'settings', entityId: 'app', payload: next, requestId: req.requestId });
  return persistAndSend(res, db.settings);
});

router.get('/admin/export', authMiddleware, adminOnly, async (req, res) => {
  if (useDirectPg()) {
    const exportedAt = new Date().toISOString();
    const current = await getSettingsPg();
    const settings = await saveSettingsPg({ ...current, lastBackupAt: exportedAt });
    const [users, providerRows, bookingRows, paymentRows, reviewRows, conversationRows, messageRows] = await Promise.all([
      queryMany(`SELECT id, name, email, role, location, created_at FROM users ORDER BY created_at DESC`),
      queryMany(`SELECT p.*,
                        COALESCE(ARRAY_AGG(DISTINCT ps.service_name ORDER BY ps.service_name) FILTER (WHERE ps.service_name IS NOT NULL), ARRAY[]::text[]) AS services,
                        COALESCE(ARRAY_AGG(DISTINCT pg.image_url ORDER BY pg.image_url) FILTER (WHERE pg.image_url IS NOT NULL), ARRAY[]::text[]) AS gallery,
                        COALESCE(ARRAY_AGG(DISTINCT pad.day_of_month ORDER BY pad.day_of_month) FILTER (WHERE pad.day_of_month IS NOT NULL), ARRAY[]::int[]) AS available_dates
                 FROM providers p
                 LEFT JOIN provider_services ps ON ps.provider_id = p.id
                 LEFT JOIN provider_gallery pg ON pg.provider_id = p.id
                 LEFT JOIN provider_available_dates pad ON pad.provider_id = p.id
                 GROUP BY p.id
                 ORDER BY p.created_at DESC`),
      queryMany(`SELECT * FROM bookings ORDER BY created_at DESC`),
      queryMany(`SELECT * FROM payments ORDER BY created_at DESC`),
      queryMany(`SELECT * FROM reviews ORDER BY created_at DESC`),
      queryMany(`SELECT * FROM conversations ORDER BY created_at DESC`),
      queryMany(`SELECT * FROM messages ORDER BY created_at ASC`),
    ]);
    return res.json({
      exportedAt,
      settings,
      users: users.map(u => ({ id: u.id, name: u.name, email: u.email, role: u.role, location: u.location, createdAt: u.created_at })),
      providers: await Promise.all(providerRows.map(r => enrichProviderPg(mapProviderRow(r)))),
      bookings: await Promise.all(bookingRows.map(hydrateBookingPg)),
      payments: paymentRows.map(mapPaymentRow),
      reviews: reviewRows.map(r => ({
        id: r.id, providerId: r.provider_id, clientId: r.client_id, clientName: r.client_name, initials: r.initials,
        rating: Number(r.rating || 0), text: r.review_text || '', tip: Number(r.tip || 0), date: r.review_date, createdAt: r.created_at
      })),
      conversations: conversationRows.map(mapConversationRow),
      messages: messageRows.map(mapMessageRow),
    });
  }
  db.settings = { ...(db.settings || {}), lastBackupAt: new Date().toISOString() };
  saveDb();
  res.json({
    exportedAt: db.settings.lastBackupAt,
    settings: db.settings,
    users: db.users.map(getSafeUser),
    providers: db.providers.map(enrichProvider),
    bookings: db.bookings.map(hydrateBooking),
    payments: db.payments,
    reviews: db.reviews,
    conversations: db.conversations,
    messages: db.messages,
  });
});

module.exports = router;
