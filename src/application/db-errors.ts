/** Extrai o SQLSTATE do Postgres de um erro (do driver ou das exceções do MikroORM). */
export function pgCode(err: unknown): string | undefined {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | undefined;
  const code = e?.code ?? e?.cause?.code;
  return typeof code === 'string' ? code : undefined;
}

/** 23505: violação de UNIQUE. */
export const isUniqueViolation = (err: unknown): boolean => pgCode(err) === '23505';

/** 22P02 (texto inválido, ex.: UUID malformado) e 22003 (valor numérico fora do intervalo). */
export const isInvalidInputValue = (err: unknown): boolean => {
  const c = pgCode(err);
  return c === '22P02' || c === '22003';
};
