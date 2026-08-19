import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ESTADOS,
  abrirBanco,
  aplicarResultado,
  buscar,
  ehDefinitivo,
  enfileirar,
  esperaAntesDe,
  listar,
  prontasParaEnvio,
  remover,
  salvar,
} from '../nucleo/fila.js';

function cobranca(chave = 'c1', valor = 4990) {
  return { chave, valor, descricao: 'Plano mensal', cliente: 'ana@exemplo.com' };
}

let bd;

beforeEach(async () => {
  indexedDB = new IDBFactory();
  bd = await abrirBanco();
});

describe('durabilidade', () => {
  it('a intenção sobrevive ao fechamento da aba', async () => {
    /**
     * É a razão de o registro ir para o disco ANTES da rede. Guardado só em
     * memória, um refresh no meio do envio apaga o pagamento sem ninguém saber
     * que ele existiu.
     */
    await enfileirar(bd, cobranca());
    bd.close();

    const outroBd = await abrirBanco();
    const guardadas = await listar(outroBd);

    expect(guardadas).toHaveLength(1);
    expect(guardadas[0].valor).toBe(4990);
  });

  it('nasce pendente e sem tentativas', async () => {
    const registro = await enfileirar(bd, cobranca());

    expect(registro.estado).toBe(ESTADOS.PENDENTE);
    expect(registro.tentativas).toBe(0);
  });

  it('a mesma chave não entra duas vezes', async () => {
    // A chave de idempotência identifica a cobrança para o servidor e para o
    // banco local. Duas entradas para a mesma intenção seriam duas cobranças.
    await enfileirar(bd, cobranca('igual'));

    await expect(enfileirar(bd, cobranca('igual'))).rejects.toThrow();
    expect(await listar(bd)).toHaveLength(1);
  });
});

describe('o que está pronto para enviar', () => {
  it('devolve as pendentes em ordem de criação', () => {
    // Quem tentou pagar primeiro é atendido primeiro, que é o que a pessoa
    // espera ao olhar a fila.
    const registros = [
      { chave: 'b', estado: ESTADOS.PENDENTE, criadaEm: 200, proximaTentativaEm: 0 },
      { chave: 'a', estado: ESTADOS.PENDENTE, criadaEm: 100, proximaTentativaEm: 0 },
    ];

    expect(prontasParaEnvio(registros, 1000).map((r) => r.chave)).toEqual(['a', 'b']);
  });

  it('não devolve o que ainda está em espera', () => {
    const registros = [
      { chave: 'a', estado: ESTADOS.PENDENTE, criadaEm: 1, proximaTentativaEm: 9999 },
    ];

    expect(prontasParaEnvio(registros, 1000)).toHaveLength(0);
  });

  it('não devolve o que já terminou', () => {
    const registros = [
      { chave: 'a', estado: ESTADOS.CONFIRMADA, criadaEm: 1, proximaTentativaEm: 0 },
      { chave: 'b', estado: ESTADOS.RECUSADA, criadaEm: 2, proximaTentativaEm: 0 },
    ];

    expect(prontasParaEnvio(registros, 1000)).toHaveLength(0);
  });
});

describe('resultado da tentativa', () => {
  const base = { chave: 'c1', tentativas: 0, estado: ESTADOS.PENDENTE };

  it('sucesso confirma e guarda o id do servidor', () => {
    const depois = aplicarResultado(base, { ok: true, id: 'pay_123' }, 5000);

    expect(depois.estado).toBe(ESTADOS.CONFIRMADA);
    expect(depois.idNoServidor).toBe('pay_123');
  });

  it('falha de rede volta para a fila com espera', () => {
    const depois = aplicarResultado(base, { ok: false, status: 0 }, 5000, () => 0.5);

    expect(depois.estado).toBe(ESTADOS.PENDENTE);
    expect(depois.tentativas).toBe(1);
    expect(depois.proximaTentativaEm).toBeGreaterThan(5000);
  });

  it('erro de servidor também volta para a fila', () => {
    // 500 costuma passar sozinho. Desistir aqui perderia um pagamento válido.
    const depois = aplicarResultado(base, { ok: false, status: 500 }, 5000, () => 0.5);

    expect(depois.estado).toBe(ESTADOS.PENDENTE);
  });

  it('cartão recusado não volta para a fila', () => {
    /**
     * Não adianta repetir: o cartão não vai passar a ter saldo por insistência.
     * Manter na fila gastaria bateria e deixaria pendurado algo que nunca sai.
     */
    const depois = aplicarResultado(
      base,
      { ok: false, status: 402, mensagem: 'Saldo insuficiente.' },
      5000,
    );

    expect(depois.estado).toBe(ESTADOS.RECUSADA);
    expect(depois.erro).toBe('Saldo insuficiente.');
  });

  it('valor inválido também é definitivo', () => {
    const depois = aplicarResultado(base, { ok: false, status: 422 }, 5000);
    expect(depois.estado).toBe(ESTADOS.RECUSADA);
  });

  it('a contagem de tentativas acumula entre falhas', () => {
    let registro = base;

    for (let i = 0; i < 3; i += 1) {
      registro = aplicarResultado(registro, { ok: false, status: 0 }, 5000, () => 0.5);
    }

    expect(registro.tentativas).toBe(3);
  });
});

describe('espera entre tentativas', () => {
  it('cresce a cada tentativa', () => {
    const primeira = esperaAntesDe(1, () => 0.5);
    const terceira = esperaAntesDe(3, () => 0.5);

    expect(terceira).toBeGreaterThan(primeira);
  });

  it('para de crescer em cinco minutos', () => {
    // Sem teto, a décima tentativa aconteceria daqui a horas, e quem voltou a
    // ter rede esperaria à toa.
    expect(esperaAntesDe(50, () => 1)).toBeLessThanOrEqual(5 * 60 * 1000);
  });

  it('duas filas que falharam juntas não voltam juntas', () => {
    /**
     * Uma queda que afeta mil pessoas produziria mil pedidos no mesmo instante
     * quando a rede voltasse, e o servidor cairia de novo. O ruído espalha.
     */
    const uma = esperaAntesDe(3, () => 0);
    const outra = esperaAntesDe(3, () => 1);

    expect(uma).not.toBe(outra);
  });

  it('o ruído nunca torna a espera maior que o teto', () => {
    for (let tentativa = 0; tentativa < 20; tentativa += 1) {
      expect(esperaAntesDe(tentativa, () => 1)).toBeLessThanOrEqual(5 * 60 * 1000);
    }
  });
});

describe('classificação de erro', () => {
  it('reconhece os definitivos', () => {
    expect(ehDefinitivo(402)).toBe(true);
    expect(ehDefinitivo(422)).toBe(true);
  });

  it('rede e servidor são temporários', () => {
    expect(ehDefinitivo(0)).toBe(false);
    expect(ehDefinitivo(500)).toBe(false);
    expect(ehDefinitivo(503)).toBe(false);
  });
});

describe('ciclo completo', () => {
  it('enfileirar, confirmar e sair da fila', async () => {
    const registro = await enfileirar(bd, cobranca('c9'));

    await salvar(bd, aplicarResultado(registro, { ok: true, id: 'pay_9' }, 1000));

    const guardado = await buscar(bd, 'c9');
    expect(guardado.estado).toBe(ESTADOS.CONFIRMADA);

    await remover(bd, 'c9');
    expect(await buscar(bd, 'c9')).toBeUndefined();
  });
});
