'use strict';
/** Pool config from DATABASE_URL or separate DB_* variables (no URL-encoding problems with symbols in passwords). */
function poolConfig(env = process.env) {
  const base = { max: 10, options: `-c timezone=${env.TZ_NAME || 'Asia/Phnom_Penh'}`,
    ssl: env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined };
  if (env.DATABASE_URL) return { ...base, connectionString: env.DATABASE_URL };
  return { ...base, host: env.DB_HOST || 'localhost', port: Number(env.DB_PORT || 5432),
    user: env.DB_USER || 'postgres', password: env.DB_PASSWORD, database: env.DB_NAME || 'hr_stock' };
}
const hasDbConfig = (env = process.env) => Boolean(env.DATABASE_URL || env.DB_PASSWORD);
module.exports = { poolConfig, hasDbConfig };
