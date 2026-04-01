const path = require('path');

const rootDir = path.join(__dirname, '../../..');

const config = {
  appName: process.env.APP_NAME || 'Čisto',
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3001),
  jwtSecret: process.env.JWT_SECRET || 'cisto_super_jak_jwt_2026_abc_987',
  refreshTokenSecret: process.env.REFRESH_TOKEN_SECRET || `${process.env.JWT_SECRET || 'cisto_super_jak_jwt_2026_abc_987'}__refresh`,
  accessTokenTtl: process.env.ACCESS_TOKEN_TTL || '30d',
  refreshTokenTtlDays: Number(process.env.REFRESH_TOKEN_TTL_DAYS || 30),
  dataMode: process.env.DATA_MODE || (process.env.DATABASE_URL ? 'postgres' : 'json'),
  databaseUrl: process.env.DATABASE_URL || '',
  databaseSsl: String(process.env.DATABASE_SSL || 'false').toLowerCase() === 'true',
  paymentMode: process.env.PAYMENT_MODE || (process.env.STRIPE_SECRET_KEY ? 'stripe-ready' : 'simulation'),
  stripePublicKey: process.env.STRIPE_PUBLIC_KEY || '',
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  stripeCurrency: process.env.STRIPE_CURRENCY || 'rsd',
  storageMode: process.env.STORAGE_MODE || (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_UPLOAD_PRESET ? 'cloudinary' : 'local'),
  cloudinaryCloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
  cloudinaryUploadPreset: process.env.CLOUDINARY_UPLOAD_PRESET || '',
  cloudinaryApiKey: process.env.CLOUDINARY_API_KEY || '',
  cloudinaryApiSecret: process.env.CLOUDINARY_API_SECRET || '',
  cloudinaryFolder: process.env.CLOUDINARY_FOLDER || 'cisto/providers',
  corsOrigin: process.env.CORS_ORIGIN || '*',
  siteUrl: process.env.SITE_URL || `http://localhost:${process.env.PORT || 3001}`,
  trustProxy: String(process.env.TRUST_PROXY || 'false').toLowerCase() === 'true',
  logLevel: process.env.LOG_LEVEL || 'info',
  rootDir,
};

module.exports = { config };
