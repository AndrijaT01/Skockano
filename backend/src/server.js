require('dotenv').config();

const express = require('express');
const cors = require('cors');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const { db, seedData, saveDb, uploadsDir, getDbMeta, ensurePg, getSchemaVersion } = require('./db/inMemoryDb');
const { config } = require('./config');
const { setSecurityHeaders, attachRequestId, createMemoryRateLimiter } = require('./middleware/security');

const app = express();
if (config.trustProxy) app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: config.corsOrigin || '*' } });

app.use(cors({ origin: config.corsOrigin || '*' }));
app.use(setSecurityHeaders);
app.use(attachRequestId);


app.post('/api/payments/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    if (!config.stripeWebhookSecret || !config.stripeSecretKey) {
      return res.status(503).json({ error: 'Stripe webhook nije konfigurisan.', requestId: req.requestId });
    }
    const signature = req.headers['stripe-signature'];
    if (!signature || typeof signature !== 'string') {
      return res.status(400).json({ error: 'Nedostaje Stripe potpis.', requestId: req.requestId });
    }

    const payloadBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
    const payloadString = payloadBuffer.toString('utf8');
    const parts = Object.fromEntries(
      signature.split(',').map((entry) => {
        const [k, v] = entry.split('=');
        return [k, v];
      })
    );
    const timestamp = parts.t;
    const expected = require('crypto')
      .createHmac('sha256', config.stripeWebhookSecret)
      .update(`${timestamp}.${payloadString}`, 'utf8')
      .digest('hex');

    if (!parts.v1 || expected !== parts.v1) {
      return res.status(400).json({ error: 'Nevažeći Stripe potpis.', requestId: req.requestId });
    }

    const event = JSON.parse(payloadString || '{}');
    const pg = await ensurePg();
    if (!pg) {
      return res.status(503).json({ error: 'Baza nije spremna za webhook.', requestId: req.requestId });
    }

    const object = event?.data?.object || {};
    const paymentIntentId = object.id;
    const bookingId = object.metadata?.bookingId || null;
    if (!paymentIntentId) return res.status(200).json({ received: true, ignored: true });

    if (event.type === 'payment_intent.succeeded') {
      await pg.query(
        `UPDATE payments
         SET status = 'paid'
         WHERE reference = $1`,
        [paymentIntentId]
      );
      if (bookingId) {
        await pg.query(
          `UPDATE bookings
           SET payment_status = 'paid', payment_method = 'stripe'
           WHERE id = $1`,
          [bookingId]
        );
      }
    } else if (event.type === 'payment_intent.payment_failed' || event.type === 'payment_intent.canceled') {
      await pg.query(
        `UPDATE payments
         SET status = 'failed'
         WHERE reference = $1`,
        [paymentIntentId]
      );
      if (bookingId) {
        await pg.query(
          `UPDATE bookings
           SET payment_status = 'failed', payment_method = 'stripe'
           WHERE id = $1`,
          [bookingId]
        );
      }
    }

    return res.json({ received: true, eventType: event.type });
  } catch (err) {
    console.error('Stripe webhook error:', err);
    return res.status(400).json({ error: err.message || 'Webhook obrada nije uspela.', requestId: req.requestId });
  }
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

const apiLimiter = createMemoryRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 600,
  skip: (req) => !req.path.startsWith('/api'),
});
const authLimiter = createMemoryRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => `${req.ip}:${req.path}`,
  skip: (req) => !req.path.startsWith('/api/auth/'),
});

app.use(apiLimiter);
app.use(authLimiter);

app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    if (config.nodeEnv !== 'test') {
      console.log(`[${req.requestId}] ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - startedAt}ms`);
    }
  });
  next();
});

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Čisto backend radi',
    endpoints: {
      health: '/api/health',
      ready: '/api/ready',
    },
  });
});
app.get('/api/health', async (req, res) => {
  const dbFile = path.join(__dirname, '../../data/db.json');
  const hasDbFile = fs.existsSync(dbFile);
  const dbMeta = getDbMeta();
  const schemaVersion = await getSchemaVersion().catch(() => dbMeta.schemaMode);
  res.json({
    status: 'ok',
    message: 'Čisto API radi!',
    appName: config.appName,
    env: config.nodeEnv,
    dataMode: config.dataMode,
    dbDriver: dbMeta.driver,
    paymentMode: config.paymentMode,
    storageMode: config.storageMode,
    hasLocalDbFile: hasDbFile,
    postgresConnected: dbMeta.postgresConnected,
    maintenanceMode: !!db.settings?.maintenanceMode,
    timestamp: new Date().toISOString(),
    version: 'phase6-finalization',
    schemaMode: dbMeta.schemaMode,
    schemaVersion,
    features: {
      adminPanel: true,
      providerUploads: true,
      chat: true,
      pwa: true,
      backups: true,
      postgresRuntime: dbMeta.driver === 'postgres',
      normalizedSchema: dbMeta.schemaMode === 'postgres-normalized',
      refreshTokens: true,
      auditLogs: true,
      stripeReady: !!config.stripeSecretKey,
      stripeWebhookReady: !!(config.stripeSecretKey && config.stripeWebhookSecret),
      cloudinaryReady: !!(config.cloudinaryCloudName && config.cloudinaryUploadPreset),
    },
  });
});

app.get('/api/ready', async (req, res) => {
  try {
    if (config.dataMode === 'postgres') await ensurePg();
    res.json({ ready: true, db: getDbMeta(), schemaVersion: await getSchemaVersion().catch(() => 'unknown') });
  } catch (err) {
    res.status(503).json({ ready: false, error: err.message, requestId: req.requestId });
  }
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api', require('./routes/api'));

const frontendDir = path.join(__dirname, '../../frontend');
app.use('/uploads', express.static(uploadsDir));
app.use(express.static(frontendDir));
app.get('/', (req, res) => res.sendFile(path.join(frontendDir, 'index.html')));
app.get(/^\/(?!api|socket\.io|uploads).*/, (req, res) => res.sendFile(path.join(frontendDir, 'index.html')));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const isJsonParse = err instanceof SyntaxError && err.status === 400 && 'body' in err;
  if (isJsonParse) {
    return res.status(400).json({ error: 'Neispravan JSON zahtev.', requestId: req.requestId });
  }
  console.error('Unhandled server error:', err);
  res.status(err.status || 500).json({ error: 'Greška na serveru.', requestId: req.requestId });
});

const onlineUsers = new Map();

function useDirectPg() {
  const meta = getDbMeta();
  return meta.driver === 'postgres' && meta.schemaMode === 'postgres-normalized';
}

io.on('connection', (socket) => {
  socket.on('join', (userId) => {
    if (!userId) return;
    onlineUsers.set(userId, socket.id);
    socket.userId = userId;
  });

  socket.on('sendMessage', async ({ conversationId, text, from, toUserId }) => {
    if (!conversationId || !text) return;
    const now = new Date();
    const time = now.toLocaleTimeString('sr-RS', { hour: '2-digit', minute: '2-digit' });

    if (useDirectPg()) {
      try {
        const pg = await ensurePg();
        const senderRole = from || 'client';
        const inserted = await pg.query(
          `INSERT INTO messages (id, conversation_id, sender_role, message_text, time_label, created_at)
           VALUES ($1,$2,$3,$4,$5,NOW())
           RETURNING id, conversation_id, sender_role, message_text, time_label, created_at`,
          [String(Date.now()), conversationId, senderRole, text, time]
        );
        const msgRow = inserted.rows[0];
        const msg = {
          id: msgRow.id,
          conversationId: msgRow.conversation_id,
          from: msgRow.sender_role,
          text: msgRow.message_text,
          time: msgRow.time_label,
          createdAt: msgRow.created_at,
        };
        const convResult = await pg.query('SELECT unread FROM conversations WHERE id = $1 LIMIT 1', [conversationId]);
        const unread = Number(convResult.rows[0]?.unread || 0) + (senderRole === 'provider' ? 1 : 0);
        await pg.query(
          'UPDATE conversations SET last_message = $1, last_time = $2, unread = $3 WHERE id = $4',
          [text, time, unread, conversationId]
        );
        socket.emit('messageSent', msg);
        const recipientSocket = onlineUsers.get(toUserId);
        if (recipientSocket) io.to(recipientSocket).emit('newMessage', msg);
        return;
      } catch (err) {
        console.error('Greška pri PG slanju poruke:', err.message);
      }
    }

    const msg = { id: Date.now().toString(), conversationId, from: from || 'client', text, time, createdAt: now };
    db.messages.push(msg);
    const conv = db.conversations.find(c => c.id === conversationId);
    if (conv) {
      conv.lastMessage = text;
      conv.lastTime = time;
      if (msg.from === 'provider') conv.unread = (conv.unread || 0) + 1;
    }
    Promise.resolve(saveDb()).catch(err => console.error('Greška pri čuvanju poruke:', err.message));
    socket.emit('messageSent', msg);
    const recipientSocket = onlineUsers.get(toUserId);
    if (recipientSocket) io.to(recipientSocket).emit('newMessage', msg);
  });

  socket.on('typing', ({ conversationId, toUserId }) => {
    const recipientSocket = onlineUsers.get(toUserId);
    if (recipientSocket) io.to(recipientSocket).emit('typing', { conversationId });
  });

  socket.on('disconnect', () => {
    if (socket.userId) onlineUsers.delete(socket.userId);
  });
});

seedData()
  .then(async () => {
    const schemaVersion = await getSchemaVersion().catch(() => 'unknown');
    server.listen(config.port, () => {
      const dbMeta = getDbMeta();
      console.log(`\n🚀 ${config.appName} Backend pokrenut na http://localhost:${config.port}`);
      console.log('📡 Socket.io aktivan');
      console.log(`💾 Storage režim: ${config.dataMode}`);
      console.log(`🗄️  DB driver: ${dbMeta.driver}${dbMeta.postgresConnected ? ' (connected)' : ''}`);
      console.log(`🧱 Schema režim: ${dbMeta.schemaMode}`);
      console.log(`🏷️  Schema verzija: ${schemaVersion}`);
      console.log(`💳 Payment režim: ${config.paymentMode}`);
      console.log(`💾 Lokalni mirror: ${dbMeta.localMirrorFile}`);
      console.log(`🌐 Proxy režim: ${config.trustProxy ? 'uključen' : 'isključen'}`);
      console.log(`🔗 Site URL: ${config.siteUrl}`);
      console.log('\n📋 Test nalozi:');
      console.log('   Klijent:   milan@test.com / lozinka123');
      console.log('   Pružalac:  marija@test.com / lozinka123');
      console.log('   Admin:     admin@test.com / admin123\n');
    });
  })
  .catch((err) => {
    console.error('❌ Server nije uspeo da se pokrene:', err);
    process.exit(1);
  });
