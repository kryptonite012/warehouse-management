import * as bcrypt from 'bcryptjs';

const COST = Number(process.env.BCRYPT_COST ?? 12);

export const hashPassword = (plain: string) => bcrypt.hash(plain, COST);
export const verifyPassword = (plain: string, hash: string) => bcrypt.compare(plain, hash);

// Constant-ish work for unknown users so timing does not reveal account existence.
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 10);
export const burnPasswordCheck = (plain: string) => bcrypt.compare(plain, DUMMY_HASH);
