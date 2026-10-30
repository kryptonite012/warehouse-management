import { PrismaService, Tx } from './prisma.service';

/** Human-readable document numbers, e.g. PO-2026-0001234. Backed by a DB sequence. */
export async function nextDocNumber(db: PrismaService | Tx, prefix: string): Promise<string> {
  const [{ n }] = await db.$queryRaw<{ n: bigint }[]>`SELECT nextval('quickstore_doc_seq') AS n`;
  return `${prefix}-${new Date().getUTCFullYear()}-${String(n).padStart(7, '0')}`;
}
