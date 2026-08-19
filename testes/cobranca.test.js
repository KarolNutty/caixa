import { describe, expect, it } from 'vitest';
import {
  VALOR_MAXIMO,
  VALOR_MINIMO,
  ehEmailPlausivel,
  novaChave,
  problemasDaCobranca,
  resumir,
} from '../nucleo/cobranca.js';

function valida(ajustes = {}) {
  return {
    valor: 4990,
    descricao: 'Plano mensal',
    cliente: 'ana@exemplo.com',
    ...ajustes,
  };
}

describe('chave de idempotência', () => {
  it('cada chamada gera uma diferente', () => {
    const chaves = new Set(Array.from({ length: 500 }, () => novaChave()));
    expect(chaves.size).toBe(500);
  });

  it('funciona sem a API de criptografia', () => {
    /**
     * Navegador antigo ou contexto sem HTTPS não expõem `randomUUID`. Falhar
     * ali impediria a cobrança inteira por causa de um detalhe de ambiente.
     */
    const chave = novaChave({});

    expect(typeof chave).toBe('string');
    expect(chave.length).toBeGreaterThan(8);
  });

  it('sem a API, ainda gera valores distintos', () => {
    const chaves = new Set(Array.from({ length: 200 }, () => novaChave({})));
    expect(chaves.size).toBeGreaterThan(190);
  });
});

describe('validação', () => {
  it('cobrança correta não tem problema', () => {
    expect(problemasDaCobranca(valida())).toEqual([]);
  });

  it('devolve todos os problemas de uma vez', () => {
    /**
     * Mostrar um erro por vez faz a pessoa corrigir, tentar, descobrir o
     * próximo, e desistir na terceira volta.
     */
    const problemas = problemasDaCobranca({ valor: 0, descricao: '', cliente: 'x' });

    expect(problemas).toHaveLength(3);
    expect(problemas.map((p) => p.campo).sort()).toEqual([
      'cliente',
      'descricao',
      'valor',
    ]);
  });

  it('recusa valor abaixo do mínimo', () => {
    const problemas = problemasDaCobranca(valida({ valor: VALOR_MINIMO - 1 }));
    expect(problemas[0].campo).toBe('valor');
  });

  it('aceita exatamente o mínimo', () => {
    // O limite pertence ao lado aceito: recusar o valor exato é o erro clássico
    // de comparação, e ninguém percebe até um cliente reclamar.
    expect(problemasDaCobranca(valida({ valor: VALOR_MINIMO }))).toEqual([]);
  });

  it('aceita exatamente o máximo', () => {
    expect(problemasDaCobranca(valida({ valor: VALOR_MAXIMO }))).toEqual([]);
  });

  it('recusa valor fracionado', () => {
    // Centavos são inteiros. Um valor com fração indica que alguém usou ponto
    // flutuante em algum lugar da cadeia.
    const problemas = problemasDaCobranca(valida({ valor: 10.5 }));
    expect(problemas[0].campo).toBe('valor');
  });

  it('descrição só de espaço não vale', () => {
    const problemas = problemasDaCobranca(valida({ descricao: '   ' }));
    expect(problemas[0].campo).toBe('descricao');
  });
});

describe('e-mail plausível', () => {
  it('aceita os comuns', () => {
    expect(ehEmailPlausivel('ana@exemplo.com')).toBe(true);
    expect(ehEmailPlausivel('ana.silva+cobranca@exemplo.com.br')).toBe(true);
  });

  it('recusa erro de digitação óbvio', () => {
    expect(ehEmailPlausivel('ana@exemplo')).toBe(false);
    expect(ehEmailPlausivel('ana exemplo.com')).toBe(false);
    expect(ehEmailPlausivel('@exemplo.com')).toBe(false);
  });

  it('recusa o que não é texto', () => {
    expect(ehEmailPlausivel(null)).toBe(false);
    expect(ehEmailPlausivel(42)).toBe(false);
  });

  it('ignora espaço em volta', () => {
    expect(ehEmailPlausivel('  ana@exemplo.com  ')).toBe(true);
  });
});

describe('resumo da fila', () => {
  const registros = [
    { estado: 'pendente', valor: 1000 },
    { estado: 'enviando', valor: 2000 },
    { estado: 'confirmada', valor: 500 },
    { estado: 'recusada', valor: 300 },
  ];

  it('conta cada situação', () => {
    const resumo = resumir(registros);

    expect(resumo.total).toBe(4);
    expect(resumo.aguardando).toBe(2);
    expect(resumo.confirmadas).toBe(1);
    expect(resumo.recusadas).toBe(1);
  });

  it('soma só o que ainda está para acontecer', () => {
    // É o número que a pessoa precisa: quanto ainda pode entrar ou falhar.
    expect(resumir(registros).valorAguardando).toBe(3000);
  });

  it('fila vazia devolve zeros', () => {
    expect(resumir([])).toMatchObject({ total: 0, aguardando: 0, valorAguardando: 0 });
  });
});
