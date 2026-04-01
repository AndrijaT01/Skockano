function badRequest(res, message, details) {
  return res.status(400).json({ error: message, details: details || [] });
}

function sanitizeString(value, { trim = true, max = 5000 } = {}) {
  if (typeof value !== 'string') return '';
  const out = trim ? value.trim() : value;
  return out.slice(0, max);
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function validateRegister(req, res, next) {
  const name = sanitizeString(req.body?.name, { max: 80 });
  const email = sanitizeString(req.body?.email, { max: 160 }).toLowerCase();
  const password = String(req.body?.password || '');
  const role = sanitizeString(req.body?.role || 'client', { max: 20 }).toLowerCase();
  const location = sanitizeString(req.body?.location || 'Beograd', { max: 80 });
  const errors = [];
  if (name.length < 2) errors.push('Ime mora imati najmanje 2 karaktera.');
  if (!isValidEmail(email)) errors.push('Email nije ispravan.');
  if (password.length < 6) errors.push('Lozinka mora imati najmanje 6 karaktera.');
  if (!['client', 'provider', 'admin'].includes(role)) errors.push('Uloga nije ispravna.');
  if (location.length < 2) errors.push('Lokacija nije ispravna.');
  if (errors.length) return badRequest(res, 'Neispravni podaci za registraciju.', errors);
  req.body.name = name;
  req.body.email = email;
  req.body.password = password;
  req.body.role = role;
  req.body.location = location;
  next();
}

function validateLogin(req, res, next) {
  const email = sanitizeString(req.body?.email, { max: 160 }).toLowerCase();
  const password = String(req.body?.password || '');
  const errors = [];
  if (!isValidEmail(email)) errors.push('Email nije ispravan.');
  if (!password) errors.push('Lozinka je obavezna.');
  if (errors.length) return badRequest(res, 'Neispravni podaci za prijavu.', errors);
  req.body.email = email;
  req.body.password = password;
  next();
}

function validateProviderUpdate(req, res, next) {
  const allowed = {};
  if (req.body?.bio !== undefined) allowed.bio = sanitizeString(req.body.bio, { max: 1200 });
  if (req.body?.pricePerHour !== undefined) {
    const price = Number(req.body.pricePerHour);
    if (!Number.isFinite(price) || price < 0 || price > 1000000) return badRequest(res, 'Cena nije ispravna.');
    allowed.pricePerHour = Math.round(price);
  }
  if (req.body?.online !== undefined) allowed.online = !!req.body.online;
  if (req.body?.services !== undefined) {
    if (!Array.isArray(req.body.services) || req.body.services.length > 20) return badRequest(res, 'Usluge moraju biti niz do 20 stavki.');
    allowed.services = req.body.services.map(v => sanitizeString(v, { max: 50 })).filter(Boolean).slice(0, 20);
  }
  if (req.body?.availableDates !== undefined) {
    if (!Array.isArray(req.body.availableDates) || req.body.availableDates.length > 31) return badRequest(res, 'Dostupni datumi moraju biti niz do 31 stavke.');
    allowed.availableDates = req.body.availableDates.map(v => Number(v)).filter(v => Number.isInteger(v) && v >= 1 && v <= 31);
  }
  if (!Object.keys(allowed).length) return badRequest(res, 'Nema ispravnih polja za izmenu.');
  req.body = allowed;
  next();
}

function validateBookingCreate(req, res, next) {
  const providerId = sanitizeString(req.body?.providerId, { max: 80 });
  const service = sanitizeString(req.body?.service, { max: 80 });
  const date = sanitizeString(req.body?.date, { max: 20 });
  const time = sanitizeString(req.body?.time, { max: 20 });
  const notes = sanitizeString(req.body?.notes || '', { max: 1000 });
  const paymentMethod = sanitizeString(req.body?.paymentMethod || 'cash', { max: 20 }).toLowerCase();
  const errors = [];
  if (!providerId) errors.push('Pružalac je obavezan.');
  if (service.length < 2) errors.push('Usluga nije ispravna.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.push('Datum nije ispravan.');
  if (!/^\d{2}:\d{2}$/.test(time)) errors.push('Vreme nije ispravno.');
  if (!['cash', 'card', 'online'].includes(paymentMethod)) errors.push('Način plaćanja nije ispravan.');
  if (errors.length) return badRequest(res, 'Neispravni podaci za rezervaciju.', errors);
  req.body = { ...req.body, providerId, service, date, time, notes, paymentMethod };
  next();
}

function validateBookingStatus(req, res, next) {
  const status = sanitizeString(req.body?.status, { max: 30 }).toLowerCase();
  if (!['pending', 'confirmed', 'completed', 'reviewed', 'cancelled'].includes(status)) {
    return badRequest(res, 'Status rezervacije nije ispravan.');
  }
  req.body.status = status;
  next();
}

function validatePaymentCheckout(req, res, next) {
  const bookingId = sanitizeString(req.body?.bookingId, { max: 80 });
  const amount = Number(req.body?.amount);
  if (!bookingId) return badRequest(res, 'Booking ID je obavezan.');
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10000000) return badRequest(res, 'Iznos nije ispravan.');
  req.body.bookingId = bookingId;
  req.body.amount = Math.round(amount);
  next();
}

function validateMessageCreate(req, res, next) {
  const conversationId = sanitizeString(req.body?.conversationId, { max: 80 });
  const text = sanitizeString(req.body?.text, { max: 2000 });
  const toUserId = sanitizeString(req.body?.toUserId || '', { max: 80 });
  if (!conversationId || text.length < 1) return badRequest(res, 'Poruka i razgovor su obavezni.');
  req.body.conversationId = conversationId;
  req.body.text = text;
  req.body.toUserId = toUserId;
  next();
}

function validateReviewCreate(req, res, next) {
  const providerId = sanitizeString(req.body?.providerId, { max: 80 });
  const bookingId = sanitizeString(req.body?.bookingId, { max: 80 });
  const text = sanitizeString(req.body?.text || '', { max: 1200 });
  const rating = Number(req.body?.rating);
  const tip = Number(req.body?.tip || 0);
  const errors = [];
  if (!providerId) errors.push('Provider ID je obavezan.');
  if (!bookingId) errors.push('Booking ID je obavezan.');
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) errors.push('Ocena mora biti između 1 i 5.');
  if (!Number.isFinite(tip) || tip < 0 || tip > 1000000) errors.push('Bakšiš nije ispravan.');
  if (errors.length) return badRequest(res, 'Neispravni podaci za recenziju.', errors);
  req.body.providerId = providerId;
  req.body.bookingId = bookingId;
  req.body.text = text;
  req.body.rating = Math.round(rating);
  req.body.tip = Math.round(tip);
  next();
}

function validateAdminSettings(req, res, next) {
  const nextSettings = { ...req.body };
  if (nextSettings.platformName !== undefined) nextSettings.platformName = sanitizeString(nextSettings.platformName, { max: 80 });
  if (nextSettings.supportEmail !== undefined) {
    const email = sanitizeString(nextSettings.supportEmail, { max: 160 }).toLowerCase();
    if (!isValidEmail(email)) return badRequest(res, 'Support email nije ispravan.');
    nextSettings.supportEmail = email;
  }
  if (nextSettings.bookingFeePercent !== undefined) {
    const n = Number(nextSettings.bookingFeePercent);
    if (!Number.isFinite(n) || n < 0 || n > 100) return badRequest(res, 'Provizija mora biti između 0 i 100.');
    nextSettings.bookingFeePercent = n;
  }
  if (nextSettings.defaultCurrency !== undefined) nextSettings.defaultCurrency = sanitizeString(nextSettings.defaultCurrency, { max: 10 }).toUpperCase();
  if (nextSettings.deployTarget !== undefined) nextSettings.deployTarget = sanitizeString(nextSettings.deployTarget, { max: 30 });
  if (nextSettings.featuredProviderIds !== undefined) {
    if (!Array.isArray(nextSettings.featuredProviderIds) || nextSettings.featuredProviderIds.length > 50) {
      return badRequest(res, 'Featured providers moraju biti niz do 50 stavki.');
    }
    nextSettings.featuredProviderIds = nextSettings.featuredProviderIds.map(v => sanitizeString(v, { max: 80 })).filter(Boolean);
  }
  if (nextSettings.maintenanceMode !== undefined) nextSettings.maintenanceMode = !!nextSettings.maintenanceMode;
  if (nextSettings.allowNewProviders !== undefined) nextSettings.allowNewProviders = !!nextSettings.allowNewProviders;
  req.body = nextSettings;
  next();
}

function validateImageUpload(req, res, next) {
  const imageData = String(req.body?.imageData || '');
  const filename = sanitizeString(req.body?.filename || 'image', { max: 50 });
  const kind = sanitizeString(req.body?.kind || 'gallery', { max: 20 }).toLowerCase();
  if (!/^data:image\/(png|jpeg|jpg|webp);base64,/.test(imageData)) return badRequest(res, 'Slika mora biti PNG, JPG ili WEBP base64.');
  if (!['gallery', 'avatar'].includes(kind)) return badRequest(res, 'Tip slike nije ispravan.');
  req.body.imageData = imageData;
  req.body.filename = filename;
  req.body.kind = kind;
  next();
}

module.exports = {
  validateRegister,
  validateLogin,
  validateProviderUpdate,
  validateBookingCreate,
  validateBookingStatus,
  validatePaymentCheckout,
  validateMessageCreate,
  validateReviewCreate,
  validateAdminSettings,
  validateImageUpload,
};
