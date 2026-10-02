'use strict';

/**
 * Seed script — creates the system admin user if it does not exist.
 * Run with: npm run seed
 */
const bcrypt = require('bcryptjs');
const env = require('../config');
const { connectDB, disconnectDB } = require('../config/db');
const { ensureSystemRoles } = require('../modules/role/role.seed');
const Role = require('../modules/role/role.model');
const User = require('../modules/user/user.model');

async function main() {
  await connectDB();
  await ensureSystemRoles();

  const adminRole = await Role.findOne({ key: 'admin' });
  if (!adminRole) throw new Error('admin role missing after ensureSystemRoles');

  const email = env.SEED_ADMIN.EMAIL.toLowerCase();
  let user = await User.findOne({ email });

  const passwordHash = await bcrypt.hash(env.SEED_ADMIN.PASSWORD, env.BCRYPT_ROUNDS);

  if (!user) {
    user = await User.create({
      email,
      username: env.SEED_ADMIN.USERNAME,
      passwordHash,
      role: adminRole._id,
      status: 'active',
      profile: {
        fullName: env.SEED_ADMIN.NAME,
        phone: env.SEED_ADMIN.PHONE,
      },
    });
    console.log(`[seed] created admin user: ${email}`);
  } else {
    user.passwordHash = passwordHash;
    user.role = adminRole._id;
    user.status = 'active';
    user.username = env.SEED_ADMIN.USERNAME;
    user.profile = {
      ...user.profile?.toObject?.() || user.profile,
      fullName: env.SEED_ADMIN.NAME,
      phone: env.SEED_ADMIN.PHONE,
    };
    await user.save();
    console.log(`[seed] updated admin user: ${email}`);
  }

  await disconnectDB();
}

main().catch(async (err) => {
  console.error('[seed] failed:', err);
  await disconnectDB();
  process.exit(1);
});